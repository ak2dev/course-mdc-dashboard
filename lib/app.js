'use strict';

// API request handler shared by the Vercel function (api/index.js)
// and the local development server (server.js).

const crypto = require('crypto');
const { getStore, memberKey } = require('./store');

const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || 'mdc@teacher2026';
const CAPACITY = 64;
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 60_000;
const MAX_LOGIN_ATTEMPTS = 8;
const MAX_BODY_BYTES = 64 * 1024;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

/* ---------------------------------------------------------------- errors */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (msg) => new HttpError(400, msg);

/* ------------------------------------------------------------------ auth */

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function tokenFrom(req) {
  const token = req.headers['x-teacher-token'];
  return typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) ? token : null;
}

async function isTeacher(req) {
  const token = tokenFrom(req);
  return token ? getStore().hasSession(hashToken(token)) : false;
}

function clientIp(req) {
  const forwarded = req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0];
  return String(forwarded).trim() || req.socket?.remoteAddress || 'unknown';
}

/* ------------------------------------------------------------ validation */

function cleanLine(value, max) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

function cleanMultiline(value, max) {
  return typeof value === 'string'
    ? value.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max)
    : '';
}

function normalizeUrl(value, label, { githubOnly = false } = {}) {
  let s = typeof value === 'string' ? value.trim() : '';
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, '')}`;
  let url;
  try {
    url = new URL(s);
  } catch {
    throw bad(`${label} is not a valid URL.`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.')) {
    throw bad(`${label} is not a valid URL.`);
  }
  if (githubOnly && !/(^|\.)github\.com$/i.test(url.hostname)) {
    throw bad('Repository link must point to github.com.');
  }
  if (url.href.length > 300) throw bad(`${label} is too long.`);
  return url.href;
}

function parseScore(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 10) throw bad('Score must be a number between 0.0 and 10.0.');
  return Math.round(n * 10) / 10;
}

function normalizeMembers(value) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const seen = new Set();
  const members = [];
  for (const item of raw) {
    const name = cleanLine(item, 48);
    const key = memberKey(name);
    if (name && !seen.has(key)) {
      seen.add(key);
      members.push(name);
    }
  }
  return members;
}

function tierOf(score) {
  if (score === null || score === undefined) return 'Pending';
  if (score >= 9) return 'Excellent';
  if (score >= 7) return 'Very Good';
  if (score >= 5) return 'Good';
  if (score >= 3) return 'Acceptable';
  return 'Needs Improvement';
}

function applyFields(target, body, { partial, teacher }) {
  const has = (k) => !partial || Object.prototype.hasOwnProperty.call(body, k);

  if (has('teamName')) {
    const v = cleanLine(body.teamName, 60);
    if (!v) throw bad('Team name is required.');
    target.teamName = v;
  }
  if (has('title')) {
    const v = cleanLine(body.title, 100);
    if (!v) throw bad('Project title is required.');
    target.title = v;
  }
  if (has('members')) {
    const members = normalizeMembers(body.members);
    if (members.length === 0) throw bad('Add at least one team member.');
    if (members.length > 8) throw bad('A team can have at most 8 members.');
    target.members = members;
  }
  if (has('techStack')) target.techStack = cleanLine(body.techStack, 300);
  if (has('vercelUrl')) target.vercelUrl = normalizeUrl(body.vercelUrl, 'Deployment URL');
  if (has('githubUrl')) target.githubUrl = normalizeUrl(body.githubUrl, 'Repository URL', { githubOnly: true });

  if (teacher) {
    if ('score' in body) target.score = parseScore(body.score);
    if ('reviewerNotes' in body) target.reviewerNotes = cleanMultiline(body.reviewerNotes, 2000);
  }
  if (target.score === undefined) target.score = null;
  if (target.reviewerNotes === undefined) target.reviewerNotes = '';
  target.status = target.score === null ? 'pending' : 'graded';
}

function checkConflicts(candidate, projects) {
  const others = projects.filter((p) => p.id !== candidate.id);

  const teamKey = candidate.teamName.toLowerCase();
  const clash = others.find((p) => p.teamName.toLowerCase() === teamKey);
  if (clash) throw new HttpError(409, `A team named "${clash.teamName}" already exists.`);

  const owner = new Map();
  for (const p of others) for (const m of p.members) owner.set(memberKey(m), p.teamName);
  for (const m of candidate.members) {
    const team = owner.get(memberKey(m));
    if (team) throw new HttpError(409, `"${m}" is already registered with team "${team}".`);
  }

  const unique = new Set(owner.keys());
  for (const m of candidate.members) unique.add(memberKey(m));
  if (unique.size > CAPACITY) {
    throw new HttpError(409, `Course capacity reached: only ${CAPACITY} students can be registered.`);
  }
}

function publicView(p, teacher) {
  if (teacher) return p;
  const { reviewerNotes, ...rest } = p;
  return rest;
}

/* ------------------------------------------------------------------- csv */

function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(projects) {
  const header = [
    '#', 'Team Name', 'Team Members', 'Member Count', 'Project Title', 'Tech Stack',
    'Deployment URL', 'GitHub URL', 'Score', 'Evaluation Level', 'Status',
    'Reviewer Notes', 'Submitted At', 'Updated At',
  ];
  const rows = projects.map((p, i) => [
    i + 1, p.teamName, p.members.join('; '), p.members.length, p.title, p.techStack,
    p.vercelUrl, p.githubUrl, p.score === null ? '' : p.score.toFixed(1), tierOf(p.score),
    p.status === 'graded' ? 'Graded' : 'Pending', p.reviewerNotes, p.createdAt, p.updatedAt,
  ]);
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/* ----------------------------------------------------------- frame check */

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') ||
    h === '::1' || h === '0.0.0.0' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^f[cd]/.test(h) || /^fe80:/.test(h)
  );
}

async function frameCheck(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw bad('Invalid URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || isPrivateHost(url.hostname)) {
    throw bad('URL cannot be checked.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'CourseMDC-PreviewCheck/1.0' },
    });
    res.body?.cancel().catch(() => {});

    const xfo = (res.headers.get('x-frame-options') || '').toLowerCase();
    const csp = res.headers.get('content-security-policy') || '';
    const fa = csp.split(';').map((d) => d.trim()).find((d) => /^frame-ancestors\b/i.test(d));

    let embeddable = true;
    let reason = '';
    if (fa) {
      if (!fa.split(/\s+/).slice(1).includes('*')) {
        embeddable = false;
        reason = 'The site restricts embedding with a Content-Security-Policy frame-ancestors rule.';
      }
    } else if (xfo.includes('deny') || xfo.includes('sameorigin')) {
      embeddable = false;
      reason = `The site sends X-Frame-Options: ${xfo.toUpperCase()}.`;
    }
    return { embeddable, reason, status: res.status, reachable: res.ok };
  } catch (err) {
    return {
      embeddable: true,
      reason: '',
      status: 0,
      reachable: false,
      error: err.name === 'AbortError' ? 'timeout' : 'unreachable',
    };
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------------------------------------------- helpers */

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
}

function asObject(data) {
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function parseJsonText(text) {
  if (!text.trim()) return {};
  try {
    return asObject(JSON.parse(text));
  } catch {
    throw bad('Malformed JSON body.');
  }
}

function readJson(req) {
  // Vercel's Node runtime pre-parses the body into req.body.
  if ('body' in req) {
    let body;
    try {
      body = req.body;
    } catch {
      throw bad('Malformed JSON body.');
    }
    if (body === undefined || body === null) return {};
    if (Buffer.isBuffer(body)) body = body.toString('utf8');
    if (typeof body === 'string') return parseJsonText(body);
    return asObject(body);
  }
  if (req.readableEnded) return {};

  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(parseJsonText(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function resolveUrl(req) {
  const url = new URL(req.url, 'http://localhost');
  // On Vercel, vercel.json rewrites /api/<path> to /api/index?__path=<path>.
  const rewritten = url.searchParams.get('__path');
  if (rewritten !== null) {
    url.pathname = `/api/${rewritten.replace(/^\/+/, '')}`;
    url.searchParams.delete('__path');
  }
  return url;
}

/* ---------------------------------------------------------------- routes */

async function route(req, res) {
  const url = resolveUrl(req);
  const { pathname } = url;
  const method = req.method;
  const store = getStore();

  if (pathname === '/api/health' && method === 'GET') {
    await store.listProjects();
    return sendJson(res, 200, { ok: true, storage: store.kind });
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    const attempts = await store.countLoginAttempt(clientIp(req), LOGIN_WINDOW_MS);
    if (attempts > MAX_LOGIN_ATTEMPTS) {
      throw new HttpError(429, 'Too many sign-in attempts. Please wait a minute and try again.');
    }
    const body = await readJson(req);
    if (!body.password || !safeEqual(body.password, TEACHER_PASSWORD)) {
      throw new HttpError(401, 'Incorrect faculty password.');
    }
    const token = crypto.randomBytes(32).toString('hex');
    await store.createSession(hashToken(token), Date.now() + TOKEN_TTL_MS);
    return sendJson(res, 200, { token, expiresIn: TOKEN_TTL_MS });
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    const token = tokenFrom(req);
    if (token) await store.deleteSession(hashToken(token));
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/auth/session' && method === 'GET') {
    return sendJson(res, 200, { authenticated: await isTeacher(req) });
  }

  if (pathname === '/api/projects' && method === 'GET') {
    const [teacher, projects] = await Promise.all([isTeacher(req), store.listProjects()]);
    return sendJson(res, 200, {
      capacity: CAPACITY,
      teacher,
      projects: projects.map((p) => publicView(p, teacher)),
    });
  }

  if (pathname === '/api/projects' && method === 'POST') {
    const [teacher, body, projects] = await Promise.all([isTeacher(req), readJson(req), store.listProjects()]);
    const now = new Date().toISOString();
    const project = { id: crypto.randomUUID(), createdAt: now, updatedAt: now };
    applyFields(project, body, { partial: false, teacher });
    checkConflicts(project, projects);
    if (project.status === 'graded') project.gradedAt = now;
    await store.insertProject(project);
    return sendJson(res, 201, { project: publicView(project, teacher) });
  }

  const match = pathname.match(/^\/api\/projects\/([\w-]+)$/);
  if (match && (method === 'PUT' || method === 'PATCH')) {
    if (!(await isTeacher(req))) throw new HttpError(401, 'Faculty authentication required.');
    const [body, projects] = await Promise.all([readJson(req), store.listProjects()]);
    const existing = projects.find((p) => p.id === match[1]);
    if (!existing) throw new HttpError(404, 'Project not found.');
    const draft = { ...existing };
    applyFields(draft, body, { partial: true, teacher: true });
    checkConflicts(draft, projects);
    draft.updatedAt = new Date().toISOString();
    if (draft.status === 'graded' && (existing.score !== draft.score || !existing.gradedAt)) {
      draft.gradedAt = draft.updatedAt;
    }
    if (!(await store.replaceProject(draft))) throw new HttpError(404, 'Project not found.');
    return sendJson(res, 200, { project: draft });
  }

  if (match && method === 'DELETE') {
    if (!(await isTeacher(req))) throw new HttpError(401, 'Faculty authentication required.');
    if (!(await store.deleteProject(match[1]))) throw new HttpError(404, 'Project not found.');
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/export/csv' && method === 'GET') {
    if (!(await isTeacher(req))) throw new HttpError(401, 'Faculty authentication required.');
    const stamp = new Date().toISOString().slice(0, 10);
    return send(res, 200, buildCsv(await store.listProjects()), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="course-mdc-grades-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    });
  }

  if (pathname === '/api/frame-check' && method === 'GET') {
    const target = url.searchParams.get('url');
    if (!target) throw bad('Missing url parameter.');
    return sendJson(res, 200, await frameCheck(target));
  }

  throw new HttpError(404, 'Endpoint not found.');
}

async function handleApi(req, res) {
  try {
    await route(req, res);
  } catch (err) {
    let status = err instanceof HttpError ? err.status : 500;
    let message = err.message;
    let duplicate = false;
    try {
      duplicate = getStore().isDuplicateKeyError(err);
    } catch { /* store unavailable */ }
    if (status === 500 && duplicate) {
      status = 409;
      message = 'That team name or student was just registered by another submission. Refresh and try again.';
    }
    if (status === 500) console.error(err);
    if (!res.headersSent) {
      sendJson(res, status, { error: status === 500 ? 'Internal server error.' : message });
    }
  }
}

module.exports = { handleApi };
