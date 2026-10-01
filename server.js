'use strict';

// Local development server: serves public/ and routes /api/* to the same
// handler Vercel runs. Reads .env.local if present (e.g. MONGODB_URI).

const http = require('http');
const fsp = require('fs').promises;
const path = require('path');

try {
  process.loadEnvFile(path.join(__dirname, '.env.local'));
} catch { /* no .env.local: JSON file storage is used */ }

const { handleApi } = require('./lib/app');
const { getStore } = require('./lib/store');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Mirrors the headers block in vercel.json.
const STATIC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': require('./vercel.json').headers[0].headers
    .find((h) => h.key === 'Content-Security-Policy').value,
};

async function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await fsp.readFile(filePath);
    res.writeHead(200, {
      ...STATIC_HEADERS,
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname.startsWith('/api/')) return handleApi(req, res);
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
  res.writeHead(405).end('Method not allowed');
});

server.listen(PORT, () => {
  console.log(`\n  Course MDC dashboard running at http://localhost:${PORT}`);
  console.log(`  Storage: ${getStore().kind === 'mongodb' ? 'MongoDB' : 'local JSON file (data/projects.json)'}`);
  if (!process.env.TEACHER_PASSWORD) {
    console.log('  Using the default faculty password (set TEACHER_PASSWORD to change it).');
  }
  console.log('');
});
