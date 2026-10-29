'use strict';

// Faculty exports. One dataset (optionally narrowed to the dashboard's tier
// filter and search) is rendered as CSV, JSON, an Excel workbook, or an HTML
// report that is downloaded or printed to PDF. The workbook and the report use
// the dashboard's monochrome Geist design tokens in its light or dark theme.

const { memberKey } = require('./store');
const { writeXlsx } = require('./xlsx');

const TYPE_LABELS = { web: 'Web project', app: 'Desktop / mobile app' };

// Mirrors TIERS in public/app.js.
const TIERS = [
  { key: 'excellent', label: 'Excellent', min: 9, range: '9.0 – 10.0' },
  { key: 'verygood', label: 'Very Good', min: 7, range: '7.0 – 8.9' },
  { key: 'good', label: 'Good', min: 5, range: '5.0 – 6.9' },
  { key: 'acceptable', label: 'Acceptable', min: 3, range: '3.0 – 4.9' },
  { key: 'improve', label: 'Needs Improvement', min: -Infinity, range: '1.0 – 2.9' },
];
const PENDING = { key: 'pending', label: 'Pending', range: 'Not scored' };
const ALL_TIERS = [...TIERS, PENDING];

const isGraded = (p) => p.score !== null && p.score !== undefined;
const tierInfo = (score) => (score === null || score === undefined ? PENDING : TIERS.find((t) => score >= t.min));

const EXPORT_FORMATS = ['csv', 'json', 'xlsx', 'html', 'print'];

/* --------------------------------------------------------------- dataset */

function exportOptions(params) {
  const tier = params.get('tier');
  const tz = Number(params.get('tz'));
  return {
    theme: params.get('theme') === 'dark' ? 'dark' : 'light',
    tier: ALL_TIERS.some((t) => t.key === tier) ? tier : 'all',
    q: String(params.get('q') || '').trim().replace(/\s+/g, ' ').slice(0, 100),
    // Minutes east of UTC, so dates read in the faculty member's local time.
    tz: Number.isInteger(tz) && Math.abs(tz) <= 14 * 60 ? tz : 0,
  };
}

function buildDataset(projects, settings, opts, now = new Date()) {
  const ranked = projects.filter(isGraded)
    .sort((a, b) => b.score - a.score || a.createdAt.localeCompare(b.createdAt));
  const ranks = new Map();
  ranked.forEach((p, i) => {
    const prev = ranked[i - 1];
    ranks.set(p.id, prev && prev.score === p.score ? ranks.get(prev.id) : i + 1);
  });

  const q = opts.q.toLowerCase();
  const rows = projects
    .map((p, i) => ({ ...p, seq: i + 1, tier: tierInfo(p.score), rank: ranks.get(p.id) ?? null }))
    .filter((p) => (opts.tier === 'all' || p.tier.key === opts.tier)
      && (!q || [p.teamName, p.title, p.techStack, ...p.members].some((v) => (v || '').toLowerCase().includes(q))));

  const students = new Set();
  let memberTotal = 0;
  for (const p of rows) {
    memberTotal += p.members.length;
    for (const m of p.members) students.add(memberKey(m));
  }
  const graded = rows.filter(isGraded);
  const avg = graded.length ? Math.round((graded.reduce((s, p) => s + p.score, 0) / graded.length) * 10) / 10 : null;

  const scope = [];
  if (opts.tier !== 'all') scope.push(ALL_TIERS.find((t) => t.key === opts.tier).label);
  if (opts.q) scope.push(`“${opts.q}”`);

  return {
    settings,
    opts,
    now,
    rows,
    ranked: graded.slice().sort((a, b) => a.rank - b.rank || a.seq - b.seq),
    filtered: scope.length > 0,
    scopeLabel: scope.join(' · '),
    stats: {
      teams: rows.length,
      students: students.size,
      graded: graded.length,
      pending: rows.length - graded.length,
      avg,
      avgTeam: rows.length ? memberTotal / rows.length : 0,
    },
    distribution: ALL_TIERS.map((t) => ({ ...t, count: rows.filter((p) => p.tier.key === t.key).length })),
  };
}

/* ----------------------------------------------------------------- dates */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');
const localDate = (value, tz) => new Date(new Date(value).getTime() + tz * 60_000);

