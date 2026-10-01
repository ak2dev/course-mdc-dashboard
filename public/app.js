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

  const state = {
    projects: [],
    capacity: 64,
    token: null, // kept in memory only
    loaded: false,
    view: ['table', 'grid', 'leaderboard'].includes(store.get('mdc-view')) ? store.get('mdc-view') : 'table',
    filter: 'all',
    query: '',
    device: DEVICES[store.get('mdc-device')] ? store.get('mdc-device') : 'desktop',
    previewId: null,
    editingId: null,
    deletingId: null,
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

  function initials(name) {
    const parts = name.trim().split(/\s+/);
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
      const payload = JSON.stringify(data.projects);
      state.capacity = data.capacity || 64;
      const changed = payload !== state.lastPayload || !state.loaded;
      state.lastPayload = payload;
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
    renderStats();
    renderChips();
    renderView();
  }

  function renderStats() {
    const s = computeStats();
    const cap = state.capacity;
    const pct = Math.min(100, Math.round((s.students / cap) * 100));
    const avgTier = tierOf(s.avg);
    el.stats.innerHTML = `
      <article class="card stat capacity">
        <div class="stat-head"><span>Course enrollment</span><span class="stat-icon">${icon('users')}</span></div>
        <div class="stat-value">${s.students}<small>/ ${cap} students registered</small></div>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${cap}" aria-valuenow="${s.students}"><span style="width:${pct}%"></span></div>
        <div class="progress-ticks"><span>${pct}% of cohort</span><span>${Math.max(0, cap - s.students)} seats remaining</span></div>
      </article>
      <article class="card stat">
        <div class="stat-head"><span>Teams</span><span class="stat-icon">${icon('layers')}</span></div>
        <div class="stat-value">${s.teams}</div>
        <div class="stat-sub"><strong>${s.avgTeam ? s.avgTeam.toFixed(1) : '0'}</strong> members per team</div>
      </article>
      <article class="card stat">
        <div class="stat-head"><span>Graded</span><span class="stat-icon">${icon('check')}</span></div>
        <div class="stat-value">${s.graded}<small>/ ${s.teams}</small></div>
        <div class="stat-sub">${s.teams ? Math.round((s.graded / s.teams) * 100) : 0}% evaluated</div>
      </article>
      <article class="card stat">
        <div class="stat-head"><span>Pending review</span><span class="stat-icon">${icon('clock')}</span></div>
        <div class="stat-value">${s.pending}</div>
        <div class="stat-sub">${s.pending ? 'awaiting faculty review' : 'all caught up'}</div>
      </article>
      <article class="card stat tier-${avgTier.key}">
        <div class="stat-head"><span>Class average</span><span class="stat-icon">${icon('star')}</span></div>
        <div class="stat-value">${fmtScore(s.avg)}<small>/ 10</small></div>
        <div class="stat-sub">${s.avg === null ? 'No scores yet' : `<span class="stat-tier">${esc(avgTier.label)}</span>`}</div>
      </article>`;
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

  function renderView() {
    $$('#viewSwitch button').forEach((b) => {
      const on = b.dataset.view === state.view;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on);
    });

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

  function evalCell(p) {
    const inner = `${badge(p.score)}<span class="score ${p.score === null ? 'empty' : ''}">${fmtScore(p.score)}</span>`;
    return isTeacher()
      ? `<button type="button" class="eval" data-action="grade" data-id="${p.id}" title="Grade in preview">${inner}</button>`
      : `<span class="eval">${inner}</span>`;
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
            <th>Deployment</th><th>Repository</th><th>Evaluation</th>
            <th class="col-actions teacher-only">Actions</th>
          </tr></thead>
          <tbody>${list.map((p, i) => `
            <tr style="animation-delay:${Math.min(i, 20) * 22}ms">
              <td><span class="seq">${seqLabel(seq.get(p.id))}</span></td>
              <td class="team-cell"><strong>${esc(p.teamName)}</strong><time datetime="${esc(p.createdAt)}" title="${esc(absTime(p.createdAt))}">Submitted ${relTime(p.createdAt)}</time></td>
              <td class="members-cell">${memberChips(p.members, 2)}</td>
              <td class="project-cell"><strong>${esc(p.title)}</strong>${p.techStack ? `<span class="stack" title="${esc(p.techStack)}">${esc(p.techStack)}</span>` : ''}</td>
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
              <p class="p-title">${esc(p.title)}</p>
            </div>
            ${ring(p.score, 56, 4)}
          </div>
          <div>${badge(p.score)}</div>
          ${techs.length ? `<div class="tags-row">${techs.map((s) => `<span class="tech">${esc(s)}</span>`).join('')}</div>` : ''}
          <div class="p-card-members">
            <div class="label">${icon('users')} ${p.members.length} member${p.members.length === 1 ? '' : 's'}</div>
            ${memberChips(p.members)}
          </div>
          <div class="p-card-foot">
            <button type="button" class="btn btn-secondary btn-sm" data-action="preview" data-id="${p.id}" ${p.vercelUrl ? '' : 'disabled'}>${icon('eye')} Preview</button>
            ${p.vercelUrl ? `<a class="icon-btn sm" href="${esc(p.vercelUrl)}" target="_blank" rel="noopener noreferrer" title="Open live site">${icon('external')}</a>` : ''}
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
          ${p.vercelUrl ? `<button type="button" class="icon-btn sm" data-action="preview" data-id="${p.id}" title="Preview">${icon('eye')}</button>` : ''}
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
        if (!tags.some((t) => t.toLowerCase() === name.toLowerCase()) && tags.length < 8) tags.push(name);
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
        if (tags.length >= 8 && input.value.trim()) toast('Team is full', 'A team can have at most 8 members.', 'info');
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

  function openSubmit(project = null) {
    state.editingId = project?.id || null;
    const f = el.submitForm;
    f.reset();
    $$('.field.invalid', f).forEach((n) => n.classList.remove('invalid'));
    $('#submitKicker').textContent = project ? 'Faculty · Edit' : 'New submission';
    $('#submitTitle').textContent = project ? `Edit ${project.teamName}` : 'Submit your project';
    $('.btn-label', el.submitSave).textContent = project ? 'Save changes' : 'Submit project';
    f.teamName.value = project?.teamName || '';
    $('#fTitle').value = project?.title || '';
    f.techStack.value = project?.techStack || '';
    f.vercelUrl.value = project?.vercelUrl || '';
    f.githubUrl.value = project?.githubUrl || '';
    f.reviewerNotes.value = project?.reviewerNotes || '';
    members.set(project?.members || []);
    formScore.set(project?.score ?? null);
    el.submitDialog.showModal();
    setTimeout(() => f.teamName.focus(), 30);
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (el.submitSave.disabled) return;
    const f = el.submitForm;
    members.commit();

    f.vercelUrl.value = withScheme(f.vercelUrl.value);
    f.githubUrl.value = withScheme(f.githubUrl.value);

    const payload = {
      teamName: f.teamName.value.trim(),
      title: $('#fTitle').value.trim(),
      members: members.get(),
      techStack: f.techStack.value.trim(),
      vercelUrl: f.vercelUrl.value,
      githubUrl: f.githubUrl.value,
    };

    const errors = [];
    const flag = (node, msg) => { node.closest('.field').classList.add('invalid'); errors.push([node, msg]); };
    $$('.field.invalid', f).forEach((n) => n.classList.remove('invalid'));
    if (!payload.teamName) flag(f.teamName, 'Team name is required.');
    if (!payload.title) flag($('#fTitle'), 'Project title is required.');
    if (!payload.members.length) flag($('#fMemberInput'), 'Add at least one team member.');
    if (payload.vercelUrl && !validUrl(payload.vercelUrl)) flag(f.vercelUrl, 'Deployment URL is not valid.');
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

  /* =============================================================== delete */

  function confirmDelete(project) {
    if (!project) return;
    state.deletingId = project.id;
    $('#confirmText').textContent = `“${project.teamName} — ${project.title}” and its evaluation will be permanently removed.`;
    el.confirmDialog.showModal();
  }

  async function doDelete() {
    const btn = $('#confirmOk');
    const project = find(state.deletingId);
    if (!project || btn.disabled) return;
    setBusy(btn, true, 'Deleting…');
    try {
      await api(`/api/projects/${project.id}`, { method: 'DELETE' });
      el.confirmDialog.close();
      toast('Project deleted', `${project.teamName} was removed.`, 'success');
      await loadProjects();
    } catch (err) {
      toast('Could not delete project', err.message, 'error');
    } finally {
      setBusy(btn, false);
    }
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
    $('#previewProject').textContent = p.title;
    $('#previewOpen').href = p.vercelUrl;
    $('#frameBlockedOpen').href = p.vercelUrl;
    $('#deviceUrl').textContent = prettyUrl(p.vercelUrl);

    const t = tierOf(p.score);
    $('#previewEval').innerHTML = `${ring(p.score, 60, 5)}<div class="sp-text">${badge(p.score)}<small>${
      p.score === null ? 'Awaiting faculty review' : `${esc(t.range)} · ${esc(t.desc)}`}</small></div>`;

    $('#previewMembers').innerHTML = p.members.map((m) => `<div class="member-row">${avatar(m)}<span>${esc(m)}</span></div>`).join('');

    const rows = [
      ['Submitted', esc(absTime(p.createdAt))],
      ['Tech stack', esc(p.techStack || '—')],
      ['Live site', `<a href="${esc(p.vercelUrl)}" target="_blank" rel="noopener noreferrer">${esc(prettyUrl(p.vercelUrl))}</a>`],
      ['Repository', p.githubUrl ? `<a href="${esc(p.githubUrl)}" target="_blank" rel="noopener noreferrer">${esc(repoPath(p.githubUrl))}</a>` : '—'],
    ];
    if (p.gradedAt && isTeacher()) rows.push(['Last graded', esc(absTime(p.gradedAt))]);
    $('#previewDetails').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');

    quickScore.set(p.score);
    $('#qNotes').value = p.reviewerNotes || '';
    $('#qSaveNext').disabled = !nextPending(p.id);
  }

  async function loadFrame(url) {
    const token = ++frameToken;
    el.frameLoading.classList.remove('done');
    el.frameBlocked.hidden = true;
    el.frame.src = 'about:blank';
    requestAnimationFrame(() => { if (token === frameToken) el.frame.src = url; });

    const done = () => { if (token === frameToken) el.frameLoading.classList.add('done'); };
    el.frame.onload = () => { if (el.frame.src !== 'about:blank') done(); };
    setTimeout(done, 12000);

    try {
      const check = await api(`/api/frame-check?url=${encodeURIComponent(url)}`);
      if (token !== frameToken) return;
      if (!check.embeddable) {
        $('#frameBlockedReason').textContent = `${check.reason} Open the deployment directly to review it.`;
        el.frameBlocked.hidden = false;
        done();
      } else if (check.error === 'unreachable') {
        toast('Deployment may be offline', 'The server could not reach this URL. The preview may not load.', 'info');
      }
    } catch { /* the iframe still attempts to load */ }
  }

  function openPreview(id) {
    const p = find(id);
    if (!p) return;
    if (!p.vercelUrl) {
      toast('No live deployment', `${p.teamName} hasn't submitted a deployment URL yet.`, 'info');
      if (isTeacher()) openSubmit(p);
      return;
    }
    state.previewId = id;
    fillPreview(p);
    setDevice(state.device);
    loadFrame(p.vercelUrl);
    if (!el.previewDialog.open) el.previewDialog.showModal();
  }

  function nextPending(currentId) {
    const list = state.projects;
    const start = list.findIndex((p) => p.id === currentId);
    for (let i = 1; i < list.length; i++) {
      const p = list[(start + i) % list.length];
      if (p.score === null && p.vercelUrl && p.id !== currentId) return p;
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
  $$('dialog.modal').forEach((dlg) => {
    let downOnBackdrop = false;
    dlg.addEventListener('mousedown', (e) => { downOnBackdrop = e.target === dlg; });
    dlg.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) return dlg.close();
      if (e.target === dlg && downOnBackdrop) dlg.close();
    });
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
  $('#submitBtn').addEventListener('click', () => openSubmit());
  $$('[data-open="rubric"]').forEach((b) => b.addEventListener('click', () => el.rubricDialog.showModal()));
  $$('[data-export]').forEach((b) => b.addEventListener('click', exportCsv));

  el.submitForm.addEventListener('submit', onSubmit);
  el.loginForm.addEventListener('submit', onLogin);
  $('#confirmOk').addEventListener('click', doDelete);
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
    else if (action === 'edit') openSubmit(find(id));
    else if (action === 'delete') confirmDelete(find(id));
    else if (action === 'submit') openSubmit();
    else if (action === 'clear-filters') clearFilters();
    else if (action === 'member') {
      el.search.value = target.dataset.member;
      state.query = target.dataset.member;
      state.filter = 'all';
      render();
      window.scrollTo({ top: el.search.getBoundingClientRect().top + window.scrollY - 120, behavior: 'smooth' });
    }
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
  setInterval(() => { if (!document.hidden) loadProjects({ silent: true }); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.loaded) loadProjects({ silent: true }); });

  /* ================================================================= init */

  renderRubric();
  setDevice(state.device);
  setToken(null, { reload: false });
  loadProjects();
})();
