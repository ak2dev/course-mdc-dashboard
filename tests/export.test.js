'use strict';

// Unit tests for the faculty exports (CSV, JSON, Excel, HTML / PDF report).
// Run with: npm run test:unit   (uses made-up names only)

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildExport } = require('../lib/export');
const { readXlsxRows } = require('../lib/xlsx');

const project = (n, teamName, members, score, extra = {}) => ({
  id: `p${n}`,
  teamName,
  title: `Project ${n}`,
  members,
  techStack: 'React, Vite',
  type: 'web',
  vercelUrl: `https://project-${n}.vercel.app/`,
  demoUrl: '',
  githubUrl: `https://github.com/team/project-${n}`,
  score,
  status: score === null ? 'pending' : 'graded',
  reviewerNotes: '',
  createdAt: `2026-10-0${n}T08:30:00.000Z`,
  updatedAt: `2026-10-0${n}T09:00:00.000Z`,
  ...extra,
});

const projects = [
  project(1, 'Alpha Team', ['Test Student One', 'Test Student Two'], 9.2, { reviewerNotes: 'Great <b>work</b> & "docs"' }),
  project(2, 'Beta Team', ['Test Student Three'], 6.4),
  project(3, 'Gamma Team', ['Test Student Four'], null, { type: 'app', vercelUrl: '', demoUrl: 'https://drive.google.com/drive/folders/x' }),
  project(4, 'Delta Team', ['Test Student Five'], 9.2),
];
const settings = { courseName: 'Course MDC', capacity: 64, program: 'Test Program', semester: '1st', batch: '2026', resultsPublished: true };
const now = new Date('2026-10-29T20:00:00.000Z');
const run = (format, params = {}) => buildExport(format, projects, settings, new URLSearchParams(params), now);

test('CSV keeps the existing columns and order', () => {
  const out = run('csv');
  assert.equal(out.filename, 'course-mdc-grades-2026-10-29.csv');
  const lines = out.body.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines.length, 5);
  assert.match(lines[0], /^#,Team Name,Team Members,Member Count,Project Type/);
  assert.match(lines[1], /^1,Alpha Team,Test Student One; Test Student Two,2,Web project,/);
  assert.match(lines[3], /Desktop \/ mobile app/);
});

test('filters by tier and search the same way as the dashboard', () => {
  const tier = JSON.parse(run('json', { tier: 'excellent' }).body);
  assert.deepEqual(tier.projects.map((p) => p.teamName), ['Alpha Team', 'Delta Team']);
  assert.equal(tier.scope.filtered, true);
  const search = JSON.parse(run('json', { q: 'student three' }).body);
  assert.deepEqual(search.projects.map((p) => p.seq), [2]);
  assert.equal(run('csv', { q: 'beta' }).filename, 'course-mdc-grades-filtered-2026-10-29.csv');
  // Unknown tiers fall back to every team.
  assert.equal(JSON.parse(run('json', { tier: 'bogus' }).body).projects.length, 4);
});

test('JSON backup has summary, ranks with ties and local dates', () => {
  const data = JSON.parse(run('json', { tz: '330' }).body);
  assert.equal(data.summary.teams, 4);
  assert.equal(data.summary.graded, 3);
  assert.equal(data.summary.avg, 8.3);
  assert.deepEqual(data.projects.map((p) => p.rank), [1, 3, null, 1]);
  assert.equal(data.projects[2].tier, 'Pending');
  // 20:00 UTC is already the 30th in India.
  assert.equal(run('json', { tz: '330' }).filename, 'course-mdc-backup-2026-10-30.json');
});

test('Excel workbook opens with overview, submissions and leaderboard sheets', () => {
  for (const theme of ['light', 'dark']) {
    const out = run('xlsx', { theme });
    assert.equal(out.filename, 'course-mdc-grades-2026-10-29.xlsx');
    assert.ok(Buffer.isBuffer(out.body));
    const overview = readXlsxRows(out.body);
    assert.equal(overview[1][1], 'Course MDC');
    assert.ok(overview.some((r) => r.includes('Excellent') && r.includes('2')));
  }
});

test('HTML report escapes team content and follows the theme', () => {
  const light = run('html');
  assert.equal(light.filename, 'course-mdc-report-2026-10-29.html');
  assert.match(light.body, /<html lang="en" data-theme="light">/);
  assert.match(light.body, /Great &lt;b&gt;work&lt;\/b&gt; &amp; &quot;docs&quot;/);
  assert.doesNotMatch(light.body, /<b>work<\/b>/);
  assert.match(run('html', { theme: 'dark' }).body, /data-theme="dark"/);

  const print = run('print', { theme: 'dark' });
  assert.equal(print.filename, null);
  assert.equal(print.pdfName, 'course-mdc-report-2026-10-29.pdf');
  assert.match(print.body, /@page \{ size: A4 landscape/);
});