function fmtDate(value, tz, { time = true } = {}) {
  if (!value) return '';
  const d = localDate(value, tz);
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return time ? `${day}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : day;
}

const dayStamp = (value, tz) => localDate(value, tz).toISOString().slice(0, 10);
const excelDate = (value, tz) => localDate(value, tz).getTime() / 86_400_000 + 25569;

function fileName(ds, kind, ext) {
  const slug = ds.settings.courseName.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'course';
  return `${slug}-${kind}${ds.filtered ? '-filtered' : ''}-${dayStamp(ds.now, ds.opts.tz)}.${ext}`;
}

/* ------------------------------------------------------------------- csv */

function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(ds) {
  const header = [
    '#', 'Team Name', 'Team Members', 'Member Count', 'Project Type', 'Project Title', 'Tech Stack',
    'Deployment URL', 'Drive Folder URL', 'GitHub URL', 'Score', 'Evaluation Level', 'Status',
    'Reviewer Notes', 'Submitted At', 'Updated At',
  ];
  const rows = ds.rows.map((p) => [
    p.seq, p.teamName, p.members.join('; '), p.members.length, TYPE_LABELS[p.type] || TYPE_LABELS.web, p.title, p.techStack,
    p.vercelUrl, p.demoUrl || '', p.githubUrl, isGraded(p) ? p.score.toFixed(1) : '', p.tier.label,
    isGraded(p) ? 'Graded' : 'Pending', p.reviewerNotes, p.createdAt, p.updatedAt,
  ]);
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------------ json */

function buildJson(ds) {
  const s = ds.settings;
  return JSON.stringify({
    exportedAt: ds.now.toISOString(),
    course: { name: s.courseName, program: s.program, semester: s.semester, batch: s.batch, capacity: s.capacity },
    scope: { filtered: ds.filtered, tier: ds.opts.tier, query: ds.opts.q },
    summary: { ...ds.stats, avgTeam: Math.round(ds.stats.avgTeam * 10) / 10, resultsPublished: Boolean(s.resultsPublished) },
    projects: ds.rows.map((p) => ({
      seq: p.seq,
      id: p.id,
      teamName: p.teamName,
      members: p.members,
      type: p.type || 'web',
      title: p.title,
      techStack: p.techStack,
      deploymentUrl: p.vercelUrl || '',
      driveFolderUrl: p.demoUrl || '',
      githubUrl: p.githubUrl || '',
      score: isGraded(p) ? p.score : null,
      tier: p.tier.label,
      rank: p.rank,
      status: isGraded(p) ? 'graded' : 'pending',
      gradeLater: Boolean(p.gradeLater),
      draftScore: p.draftScore ?? null,
      reviewerNotes: p.reviewerNotes || '',
      gradedAt: p.gradedAt || null,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })),
  }, null, 2) + '\n';
}

/* ----------------------------------------------------------------- theme */

// Solid equivalents of the design tokens in public/styles.css, for Excel.
const PALETTE = {
  light: {
    page: 'FFFFFF', text: '0A0A0A', text2: '4D4D4D', text3: '8A8A8A', border: 'EBEBEB', borderStrong: 'D6D6D6', sunk: 'F7F7F7',
    tiers: { excellent: '000000', verygood: '2E2E2E', good: '5C5C5C', acceptable: '858585', improve: 'A3A3A3', pending: 'ABABAB' },
  },
  dark: {
    page: '0A0A0A', text: 'FAFAFA', text2: 'A1A1A1', text3: '666666', border: '1F1F1F', borderStrong: '333333', sunk: '121212',
    tiers: { excellent: 'FFFFFF', verygood: 'D4D4D4', good: 'A3A3A3', acceptable: '7A7A7A', improve: '5E5E5E', pending: '555555' },
  },
};

/* ------------------------------------------------------------------ xlsx */

function buildXlsx(ds) {
  const c = PALETTE[ds.opts.theme];
  const s = ds.settings;
  const tz = ds.opts.tz;
  const SANS = 'Geist';
  const MONO = 'Geist Mono';

  const base = { fill: c.page, font: { color: c.text } };
  const st = (extra = {}) => ({
    fill: c.page,
    ...extra,
    font: { color: c.text, ...extra.font },
  });
  const hair = { bottom: { color: c.border } };
  const cell = (v, style, link) => ({ v, style, link });
  const blank = (style) => ({ v: '', style });

  const kicker = st({ font: { name: MONO, size: 8, color: c.text3 } });
  const head = st({ font: { name: MONO, size: 8, color: c.text3 }, border: { bottom: { color: c.borderStrong } }, align: { v: 'bottom' } });
  const body = st({ border: hair, align: { v: 'top', wrap: true } });
  const bodyMuted = st({ font: { color: c.text2 }, border: hair, align: { v: 'top', wrap: true } });
  const bodyMono = st({ font: { name: MONO, size: 9, color: c.text3 }, border: hair, align: { v: 'top' } });
  const bodyStrong = st({ font: { bold: true }, border: hair, align: { v: 'top', wrap: true } });
  const bodyLink = st({ font: { color: c.text2, underline: true }, border: hair, align: { v: 'top' } });
  const scoreStyle = (p) => st({
    font: { name: MONO, bold: isGraded(p), color: isGraded(p) ? c.text : c.text3 },
    border: hair, align: { v: 'top', h: 'right' }, numFmt: '0.0',
  });
  // Tier cells echo the dashboard's badges: Excellent is inverted, Pending is muted.
  const tierStyle = (key, border = hair) => (key === 'excellent'
    ? { fill: c.tiers.excellent, font: { bold: true, color: c.page }, border, align: { v: 'top', h: 'center' } }
    : st({
      font: { bold: key === 'verygood', italic: key === 'pending', color: c.tiers[key] },
      border, align: { v: 'top', h: 'center' },
    }));

  /* Overview */
  const meta = [s.program, s.semester, s.batch && `Batch ${s.batch}`].filter(Boolean).join('  ·  ');
  const stat = (label) => cell(label.toUpperCase(), kicker);
  const big = (v, fmt) => cell(v, st({ font: { size: 26, color: c.text }, numFmt: fmt, align: { h: 'left', v: 'bottom' } }));
  const sub = (v) => cell(v, st({ font: { size: 9, color: c.text3 }, align: { v: 'top' } }));
  const st0 = ds.stats;
  const avgTier = tierInfo(st0.avg);
  const overview = [
    { height: 12, cells: [] },
    { height: 34, cells: [null, cell(s.courseName, st({ font: { size: 22, bold: true }, align: { v: 'bottom' } }))] },
    { cells: [null, cell('SHOWCASE  ·  EVALUATION REPORT', kicker)] },
    { height: 22, cells: [null, cell(meta, st({ font: { color: c.text2 } }))] },
    { cells: [null, cell(`Generated ${fmtDate(ds.now, tz)}${ds.filtered ? `  ·  Filtered: ${ds.scopeLabel}` : ''}`, st({ font: { size: 9, color: c.text3 } }))] },
    { height: 14, cells: [] },
    { height: 20, cells: [null, stat('Teams'), stat('Students'), stat('Graded'), stat('Class average')] },
    { height: 36, cells: [null, big(st0.teams), big(st0.students), big(st0.graded), big(st0.avg ?? '—', '0.0')] },
    {
      cells: [null,
        sub(`${st0.avgTeam.toFixed(1)} members per team`),
        sub(`of ${s.capacity} seats`),
        sub(`${st0.teams ? Math.round((st0.graded / st0.teams) * 100) : 0}% evaluated · ${st0.pending} pending`),
        sub(st0.avg === null ? 'no scores yet' : `${avgTier.label} tier`)],
    },
    { height: 22, cells: [] },
    { cells: [null, cell('DISTRIBUTION', kicker)] },
    { height: 22, cells: [null, ...['Tier', 'Range', 'Teams', 'Share'].map((h) => cell(h.toUpperCase(), head)), cell('', head)] },
  ];
  const maxCount = Math.max(1, ...ds.distribution.map((t) => t.count));
  for (const t of ds.distribution) {
    overview.push({
      height: 22,
      cells: [null,
        cell(t.label, tierStyle(t.key)),
        cell(t.range, st({ font: { name: MONO, size: 9, color: c.text3 }, border: hair, align: { v: 'top' } })),
        cell(t.count, st({ font: { name: MONO }, border: hair, align: { v: 'top', h: 'left' } })),
        cell(st0.teams ? t.count / st0.teams : 0, st({ font: { name: MONO, color: c.text2 }, border: hair, align: { v: 'top', h: 'left' }, numFmt: '0%' })),
        cell('█'.repeat(Math.round((t.count / maxCount) * 24)), st({ font: { name: MONO, size: 9, color: c.tiers[t.key] }, border: hair, align: { v: 'top' } })),
      ],
    });
  }
  if (!s.resultsPublished) {
    overview.push({ height: 14, cells: [] }, { cells: [null, cell('Results are not yet published to students.', st({ font: { italic: true, size: 9, color: c.text3 } }))] });
  }

  /* Submissions */
  const cols = [
    ['#', 6], ['Team', 22], ['Members', 30], ['Size', 7], ['Type', 12], ['Project', 26], ['Tech stack', 26],
    ['Live site / Drive folder', 34], ['Repository', 34], ['Score', 8], ['Evaluation', 18], ['Rank', 7],
    ['Status', 12], ['Reviewer notes', 48], ['Submitted', 18], ['Updated', 18],
  ];
  const dateStyle = st({ font: { name: MONO, size: 9, color: c.text3 }, border: hair, align: { v: 'top', h: 'left' }, numFmt: 'd mmm yyyy, hh:mm' });
  const subRows = [{ height: 26, cells: cols.map(([h]) => cell(h.toUpperCase(), head)) }];
  for (const p of ds.rows) {
    const link = p.type === 'app' ? p.demoUrl : p.vercelUrl;
    const status = isGraded(p) ? 'Graded' : p.gradeLater ? `Grade later${p.draftScore != null ? ` · ${p.draftScore.toFixed(1)}` : ''}` : 'Pending';
    subRows.push({
      cells: [
        cell(p.seq, st({ font: { name: MONO, size: 9, color: c.text3 }, border: hair, align: { v: 'top', h: 'left' } })),
        cell(p.teamName, bodyStrong),
        cell(p.members.join(', '), bodyMuted),
        cell(p.members.length, st({ font: { name: MONO, color: c.text2 }, border: hair, align: { v: 'top', h: 'left' } })),
        cell(p.type === 'app' ? 'App' : 'Web', bodyMono),
        cell(p.title, body),
        cell(p.techStack || '', bodyMuted),
        link ? cell(link, bodyLink, link) : blank(body),
        p.githubUrl ? cell(p.githubUrl, bodyLink, p.githubUrl) : blank(body),
        isGraded(p) ? cell(p.score, scoreStyle(p)) : cell('—', scoreStyle(p)),
        cell(p.tier.label, tierStyle(p.tier.key)),
        p.rank ? cell(p.rank, st({ font: { name: MONO }, border: hair, align: { v: 'top', h: 'left' } })) : blank(body),
        cell(status, bodyMuted),
        cell(p.reviewerNotes || '', bodyMuted),
        cell(excelDate(p.createdAt, tz), dateStyle),
        cell(excelDate(p.updatedAt, tz), dateStyle),
      ],
    });
  }

  /* Leaderboard */
  const lbCols = [['Rank', 8], ['Team', 24], ['Project', 30], ['Members', 40], ['Score', 9], ['Evaluation', 18]];
  const lbRows = [{ height: 26, cells: lbCols.map(([h]) => cell(h.toUpperCase(), head)) }];
  for (const p of ds.ranked) {
    const top = p.rank <= 3;
    lbRows.push({
      height: top ? 24 : undefined,
      cells: [
        cell(p.rank, st({ font: { name: MONO, bold: top, size: top ? 12 : 10, color: top ? c.text : c.text3 }, border: hair, align: { v: 'top', h: 'left' } })),
        cell(p.teamName, bodyStrong),
        cell(p.title, body),
        cell(p.members.join(', '), bodyMuted),
        cell(p.score, scoreStyle(p)),
        cell(p.tier.label, tierStyle(p.tier.key)),
      ],
    });
  }

  const lastCol = (n) => String.fromCharCode(64 + n);
  return writeXlsx({
    font: { name: SANS, size: 10, color: c.text },
    sheets: [
      {
        name: 'Overview', base, tabColor: c.text,
        cols: [{ width: 3 }, { width: 24 }, { width: 22 }, { width: 22 }, { width: 22 }, { width: 30 }],
        rows: overview,
      },
      {
        name: 'Submissions', base, tabColor: c.text, landscape: true, freezeRows: 1, printTitleRows: 1,
        autoFilter: subRows.length > 1 ? `A1:${lastCol(cols.length)}${subRows.length}` : null,
        cols: cols.map(([, width]) => ({ width })),
        rows: subRows,
      },
      {
        name: 'Leaderboard', base, tabColor: c.text, freezeRows: 1, printTitleRows: 1,
        cols: lbCols.map(([, width]) => ({ width })),
        rows: lbRows,
      },
    ],
  });
}

/* ---------------------------------------------------------------- report */

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

const fmtScore = (score) => (isGraded({ score }) ? Number(score).toFixed(1) : '—');

function hue(name) {
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

const TITLE = /^(mr|mrs|ms|miss|mx|dr|shri|sri|smt|kumari)\.?$/i;
function initials(name) {
  const parts = name.trim().split(/\s+/);
  while (parts.length > 1 && TITLE.test(parts[0])) parts.shift();
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : parts[0]?.[1] || '')).toUpperCase();
}

function prettyUrl(url) {
  try {
    const u = new URL(url);
    return (u.host + u.pathname).replace(/\/$/, '');
  } catch {
    return url;
  }
}

const icon = (name) => `<svg class="i"><use href="#i-${name}"/></svg>`;
const avatar = (name) => {
  const h = hue(name);
  return `<span class="avatar" style="background:linear-gradient(145deg,hsl(0 0% ${(24 + h * 0.06).toFixed(1)}%),hsl(0 0% ${(8 + h * 0.03).toFixed(1)}%))">${esc(initials(name))}</span>`;
};
const badge = (p) => `<span class="badge tier-${p.tier.key}">${esc(p.tier.label)}</span>`;

function ring(score, size, stroke) {
  const t = tierInfo(score);
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - (isGraded({ score }) ? score / 10 : 0));
  const mid = size / 2;
  return `<span class="ring tier-${t.key}" style="width:${size}px;height:${size}px">`
    + `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle class="track" cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke-width="${stroke}"/>`
    + `<circle class="fill" cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke-width="${stroke}" stroke-dasharray="${circ.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"/></svg>`
    + `<span style="font-size:${Math.round(size * 0.27)}px">${fmtScore(score)}</span></span>`;
}

const SPRITE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<symbol id="i-deploy" viewBox="0 0 24 24"><path d="M12 3.5 21.5 20h-19z" fill="currentColor" stroke="none"/></symbol>
<symbol id="i-folder" viewBox="0 0 24 24"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.2h7.4A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/></symbol>
<symbol id="i-github" viewBox="0 0 24 24"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></symbol>
<symbol id="i-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9M12 3c-2.5 2.7-3.8 5.7-3.8 9s1.3 6.3 3.8 9"/></symbol>
<symbol id="i-video" viewBox="0 0 24 24"><rect x="2" y="5" width="14" height="14" rx="2.5"/><path d="m16 10.5 6-3.5v10l-6-3.5"/></symbol>
<symbol id="i-message" viewBox="0 0 24 24"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5h-3L12 20l-2.5-3h-3A2.5 2.5 0 0 1 4 14.5z"/></symbol>
<symbol id="i-layers" viewBox="0 0 24 24"><path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/></symbol>
<symbol id="i-check" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></symbol>
<symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></symbol>
<symbol id="i-star" viewBox="0 0 24 24"><path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.2-6.2 3.2 1.2-6.8-5-4.9 6.9-1z"/></symbol>
<symbol id="i-calendar" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></symbol>
<symbol id="i-users" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></symbol>
<symbol id="i-filter" viewBox="0 0 24 24"><path d="M3 5h18l-7 8v6l-4 2v-8z"/></symbol>
<symbol id="i-eye-off" viewBox="0 0 24 24"><path d="M9.9 4.2A10.9 10.9 0 0 1 12 4c6.5 0 10 8 10 8a18.5 18.5 0 0 1-2.2 3.2M6.6 6.6A18.3 18.3 0 0 0 2 12s3.5 8 10 8a9.7 9.7 0 0 0 5.4-1.6"/><path d="m2 2 20 20"/><path d="M14.1 14.1a3 3 0 1 1-4.2-4.2"/></symbol>
</defs></svg>`;

// Tokens and components adapted from public/styles.css.
const REPORT_CSS = `
:root, [data-theme='light'] {
  color-scheme: light;
  --bg: #fafafa; --surface-solid: #ffffff; --surface-sunk: rgba(0,0,0,.028); --border: rgba(0,0,0,.08); --border-strong: rgba(0,0,0,.16);
  --text: #0a0a0a; --text-2: #4d4d4d; --text-3: #8a8a8a; --grid-line: rgba(0,0,0,.05);
  --shadow: 0 0 0 1px rgba(0,0,0,.02), 0 1px 1px rgba(0,0,0,.03), 0 4px 8px -4px rgba(0,0,0,.04), 0 16px 32px -16px rgba(0,0,0,.1);
  --t-excellent: #000000; --t-verygood: #2e2e2e; --t-good: #5c5c5c; --t-acceptable: #858585; --t-improve: #a3a3a3; --t-pending: #ababab;
}
[data-theme='dark'] {
  color-scheme: dark;
  --bg: #000000; --surface-solid: #0a0a0a; --surface-sunk: rgba(255,255,255,.035); --border: rgba(255,255,255,.09); --border-strong: rgba(255,255,255,.17);
  --text: #fafafa; --text-2: #a1a1a1; --text-3: #666666; --grid-line: rgba(255,255,255,.045);
  --shadow: 0 1px 0 rgba(255,255,255,.05) inset, 0 12px 32px -14px rgba(0,0,0,.9);
  --t-excellent: #ffffff; --t-verygood: #d4d4d4; --t-good: #a3a3a3; --t-acceptable: #7a7a7a; --t-improve: #5e5e5e; --t-pending: #555555;
}
@page { size: A4 landscape; margin: 0; }
*, *::before, *::after { box-sizing: border-box; }
html { background: var(--bg); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: 'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; font-size: 13px; line-height: 1.5; -webkit-font-smoothing: antialiased; font-feature-settings: 'ss01', 'cv11'; }
h1, h2, h3, p { margin: 0; }
h1, h2, h3 { letter-spacing: -0.02em; font-weight: 600; }
a { color: inherit; text-decoration: none; }
.mono, .seq { font-family: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace; font-feature-settings: 'zero'; }
.i { width: 14px; height: 14px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.grad-text { color: color-mix(in srgb, var(--text) 32%, var(--bg)); }
.kicker { display: inline-flex; align-items: center; gap: 8px; font-family: 'Geist Mono', monospace; font-size: 10.5px; font-weight: 500; letter-spacing: .12em; text-transform: uppercase; color: var(--text-3); }
.kicker::before { content: ''; width: 18px; height: 1px; background: currentColor; }

/* Page frame: repeating spacer rows give every printed page a top and bottom margin on the themed background. */
.sheet { width: 100%; border-collapse: collapse; table-layout: fixed; }
.sheet > thead > tr > td, .sheet > tfoot > tr > td, .sheet > tbody > tr > td { padding: 0; }
.page-space { height: 0; }
.report { position: relative; max-width: 1180px; margin: 0 auto; padding: 36px 32px 40px; }
.report::before { content: ''; position: absolute; inset: 0 0 auto; height: 420px; z-index: -1; background-image: linear-gradient(var(--grid-line) 1px, transparent 1px), linear-gradient(90deg, var(--grid-line) 1px, transparent 1px); background-size: 48px 48px; -webkit-mask-image: radial-gradient(ellipse 80% 70% at 50% 0%, #000 30%, transparent 75%); mask-image: radial-gradient(ellipse 80% 70% at 50% 0%, #000 30%, transparent 75%); }

.r-top { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding-bottom: 18px; border-bottom: 1px solid var(--border); }
.brand { display: flex; align-items: center; gap: 12px; }
.brand-mark { position: relative; display: grid; place-items: center; flex: none; width: 36px; height: 36px; border-radius: 11px; color: var(--bg); background: linear-gradient(155deg, color-mix(in srgb, var(--text) 72%, var(--bg)) 0%, var(--text) 55%); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--bg) 14%, transparent), 0 1px 2px rgba(0,0,0,.18); overflow: hidden; }
.brand-mark svg { width: 62%; height: 62%; fill: currentColor; }
.brand-mark.sm { width: 22px; height: 22px; border-radius: 7px; }
.brand-text { display: flex; flex-direction: column; gap: 6px; line-height: 1; }
.brand-text strong { font-size: 16px; font-weight: 600; letter-spacing: -0.045em; white-space: nowrap; }
.brand-text small { display: inline-flex; align-items: center; gap: 6px; font-family: 'Geist Mono', monospace; font-size: 9.5px; font-weight: 500; letter-spacing: .1em; text-transform: uppercase; color: var(--text-3); }
.brand-text small i { width: 3px; height: 3px; border-radius: 50%; background: currentColor; opacity: .6; }
.stamp { text-align: right; }
.stamp time { display: block; margin-top: 4px; font-size: 12.5px; color: var(--text-2); font-variant-numeric: tabular-nums; }

.hero { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 300px); align-items: end; gap: 40px; padding: 34px 0 26px; }
.hero-program { display: inline-flex; align-items: center; height: 32px; margin-bottom: 14px; padding: 0 14px; border-radius: 999px; background: linear-gradient(180deg, color-mix(in srgb, var(--text) 84%, var(--bg)), var(--text)); color: var(--bg); font-size: 13.5px; font-weight: 600; }
h1 { font-size: 58px; line-height: .94; letter-spacing: -0.058em; }
.hero-meta { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 16px; }
.meta-chip { display: inline-flex; align-items: center; gap: 7px; height: 27px; padding: 0 11px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface-solid); font-size: 12px; font-weight: 500; }
.meta-chip .i { width: 13px; height: 13px; color: var(--text-3); }
.lede { margin-top: 14px; max-width: 560px; font-size: 14.5px; color: var(--text-2); }

.cohort { position: relative; padding: 20px; border-radius: 20px; color: var(--bg); background: var(--text); overflow: hidden; --ink-2: color-mix(in srgb, var(--bg) 62%, var(--text)); }
.cohort .kicker { color: var(--ink-2); }
.cohort-count { display: flex; align-items: baseline; gap: 8px; margin-top: 14px; }
.cohort-count strong { font-size: 46px; line-height: .9; font-weight: 500; letter-spacing: -0.05em; font-variant-numeric: tabular-nums; }
.cohort-count span { font-size: 13.5px; color: var(--ink-2); }
.seats-bar { height: 8px; margin-top: 18px; border-radius: 999px; background: color-mix(in srgb, var(--bg) 13%, transparent); overflow: hidden; }
.seats-bar span { display: block; height: 100%; border-radius: inherit; background: var(--bg); }
.cohort-foot { display: flex; justify-content: space-between; gap: 12px; margin-top: 14px; padding-top: 12px; border-top: 1px solid color-mix(in srgb, var(--bg) 14%, transparent); font-size: 12px; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.cohort-foot strong { color: var(--bg); font-weight: 500; }

.card { border: 1px solid var(--border); border-radius: 18px; background: var(--surface-solid); box-shadow: var(--shadow); }
.stats { display: grid; grid-template-columns: repeat(4, 1fr); overflow: hidden; break-inside: avoid; }
.stat { padding: 20px 22px 18px; min-width: 0; }
.stat + .stat { border-left: 1px solid var(--border); }
.stat-head { display: flex; align-items: center; justify-content: space-between; font-family: 'Geist Mono', monospace; font-size: 10.5px; font-weight: 500; letter-spacing: .1em; text-transform: uppercase; color: var(--text-3); }
.stat-value { margin-top: 14px; display: flex; align-items: baseline; gap: 6px; font-size: 36px; font-weight: 500; letter-spacing: -0.05em; line-height: .95; font-variant-numeric: tabular-nums; }
.stat-value small { font-size: 14px; color: var(--text-3); font-weight: 400; letter-spacing: -0.01em; }
.stat-sub { margin-top: 8px; font-size: 12px; color: var(--text-3); }
.stat-sub strong { color: var(--text-2); font-weight: 500; }
.stat-tier { display: inline-flex; align-items: center; gap: 6px; color: var(--tier); font-weight: 500; }
.stat-tier::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }

.tier-excellent { --tier: var(--t-excellent); } .tier-verygood { --tier: var(--t-verygood); } .tier-good { --tier: var(--t-good); }
.tier-acceptable { --tier: var(--t-acceptable); } .tier-improve { --tier: var(--t-improve); } .tier-pending { --tier: var(--t-pending); }
.badge { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 9px; border-radius: 999px; font-size: 11.5px; font-weight: 500; white-space: nowrap; color: var(--tier); background: color-mix(in srgb, var(--tier) 12%, transparent); border: 1px solid color-mix(in srgb, var(--tier) 28%, transparent); }
.badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.badge.tier-excellent { color: var(--bg); background: var(--text); border-color: var(--text); }
.badge.tier-verygood { color: var(--text); background: transparent; border-color: color-mix(in srgb, var(--text) 75%, transparent); }
.badge.tier-improve { border-style: dashed; border-color: var(--border-strong); }
.badge.tier-pending { border-style: dotted; border-color: var(--border-strong); background: transparent; }
.ring { position: relative; display: inline-grid; place-items: center; flex: none; }
.ring svg { display: block; transform: rotate(-90deg); }
.ring .track { stroke: var(--border); }
.ring .fill { stroke: var(--tier); stroke-linecap: round; }
.ring > span { position: absolute; font-family: 'Geist Mono', monospace; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }

.section-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin: 34px 0 14px; break-after: avoid; }
.section-head h2 { margin-top: 8px; font-size: 24px; letter-spacing: -0.04em; line-height: 1; }
.section-meta { font-size: 12.5px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.section-meta strong { color: var(--text); font-weight: 500; }

.dist { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr); gap: 28px; align-items: center; padding: 20px 22px; break-inside: avoid; }
.dist-bar { display: flex; gap: 3px; height: 14px; }
.dist-bar i { display: block; height: 100%; border-radius: 4px; background: var(--tier); }
.dist-bar i.tier-pending { background: transparent; border: 1px dashed var(--border-strong); }
.dist-bar.empty { border-radius: 4px; background: var(--surface-sunk); border: 1px solid var(--border); }
.dist-caption { margin-top: 10px; font-size: 12px; color: var(--text-3); }
.legend { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px 18px; }
.legend div { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 2px 8px; }
.legend .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--tier); }
.legend .tier-pending .dot { background: transparent; border: 1.5px dotted var(--t-pending); }
.legend strong { font-size: 12.5px; font-weight: 500; white-space: nowrap; }
.legend .count { font-family: 'Geist Mono', monospace; font-size: 12.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
.legend small { grid-column: 2 / 4; font-family: 'Geist Mono', monospace; font-size: 10.5px; color: var(--text-3); }

.podium { display: grid; grid-template-columns: 1fr 1.12fr 1fr; align-items: end; gap: 14px; break-inside: avoid; }
.podium-card { position: relative; padding: 20px 16px 18px; text-align: center; overflow: hidden; }
.podium-card::before { content: ''; position: absolute; inset: 0; background: radial-gradient(100% 70% at 50% 0%, color-mix(in srgb, var(--medal) 14%, transparent), transparent 70%); }
.podium-card > * { position: relative; }
.podium-card.place-1 { --medal: var(--text); padding-top: 28px; padding-bottom: 24px; border-color: color-mix(in srgb, var(--text) 40%, var(--border)); }
.podium-card.place-2 { --medal: color-mix(in srgb, var(--text) 55%, transparent); }
.podium-card.place-3 { --medal: color-mix(in srgb, var(--text) 35%, transparent); }
.medal { display: block; font-size: 30px; line-height: 1; filter: grayscale(1) contrast(1.15); }
.place-1 .medal { font-size: 40px; }
.place { margin-top: 8px; font-family: 'Geist Mono', monospace; font-size: 10.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--text-3); }
.podium-card h3 { margin-top: 4px; font-size: 16px; }
.podium-card p { margin-top: 1px; font-size: 12.5px; color: var(--text-2); }
.podium-card .ring { margin-top: 12px; }
.podium-card .badge { margin-top: 10px; }
.avatar-stack { display: flex; justify-content: center; margin-top: 12px; }
.avatar-stack .avatar { margin-left: -6px; box-shadow: 0 0 0 2px var(--surface-solid); }
.avatar-stack .avatar:first-child { margin-left: 0; }

.avatar { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; flex: none; font-size: 8.5px; font-weight: 600; letter-spacing: .02em; color: #fff; box-shadow: inset 0 0 0 1px rgba(255,255,255,.14); }
.table-card { overflow: hidden; overflow-x: auto; }
.data-table { width: 100%; border-collapse: collapse; }
.data-table th { padding: 12px 14px 10px; text-align: left; font-family: 'Geist Mono', monospace; font-size: 10px; font-weight: 500; letter-spacing: .1em; text-transform: uppercase; color: var(--text-3); border-bottom: 1px solid var(--border); white-space: nowrap; }
.data-table td { padding: 14px; vertical-align: top; }
.data-table > tbody { break-inside: avoid; }
.data-table > tbody + tbody > tr:first-child > td { border-top: 1px solid var(--border); }
.data-table .col-seq { width: 46px; padding-left: 20px; }
.seq { font-size: 12px; color: var(--text-3); }
.team-cell { width: 30%; }
.team-cell strong { display: block; font-size: 14px; font-weight: 600; letter-spacing: -0.015em; }
.team-cell time { display: block; margin-top: 1px; font-size: 11.5px; color: var(--text-3); }
.member-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.member-chip { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 9px 0 2px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface-sunk); font-size: 11.5px; color: var(--text-2); white-space: nowrap; }
.project-cell strong { font-weight: 500; }
.type-tag { display: inline-flex; align-items: center; gap: 4px; height: 19px; padding: 0 8px 0 6px; margin-left: 6px; border-radius: 999px; font-size: 10.5px; font-weight: 550; line-height: 1; white-space: nowrap; vertical-align: 1px; color: var(--text-2); background: var(--surface-solid); box-shadow: inset 0 0 0 1px var(--border); }
.type-tag .i { width: 10px; height: 10px; stroke-width: 2; color: var(--text-3); }
.type-tag.app { color: var(--bg); background: var(--text); box-shadow: inset 0 0 0 1px var(--text); }
.type-tag.app .i { color: color-mix(in srgb, var(--bg) 75%, var(--text)); }
.stack { display: block; margin-top: 3px; font-size: 12px; color: var(--text-3); }
.links { display: flex; flex-direction: column; align-items: flex-start; gap: 5px; }
.link-pill { display: inline-flex; align-items: center; gap: 7px; max-width: 220px; height: 26px; padding: 0 9px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-sunk); font-size: 11.5px; color: var(--text-2); white-space: nowrap; }
.link-pill span { overflow: hidden; text-overflow: ellipsis; }
.link-pill .i { width: 12px; height: 12px; }
.link-pill.deploy .i { color: var(--text); }
.not-provided { font-size: 12px; color: var(--text-3); font-style: italic; }
.eval { display: flex; align-items: center; gap: 10px; }
.eval-text { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
.eval-text .rank { font-family: 'Geist Mono', monospace; font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--text-3); }
.awaiting { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-3); white-space: nowrap; }
.awaiting::before { content: ''; width: 8px; height: 8px; border-radius: 50%; border: 1.5px dashed var(--text-3); }
.awaiting.later { color: var(--text-2); }
.awaiting.later::before { border-style: solid; border-color: var(--t-pending); }
.note-row td { padding-top: 0; }
.note { display: flex; gap: 9px; padding: 10px 12px; border-radius: 10px; background: var(--surface-sunk); border: 1px solid var(--border); font-size: 12.5px; color: var(--text-2); white-space: pre-wrap; }
.note .i { margin-top: 2px; color: var(--text-3); }
.empty { padding: 48px 24px; text-align: center; color: var(--text-2); }

.r-foot { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 30px; padding-top: 16px; border-top: 1px solid var(--border); font-size: 12px; color: var(--text-3); break-inside: avoid; }
.r-foot .brand { gap: 9px; }

@media print {
  .page-space { height: 11mm; }
  .report { max-width: none; padding: 0 13mm; }
  .report::before { display: none; }
  .card { box-shadow: none; }
  .table-card { overflow: hidden; }
}
@media screen and (max-width: 960px) {
  .report { padding: 24px 16px 32px; }
  .hero { grid-template-columns: 1fr; gap: 24px; }
  h1 { font-size: 42px; }
  .stats { grid-template-columns: 1fr 1fr; }
  .stat:nth-child(3) { border-left: 0; }
  .stat:nth-child(n + 3) { border-top: 1px solid var(--border); }
  .dist, .podium { grid-template-columns: 1fr; }
  .podium-card.place-1 { order: -1; }
  .legend { grid-template-columns: 1fr 1fr; }
  .table-card { overflow-x: auto; }
  .data-table { min-width: 760px; }
}
`;

const BRAND_MARK = '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M16 46V18h6l10 14 10-14h6v28h-7V30l-9 12-9-12v16z"/></svg>';

// Wordmark as in the top bar (last word muted), or a small mark beside a caption.
function brandHtml(name, caption = '') {
  const words = esc(name).split(' ');
  const last = words.length > 1 ? words.pop() : '';
  return caption
    ? `<div class="brand"><span class="brand-mark sm">${BRAND_MARK}</span><span>${caption}</span></div>`
    : `<div class="brand"><span class="brand-mark">${BRAND_MARK}</span><span class="brand-text"><strong>${words.join(' ')}`
      + `${last ? ` <span class="grad-text">${last}</span>` : ''}</strong><small>Showcase<i></i>Evaluation</small></span></div>`;
}

function linksHtml(p) {
  const out = [];
  if (p.type === 'app') {
    out.push(p.demoUrl
      ? `<a class="link-pill" href="${esc(p.demoUrl)}">${icon('folder')}<span>Drive folder</span></a>`
      : '<span class="not-provided">No Drive folder</span>');
  } else {
    out.push(p.vercelUrl
      ? `<a class="link-pill deploy" href="${esc(p.vercelUrl)}">${icon('deploy')}<span>${esc(prettyUrl(p.vercelUrl))}</span></a>`
      : '<span class="not-provided">No live site</span>');
  }
  if (p.githubUrl) {
    let repo = p.githubUrl;
    try { repo = new URL(p.githubUrl).pathname.replace(/^\/|\/$/g, '').replace(/\.git$/, '') || 'github.com'; } catch { /* keep url */ }
    out.push(`<a class="link-pill" href="${esc(p.githubUrl)}">${icon('github')}<span>${esc(repo)}</span></a>`);
  }
  return `<div class="links">${out.join('')}</div>`;
}

function evalHtml(p) {
  if (!isGraded(p)) {
    return p.gradeLater
      ? `<span class="awaiting later">Grade later${p.draftScore != null ? ` · draft ${fmtScore(p.draftScore)}` : ''}</span>`
      : '<span class="awaiting">Awaiting review</span>';
  }
  return `<div class="eval">${ring(p.score, 40, 3.5)}<div class="eval-text">${badge(p)}<span class="rank">Rank ${p.rank}</span></div></div>`;
}

function buildReport(ds) {
  const s = ds.settings;
  const tz = ds.opts.tz;
  const st = ds.stats;
  const generated = fmtDate(ds.now, tz);
  const avgTier = tierInfo(st.avg);

  const chips = [
    s.semester && `<span class="meta-chip">${icon('calendar')}${esc(s.semester)}</span>`,
    s.batch && `<span class="meta-chip">${icon('users')}Batch ${esc(s.batch)}</span>`,
    ds.filtered && `<span class="meta-chip">${icon('filter')}${esc(ds.scopeLabel)}</span>`,
    !s.resultsPublished && `<span class="meta-chip">${icon('eye-off')}Not yet published to students</span>`,
  ].filter(Boolean).join('');

  const stat = (label, ico, value, sub, cls = '') => `<article class="stat ${cls}"><div class="stat-head"><span>${label}</span>${icon(ico)}</div>`
    + `<div class="stat-value">${value}</div><div class="stat-sub">${sub}</div></article>`;
  const stats = `<section class="card stats">${[
    stat('Teams', 'layers', st.teams, `<strong>${st.avgTeam ? st.avgTeam.toFixed(1) : '0'}</strong> members per team`),
    stat('Graded', 'check', `${st.graded}<small>/ ${st.teams}</small>`, `${st.teams ? Math.round((st.graded / st.teams) * 100) : 0}% evaluated`),
    stat('Pending', 'clock', st.pending, st.pending ? 'awaiting faculty review' : 'all caught up'),
    stat('Class average', 'star', `${st.avg === null ? '—' : st.avg.toFixed(1)}<small>/ 10</small>`,
      st.avg === null ? 'no scores yet' : `<span class="stat-tier">${esc(avgTier.label)}</span>`, `tier-${avgTier.key}`),
  ].join('')}</section>`;

  const seatPct = s.capacity ? Math.min(100, Math.round((st.students / s.capacity) * 100)) : 0;
  const cohort = `<aside class="cohort"><span class="kicker">${ds.filtered ? 'In this export' : 'Cohort'}</span>`
    + `<div class="cohort-count"><strong>${st.students}</strong><span>/ ${s.capacity} students</span></div>`
    + `<div class="seats-bar"><span style="width:${seatPct}%"></span></div>`
    + `<div class="cohort-foot"><span><strong>${st.teams}</strong> teams</span><span><strong>${seatPct}%</strong> of seats</span></div></aside>`;

  const distBar = st.teams
    ? `<div class="dist-bar">${ds.distribution.filter((t) => t.count).map((t) => `<i class="tier-${t.key}" style="flex:${t.count}" title="${esc(t.label)}: ${t.count}"></i>`).join('')}</div>`
    : '<div class="dist-bar empty"></div>';
  const distribution = `<div class="section-head"><div><span class="kicker">Distribution</span><h2>Performance tiers</h2></div>`
    + `<p class="section-meta"><strong>${st.graded}</strong> of ${st.teams} scored</p></div>`
    + `<section class="card dist"><div>${distBar}<p class="dist-caption">Share of teams in each tier, highest first.</p></div>`
    + `<div class="legend">${ds.distribution.map((t) => `<div class="tier-${t.key}"><span class="dot"></span><strong>${esc(t.label)}</strong>`
      + `<span class="count">${t.count}</span><small>${esc(t.range)}</small></div>`).join('')}</div></section>`;

  const medals = { 1: '🥇', 2: '🥈', 3: '🥉' };
  const ordinal = { 1: '1st', 2: '2nd', 3: '3rd' };
  const top = ds.ranked.slice(0, 3);
  const podium = top.length
    ? `<div class="section-head"><div><span class="kicker">Leaderboard</span><h2>Top performers</h2></div></div><div class="podium">${
      [top[1], top[0], top[2]].filter(Boolean).map((p) => {
        const place = Math.min(p.rank, 3);
        return `<article class="card podium-card place-${place}"><span class="medal">${medals[place]}</span><div class="place">${ordinal[place]} place</div>`
          + `<h3>${esc(p.teamName)}</h3><p>${esc(p.title)}</p>${ring(p.score, place === 1 ? 76 : 64, place === 1 ? 5 : 4)}<div>${badge(p)}</div>`
          + `<div class="avatar-stack">${p.members.map(avatar).join('')}</div></article>`;
      }).join('')}</div>`
    : '';

  const body = ds.rows.length
    ? ds.rows.map((p) => `<tbody><tr>
        <td class="col-seq"><span class="seq">${String(p.seq).padStart(2, '0')}</span></td>
        <td class="team-cell"><strong>${esc(p.teamName)}</strong><time>Submitted ${esc(fmtDate(p.createdAt, tz))}</time>
          <div class="member-chips">${p.members.map((m) => `<span class="member-chip">${avatar(m)}${esc(m)}</span>`).join('')}</div></td>
        <td class="project-cell"><strong>${esc(p.title)}</strong>${p.type === 'app'
          ? `<span class="type-tag app">${icon('video')}App</span>` : `<span class="type-tag">${icon('globe')}Web</span>`}
          ${p.techStack ? `<span class="stack">${esc(p.techStack)}</span>` : ''}</td>
        <td>${linksHtml(p)}</td>
        <td>${evalHtml(p)}</td>
      </tr>${p.reviewerNotes ? `<tr class="note-row"><td></td><td colspan="4"><div class="note">${icon('message')}<span>${esc(p.reviewerNotes)}</span></div></td></tr>` : ''}</tbody>`).join('')
    : '<tbody><tr><td colspan="5" class="empty">No teams match this export.</td></tr></tbody>';

  const table = `<div class="section-head"><div><span class="kicker">Index</span><h2>Submissions</h2></div>`
    + `<p class="section-meta"><strong>${st.teams}</strong> team${st.teams === 1 ? '' : 's'} · submission order</p></div>`
    + `<section class="card table-card"><table class="data-table"><thead><tr><th class="col-seq">#</th><th>Team &amp; members</th><th>Project</th><th>Links</th><th>Evaluation</th></tr></thead>${body}</table></section>`;

  const title = `${s.courseName} · Evaluation report · ${dayStamp(ds.now, tz)}`;
  return `<!doctype html>
<html lang="en" data-theme="${ds.opts.theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@300..800&family=Geist+Mono:wght@400..600&display=swap" rel="stylesheet">
<style>${REPORT_CSS}</style>
</head>
<body>
${SPRITE}
<table class="sheet"><thead><tr><td><div class="page-space"></div></td></tr></thead><tfoot><tr><td><div class="page-space"></div></td></tr></tfoot><tbody><tr><td>
<main class="report">
  <header class="r-top">${brandHtml(s.courseName)}<div class="stamp"><span class="kicker">Evaluation report</span><time>${esc(generated)}</time></div></header>
  <section class="hero">
    <div>
      ${s.program ? `<span class="hero-program">${esc(s.program)}</span>` : ''}
      <h1>Evaluation <span class="grad-text">Report</span></h1>
      ${chips ? `<div class="hero-meta">${chips}</div>` : ''}
      <p class="lede">Scores, performance tiers and reviewer feedback for ${st.teams} team${st.teams === 1 ? '' : 's'}${ds.filtered ? ' matching the dashboard filter' : ''}.</p>
    </div>
    ${cohort}
  </section>
  ${stats}
  ${distribution}
  ${podium}
  ${table}
  <footer class="r-foot">${brandHtml(s.courseName, `${esc(s.courseName)} · Project Showcase &amp; Evaluation`)}<span>Faculty export · ${esc(generated)} · includes reviewer notes</span></footer>
</main>
</td></tr></tbody></table>
</body>
</html>
`;
}

/* ---------------------------------------------------------------- export */

function buildExport(format, projects, settings, params, now = new Date()) {
  const ds = buildDataset(projects, settings, exportOptions(params), now);
  switch (format) {
    case 'csv':
      return { body: buildCsv(ds), type: 'text/csv; charset=utf-8', filename: fileName(ds, 'grades', 'csv') };
    case 'json':
      return { body: buildJson(ds), type: 'application/json; charset=utf-8', filename: fileName(ds, 'backup', 'json') };
    case 'xlsx':
      return {
        body: buildXlsx(ds),
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        filename: fileName(ds, 'grades', 'xlsx'),
      };
    case 'html':
      return { body: buildReport(ds), type: 'text/html; charset=utf-8', filename: fileName(ds, 'report', 'html') };
    case 'print': // rendered by the dashboard and printed to PDF
      return { body: buildReport(ds), type: 'text/html; charset=utf-8', filename: null, pdfName: fileName(ds, 'report', 'pdf') };
    default:
      return null;
  }
}

module.exports = { EXPORT_FORMATS, buildExport, tierInfo, TYPE_LABELS };
