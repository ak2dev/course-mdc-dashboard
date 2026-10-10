'use strict';

// Persistence layer. Uses MongoDB when MONGODB_URI is set (required on Vercel),
// otherwise falls back to a local JSON file for offline development.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const memberKey = (name) => name.trim().toLowerCase().replace(/\s+/g, ' ');
const PUBLIC_FIELDS = { _id: 0, teamKey: 0, memberKeys: 0 };
const ACTIVITY_TTL_SECONDS = 180 * 24 * 60 * 60;

// Windows (OneDrive sync, antivirus) can briefly lock a file being replaced.
async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fsp.rename(from, to);
    } catch (err) {
      if (attempt >= 6 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function withKeys(project) {
  return {
    ...project,
    teamKey: project.teamName.toLowerCase(),
    memberKeys: project.members.map(memberKey),
  };
}

/* ---------------------------------------------------------------- MongoDB */

function createMongoStore(uri, dbName) {
  const { MongoClient } = require('mongodb');

  // Reuse one client across warm serverless invocations.
  const cache = (globalThis.__mdcMongo ||= { promise: null });

  async function ensureIndexes(db) {
    await Promise.all([
      db.collection('projects').createIndexes([
        { key: { id: 1 }, unique: true },
        { key: { teamKey: 1 }, unique: true },
        // Multikey unique index: a student can belong to only one team.
        { key: { memberKeys: 1 }, unique: true },
        { key: { createdAt: 1 } },
      ]),
      db.collection('sessions').createIndexes([
        { key: { tokenHash: 1 }, unique: true },
        { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
      ]),
      db.collection('login_attempts').createIndexes([
        { key: { ip: 1 }, unique: true },
        { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
      ]),
      // Activity entries expire after 180 days.
      db.collection('activity').createIndexes([
        { key: { at: -1 }, expireAfterSeconds: ACTIVITY_TTL_SECONDS },
      ]),
    ]);
  }

  async function db() {
    if (!cache.promise) {
      const client = new MongoClient(uri, {
        appName: 'course-mdc',
        maxPoolSize: 5,
        serverSelectionTimeoutMS: 8000,
      });
      cache.promise = client
        .connect()
        .then(async (c) => {
          // Indexes back up the app-level checks; a failure here must not take the API down.
          await ensureIndexes(c.db(dbName)).catch((err) => console.error('Index setup failed:', err));
          return c;
        })
        .catch((err) => {
          cache.promise = null;
          throw err;
        });
    }
    return (await cache.promise).db(dbName);
  }

  const projects = async () => (await db()).collection('projects');

  return {
    kind: 'mongodb',

    async listProjects() {
      return (await projects()).find({}, { projection: PUBLIC_FIELDS }).sort({ createdAt: 1 }).toArray();
    },
    async insertProject(project) {
      await (await projects()).insertOne(withKeys(project));
    },
    async replaceProject(project) {
      const res = await (await projects()).replaceOne({ id: project.id }, withKeys(project));
      return res.matchedCount > 0;
    },
    async deleteProject(id) {
      const res = await (await projects()).deleteOne({ id });
      return res.deletedCount > 0;
    },
    async replaceAll(list) {
      const col = await projects();
      await col.deleteMany({});
      if (list.length) await col.insertMany(list.map(withKeys));
    },

    async createSession(tokenHash, expiresAt) {
      await (await db()).collection('sessions').insertOne({ tokenHash, expiresAt: new Date(expiresAt) });
    },
    async hasSession(tokenHash) {
      const found = await (await db())
        .collection('sessions')
        .findOne({ tokenHash, expiresAt: { $gt: new Date() } }, { projection: { _id: 1 } });
      return Boolean(found);
    },
    async deleteSession(tokenHash) {
      await (await db()).collection('sessions').deleteOne({ tokenHash });
    },

    async countLoginAttempt(ip, windowMs) {
      const entry = await (await db()).collection('login_attempts').findOneAndUpdate(
        { ip },
        { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(Date.now() + windowMs) } },
        { upsert: true, returnDocument: 'after' }
      );
      // TTL cleanup runs about once a minute, so also honour the window here.
      if (entry && entry.expiresAt < new Date()) {
        await (await db()).collection('login_attempts').deleteOne({ ip });
        return 1;
      }
      return entry?.count ?? 1;
    },

    async resetScores() {
      const res = await (await projects()).updateMany(
        { score: { $ne: null } },
        { $set: { score: null, status: 'pending', updatedAt: new Date().toISOString() }, $unset: { gradedAt: '' } }
      );
      return res.modifiedCount;
    },
    async revokeAllSessions() {
      const res = await (await db()).collection('sessions').deleteMany({});
      return res.deletedCount;
    },

    async getSettings() {
      return (await (await db()).collection('settings').findOne({ _id: 'course' }, { projection: { _id: 0 } })) || {};
    },
    async saveSettings(settings) {
      await (await db()).collection('settings').updateOne({ _id: 'course' }, { $set: settings }, { upsert: true });
    },

    async logActivity(entry) {
      await (await db()).collection('activity').insertOne({ ...entry, at: new Date(entry.at) });
    },
    async listActivity(limit) {
      const rows = await (await db()).collection('activity')
        .find({}, { projection: { _id: 0 } }).sort({ at: -1 }).limit(limit).toArray();
      return rows.map((r) => ({ ...r, at: new Date(r.at).toISOString() }));
    },

    isDuplicateKeyError: (err) => err && err.code === 11000,
  };
}

/* -------------------------------------------------------------- JSON file */

function createFileStore(file) {
  const dir = path.dirname(file);
  let projects = null;
  let settings = readJson(path.join(dir, 'settings.json'), {});
  let activity = readJson(path.join(dir, 'activity.json'), []);
  let writeChain = Promise.resolve();
  const sessions = new Map();
  const attempts = new Map();

  function load() {
    if (!projects) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        projects = Array.isArray(data) ? data : [];
      } catch {
        projects = [];
      }
    }
    return projects;
  }

  function write(target, data) {
    const snapshot = JSON.stringify(data, null, 2);
    writeChain = writeChain
      .catch(() => {})
      .then(async () => {
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(`${target}.tmp`, snapshot);
        await renameWithRetry(`${target}.tmp`, target);
      });
    return writeChain;
  }

  const persist = () => write(file, projects);

  const clone = (p) => JSON.parse(JSON.stringify(p));

  return {
    kind: 'file',

    async listProjects() {
      return load().map(clone).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async insertProject(project) {
      load().push(clone(project));
      await persist();
    },
    async replaceProject(project) {
      const list = load();
      const idx = list.findIndex((p) => p.id === project.id);
      if (idx === -1) return false;
      list[idx] = clone(project);
      await persist();
      return true;
    },
    async deleteProject(id) {
      const list = load();
      const idx = list.findIndex((p) => p.id === id);
      if (idx === -1) return false;
      list.splice(idx, 1);
      await persist();
      return true;
    },
    async replaceAll(list) {
      projects = list.map(clone);
      await persist();
    },

    async createSession(tokenHash, expiresAt) {
      sessions.set(tokenHash, expiresAt);
    },
    async hasSession(tokenHash) {
      const exp = sessions.get(tokenHash);
      if (!exp) return false;
      if (exp < Date.now()) {
        sessions.delete(tokenHash);
        return false;
      }
      return true;
    },
    async deleteSession(tokenHash) {
      sessions.delete(tokenHash);
    },

    async countLoginAttempt(ip, windowMs) {
      const now = Date.now();
      const entry = attempts.get(ip);
      if (!entry || entry.resetAt < now) {
        attempts.set(ip, { count: 1, resetAt: now + windowMs });
        return 1;
      }
      entry.count += 1;
      return entry.count;
    },

    async resetScores() {
      let count = 0;
      for (const p of load()) {
        if (p.score !== null) {
          p.score = null;
          p.status = 'pending';
          p.updatedAt = new Date().toISOString();
          delete p.gradedAt;
          count++;
        }
      }
      await persist();
      return count;
    },
    async revokeAllSessions() {
      const count = sessions.size;
      sessions.clear();
      return count;
    },

    async getSettings() {
      return clone(settings);
    },
    async saveSettings(next) {
      settings = { ...settings, ...clone(next) };
      await write(path.join(dir, 'settings.json'), settings);
    },

    async logActivity(entry) {
      activity.unshift(clone(entry));
      activity = activity.slice(0, 300);
      await write(path.join(dir, 'activity.json'), activity);
    },
    async listActivity(limit) {
      return activity.slice(0, limit).map(clone);
    },

    isDuplicateKeyError: () => false,
  };
}

/* ---------------------------------------------------------------- factory */

let store;

function getStore() {
  if (!store) {
    const uri = process.env.MONGODB_URI;
    if (uri) {
      store = createMongoStore(uri, process.env.MONGODB_DB || 'course_mdc');
    } else if (process.env.VERCEL) {
      throw new Error('MONGODB_URI is not configured for this deployment.');
    } else {
      store = createFileStore(path.join(__dirname, '..', 'data', 'projects.json'));
    }
  }
  return store;
}

module.exports = { getStore, memberKey };
