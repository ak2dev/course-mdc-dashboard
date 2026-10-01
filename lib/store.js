'use strict';

// Persistence layer. Uses MongoDB when MONGODB_URI is set (required on Vercel),
// otherwise falls back to a local JSON file for offline development.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const memberKey = (name) => name.trim().toLowerCase().replace(/\s+/g, ' ');
const PUBLIC_FIELDS = { _id: 0, teamKey: 0, memberKeys: 0 };

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
          await ensureIndexes(c.db(dbName));
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

    isDuplicateKeyError: (err) => err && err.code === 11000,
  };
}

/* -------------------------------------------------------------- JSON file */

function createFileStore(file) {
  let projects = null;
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

  function persist() {
    const snapshot = JSON.stringify(projects, null, 2);
    writeChain = writeChain
      .catch(() => {})
      .then(async () => {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(`${file}.tmp`, snapshot);
        await fsp.rename(`${file}.tmp`, file);
      });
    return writeChain;
  }

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
