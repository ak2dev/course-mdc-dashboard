(() => {
  'use strict';

  /* ================================================================ setup */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const store = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } },
  };

  const TIERS = [
    { key: 'excellent', label: 'Excellent', chip: 'Excellent', emoji: '🌟', min: 9, range: '9.0 – 10.0', desc: 'Production-grade, polished UI, fully responsive, thorough documentation.' },
    { key: 'verygood', label: 'Very Good', chip: 'Very Good', emoji: '🚀', min: 7, range: '7.0 – 8.9', desc: 'All requirements met, functional deployment, clean Git history.' },
    { key: 'good', label: 'Good', chip: 'Good', emoji: '👍', min: 5, range: '5.0 – 6.9', desc: 'Core functionality complete, standard design, working repository.' },
    { key: 'acceptable', label: 'Acceptable', chip: 'Acceptable', emoji: '⚠️', min: 3, range: '3.0 – 4.9', desc: 'Functional, but with UI inconsistencies, responsiveness flaws or unhandled edge cases.' },
    { key: 'improve', label: 'Needs Improvement', chip: 'Improve', emoji: '🔄', min: -Infinity, range: '1.0 – 2.9', desc: 'Build or deployment issues, missing documentation, or incomplete criteria.' },
  ];
  const PENDING = { key: 'pending', label: 'Pending', chip: 'Pending', emoji: '⏳', range: 'Not scored', desc: 'Newly submitted project awaiting faculty review.' };
  const FILTERS = [{ key: 'all', chip: 'All' }, ...TIERS, PENDING];
  const DEVICES = { desktop: '100%', tablet: '768px', mobile: '390px' };

  const DEFAULT_SETTINGS = {
    courseName: 'Course MDC',
    submissionsOpen: true,
    deadline: null,
    capacity: 64,
    maxTeamSize: 8,
    resultsPublished: true,
    announcement: '',
    program: 'B.Tech CSE · Cyber Security',
    semester: '3rd Semester',
    batch: '2025–2029',
  };

  const state = {
    projects: [],
    settings: { ...DEFAULT_SETTINGS },
    capacity: 64,
    token: null, // kept in memory only
    loaded: false,
    view: ['table', 'grid', 'leaderboard'].includes(store.get('mdc-view')) ? store.get('mdc-view') : 'table',
    filter: 'all',
    query: '',
    device: DEVICES[store.get('mdc-device')] ? store.get('mdc-device') : 'desktop',
    previewId: null,
    editingId: null,
    confirmHandler: null,
    controlTab: 'overview',
    security: null,
    afterLogin: null,
    lastPayload: '',
  };

  const el = {
    view: $('#view'),
    stats: $('#stats'),
    chips: $('#chips'),
    search: $('#search'),
    facultyBtn: $('#facultyBtn'),
    submitDialog: $('#submitDialog'),
    submitForm: $('#submitForm'),
    submitSave: $('#submitSave'),
    loginDialog: $('#loginDialog'),
    loginForm: $('#loginForm'),
    loginSave: $('#loginSave'),
    password: $('#fPassword'),
    previewDialog: $('#previewDialog'),
    frame: $('#previewFrame'),
    frameLoading: $('#frameLoading'),
    frameBlocked: $('#frameBlocked'),
    device: $('#device'),
    rubricDialog: $('#rubricDialog'),
    confirmDialog: $('#confirmDialog'),
    controlDialog: $('#controlDialog'),
    controlForm: $('#controlForm'),
    controlSave: $('#controlSave'),
    toasts: $('#toasts'),
  };

  /* ============================================================== helpers */

  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const icon = (name, cls = '') => `<svg class="i ${cls}"><use href="#i-${name}"/></svg>`;

  function tierOf(score) {
    if (score === null || score === undefined) return PENDING;
    return TIERS.find((t) => score >= t.min);
  }

  function hue(name) {
    let h = 0;
    for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  }

  // Leading titles are skipped, so "MR. HAR PREET GILL" → "HG", not "MG".
  const TITLE = /^(mr|mrs|ms|miss|mx|dr|shri|sri|smt|kumari)\.?$/i;
  function initials(name) {
    const parts = name.trim().split(/\s+/);
    while (parts.length > 1 && TITLE.test(parts[0])) parts.shift();
    return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : parts[0]?.[1] || '')).toUpperCase();
  }

  const avatar = (name) => `<span class="avatar" style="--h:${hue(name)}" aria-hidden="true">${esc(initials(name))}</span>`;
  const fmtScore = (s) => (s === null || s === undefined ? '—' : Number(s).toFixed(1));
  const seqLabel = (n) => String(n).padStart(2, '0');

  function prettyUrl(url) {
    try {
      const u = new URL(url);
      return (u.host + u.pathname).replace(/\/$/, '');
    } catch {
      return url;
    }
  }

  function repoPath(url) {
    try {
      return new URL(url).pathname.replace(/^\/|\/$/g, '').replace(/\.git$/, '') || 'github.com';
    } catch {
      return url;
    }
  }

  function relTime(iso) {
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  const absTime = (iso) =>
    new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  function badge(score) {
    const t = tierOf(score);
    return `<span class="badge tier-${t.key}">${esc(t.label)}</span>`;
  }

  function ring(score, size = 46, stroke = 4) {
    const t = tierOf(score);
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const offset = c * (1 - (score === null || score === undefined ? 0 : score / 10));
    const mid = size / 2;
    return `<span class="ring tier-${t.key}" style="width:${size}px;height:${size}px">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
        <circle class="track" cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke-width="${stroke}"/>
        <circle class="fill" cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke-width="${stroke}"
          stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"/>
      </svg>
      <span style="font-size:${Math.round(size * 0.27)}px">${fmtScore(score)}</span>
    </span>`;
  }

  function withScheme(value) {
    const s = value.trim();
    if (!s) return '';
    return /^https?:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, '')}`;
  }

  function validUrl(value, { github = false } = {}) {
    try {
      const u = new URL(value);
      if (!['http:', 'https:'].includes(u.protocol) || !u.hostname.includes('.')) return false;
      return github ? /(^|\.)github\.com$/i.test(u.hostname) : true;
    } catch {
      return false;
    }
  }

  // Web projects showcase a live deployment; desktop / mobile apps a Drive demo video.
  const isApp = (p) => p?.type === 'app';
  const linkOf = (p) => (isApp(p) ? p.demoUrl : p.vercelUrl) || '';
  const isDriveUrl = (value) => {
    try { return /^(drive|docs)\.google\.com$/i.test(new URL(value).hostname); } catch { return false; }
  };

  // File ID from /file/d/<id>/… or ?id=<id> links; folders and other links return null.
  function driveFileId(value) {
    try {
      const u = new URL(value);
      if (!isDriveUrl(value)) return null;
      const id = u.pathname.match(/\/file\/d\/([\w-]{10,})/)?.[1] || u.searchParams.get('id');
      return id && /^[\w-]{10,}$/.test(id) ? id : null;
    } catch {
      return null;
    }
  }

  const typeTag = (p) => isApp(p)
    ? `<span class="type-tag app" title="Desktop / mobile app · demo video">${icon('video')}App</span>`
    : `<span class="type-tag" title="Web project · live deployment">${icon('globe')}Web</span>`;

  const find = (id) => state.projects.find((p) => p.id === id);
  const isTeacher = () => Boolean(state.token);

  function setBusy(btn, busy, label) {
    const lbl = $('.btn-label', btn);
    if (busy) {
      btn.dataset.idle = lbl.textContent;
      lbl.textContent = label;
    } else if (btn.dataset.idle) {
      lbl.textContent = btn.dataset.idle;
    }
    btn.disabled = busy;
    btn.classList.toggle('is-loading', busy);
  }

  /* ================================================================ toast */

  function toast(title, message = '', type = 'info', duration) {
    const ms = duration ?? (type === 'error' ? 7000 : 3800);
    const node = document.createElement('div');
    node.className = `toast ${type}`;
    node.setAttribute('role', type === 'error' ? 'alert' : 'status');
    const ico = { success: 'check', error: 'alert', info: 'info' }[type] || 'info';
    node.innerHTML = `
      <span class="t-icon">${icon(ico)}</span>
      <div class="t-body"><strong>${esc(title)}</strong>${message ? `<p>${esc(message)}</p>` : ''}</div>
      <button class="t-close" type="button" aria-label="Dismiss">${icon('x')}</button>
      <span class="t-progress" style="animation-duration:${ms}ms"></span>`;
    el.toasts.appendChild(node);

    let remaining = ms;
    let started = Date.now();
    let timer;
    const dismiss = () => {
      clearTimeout(timer);
      node.classList.add('leaving');
      node.addEventListener('animationend', () => node.remove(), { once: true });
    };
    const arm = () => { started = Date.now(); timer = setTimeout(dismiss, remaining); };
    node.addEventListener('mouseenter', () => { clearTimeout(timer); remaining -= Date.now() - started; });
    node.addEventListener('mouseleave', arm);
    $('.t-close', node).addEventListener('click', dismiss);
    arm();

    while (el.toasts.children.length > 4) el.toasts.firstElementChild.remove();
  }

  /* ================================================================== api */

  async function api(path, { method = 'GET', body } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (state.token) headers['x-teacher-token'] = state.token;

    let res;
    try {
      res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new Error('Network error — is the dashboard server running?');
    }
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json().catch(() => null) : null;

    if (res.status === 401 && state.token) {
      setToken(null, { reload: false });
      toast('Faculty session expired', 'Please sign in again to continue.', 'error');
    }
    if (!res.ok) throw new Error(data?.error || `Request failed (${res.status}).`);
    return data;
  }

  async function loadProjects({ silent = false } = {}) {
    try {
      const data = await api('/api/projects');
      if (state.token && !data.teacher) {
        setToken(null, { reload: false });
        toast('Faculty session ended', 'The server was restarted. Sign in again to grade.', 'info');
      }
      const payload = JSON.stringify([data.projects, data.settings]);
      const changed = payload !== state.lastPayload || !state.loaded;
      state.lastPayload = payload;
      applySettings(data.settings);
      state.projects = data.projects.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      state.loaded = true;
      if (changed) render();
    } catch (err) {
      if (!silent) toast('Could not load projects', err.message, 'error');
      if (!state.loaded) {
        state.loaded = true;
        render();
      }
    }
  }

  /* ============================================================= settings */

  function applySettings(settings) {
    state.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    state.capacity = state.settings.capacity;
  }

  // Mirrors the server rule; the server stays authoritative.
  const isAccepting = (s = state.settings) =>
    Boolean(s.submissionsOpen) && (!s.deadline || Date.now() < Date.parse(s.deadline));

  const resultsHidden = () => !state.settings.resultsPublished && !isTeacher();
  const maxMembers = () => (isTeacher() ? 20 : state.settings.maxTeamSize);

  function fmtDeadline(iso) {
    return new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function countdown(iso) {
    const ms = Date.parse(iso) - Date.now();
    if (ms <= 0) return 'passed';
    const m = Math.floor(ms / 60000);
    const d = Math.floor(m / 1440);
    const h = Math.floor((m % 1440) / 60);
    if (d > 0) return `in ${d}d ${h}h`;
    if (h > 0) return `in ${h}h ${m % 60}m`;
    return m > 0 ? `in ${m}m` : 'in under a minute';
  }

  function submissionStatus(s = state.settings) {
    if (!s.submissionsOpen) return { open: false, label: 'Submissions closed', detail: '' };
    if (s.deadline && Date.now() >= Date.parse(s.deadline)) {
      return { open: false, label: 'Submissions closed', detail: `deadline passed ${fmtDeadline(s.deadline)}` };
    }
    if (s.deadline) return { open: true, label: 'Submissions open', detail: `closes ${fmtDeadline(s.deadline)} · ${countdown(s.deadline)}` };
    return { open: true, label: 'Submissions open', detail: '' };
  }

  // Course name, banner, status pills and submit button state.
  function renderChrome() {
    const s = state.settings;
    $('#brandName').textContent = s.courseName;
    $('#footerName').textContent = s.courseName;
    $('#footerMark').textContent = s.courseName;
    $('#lede').textContent = `Submissions, live device previews and tiered evaluations for the ${s.courseName} cohort.`;

    // Heading details: program above the title, semester / batch / course as chips below.
    $('#heroProgram').innerHTML = `${icon('shield')}<span>${esc(s.program)}</span>`;
    $('#heroProgram').hidden = !s.program;
    const chips = [
      s.semester && [icon('calendar'), s.semester],
      s.batch && [icon('users'), `Batch ${s.batch}`],
      s.courseName && [icon('book'), s.courseName],
    ].filter(Boolean);
    $('#heroMeta').innerHTML = chips.map(([ico, text]) => `<span class="meta-chip">${ico}${esc(text)}</span>`).join('');
    document.title = `${s.courseName} · Project Showcase`;

    $('#announce').hidden = !s.announcement;
    $('#announceText').textContent = s.announcement;

    const status = submissionStatus();
    const pills = [
      `<span class="eyebrow ${status.open ? '' : 'is-closed'}"><i class="pulse"></i><strong>${esc(status.label)}</strong>${
        status.detail ? `<span>· ${esc(status.detail)}</span>` : ''}</span>`,
    ];
    if (!s.resultsPublished) {
      pills.push(`<span class="eyebrow">${icon('eye-off')}${isTeacher() ? 'Results hidden from students' : 'Results not yet published'}</span>`);
    }
    $('#statusPills').innerHTML = pills.join('');

    const btn = $('#submitBtn');
    const locked = !status.open && !isTeacher();
    btn.classList.toggle('is-disabled', locked);
    btn.setAttribute('aria-disabled', String(locked));
    btn.innerHTML = locked
      ? `${icon('lock')}<span class="hide-sm">Submissions closed</span>`
      : `${icon('plus')}<span class="hide-sm">Submit project</span>${icon('chevron', 'chev')}`;
    if (locked) closeSubmitMenu();
  }

  /* =============================================================== derive */

  function sequence() {
    const map = new Map();
    state.projects.forEach((p, i) => map.set(p.id, i + 1));
    return map;
  }

  function computeStats() {
    const students = new Set();
    let memberTotal = 0;
    for (const p of state.projects) {
      memberTotal += p.members.length;
      for (const m of p.members) students.add(m.trim().toLowerCase().replace(/\s+/g, ' '));
    }
    const graded = state.projects.filter((p) => p.score !== null && p.score !== undefined);
    const avg = graded.length ? graded.reduce((s, p) => s + p.score, 0) / graded.length : null;
    return {
      teams: state.projects.length,
      students: students.size,
      graded: graded.length,
      pending: state.projects.length - graded.length,
      avg: avg === null ? null : Math.round(avg * 10) / 10,
      avgTeam: state.projects.length ? memberTotal / state.projects.length : 0,
    };
  }

  function matchesQuery(p) {
    const q = state.query.trim().toLowerCase();
    if (!q) return true;
    return [p.teamName, p.title, p.techStack, ...p.members].some((v) => (v || '').toLowerCase().includes(q));
  }

  const matchesFilter = (p) => state.filter === 'all' || tierOf(p.score).key === state.filter;
  const visibleProjects = () => state.projects.filter((p) => matchesFilter(p) && matchesQuery(p));

  function rankings() {
    const graded = state.projects
      .filter((p) => p.score !== null && p.score !== undefined)
      .sort((a, b) => b.score - a.score || a.createdAt.localeCompare(b.createdAt));
    const ranks = new Map();
    graded.forEach((p, i) => {
      const prev = graded[i - 1];
      ranks.set(p.id, prev && prev.score === p.score ? ranks.get(prev.id) : i + 1);
    });
    return { graded, ranks };
  }

  /* =============================================================== render */

  function render() {
    renderChrome();
    renderStats();
    renderChips();
    renderView();
  }

  // Numbers render as data-count targets; the first render animates them up from zero.
  const counter = (value, decimals = 0) =>
    `<span data-count="${value}" data-dec="${decimals}">${Number(value).toFixed(decimals)}</span>`;

  function countUp(root) {
    const start = performance.now();
    const nodes = $$('[data-count]', root);
    const ease = (t) => 1 - (1 - t) ** 3;
    const frame = (now) => {
      const t = Math.min(1, (now - start) / 900);
      for (const n of nodes) n.textContent = (Number(n.dataset.count) * ease(t)).toFixed(Number(n.dataset.dec));
      if (t < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  function renderCohort(s, intro) {
    const cap = state.capacity;
    const filled = Math.min(s.students, cap);
    const pct = Math.min(100, Math.round((s.students / cap) * 100));
    const cols = cap <= 16 ? cap : cap <= 64 ? 16 : 20;
    // A seat per student reads well up to ~160 seats; beyond that use a bar.
    // Final state is always rendered; the intro is a pure CSS animation, so it
    // never depends on animation frames (which pause in background tabs).
    const seats = cap <= 160
      ? `<div class="seats ${intro ? 'intro' : ''}" style="--cols:${cols}" role="img" aria-label="${filled} of ${cap} seats taken">${
          Array.from({ length: cap }, (_, i) => `<i class="${i < filled ? 'on' : ''}" style="--sd:${i * 14}ms"></i>`).join('')}</div>`
      : `<div class="seats-bar ${intro ? 'intro' : ''}"><span style="width:${pct}%"></span></div>`;

    $('#cohort').innerHTML = `
      <div class="cohort-top">
        <span class="kicker">Cohort</span>
        <span class="cohort-live"><i></i>Live</span>
      </div>
      <div class="cohort-count"><strong>${counter(s.students)}</strong><span>/ ${cap} students</span></div>
      ${seats}
      <div class="cohort-foot">
        <span><strong>${Math.max(0, cap - s.students)}</strong> seats remaining</span>
        <span><strong>${pct}%</strong> enrolled</span>
      </div>`;
  }

  function renderStats() {
    const s = computeStats();
    const intro = !state.introDone && state.loaded;
    const avgTier = tierOf(s.avg);
    const hidden = resultsHidden();
    const facultyNote = !state.settings.resultsPublished && isTeacher() ? ' · hidden from students' : '';
    const stat = (label, iconName, value, sub, cls = '') => `
      <article class="stat ${cls}">
        <div class="stat-head"><span>${label}</span><span class="stat-icon">${icon(iconName)}</span></div>
        <div class="stat-value">${value}</div>
        <div class="stat-sub">${sub}</div>
      </article>`;

    renderCohort(s, intro);
    el.stats.innerHTML = [
      stat('Teams', 'layers', counter(s.teams), `<strong>${s.avgTeam ? s.avgTeam.toFixed(1) : '0'}</strong> members per team`),
      hidden
        ? stat('Graded', 'check', '—', 'shown when results are published')
        : stat('Graded', 'check', `${counter(s.graded)}<small>/ ${s.teams}</small>`, `${s.teams ? Math.round((s.graded / s.teams) * 100) : 0}% evaluated`),
      hidden
        ? stat('Pending', 'clock', '—', 'evaluations in progress')
        : stat('Pending', 'clock', counter(s.pending), s.pending ? 'awaiting faculty review' : 'all caught up'),
      stat('Class average', hidden ? 'eye-off' : 'star',
        `${hidden || s.avg === null ? '—' : counter(s.avg, 1)}<small>/ 10</small>`,
        hidden ? 'not yet published'
          : s.avg === null ? `no scores yet${facultyNote}` : `<span class="stat-tier">${esc(avgTier.label)}</span>${esc(facultyNote)}`,
        `tier-${hidden ? 'pending' : avgTier.key}`),
    ].join('');

    if (intro) {
      state.introDone = true;
      countUp(document);
    }
  }

  function renderChips() {
    const counts = { all: state.projects.length };
    for (const p of state.projects) {
      const k = tierOf(p.score).key;
      counts[k] = (counts[k] || 0) + 1;
    }
    el.chips.innerHTML = FILTERS.map((f) => {
      const tierCls = f.key === 'all' ? '' : `tier-${f.key}`;
      const active = state.filter === f.key;
      return `<button type="button" role="tab" aria-selected="${active}" class="chip ${tierCls} ${active ? 'active' : ''}" data-filter="${f.key}">
        ${f.key === 'all' ? '' : '<span class="dot"></span>'}${esc(f.chip)}<span class="count">${counts[f.key] || 0}</span>
      </button>`;
    }).join('');
  }

  // When a filter is active, say so and offer a one-click way back to all teams.
  function renderSectionMeta() {
    const total = state.projects.length;
    const shown = visibleProjects().length;
    const query = state.query.trim();
    const parts = [];
    if (query) parts.push(`“${esc(query)}”`);
    if (state.filter !== 'all') parts.push(esc(FILTERS.find((f) => f.key === state.filter)?.chip || state.filter));
    $('#sectionMeta').innerHTML = !state.loaded ? ''
      : parts.length
        ? `<span class="filter-pill">${icon('filter')}<span>Filtered by ${parts.join(' + ')}</span>
             <button type="button" data-clear-filters aria-label="Clear filters" title="Show all teams">${icon('x')}</button></span>
           <span>Showing <strong>${shown}</strong> of ${total} team${total === 1 ? '' : 's'}</span>`
        : `<span><strong>${total}</strong> team${total === 1 ? '' : 's'} · <strong>${computeStats().students}</strong> students</span>`;
  }

  function renderView() {
    $$('#viewSwitch button').forEach((b) => {
      const on = b.dataset.view === state.view;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on);
    });
    renderSectionMeta();

    if (!state.loaded) {
      el.view.innerHTML = `<div class="card">${Array.from({ length: 6 }, () =>
        `<div class="skeleton-row">${'<div class="skeleton"></div>'.repeat(6)}</div>`).join('')}</div>`;
      return;
    }
    if (!state.projects.length) {
      el.view.innerHTML = emptyState('inbox', 'No submissions yet',
        'Be the first team to share your work. Your project will appear here instantly, marked as pending review.',
        `<button class="btn btn-primary" data-action="submit" type="button">${icon('plus')} Submit a project</button>`);
      return;
    }

    if (state.view === 'leaderboard') return renderLeaderboard();

    const list = visibleProjects();
    if (!list.length) {
      el.view.innerHTML = emptyState('filter', 'No matching projects',
        'Try a different search term or tier filter.',
        `<button class="btn btn-secondary" data-action="clear-filters" type="button">Clear filters</button>`);
      return;
    }
    if (state.view === 'grid') renderGrid(list);
    else renderTable(list);
  }

  function emptyState(ico, title, text, action = '') {
    return `<div class="card empty-state"><span class="empty-icon">${icon(ico)}</span><h3>${esc(title)}</h3><p>${esc(text)}</p>${action}</div>`;
  }

  function memberChips(members, limit = Infinity) {
    const shown = members.slice(0, limit);
    const rest = members.slice(limit);
    return `<div class="member-chips">${shown.map((m) =>
      `<button type="button" class="member-chip" data-action="member" data-member="${esc(m)}" title="Show ${esc(m)}'s projects">${avatar(m)}${esc(m.split(/\s+/)[0])}</button>`).join('')}
      ${rest.length ? `<span class="member-more" title="${esc(rest.join(', '))}">+${rest.length}</span>` : ''}</div>`;
  }

  function deployLink(p) {
    if (isApp(p)) {
      if (!p.demoUrl) return '<span class="not-provided">No demo video</span>';
      return `<div class="link-group">
        <a class="link-pill demo" href="${esc(p.demoUrl)}" target="_blank" rel="noopener noreferrer" title="${esc(p.demoUrl)}">${icon('play')}<span>Demo video</span></a>
        <button type="button" class="icon-btn sm" data-action="preview" data-id="${p.id}" title="Watch demo here" aria-label="Watch ${esc(p.teamName)} demo">${icon('eye')}</button>
      </div>`;
    }
    if (!p.vercelUrl) return '<span class="not-provided">Not submitted</span>';
    return `<div class="link-group">
      <a class="link-pill deploy" href="${esc(p.vercelUrl)}" target="_blank" rel="noopener noreferrer" title="${esc(p.vercelUrl)}">${icon('deploy')}<span>${esc(prettyUrl(p.vercelUrl))}</span></a>
      <button type="button" class="icon-btn sm" data-action="preview" data-id="${p.id}" title="Open device preview" aria-label="Preview ${esc(p.teamName)}">${icon('eye')}</button>
    </div>`;
  }

  function repoLink(p) {
    if (!p.githubUrl) return '<span class="not-provided">Not submitted</span>';
    return `<a class="link-pill" href="${esc(p.githubUrl)}" target="_blank" rel="noopener noreferrer" title="${esc(p.githubUrl)}">${icon('github')}<span>${esc(repoPath(p.githubUrl))}</span></a>`;
  }

  // Overlapping avatars (each one filters by that student) followed by first names.
  function people(members) {
    const first = (m) => m.split(/\s+/)[0];
    const shown = members.slice(0, 2).map(first).join(', ');
    const extra = members.length > 2 ? ` <em>+${members.length - 2}</em>` : '';
    return `<div class="people">
      <div class="avatar-stack">${members.slice(0, 3).map((m) =>
        `<button type="button" class="avatar-btn" data-action="member" data-member="${esc(m)}" title="${esc(m)} · show only this student’s team">${avatar(m)}</button>`).join('')}</div>
      <span class="people-names" title="${esc(members.join(', '))}">${esc(shown)}${extra}</span>
    </div>`;
  }

  // Students only receive notes once they're visible; faculty always have them.
  const notesVisibleToTeam = (p) => p.score !== null && p.score !== undefined && state.settings.resultsPublished;

  function notesButton(p) {
    if (!p.reviewerNotes) return '';
    const hiddenForTeam = isTeacher() && !notesVisibleToTeam(p);
    // Icon-only, so the label lives in the tooltip and the accessible name.
    const label = hiddenForTeam
      ? `Reviewer feedback for ${p.teamName} (not visible to students yet: needs a score and published results)`
      : `Read reviewer feedback for ${p.teamName}`;
    return `<button type="button" class="notes-icon ${hiddenForTeam ? 'is-hidden' : ''}" data-action="notes" data-id="${p.id}"
      title="${esc(hiddenForTeam ? 'Feedback · not visible to students yet' : 'Read feedback')}" aria-label="${esc(label)}">${icon('message')}</button>`;
  }

  function evalCell(p) {
    const inner = p.score === null
      ? '<span class="awaiting">Awaiting review</span>'
      : `${badge(p.score)}<span class="score">${fmtScore(p.score)}</span>`;
    const evaluation = isTeacher()
      ? `<button type="button" class="eval" data-action="grade" data-id="${p.id}" title="Grade in preview">${inner}</button>`
      : `<span class="eval">${inner}</span>`;
    return `<div class="eval-wrap">${evaluation}${notesButton(p)}</div>`;
  }

  function openNotes(p) {
    if (!p?.reviewerNotes) return;
    const t = tierOf(p.score);
    $('#notesTitle').textContent = p.teamName;
    $('#notesBody').innerHTML = `
      <div class="notes-head">
        ${ring(p.score, 52, 4)}
        <div class="sp-text"><strong>${esc(p.title)}</strong>${badge(p.score)}</div>
      </div>
      <p class="notes-text">${esc(p.reviewerNotes)}</p>
      ${isTeacher() && !notesVisibleToTeam(p) ? `<p class="hint">${icon('eye-off')} Students can't see this yet: it appears once the project has a score and results are published.</p>` : ''}
      ${p.gradedAt ? `<p class="notes-meta">Graded ${esc(absTime(p.gradedAt))}${t.key !== 'pending' ? ` · ${esc(t.range)}` : ''}</p>` : ''}`;
    $('#notesDialog').showModal();
  }

  function teacherActions(p) {
    return `<div class="row-actions">
      <button type="button" class="icon-btn sm" data-action="edit" data-id="${p.id}" title="Edit" aria-label="Edit ${esc(p.teamName)}">${icon('edit')}</button>
      <button type="button" class="icon-btn sm danger" data-action="delete" data-id="${p.id}" title="Delete" aria-label="Delete ${esc(p.teamName)}">${icon('trash')}</button>
    </div>`;
  }

  function renderTable(list) {
    const seq = sequence();
    el.view.innerHTML = `
      <div class="card table-card"><div class="table-scroll">
        <table class="data-table">
          <thead><tr>
            <th class="col-seq">#</th><th>Team</th><th>Members</th><th>Project</th>
            <th>Live site / Demo</th><th>Repository</th><th>Evaluation</th>
            <th class="col-actions teacher-only">Actions</th>
          </tr></thead>
          <tbody>${list.map((p, i) => `
            <tr style="animation-delay:${Math.min(i, 20) * 22}ms">
              <td><span class="seq">${seqLabel(seq.get(p.id))}</span></td>
              <td class="team-cell"><strong>${esc(p.teamName)}</strong><time datetime="${esc(p.createdAt)}" title="${esc(absTime(p.createdAt))}">Submitted ${relTime(p.createdAt)}</time></td>
              <td class="members-cell">${people(p.members)}</td>
              <td class="project-cell"><div class="title-row"><strong title="${esc(p.title)}">${esc(p.title)}</strong>${typeTag(p)}</div>${p.techStack ? `<span class="stack" title="${esc(p.techStack)}">${esc(p.techStack)}</span>` : ''}</td>
              <td>${deployLink(p)}</td>
              <td>${repoLink(p)}</td>
              <td>${evalCell(p)}</td>
              <td class="col-actions teacher-only">${teacherActions(p)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div></div>`;
  }

  function renderGrid(list) {
    const seq = sequence();
    el.view.innerHTML = `<div class="grid">${list.map((p, i) => {
      const t = tierOf(p.score);
      const techs = (p.techStack || '').split(/[,·|/]+/).map((s) => s.trim()).filter(Boolean).slice(0, 6);
      return `
        <article class="card p-card tier-${t.key}" style="animation-delay:${Math.min(i, 16) * 35}ms">
          <div class="p-card-top">
            <div>
              <span class="seq">#${seqLabel(seq.get(p.id))}</span>
              <h3>${esc(p.teamName)}</h3>
              <p class="p-title">${esc(p.title)}${typeTag(p)}</p>
            </div>
            ${ring(p.score, 56, 4)}
          </div>
          <div>${badge(p.score)}</div>
          ${p.reviewerNotes ? `<button type="button" class="p-notes ${isTeacher() && !notesVisibleToTeam(p) ? 'is-hidden' : ''}" data-action="notes" data-id="${p.id}" title="Read the full reviewer feedback">
            <span class="p-notes-label">${icon('message')} Reviewer feedback</span>
            <span class="p-notes-text">${esc(p.reviewerNotes)}</span>
          </button>` : ''}
          ${techs.length ? `<div class="tags-row">${techs.map((s) => `<span class="tech">${esc(s)}</span>`).join('')}</div>` : ''}
          <div class="p-card-members">
            <div class="label">${icon('users')} ${p.members.length} member${p.members.length === 1 ? '' : 's'}</div>
            ${memberChips(p.members)}
          </div>
          <div class="p-card-foot">
            <button type="button" class="btn btn-secondary btn-sm" data-action="preview" data-id="${p.id}" ${linkOf(p) ? '' : 'disabled'}>${icon(isApp(p) ? 'play' : 'eye')} ${isApp(p) ? 'Watch demo' : 'Preview'}</button>
            ${linkOf(p) ? `<a class="icon-btn sm" href="${esc(linkOf(p))}" target="_blank" rel="noopener noreferrer" title="${isApp(p) ? 'Open demo video in Google Drive' : 'Open live site'}">${icon('external')}</a>` : ''}
            ${p.githubUrl ? `<a class="icon-btn sm" href="${esc(p.githubUrl)}" target="_blank" rel="noopener noreferrer" title="Open repository">${icon('github')}</a>` : ''}
            <span class="spacer"></span>
            <span class="teacher-only">${teacherActions(p)}</span>
          </div>
        </article>`;
    }).join('')}</div>`;
  }

  function renderLeaderboard() {
    const { graded, ranks } = rankings();
    const showPodium = state.filter === 'all' && !state.query.trim();
    const list = graded.filter((p) => matchesFilter(p) && matchesQuery(p));
    const pendingCount = state.projects.filter((p) => p.score === null && matchesQuery(p)).length;
    const medals = { 1: '🥇', 2: '🥈', 3: '🥉' };
    const ordinal = { 1: '1st', 2: '2nd', 3: '3rd' };

    if (resultsHidden()) {
      el.view.innerHTML = emptyState('lock', 'Results haven’t been published yet',
        'Faculty will publish scores and rankings once evaluations are complete. Check back soon.');
      return;
    }
    if (state.filter === 'pending') {
      el.view.innerHTML = emptyState('clock', 'Pending projects aren’t ranked yet',
        `${pendingCount} project${pendingCount === 1 ? ' is' : 's are'} awaiting review. They join the leaderboard once scored.`,
        `<button class="btn btn-secondary" data-action="clear-filters" type="button">Show full leaderboard</button>`);
      return;
    }
    if (!graded.length) {
      el.view.innerHTML = emptyState('trophy', 'The leaderboard is warming up',
        'Rankings appear as soon as faculty publish the first scores.');
      return;
    }

    const podium = showPodium ? graded.slice(0, 3) : [];
    const podiumOrder = [podium[1], podium[0], podium[2]].filter(Boolean);
    const podiumHtml = podium.length ? `<div class="podium">${podiumOrder.map((p) => {
      const r = ranks.get(p.id);
      const place = Math.min(r, 3);
      return `<article class="card podium-card place-${place}">
        <span class="medal" aria-hidden="true">${medals[place]}</span>
        <div class="place">${ordinal[place]} place</div>
        <h3>${esc(p.teamName)}</h3>
        <p>${esc(p.title)}</p>
        ${ring(p.score, place === 1 ? 84 : 70, place === 1 ? 5 : 4)}
        <div>${badge(p.score)}</div>
        <div class="avatar-stack" title="${esc(p.members.join(', '))}">${p.members.map(avatar).join('')}</div>
      </article>`;
    }).join('')}</div>` : '';

    const rows = list.map((p, i) => {
      const r = ranks.get(p.id);
      const t = tierOf(p.score);
      return `<div class="rank-row" style="animation-delay:${Math.min(i, 20) * 25}ms">
        <div class="rank-num ${r <= 3 ? 'top' : ''}">${r <= 3 ? medals[r] : r}</div>
        <div class="rank-team"><strong>${esc(p.teamName)}</strong><span>${esc(p.title)}</span></div>
        <div class="rank-members">${memberChips(p.members, 2)}</div>
        <div class="rank-project">${badge(p.score)}</div>
        <div class="score-bar tier-${t.key}"><span class="bar"><i style="width:${p.score * 10}%"></i></span><span class="score">${fmtScore(p.score)}</span></div>
        <div class="rank-links">
          ${linkOf(p) ? `<button type="button" class="icon-btn sm" data-action="preview" data-id="${p.id}" title="${isApp(p) ? 'Watch demo' : 'Preview'}">${icon(isApp(p) ? 'play' : 'eye')}</button>` : ''}
          ${p.githubUrl ? `<a class="icon-btn sm" href="${esc(p.githubUrl)}" target="_blank" rel="noopener noreferrer" title="Repository">${icon('github')}</a>` : ''}
        </div>
      </div>`;
    }).join('');

    el.view.innerHTML = `${podiumHtml}
      ${list.length ? `<div class="card rank-list">
        <div class="rank-row rank-head"><div>Rank</div><div>Team</div><div class="rank-members">Members</div><div class="rank-project">Tier</div><div>Score</div><div></div></div>
        ${rows}
      </div>` : emptyState('filter', 'No ranked projects match', 'Try another search or tier filter.',
        `<button class="btn btn-secondary" data-action="clear-filters" type="button">Clear filters</button>`)}
      ${pendingCount ? `<div class="card awaiting">${icon('clock')}<span><strong>${pendingCount}</strong> project${pendingCount === 1 ? '' : 's'} awaiting review — they’ll be ranked once scored.</span></div>` : ''}`;
  }

  function renderRubric() {
    $('#rubricList').innerHTML = [...TIERS, PENDING].map((t) => `
      <li class="tier-${t.key}">
        <span class="r-emoji" aria-hidden="true">${t.emoji}</span>
        <div><h3>${esc(t.label)}</h3><p>${esc(t.desc)}</p></div>
        <span class="r-range">${esc(t.range)}</span>
      </li>`).join('') +
      '<p class="rubric-foot">Scores below 1.0 are also classified as Needs Improvement.</p>';
  }

  /* ========================================================= score editor */

  function scoreEditor(root) {
    const num = $('.score-number', root);
    const range = $('.score-range', root);
    const preview = $('.score-preview', root);

    function read() {
      const raw = num.value.trim();
      if (raw === '') return null;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 10) return undefined;
      return Math.round(n * 10) / 10;
    }

    function paint() {
      const v = read();
      const t = tierOf(v === undefined ? null : v);
      TIERS.concat(PENDING).forEach((x) => root.classList.remove(`tier-${x.key}`));
      root.classList.add(`tier-${t.key}`);
      range.style.setProperty('--pct', `${(v ?? 0) * 10}%`);
      preview.innerHTML = `${ring(v ?? null, 52, 4)}<div class="sp-text">${badge(v ?? null)}<small>${
        v === undefined ? 'Enter 0.0 – 10.0' : v === null ? 'Leave empty to keep pending' : `${t.range} band`}</small></div>`;
    }

    num.addEventListener('input', () => {
      const v = read();
      if (v !== undefined && v !== null) range.value = v;
      paint();
    });
    num.addEventListener('blur', () => {
      const v = read();
      if (v !== undefined && v !== null) num.value = v.toFixed(1);
    });
    range.addEventListener('input', () => {
      num.value = Number(range.value).toFixed(1);
      paint();
    });

    return {
      get: read,
      set(v) {
        num.value = v === null || v === undefined ? '' : Number(v).toFixed(1);
        range.value = v ?? 0;
        paint();
      },
      focus: () => num.focus(),
    };
  }

  /* ============================================================ tag input */

  function tagInput(root, onChange) {
    const input = $('input', root);
    const list = $('.tags', root);
    let tags = [];

    function paint() {
      list.innerHTML = tags.map((t, i) =>
        `<span class="tag">${avatar(t)}${esc(t)}<button type="button" data-remove="${i}" aria-label="Remove ${esc(t)}">${icon('x')}</button></span>`).join('');
      onChange(tags);
    }

    function add(raw) {
      raw.split(/[,\n]/).map((s) => s.trim().replace(/\s+/g, ' ').slice(0, 48)).filter(Boolean).forEach((name) => {
        if (!tags.some((t) => t.toLowerCase() === name.toLowerCase()) && tags.length < maxMembers()) tags.push(name);
      });
      paint();
    }

    function commit() {
      if (input.value.trim()) add(input.value);
      input.value = '';
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const max = maxMembers();
        if (tags.length >= max && input.value.trim()) {
          toast('Team is full', `A team can have at most ${max} member${max === 1 ? '' : 's'}.`, 'info');
        }
        commit();
      } else if (e.key === 'Backspace' && !input.value && tags.length) {
        tags.pop();
        paint();
      }
    });
    input.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text') || '';
      if (/[,\n]/.test(text)) {
        e.preventDefault();
        add(text);
      }
    });
    input.addEventListener('blur', commit);
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-remove]');
      if (btn) {
        tags.splice(Number(btn.dataset.remove), 1);
        paint();
      }
      input.focus();
    });

    return {
      get: () => tags.slice(),
      set(arr) { tags = [...arr]; input.value = ''; paint(); },
      commit,
      focus: () => input.focus(),
    };
  }

  /* ========================================================= submit / edit */

  const formScore = scoreEditor($('[data-score-editor]', el.submitForm));
  const members = tagInput($('#memberTags'), (tags) => {
    const counter = $('#memberCount');
    counter.textContent = `${tags.length} member${tags.length === 1 ? '' : 's'}`;
    counter.classList.toggle('has', tags.length > 0);
    if (tags.length) $('#memberTags').closest('.field').classList.remove('invalid');
  });

  const formType = () => el.submitForm.elements.type.value || 'web';

  // Shows the link field that matches the chosen submission type.
  function applyFormType(type, { isNew = !state.editingId } = {}) {
    el.submitForm.elements.type.value = type;
    const app = type === 'app';
    $('#fieldVercel').hidden = app;
    $('#fieldDemo').hidden = !app;
    $('#driveHint').hidden = !app;
    if (isNew) {
      $('#submitTitle').textContent = app ? 'Submit a desktop / mobile app' : 'Submit a web project';
      $('#submitKicker').textContent = app ? 'New submission · Desktop / mobile app' : 'New submission · Web project';
    }
    $$('#fieldVercel, #fieldDemo').forEach((n) => n.classList.remove('invalid'));
  }

  function openSubmit(project = null, type = 'web') {
    closeSubmitMenu();
    if (!project && !isTeacher() && !isAccepting()) {
      const status = submissionStatus();
      toast('Submissions are closed', status.detail ? `The ${status.detail}.` : 'Faculty have closed new submissions.', 'error');
      return;
    }
    state.editingId = project?.id || null;
    const f = el.submitForm;
    const max = maxMembers();
    $('#memberHint').textContent = isTeacher()
      ? 'Use each student’s full name — it’s how course capacity is tracked.'
      : `Up to ${max} member${max === 1 ? '' : 's'}. Use each student’s full name — it’s how course capacity is tracked.`;
    f.reset();
    $$('.field.invalid', f).forEach((n) => n.classList.remove('invalid'));
    $('#submitKicker').textContent = project ? 'Faculty · Edit' : 'New submission';
    $('#submitTitle').textContent = project ? `Edit ${project.teamName}` : 'Submit your project';
    $('.btn-label', el.submitSave).textContent = project ? 'Save changes' : 'Submit project';
    f.teamName.value = project?.teamName || '';
    $('#fTitle').value = project?.title || '';
    f.techStack.value = project?.techStack || '';
    f.vercelUrl.value = project?.vercelUrl || '';
    f.demoUrl.value = project?.demoUrl || '';
    f.githubUrl.value = project?.githubUrl || '';
    f.reviewerNotes.value = project?.reviewerNotes || '';
    members.set(project?.members || []);
    formScore.set(project?.score ?? null);
    applyFormType(project ? (isApp(project) ? 'app' : 'web') : type, { isNew: !project });
    el.submitDialog.showModal();
    setTimeout(() => f.teamName.focus(), 30);
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (el.submitSave.disabled) return;
    const f = el.submitForm;
    members.commit();

    f.vercelUrl.value = withScheme(f.vercelUrl.value);
    f.demoUrl.value = withScheme(f.demoUrl.value);
    f.githubUrl.value = withScheme(f.githubUrl.value);

    const type = formType();
    const payload = {
      type,
      teamName: f.teamName.value.trim(),
      title: $('#fTitle').value.trim(),
      members: members.get(),
      techStack: f.techStack.value.trim(),
      vercelUrl: type === 'web' ? f.vercelUrl.value : '',
      demoUrl: type === 'app' ? f.demoUrl.value : '',
      githubUrl: f.githubUrl.value,
    };

    const errors = [];
    const flag = (node, msg) => { node.closest('.field').classList.add('invalid'); errors.push([node, msg]); };
    $$('.field.invalid', f).forEach((n) => n.classList.remove('invalid'));
    if (!payload.teamName) flag(f.teamName, 'Team name is required.');
    if (!payload.title) flag($('#fTitle'), 'Project title is required.');
    if (!payload.members.length) flag($('#fMemberInput'), 'Add at least one team member.');
    if (payload.vercelUrl && !validUrl(payload.vercelUrl)) flag(f.vercelUrl, 'Deployment URL is not valid.');
    if (payload.demoUrl && !(validUrl(payload.demoUrl) && isDriveUrl(payload.demoUrl))) {
      flag(f.demoUrl, 'Demo video must be a Google Drive link (drive.google.com).');
    }
    if (payload.githubUrl && !validUrl(payload.githubUrl, { github: true })) flag(f.githubUrl, 'Repository link must be a github.com URL.');

    if (isTeacher()) {
      const score = formScore.get();
      if (score === undefined) errors.push([f.score, 'Score must be between 0.0 and 10.0.']);
      payload.score = score;
      payload.reviewerNotes = f.reviewerNotes.value;
    }

    if (errors.length) {
      toast('Please check the form', errors[0][1], 'error');
      errors[0][0].focus();
      return;
    }

    setBusy(el.submitSave, true, 'Saving…');
    try {
      if (state.editingId) {
        await api(`/api/projects/${state.editingId}`, { method: 'PATCH', body: payload });
        toast('Changes saved', `${payload.teamName} was updated.`, 'success');
      } else {
        const { project } = await api('/api/projects', { method: 'POST', body: payload });
        toast('Project submitted 🎉', `${project.teamName} is now ${project.status === 'pending' ? 'pending review' : 'graded'}.`, 'success');
      }
      el.submitDialog.close();
      await loadProjects();
    } catch (err) {
      toast('Could not save project', err.message, 'error');
      // Settings may have changed (e.g. submissions just closed).
      loadProjects({ silent: true });
    } finally {
      setBusy(el.submitSave, false);
    }
  }

  /* ================================================================= auth */

  function setToken(token, { reload = true } = {}) {
    state.token = token;
    document.body.classList.toggle('is-teacher', Boolean(token));
    const btn = el.facultyBtn;
    btn.classList.toggle('btn-secondary', true);
    btn.classList.toggle('is-faculty', Boolean(token));
    btn.title = token ? 'Faculty mode active — click to sign out' : 'Faculty sign in';
    btn.innerHTML = token
      ? `<span class="dot"></span><span class="label">Faculty</span>${icon('logout')}`
      : `${icon('lock')}<span class="label">Faculty</span>`;
    $('#footerFaculty').textContent = token ? 'Sign out' : 'Faculty access';
    if (!token && el.controlDialog.open) el.controlDialog.close();
    if (reload) loadProjects({ silent: true });
    else render();
    if (state.previewId && el.previewDialog.open) fillPreview(find(state.previewId));
  }

  function openLogin(after = null) {
    state.afterLogin = after;
    el.loginForm.reset();
    el.password.type = 'password';
    el.loginDialog.showModal();
    setTimeout(() => el.password.focus(), 30);
  }

  async function onLogin(e) {
    e.preventDefault();
    if (el.loginSave.disabled) return;
    const password = el.password.value;
    if (!password) {
      el.password.focus();
      return;
    }
    setBusy(el.loginSave, true, 'Verifying…');
    try {
      const { token } = await api('/api/auth/login', { method: 'POST', body: { password } });
      el.loginDialog.close();
      setToken(token);
      toast('Faculty mode enabled', 'You can now score, edit and delete projects.', 'success');
      const after = state.afterLogin;
      state.afterLogin = null;
      if (after) after();
    } catch (err) {
      el.loginForm.classList.remove('shake');
      void el.loginForm.offsetWidth;
      el.loginForm.classList.add('shake');
      el.password.select();
      toast('Sign in failed', err.message, 'error');
    } finally {
      setBusy(el.loginSave, false);
    }
  }

  async function logout() {
    const token = state.token;
    setToken(null);
    toast('Signed out', 'Faculty mode is now off.', 'info');
    try {
      await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-teacher-token': token } });
    } catch { /* token is discarded locally regardless */ }
  }

  /* =============================================================== export */

  async function exportCsv() {
    if (!isTeacher()) return openLogin(exportCsv);
    try {
      const res = await fetch('/api/export/csv', { headers: { 'x-teacher-token': state.token } });
      if (res.status === 401) {
        setToken(null, { reload: false });
        return openLogin(exportCsv);
      }
      if (!res.ok) throw new Error(`Export failed (${res.status}).`);
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'course-mdc-grades.csv';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast('Export ready', `${name} downloaded with ${state.projects.length} team${state.projects.length === 1 ? '' : 's'}.`, 'success');
    } catch (err) {
      toast('Export failed', err.message, 'error');
    }
  }

  /* ============================================================== confirm */

  // Generic confirmation dialog. `requireText` makes the user type a word first.
  function confirmAction({ title, text, okLabel = 'Delete', busyLabel = 'Working…', iconName = 'trash', requireText = null, onConfirm }) {
    const ok = $('#confirmOk');
    const typed = $('#confirmType');
    $('#confirmTitle').textContent = title;
    $('#confirmText').textContent = text;
    $('#confirmIcon').setAttribute('href', `#i-${iconName}`);
    $('.btn-label', ok).textContent = okLabel;
    $('#confirmTypeField').hidden = !requireText;
    $('#confirmWord').textContent = requireText || '';
    typed.value = '';
    ok.disabled = Boolean(requireText);
    state.confirmHandler = { requireText, busyLabel, onConfirm };
    el.confirmDialog.showModal();
    setTimeout(() => (requireText ? typed : ok).focus(), 30);
  }

  async function runConfirm() {
    const ok = $('#confirmOk');
    const handler = state.confirmHandler;
    if (!handler || ok.disabled) return;
    if (handler.requireText && $('#confirmType').value.trim() !== handler.requireText) return;
    setBusy(ok, true, handler.busyLabel);
    try {
      await handler.onConfirm();
      el.confirmDialog.close();
    } catch (err) {
      toast('Action failed', err.message, 'error');
    } finally {
      setBusy(ok, false);
      ok.disabled = Boolean(handler.requireText) && $('#confirmType').value.trim() !== handler.requireText;
    }
  }

  function confirmDelete(project) {
    if (!project) return;
    confirmAction({
      title: 'Delete project?',
      text: `“${project.teamName} — ${project.title}” and its evaluation will be permanently removed.`,
      busyLabel: 'Deleting…',
      onConfirm: async () => {
        await api(`/api/projects/${project.id}`, { method: 'DELETE' });
        toast('Project deleted', `${project.teamName} was removed.`, 'success');
        await loadProjects();
      },
    });
  }

  /* ======================================================= control center */

  const SETTING_FIELDS = ['submissionsOpen', 'deadline', 'capacity', 'maxTeamSize', 'resultsPublished', 'courseName', 'announcement', 'program', 'semester', 'batch'];
  const ACTIVITY_ICONS = { login: 'lock', submit: 'plus', grade: 'star', edit: 'edit', delete: 'trash', settings: 'sliders', danger: 'alert', security: 'shield' };

  const pad = (n) => String(n).padStart(2, '0');
  function isoToLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function readControlForm() {
    const f = el.controlForm.elements;
    return {
      submissionsOpen: f.submissionsOpen.checked,
      deadline: f.deadline.value ? new Date(f.deadline.value).toISOString() : null,
      capacity: Number(f.capacity.value),
      maxTeamSize: Number(f.maxTeamSize.value),
      resultsPublished: f.resultsPublished.checked,
      courseName: f.courseName.value.trim(),
      announcement: f.announcement.value.trim().replace(/\s+/g, ' '),
      program: f.program.value.trim().replace(/\s+/g, ' '),
      semester: f.semester.value.trim().replace(/\s+/g, ' '),
      batch: f.batch.value.trim().replace(/\s+/g, ' ').replace(/^batch\s*/i, ''),
    };
  }

  // Compares at minute precision because datetime-local drops seconds.
  function controlChanges() {
    const form = readControlForm();
    const changes = {};
    for (const key of SETTING_FIELDS) {
      const current = state.settings[key];
      const same = key === 'deadline'
        ? isoToLocalInput(form.deadline) === isoToLocalInput(current)
        : form[key] === current;
      if (!same) changes[key] = form[key];
    }
    return changes;
  }

  function updateControlDirty() {
    const count = Object.keys(controlChanges()).length;
    const status = $('#controlStatus');
    status.textContent = count ? `${count} unsaved change${count === 1 ? '' : 's'}` : 'All changes saved';
    status.classList.toggle('dirty', count > 0);
    el.controlSave.disabled = count === 0;
    $('#controlDiscard').disabled = count === 0;
    $('#announceCount').textContent = `${el.controlForm.elements.announcement.value.length} / 280`;
    renderResultsCallout();
  }

  function fillControlForm() {
    const s = state.settings;
    const f = el.controlForm.elements;
    f.submissionsOpen.checked = s.submissionsOpen;
    f.deadline.value = isoToLocalInput(s.deadline);
    f.capacity.value = s.capacity;
    f.maxTeamSize.value = s.maxTeamSize;
    f.resultsPublished.checked = s.resultsPublished;
    f.courseName.value = s.courseName;
    f.announcement.value = s.announcement;
    f.program.value = s.program;
    f.semester.value = s.semester;
    f.batch.value = s.batch;
    updateControlDirty();
  }

  function renderResultsCallout() {
    const published = el.controlForm.elements.resultsPublished.checked;
    $('#resultsCallout').innerHTML = published
      ? `${icon('eye')}<p><strong>Students currently see</strong> every score, tier badge, the class average and the ranked leaderboard.</p>`
      : `${icon('eye-off')}<p><strong>Students will see</strong> all projects as Pending, a locked leaderboard and no class average. Faculty views are unchanged.</p>`;
  }

  function renderOverview() {
    const s = state.settings;
    const stats = computeStats();
    const status = submissionStatus();
    const pct = Math.min(100, Math.round((stats.students / s.capacity) * 100));
    $('#overviewGrid').innerHTML = `
      ${state.security?.usingDefault ? `
      <div class="ov-alert">
        <p>${icon('alert')}<span><strong>The default faculty password is still active.</strong> Anyone who has seen it can sign in and change grades.</span></p>
        <button type="button" class="btn btn-sm" data-goto-tab="security">Change password</button>
      </div>` : ''}
      <div class="ov-card">
        <span class="ov-label">${icon('calendar')} Submissions</span>
        <span class="ov-value"><i class="state-dot ${status.open ? '' : 'off'}"></i>${status.open ? 'Open' : 'Closed'}</span>
        <span class="ov-sub">${esc(status.detail || (s.deadline ? '' : 'No deadline set'))}</span>
        <button type="button" class="btn btn-secondary btn-sm" data-quick="submissionsOpen">${s.submissionsOpen ? 'Close submissions' : 'Open submissions'}</button>
      </div>
      <div class="ov-card">
        <span class="ov-label">${icon(s.resultsPublished ? 'eye' : 'eye-off')} Results</span>
        <span class="ov-value"><i class="state-dot ${s.resultsPublished ? '' : 'off'}"></i>${s.resultsPublished ? 'Published' : 'Hidden'}</span>
        <span class="ov-sub">${s.resultsPublished ? 'Students can see scores and rankings' : 'Students see every project as Pending'}</span>
        <button type="button" class="btn btn-secondary btn-sm" data-quick="resultsPublished">${s.resultsPublished ? 'Hide results' : 'Publish results'}</button>
      </div>
      <div class="ov-card">
        <span class="ov-label">${icon('users')} Enrollment</span>
        <span class="ov-value">${stats.students} <span class="muted" style="font-size:14px;font-weight:500">/ ${s.capacity}</span></span>
        <span class="ov-sub">${stats.teams} team${stats.teams === 1 ? '' : 's'} · max ${s.maxTeamSize} per team</span>
        <div class="progress"><span style="width:${pct}%"></span></div>
      </div>
      <div class="ov-card">
        <span class="ov-label">${icon('check')} Grading</span>
        <span class="ov-value">${stats.graded} <span class="muted" style="font-size:14px;font-weight:500">/ ${stats.teams} graded</span></span>
        <span class="ov-sub">${stats.pending ? `${stats.pending} awaiting review` : 'All caught up'}${stats.avg === null ? '' : ` · average ${fmtScore(stats.avg)}`}</span>
        <div class="progress"><span style="width:${stats.teams ? Math.round((stats.graded / stats.teams) * 100) : 0}%"></span></div>
      </div>
      ${rosterOverviewCard()}`;
  }

  function rosterOverviewCard() {
    const data = rosterState.data;
    if (!data) return '';
    if (!data.roster) {
      return `<div class="ov-card ov-wide">
        <span class="ov-label">${icon('users')} Roster</span>
        <span class="ov-sub">Upload the class list to see which students haven’t submitted yet.</span>
        <button type="button" class="btn btn-secondary btn-sm" data-goto-tab="roster">Upload class list</button>
      </div>`;
    }
    const s = data.report.summary;
    return `<div class="ov-card ov-wide">
      <span class="ov-label">${icon('users')} Roster</span>
      <span class="ov-value">${s.submitted} <span class="muted" style="font-size:14px;font-weight:500">/ ${s.total} submitted</span></span>
      <span class="ov-sub"><strong>${s.missing}</strong> not submitted${s.possible ? ` · ${s.possible} possible match${s.possible === 1 ? '' : 'es'} to confirm` : ''}</span>
      <div class="progress"><span style="width:${s.total ? Math.round((s.submitted / s.total) * 100) : 0}%"></span></div>
      <button type="button" class="btn btn-secondary btn-sm" data-goto-tab="roster">View who hasn’t submitted</button>
    </div>`;
  }

  async function loadActivity() {
    const list = $('#activityList');
    list.innerHTML = '<li class="activity-empty"><span class="spinner lg" style="margin:0 auto"></span></li>';
    try {
      const { activity } = await api('/api/admin/activity?limit=100');
      list.innerHTML = activity.length
        ? activity.map((a, i) => `
          <li class="act act-${esc(a.action)}" style="animation-delay:${Math.min(i, 15) * 20}ms">
            <span class="act-icon">${icon(ACTIVITY_ICONS[a.action] || 'info')}</span>
            <div>
              <p>${esc(a.summary)}${a.meta?.deadline ? ` <span class="muted">(${esc(fmtDeadline(a.meta.deadline))})</span>` : ''}</p>
              <time datetime="${esc(a.at)}" title="${esc(absTime(a.at))}">${relTime(a.at)}</time>
            </div>
            <span class="act-actor ${a.actor === 'faculty' ? 'faculty' : ''}">${esc(a.actor)}</span>
          </li>`).join('')
        : '<li class="activity-empty">No activity recorded yet.</li>';
    } catch (err) {
      list.innerHTML = `<li class="activity-empty">${esc(err.message)}</li>`;
    }
  }

  function showControlTab(tab) {
    state.controlTab = tab;
    $$('#controlNav [data-tab]').forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    $$('#controlDialog [data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
    if (tab === 'overview') renderOverview();
    if (tab === 'activity') loadActivity();
    if (tab === 'security') loadSecurity();
    if (tab === 'roster') loadRoster();
  }

  function openControl(tab = state.controlTab) {
    if (!isTeacher()) return openLogin(() => openControl(tab));
    fillControlForm();
    showControlTab(tab);
    if (!el.controlDialog.open) el.controlDialog.showModal();
    if (tab !== 'security') loadSecurity();
    if (tab !== 'roster') loadRoster();
  }

  /* ---------------------------------------------------------- roster tab */

  const rosterState = { data: null, filter: 'missing', query: '', preview: null, replacing: false };
  const ROSTER_LABELS = { missing: 'Not submitted', possible: 'Possible match', submitted: 'Submitted' };

  async function loadRoster() {
    try {
      rosterState.data = await api('/api/admin/roster');
    } catch {
      return;
    }
    renderRoster();
    if (el.controlDialog.open && state.controlTab === 'overview') renderOverview();
  }

  function renderRoster() {
    const has = Boolean(rosterState.data?.roster);
    const preview = rosterState.preview;
    $('#rosterPreview').hidden = !preview;
    $('#rosterImport').hidden = Boolean(preview) || (has && !rosterState.replacing);
    $('#rosterReport').hidden = Boolean(preview) || !has || rosterState.replacing;
    $('#rosterTools').hidden = Boolean(preview) || !has || rosterState.replacing;
    $('#rosterCancelReplace').hidden = !(has && rosterState.replacing);
    if (preview) renderRosterPreview();
    else if (has && !rosterState.replacing) renderRosterReport();
  }

  function renderRosterPreview() {
    const { students, columns, source } = rosterState.preview;
    const detected = [['Name', columns.name], ['Roll number', columns.rollNo], ['Email', columns.email]]
      .filter(([, c]) => c).map(([k, c]) => `${k} ← “${esc(c)}”`).join(' · ');
    $('#rosterPreview').innerHTML = `
      <h4>Found ${students.length} student${students.length === 1 ? '' : 's'}</h4>
      <p>${esc(source)}${detected ? ` · ${detected}` : ' · single column of names'}</p>
      <table>
        <thead><tr><th>Name</th><th>Roll number</th><th>Email</th></tr></thead>
        <tbody>${students.slice(0, 5).map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.rollNo || '—')}</td><td>${esc(s.email || '—')}</td></tr>`).join('')}</tbody>
      </table>
      ${students.length > 5 ? `<p>…and ${students.length - 5} more.</p>` : ''}
      <div class="actions">
        <button type="button" class="btn btn-primary btn-sm" data-roster="save"><span class="spinner"></span><span class="btn-label">${rosterState.data?.roster ? 'Replace roster' : 'Save roster'}</span></button>
        <button type="button" class="btn btn-ghost btn-sm" data-roster="discard">Cancel</button>
      </div>`;
  }

  function rosterMatches(s) {
    const q = rosterState.query.trim().toLowerCase();
    return (rosterState.filter === 'all' || s.status === rosterState.filter)
      && (!q || [s.name, s.rollNo, s.email].some((v) => (v || '').toLowerCase().includes(q)));
  }

  function renderRosterReport() {
    const { roster, report } = rosterState.data;
    const { summary } = report;
    const cards = [['missing', 'Not submitted', summary.missing], ['possible', 'Possible match', summary.possible],
      ['submitted', 'Submitted', summary.submitted], ['all', 'All students', summary.total]];
    $('#rosterSummary').innerHTML = cards.map(([key, label, n]) => `
      <button type="button" role="tab" aria-selected="${rosterState.filter === key}" class="rs-card ${key} ${rosterState.filter === key ? 'active' : ''}" data-roster-filter="${key}">
        <span>${label}</span><strong>${n}</strong>
      </button>`).join('');

    const list = report.students.filter(rosterMatches);
    $('#rosterList').innerHTML = list.length
      ? list.map((s) => {
        const m = s.matches[0];
        const detail = m
          ? `Team <b>${esc(m.team)}</b>${s.status === 'possible' || m.member.trim().toLowerCase() !== s.name.trim().toLowerCase() ? ` · entered as “${esc(m.member)}”` : ''}${s.matches.length > 1 ? ` · +${s.matches.length - 1} more` : ''}`
          : esc([s.rollNo, s.email].filter(Boolean).join(' · ') || 'No submission found');
        return `<li class="roster-row">${avatar(s.name)}
          <div class="who"><strong>${esc(s.name)}</strong><small>${s.rollNo && m ? `${esc(s.rollNo)} · ` : ''}${detail}</small></div>
          <span class="r-status ${s.status}">${ROSTER_LABELS[s.status]}</span></li>`;
      }).join('')
      : `<li class="roster-empty">${rosterState.filter === 'missing' && !rosterState.query ? 'Everyone on the roster has submitted. 🎉' : 'No students match.'}</li>`;

    const unmatched = report.unmatched;
    $('#rosterUnmatched').innerHTML = unmatched.length ? `
      <details>
        <summary>${unmatched.length} name${unmatched.length === 1 ? ' in submissions doesn’t' : 's in submissions don’t'} match the roster</summary>
        <p>Usually a typo, a nickname or a student outside this class. Fix the name in the project (Edit) to link it.</p>
        <ul>${unmatched.map((u) => `<li>${esc(u.name)} · team ${esc(u.team)}${u.reason === 'ambiguous' ? ' (matches more than one student)' : ''}</li>`).join('')}</ul>
      </details>` : '';

    $('#rosterMeta').innerHTML = `<span>Roster of ${roster.count} students${roster.source ? ` from ${esc(roster.source)}` : ''} · updated ${relTime(roster.updatedAt)}</span>
      <button type="button" class="link-btn" data-roster="replace">Replace list</button>
      <button type="button" class="link-btn" data-roster="remove">Remove roster</button>`;
  }

  const fileToBase64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });

  async function previewRoster(body, source) {
    try {
      const parsed = await api('/api/admin/roster/preview', { method: 'POST', body });
      rosterState.preview = { ...parsed, source };
      renderRoster();
    } catch (err) {
      toast('Could not read the class list', err.message, 'error');
    }
  }

  async function saveRoster(btn) {
    const { students, source } = rosterState.preview;
    setBusy(btn, true, 'Saving…');
    try {
      rosterState.data = await api('/api/admin/roster', { method: 'PUT', body: { students, source } });
      rosterState.preview = null;
      rosterState.replacing = false;
      rosterState.filter = 'missing';
      $('#rosterPaste').value = '';
      renderRoster();
      const { summary } = rosterState.data.report;
      toast('Roster saved', `${summary.total} students · ${summary.missing} haven’t submitted yet.`, 'success');
    } catch (err) {
      toast('Could not save roster', err.message, 'error');
      setBusy(btn, false);
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = Object.assign(document.createElement('textarea'), { value: text });
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    }
  }

  async function copyMissing() {
    const missing = rosterState.data.report.students.filter((s) => s.status === 'missing');
    if (!missing.length) return toast('Nothing to copy', 'Everyone on the roster has submitted.', 'info');
    const text = ['Roll Number\tStudent Name\tEmail', ...missing.map((s) => [s.rollNo, s.name, s.email].join('\t'))].join('\n');
    if (await copyText(text)) toast('Copied', `${missing.length} students who haven’t submitted · paste into Excel or an email.`, 'success');
    else toast('Copy failed', 'Your browser blocked clipboard access. Use Export CSV instead.', 'error');
  }

  function exportRoster() {
    const cell = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [['Roll Number', 'Student Name', 'Email', 'Status', 'Team', 'Entered As']];
    for (const s of rosterState.data.report.students) {
      rows.push([s.rollNo, s.name, s.email, ROSTER_LABELS[s.status], s.matches.map((m) => m.team).join('; '), s.matches.map((m) => m.member).join('; ')]);
    }
    const blob = new Blob(['﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `roster-submission-status-${new Date().toISOString().slice(0, 10)}.csv`,
    });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function rosterAction(action, btn) {
    if (action === 'save') return saveRoster(btn);
    if (action === 'discard') {
      rosterState.preview = null;
      return renderRoster();
    }
    if (action === 'replace') {
      rosterState.replacing = true;
      return renderRoster();
    }
    if (action === 'remove') {
      return confirmAction({
        title: 'Remove the class roster?',
        text: 'The class list is deleted from the dashboard. Projects are not affected, and you can upload the list again any time.',
        okLabel: 'Remove roster',
        iconName: 'trash',
        busyLabel: 'Removing…',
        onConfirm: async () => {
          await api('/api/admin/roster', { method: 'DELETE' });
          rosterState.data = { roster: null, report: null };
          renderRoster();
          toast('Roster removed', '', 'success');
        },
      });
    }
    return undefined;
  }

  /* -------------------------------------------------------- security tab */

  async function loadSecurity() {
    try {
      state.security = await api('/api/admin/security');
    } catch {
      return;
    }
    renderSecurityStatus();
    if (el.controlDialog.open && state.controlTab === 'overview') renderOverview();
  }

  function renderSecurityStatus() {
    const s = state.security;
    const box = $('#securityStatus');
    if (!s) return;
    box.classList.toggle('warn', s.usingDefault);
    box.innerHTML = s.usingDefault
      ? `${icon('alert')}<p><strong>The default password is still active.</strong> It appears in the course spec, so anyone who has seen it can sign in. Set a new one below.</p>`
      : s.customPassword
        ? `${icon('shield')}<p><strong>Custom password in use.</strong> Last changed ${esc(absTime(s.changedAt))} (${relTime(s.changedAt)}).</p>`
        : `${icon('shield')}<p><strong>Using the password from the server's TEACHER_PASSWORD setting.</strong> A password set here replaces it.</p>`;
  }

  // 0–4: length ≥10, length ≥14, mixed case, number or symbol beyond letters.
  function passwordScore(pw) {
    if (!pw) return 0;
    let score = 0;
    if (pw.length >= 10) score++;
    if (pw.length >= 14) score++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
    if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
    return score;
  }

  function updatePasswordMeter() {
    const pw = $('#pwNew').value;
    const score = passwordScore(pw);
    const meetsRules = pw.length >= 10 && /[A-Za-z]/.test(pw) && /[^A-Za-z]/.test(pw);
    $('#pwMeterBar').style.width = pw ? `${Math.max(12, score * 25)}%` : '0';
    $('#pwHint').textContent = !pw
      ? 'At least 10 characters, with letters and a number or symbol.'
      : !meetsRules
        ? 'Too weak: use at least 10 characters with letters and a number or symbol.'
        : ['Acceptable', 'Acceptable', 'Good', 'Strong', 'Very strong'][score] + ' password.';
  }

  function clearPasswordForm() {
    ['#pwCurrent', '#pwNew', '#pwConfirm'].forEach((sel) => {
      const input = $(sel);
      input.value = '';
      input.type = 'password';
      input.closest('.field').classList.remove('invalid');
    });
    updatePasswordMeter();
  }

  async function changePassword() {
    const btn = $('#pwSave');
    if (btn.disabled) return;
    const current = $('#pwCurrent').value;
    const next = $('#pwNew').value;
    const confirmValue = $('#pwConfirm').value;
    const fields = { current: $('#pwCurrent'), next: $('#pwNew'), confirm: $('#pwConfirm') };
    Object.values(fields).forEach((f) => f.closest('.field').classList.remove('invalid'));

    const fail = (field, title, message) => {
      field.closest('.field').classList.add('invalid');
      field.focus();
      toast(title, message, 'error');
    };
    if (!current) return fail(fields.current, 'Enter your current password', '');
    if (next.length < 10 || !/[A-Za-z]/.test(next) || !/[^A-Za-z]/.test(next)) {
      return fail(fields.next, 'New password is too weak', 'Use at least 10 characters with letters and a number or symbol.');
    }
    if (next === current) return fail(fields.next, 'Choose a different password', 'The new password matches the current one.');
    if (next !== confirmValue) return fail(fields.confirm, 'Passwords don’t match', 'Re-type the new password to confirm it.');

    setBusy(btn, true, 'Updating…');
    try {
      const { token } = await api('/api/admin/password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      setToken(token, { reload: false });
      clearPasswordForm();
      toast('Password updated', 'All other faculty sessions were signed out. Use the new password from now on.', 'success');
      await loadSecurity();
    } catch (err) {
      if (/current password/i.test(err.message)) fields.current.closest('.field').classList.add('invalid');
      toast('Could not change password', err.message, 'error');
    } finally {
      setBusy(btn, false);
    }
  }

  async function saveSettings(patch, { quiet = false } = {}) {
    const { settings } = await api('/api/admin/settings', { method: 'PATCH', body: patch });
    applySettings(settings);
    state.lastPayload = '';
    render();
    if (!quiet) toast('Settings saved', 'Changes are live for everyone.', 'success');
    return settings;
  }

  async function onControlSave(e) {
    e.preventDefault();
    const changes = controlChanges();
    if (!Object.keys(changes).length || el.controlSave.disabled) return;
    if ('courseName' in changes && !changes.courseName) {
      showControlTab('course');
      toast('Course name is required', '', 'error');
      return;
    }
    setBusy(el.controlSave, true, 'Saving…');
    try {
      await saveSettings(changes);
      fillControlForm();
      if (state.controlTab === 'overview') renderOverview();
    } catch (err) {
      toast('Could not save settings', err.message, 'error');
    } finally {
      setBusy(el.controlSave, false);
      updateControlDirty();
    }
  }

  // Overview quick toggles save one field immediately and keep other edits intact.
  async function quickToggle(key, btn) {
    btn.disabled = true;
    try {
      const next = !state.settings[key];
      await saveSettings({ [key]: next }, { quiet: true });
      el.controlForm.elements[key].checked = next;
      updateControlDirty();
      renderOverview();
      const labels = {
        submissionsOpen: next ? ['Submissions opened', 'Students can submit again.'] : ['Submissions closed', 'Students can no longer submit.'],
        resultsPublished: next ? ['Results published', 'Students can now see scores and rankings.'] : ['Results hidden', 'Students now see every project as Pending.'],
      }[key];
      toast(labels[0], labels[1], 'success');
    } catch (err) {
      toast('Could not update setting', err.message, 'error');
      btn.disabled = false;
    }
  }

  function requestCloseControl() {
    if (!Object.keys(controlChanges()).length) return el.controlDialog.close();
    confirmAction({
      title: 'Discard unsaved changes?',
      text: 'Your edits to the course settings haven’t been saved.',
      okLabel: 'Discard',
      iconName: 'alert',
      onConfirm: async () => el.controlDialog.close(),
    });
  }

  function dangerAction(kind) {
    const actions = {
      revoke: {
        title: 'Sign out all faculty?',
        text: 'Every faculty session ends immediately, including yours. Everyone will need the instructor password to sign in again.',
        okLabel: 'Sign out everyone',
        iconName: 'logout',
        run: async () => {
          const { count } = await api('/api/admin/revoke-sessions', { method: 'POST' });
          setToken(null, { reload: true });
          toast('All faculty signed out', `${count} session${count === 1 ? '' : 's'} ended.`, 'success');
        },
      },
      reset: {
        title: 'Clear all scores?',
        text: 'Every project goes back to Pending. Reviewer notes are kept. This can’t be undone, so export a CSV backup first.',
        okLabel: 'Clear scores',
        iconName: 'alert',
        requireText: 'RESET',
        run: async () => {
          const { count } = await api('/api/admin/reset-scores', { method: 'POST', body: { confirm: 'RESET' } });
          await loadProjects({ silent: true });
          renderOverview();
          toast('Scores cleared', `${count} project${count === 1 ? '' : 's'} moved back to Pending.`, 'success');
        },
      },
      delete: {
        title: 'Delete all projects?',
        text: 'Every submission and evaluation is permanently removed. This can’t be undone, so export a CSV backup first.',
        okLabel: 'Delete everything',
        iconName: 'trash',
        requireText: 'DELETE',
        run: async () => {
          const { count } = await api('/api/admin/delete-all', { method: 'POST', body: { confirm: 'DELETE' } });
          await loadProjects({ silent: true });
          renderOverview();
          toast('All projects deleted', `${count} project${count === 1 ? '' : 's'} removed.`, 'success');
        },
      },
    };
    const a = actions[kind];
    if (a) confirmAction({ ...a, busyLabel: 'Working…', onConfirm: a.run });
  }

  /* ============================================================== preview */

  const quickScore = scoreEditor($('[data-score-editor]', $('#previewSide')));
  let frameToken = 0;

  function setDevice(device) {
    state.device = device;
    store.set('mdc-device', device);
    el.device.dataset.device = device;
    $('#deviceWidth').textContent = DEVICES[device];
    $$('#deviceSwitch button').forEach((b) => {
      const on = b.dataset.device === device;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on);
    });
  }

  function fillPreview(p) {
    if (!p) return;
    $('#previewSeq').textContent = `#${seqLabel(sequence().get(p.id))}`;
    $('#previewTeam').textContent = p.teamName;
    $('#previewProject').textContent = `${p.title} · ${isApp(p) ? 'Desktop / mobile app' : 'Web project'}`;
    $('#previewOpen').href = linkOf(p);
    $('#previewOpen').querySelector('span').textContent = isApp(p) ? 'Open in Drive' : 'Open site';
    $('#frameBlockedOpen').href = linkOf(p);
    $('#deviceUrl').textContent = prettyUrl(linkOf(p));

    const t = tierOf(p.score);
    $('#previewEval').innerHTML = `${ring(p.score, 60, 5)}<div class="sp-text">${badge(p.score)}<small>${
      p.score === null ? 'Awaiting faculty review' : `${esc(t.range)} · ${esc(t.desc)}`}</small></div>`;

    $('#previewMembers').innerHTML = p.members.map((m) => `<div class="member-row">${avatar(m)}<span>${esc(m)}</span></div>`).join('');

    const rows = [
      ['Submitted', esc(absTime(p.createdAt))],
      ['Tech stack', esc(p.techStack || '—')],
      [isApp(p) ? 'Demo video' : 'Live site',
        `<a href="${esc(linkOf(p))}" target="_blank" rel="noopener noreferrer">${isApp(p) ? 'Open in Google Drive' : esc(prettyUrl(linkOf(p)))}</a>`],
      ['Repository', p.githubUrl ? `<a href="${esc(p.githubUrl)}" target="_blank" rel="noopener noreferrer">${esc(repoPath(p.githubUrl))}</a>` : '—'],
    ];
    if (p.gradedAt && isTeacher()) rows.push(['Last graded', esc(absTime(p.gradedAt))]);
    $('#previewDetails').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');

    quickScore.set(p.score);
    $('#qNotes').value = p.reviewerNotes || '';
    $('#qSaveNext').disabled = !nextPending(p.id);
    $('#previewNotesBlock').hidden = !p.reviewerNotes;
    $('#previewNotes').textContent = p.reviewerNotes || '';
  }

  function showFrameBlocked(title, reason) {
    $('#frameBlockedTitle').textContent = title;
    $('#frameBlockedReason').textContent = reason;
    el.frameBlocked.hidden = false;
    el.frameLoading.classList.add('done');
  }

  async function loadFrame(p) {
    const app = isApp(p);
    const token = ++frameToken;
    el.frameLoading.classList.remove('done');
    $('#frameLoadingText').textContent = app ? 'Loading demo video…' : 'Loading deployment…';
    el.frameBlocked.hidden = true;
    el.frame.src = 'about:blank';

    // Drive's /preview player is embeddable; folder links and other Drive URLs are not.
    let url = linkOf(p);
    if (app) {
      const id = driveFileId(url);
      if (!id) {
        showFrameBlocked('This Drive link can’t be played here',
          'Only links to a single video file (drive.google.com/file/d/…) can be embedded. Open it in Google Drive instead.');
        return;
      }
      url = `https://drive.google.com/file/d/${encodeURIComponent(id)}/preview`;
    }
    setTimeout(() => { if (token === frameToken) el.frame.src = url; }, 0);

    const done = () => { if (token === frameToken) el.frameLoading.classList.add('done'); };
    el.frame.onload = () => { if (el.frame.src !== 'about:blank') done(); };
    setTimeout(done, 12000);
    if (app) return;

    try {
      const check = await api(`/api/frame-check?url=${encodeURIComponent(url)}`);
      if (token !== frameToken) return;
      if (!check.embeddable) {
        showFrameBlocked('This site can’t be embedded', `${check.reason} Open the deployment directly to review it.`);
      } else if (check.error === 'unreachable') {
        toast('Deployment may be offline', 'The server could not reach this URL. The preview may not load.', 'info');
      }
    } catch { /* the iframe still attempts to load */ }
  }

  function openPreview(id) {
    const p = find(id);
    if (!p) return;
    if (!linkOf(p)) {
      toast(isApp(p) ? 'No demo video' : 'No live deployment',
        `${p.teamName} hasn't submitted ${isApp(p) ? 'a demo video link' : 'a deployment URL'} yet.`, 'info');
      if (isTeacher()) openSubmit(p);
      return;
    }
    state.previewId = id;
    el.previewDialog.classList.toggle('is-app', isApp(p));
    fillPreview(p);
    setDevice(state.device);
    loadFrame(p);
    if (!el.previewDialog.open) el.previewDialog.showModal();
  }

  function nextPending(currentId) {
    const list = state.projects;
    const start = list.findIndex((p) => p.id === currentId);
    for (let i = 1; i < list.length; i++) {
      const p = list[(start + i) % list.length];
      if (p.score === null && linkOf(p) && p.id !== currentId) return p;
    }
    return null;
  }

  async function saveQuickGrade(goNext) {
    const p = find(state.previewId);
    if (!p) return;
    const score = quickScore.get();
    if (score === undefined) {
      toast('Invalid score', 'Enter a score between 0.0 and 10.0.', 'error');
      quickScore.focus();
      return;
    }
    const saveBtn = $('#qSave');
    if (saveBtn.disabled) return;
    setBusy(saveBtn, true, 'Saving…');
    $('#qSaveNext').disabled = true;
    try {
      const { project } = await api(`/api/projects/${p.id}`, {
        method: 'PATCH',
        body: { score, reviewerNotes: $('#qNotes').value },
      });
      Object.assign(p, project);
      state.lastPayload = '';
      render();
      const t = tierOf(project.score);
      toast('Score saved', project.score === null ? `${p.teamName} is back to pending.` : `${p.teamName} · ${fmtScore(project.score)} — ${t.label}`, 'success');
      const next = goNext ? nextPending(p.id) : null;
      if (goNext && next) openPreview(next.id);
      else {
        fillPreview(p);
        if (goNext) toast('All caught up', 'There are no more pending projects with a deployment.', 'info');
      }
    } catch (err) {
      toast('Could not save score', err.message, 'error');
      $('#qSaveNext').disabled = !nextPending(p.id);
    } finally {
      setBusy(saveBtn, false);
    }
  }

  /* =============================================================== events */

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    store.set('mdc-theme', theme);
  }

  function clearFilters() {
    state.filter = 'all';
    state.query = '';
    el.search.value = '';
    render();
  }

  // Generic dialog behaviour: [data-close] buttons and backdrop clicks.
  // The Control Center asks before discarding unsaved settings.
  $$('dialog.modal').forEach((dlg) => {
    const close = () => (dlg === el.controlDialog ? requestCloseControl() : dlg.close());
    let downOnBackdrop = false;
    dlg.addEventListener('mousedown', (e) => { downOnBackdrop = e.target === dlg; });
    dlg.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) return close();
      if (e.target === dlg && downOnBackdrop) close();
    });
  });

  el.controlDialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    requestCloseControl();
  });

  el.previewDialog.addEventListener('close', () => {
    frameToken++;
    el.frame.src = 'about:blank';
    state.previewId = null;
  });

  $('#themeToggle').addEventListener('click', () => {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });

  el.facultyBtn.addEventListener('click', () => (isTeacher() ? logout() : openLogin()));
  $('#footerFaculty').addEventListener('click', () => (isTeacher() ? logout() : openLogin()));
  $('#previewLogin').addEventListener('click', () => openLogin());
  // Submit button opens a small menu: web project or desktop / mobile app.
  function openSubmitMenu() {
    if (!isTeacher() && !isAccepting()) return openSubmit(); // shows the "closed" message
    $('#submitMenu').hidden = false;
    $('#submitBtn').setAttribute('aria-expanded', 'true');
    $('#submitMenu [role=menuitem]').focus();
  }

  function closeSubmitMenu() {
    const menu = $('#submitMenu');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    $('#submitBtn').setAttribute('aria-expanded', 'false');
  }

  $('#submitBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    if ($('#submitMenu').hidden) openSubmitMenu();
    else closeSubmitMenu();
  });
  $('#submitMenu').addEventListener('click', (e) => {
    const item = e.target.closest('[data-submit-type]');
    if (item) openSubmit(null, item.dataset.submitType);
  });
  $('#submitMenu').addEventListener('keydown', (e) => {
    const items = $$('#submitMenu [role=menuitem]');
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    } else if (e.key === 'Escape') {
      closeSubmitMenu();
      $('#submitBtn').focus();
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.submit-wrap')) closeSubmitMenu();
  });
  el.submitForm.addEventListener('change', (e) => {
    if (e.target.name === 'type') applyFormType(e.target.value);
  });
  $$('[data-open="rubric"]').forEach((b) => b.addEventListener('click', () => el.rubricDialog.showModal()));
  $$('[data-export]').forEach((b) => b.addEventListener('click', exportCsv));

  el.submitForm.addEventListener('submit', onSubmit);
  el.loginForm.addEventListener('submit', onLogin);
  $('#confirmOk').addEventListener('click', runConfirm);
  $('#confirmType').addEventListener('input', (e) => {
    const word = state.confirmHandler?.requireText;
    $('#confirmOk').disabled = Boolean(word) && e.target.value.trim() !== word;
  });
  $('#confirmType').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runConfirm();
    }
  });

  $('#controlBtn').addEventListener('click', () => openControl());
  el.controlForm.addEventListener('submit', onControlSave);
  el.controlForm.addEventListener('input', updateControlDirty);
  el.controlForm.addEventListener('change', updateControlDirty);
  $('#controlDiscard').addEventListener('click', fillControlForm);
  $('#clearDeadline').addEventListener('click', () => {
    el.controlForm.elements.deadline.value = '';
    updateControlDirty();
  });
  $('#activityRefresh').addEventListener('click', loadActivity);
  $('#controlNav').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (btn) showControlTab(btn.dataset.tab);
  });
  $('#overviewGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-quick]');
    if (btn) quickToggle(btn.dataset.quick, btn);
    const go = e.target.closest('[data-goto-tab]');
    if (go) showControlTab(go.dataset.gotoTab);
  });

  // Security tab. The fields live inside the settings form, so Enter must not submit it.
  // Roster tab.
  $('#rosterFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 1024 * 1024) return toast('File too large', 'The class list must be under 1 MB.', 'error');
    await previewRoster({ fileName: file.name, base64: await fileToBase64(file) }, file.name);
  });
  const drop = $('#rosterDrop');
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, () => drop.classList.add('over')));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
  $('#rosterUsePaste').addEventListener('click', () => {
    const text = $('#rosterPaste').value;
    if (!text.trim()) return toast('Nothing to use', 'Paste rows copied from Excel, or one name per line.', 'info');
    return previewRoster({ text }, 'Pasted list');
  });
  $('#rosterCancelReplace').addEventListener('click', () => {
    rosterState.replacing = false;
    renderRoster();
  });
  $('#rosterCopy').addEventListener('click', copyMissing);
  $('#rosterExport').addEventListener('click', exportRoster);
  $('#rosterSearch').addEventListener('input', (e) => {
    rosterState.query = e.target.value;
    renderRosterReport();
  });
  $('#rosterSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  $('[data-panel="roster"]').addEventListener('click', (e) => {
    const f = e.target.closest('[data-roster-filter]');
    if (f) {
      rosterState.filter = f.dataset.rosterFilter;
      renderRosterReport();
      return;
    }
    const a = e.target.closest('[data-roster]');
    if (a) rosterAction(a.dataset.roster, a);
  });

  $('#pwSave').addEventListener('click', changePassword);
  $('#pwNew').addEventListener('input', updatePasswordMeter);
  $$('.pw-form input').forEach((input) => input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      changePassword();
    }
  }));
  $$('[data-toggle-pw]').forEach((btn) => btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.togglePw);
    input.type = input.type === 'password' ? 'text' : 'password';
    btn.setAttribute('aria-label', input.type === 'password' ? 'Show password' : 'Hide password');
    input.focus();
  }));
  el.controlDialog.addEventListener('close', clearPasswordForm);
  $$('[data-danger]').forEach((b) => b.addEventListener('click', () => dangerAction(b.dataset.danger)));
  $('#qSave').addEventListener('click', () => saveQuickGrade(false));
  $('#qSaveNext').addEventListener('click', () => saveQuickGrade(true));

  $('#togglePw').addEventListener('click', () => {
    el.password.type = el.password.type === 'password' ? 'text' : 'password';
    el.password.focus();
  });

  $$('input[data-url]').forEach((input) =>
    input.addEventListener('blur', () => { input.value = withScheme(input.value); }));

  el.chips.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-filter]');
    if (!chip) return;
    state.filter = chip.dataset.filter;
    renderChips();
    renderView();
  });

  $('#viewSwitch').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (!btn) return;
    state.view = btn.dataset.view;
    store.set('mdc-view', state.view);
    renderView();
  });

  $('#deviceSwitch').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-device]');
    if (btn) setDevice(btn.dataset.device);
  });

  let searchTimer;
  el.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = el.search.value;
      renderView();
    }, 120);
  });

  el.view.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const { action, id } = target.dataset;
    if (action === 'preview' || action === 'grade') openPreview(id);
    else if (action === 'notes') openNotes(find(id));
    else if (action === 'edit') openSubmit(find(id));
    else if (action === 'delete') confirmDelete(find(id));
    else if (action === 'submit') openSubmit();
    else if (action === 'clear-filters') clearFilters();
    else if (action === 'member') {
      // Clicking the same student again turns the filter off.
      const member = target.dataset.member;
      if (state.query.trim().toLowerCase() === member.toLowerCase()) return clearFilters();
      el.search.value = member;
      state.query = member;
      state.filter = 'all';
      render();
    }
  });

  $('#sectionMeta').addEventListener('click', (e) => {
    if (e.target.closest('[data-clear-filters]')) clearFilters();
  });

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if (e.key === '/' && !typing && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      el.search.focus();
      el.search.select();
    } else if (e.key === 'Escape' && document.activeElement === el.search && el.search.value) {
      clearFilters();
    }
  });

  // Live refresh so faculty see new submissions without reloading.
  // Top bar gains a hairline after scrolling; the filter bar docks beneath it.
  const topbar = $('.topbar');
  const toolbar = $('#toolbar');
  function onScroll() {
    document.body.classList.toggle('scrolled', window.scrollY > 8);
    toolbar.classList.toggle('stuck', toolbar.getBoundingClientRect().top <= topbar.offsetHeight + 0.5);
  }
  function measureTopbar() {
    document.documentElement.style.setProperty('--topbar-h', `${topbar.offsetHeight}px`);
    onScroll();
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', measureTopbar);
  measureTopbar();

  setInterval(() => { if (!document.hidden) loadProjects({ silent: true }); }, 30000);
  // Keep the deadline countdown and open/closed state current between refreshes.
  setInterval(() => {
    if (document.hidden || !state.settings.deadline) return;
    renderChrome();
    if (el.controlDialog.open && state.controlTab === 'overview') renderOverview();
  }, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.loaded) loadProjects({ silent: true }); });

  /* ================================================================= init */

  $('#copyrightYear').textContent = new Date().getFullYear();
  renderRubric();
  setDevice(state.device);
  setToken(null, { reload: false });
  loadProjects();
})();
