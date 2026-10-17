'use strict';

// End-to-end API smoke test. Runs against a live server and cleans up after itself:
// test projects are deleted and Control Center settings are restored.
//
//   npm test                                   -> http://localhost:3000
//   BASE_URL=https://your-app.vercel.app npm test
//
// The faculty password is read from TEACHER_PASSWORD (environment or .env.local).

const path = require('path');

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env.local'));
} catch { /* optional */ }

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const PW = process.env.TEACHER_PASSWORD || 'mdc@teacher2026';
const stamp = Date.now().toString(36);
let failures = 0;

async function call(method, route, { body, token } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers['x-teacher-token'] = token;
  const res = await fetch(BASE + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);
  if (!cond) failures++;
}

async function login() {
  const res = await call('POST', '/api/auth/login', { body: { password: PW } });
  if (res.status !== 200) throw new Error(`Faculty login failed (${res.status}): ${res.data.error}`);
  return res.data.token;
}

const team = (label, members) => ({
  teamName: `Test ${label} ${stamp}`,
  title: 'Smoke test',
  members: members.map((m) => `${m} ${stamp}`),
});

async function coreSuite() {
  console.log('\n— Core API');
  const health = await call('GET', '/api/health');
  check('health', health.status === 200, JSON.stringify(health.data));

  const page = await fetch(`${BASE}/`);
  check('index served with CSP', page.status === 200 && /frame-ancestors/.test(page.headers.get('content-security-policy') || ''));

  check('unauth PATCH -> 401', (await call('PATCH', '/api/projects/x', { body: {} })).status === 401);
  check('bad password -> 401', (await call('POST', '/api/auth/login', { body: { password: `wrong-${stamp}` } })).status === 401);

  const token = await login();
  check('login', /^[a-f0-9]{64}$/.test(token));
  check('session valid', (await call('GET', '/api/auth/session', { token })).data.authenticated === true);

  const created = await call('POST', '/api/projects', {
    body: { ...team('Core', ['Alpha', 'Beta']), vercelUrl: 'smoke.vercel.app', githubUrl: 'github.com/x/y', score: 10 },
  });
  const id = created.data.project?.id;
  check('student submit ignores score + prefixes URL',
    created.status === 201 && created.data.project.score === null && created.data.project.vercelUrl === 'https://smoke.vercel.app/',
    String(created.status));

  const dupMember = await call('POST', '/api/projects', { body: { teamName: `Other ${stamp}`, title: 'X', members: [`alpha ${stamp}`] } });
  check('duplicate student -> 409', dupMember.status === 409, dupMember.data.error);
  const dupTeam = await call('POST', '/api/projects', { body: { teamName: `test core ${stamp}`, title: 'X', members: [`New ${stamp}`] } });
  check('duplicate team -> 409', dupTeam.status === 409, dupTeam.data.error);

  check('web submission defaults to type "web"', created.data.project?.type === 'web');
  const app = await call('POST', '/api/projects', {
    body: { ...team('App', ['Gamma']), type: 'app', demoUrl: 'drive.google.com/file/d/1AbCdEfGhIjKlMnOpQr/view', vercelUrl: 'ignored.vercel.app' },
  });
  const appId = app.data.project?.id;
  check('desktop/mobile app: Drive demo stored, deployment link dropped',
    app.status === 201 && app.data.project.type === 'app' &&
    app.data.project.demoUrl === 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQr/view' && app.data.project.vercelUrl === '',
    String(app.status));
  const notDrive = await call('POST', '/api/projects', { body: { ...team('App2', ['Delta']), type: 'app', demoUrl: 'youtube.com/watch?v=x' } });
  check('non-Drive demo link -> 400', notDrive.status === 400, notDrive.data.error);
  check('unknown project type -> 400', (await call('POST', '/api/projects', { body: { ...team('App3', ['Eps']), type: 'mobile' } })).status === 400);

  const graded = await call('PATCH', `/api/projects/${id}`, { token, body: { score: 8.46, reviewerNotes: 'smoke' } });
  check('grade rounds to 8.5', graded.status === 200 && graded.data.project.score === 8.5 && graded.data.project.status === 'graded');
  check('score 11 -> 400', (await call('PATCH', `/api/projects/${id}`, { token, body: { score: 11 } })).status === 400);

  const mine = (await call('GET', '/api/projects')).data.projects.find((p) => p.id === id);
  check('public list hides notes + internal keys', mine && !('reviewerNotes' in mine) && !('teamKey' in mine) && !('_id' in mine));
  const priv = await call('GET', '/api/projects', { token });
  check('faculty list includes notes', priv.data.teacher === true && priv.data.projects.find((p) => p.id === id)?.reviewerNotes === 'smoke');

  check('CSV unauth -> 401', (await call('GET', '/api/export/csv')).status === 401);
  const csv = await call('GET', '/api/export/csv', { token });
  check('CSV export', csv.status === 200 && String(csv.data).includes(`Test Core ${stamp}`));
  check('CSV includes project type + demo video columns',
    /Project Type/.test(String(csv.data)) && String(csv.data).includes('Desktop / mobile app') && String(csv.data).includes('drive.google.com/file/d/1AbCdEfGhIjKlMnOpQr'));
  check('delete desktop/mobile app', (await call('DELETE', `/api/projects/${appId}`, { token })).status === 200);

  const fc = await call('GET', `/api/frame-check?url=${encodeURIComponent('https://github.com')}`);
  check('frame-check detects blocked embedding', fc.status === 200 && fc.data.embeddable === false);

  check('delete', (await call('DELETE', `/api/projects/${id}`, { token })).status === 200);
  check('delete again -> 404', (await call('DELETE', `/api/projects/${id}`, { token })).status === 404);

  await call('POST', '/api/auth/logout', { token });
  check('logout revokes session', (await call('GET', '/api/auth/session', { token })).data.authenticated === false);
}

async function controlSuite() {
  console.log('\n— Control Center');
  let token = await login();
  const created = [];
  const initial = (await call('GET', '/api/projects')).data;
  const s0 = initial.settings;
  check('settings exposed', s0 && typeof s0.accepting === 'boolean' && Number.isInteger(s0.capacity), JSON.stringify(s0));

  const restore = {
    courseName: s0.courseName, submissionsOpen: s0.submissionsOpen, deadline: s0.deadline, capacity: s0.capacity,
    maxTeamSize: s0.maxTeamSize, resultsPublished: s0.resultsPublished, announcement: s0.announcement,
  };

  try {
    check('settings PATCH unauth -> 401', (await call('PATCH', '/api/admin/settings', { body: { submissionsOpen: false } })).status === 401);
    check('invalid capacity -> 400', (await call('PATCH', '/api/admin/settings', { token, body: { capacity: 0 } })).status === 400);
    check('invalid boolean -> 400', (await call('PATCH', '/api/admin/settings', { token, body: { submissionsOpen: 'no' } })).status === 400);
    check('invalid deadline -> 400', (await call('PATCH', '/api/admin/settings', { token, body: { deadline: 'soon' } })).status === 400);

    let r = await call('PATCH', '/api/admin/settings', { token, body: { submissionsOpen: false, deadline: null } });
    check('close submissions', r.status === 200 && r.data.settings.accepting === false);
    r = await call('POST', '/api/projects', { body: team('A', ['Ann', 'Bo']) });
    check('student blocked when closed -> 403', r.status === 403, r.data.error);
    r = await call('POST', '/api/projects', { token, body: team('B', ['Cy']) });
    check('faculty can still add when closed', r.status === 201);
    if (r.data.project) created.push(r.data.project.id);

    r = await call('PATCH', '/api/admin/settings', { token, body: { submissionsOpen: true, deadline: new Date(Date.now() - 60_000).toISOString() } });
    check('past deadline -> not accepting', r.data.settings.accepting === false);
    r = await call('POST', '/api/projects', { body: team('C', ['Di']) });
    check('student blocked after deadline', r.status === 403 && /deadline/i.test(r.data.error), r.data.error);

    r = await call('PATCH', '/api/admin/settings', { token, body: { deadline: new Date(Date.now() + 864e5).toISOString(), maxTeamSize: 2, capacity: 500 } });
    check('future deadline -> accepting', r.data.settings.accepting === true && r.data.settings.maxTeamSize === 2);
    r = await call('POST', '/api/projects', { body: team('D', ['Ed', 'Fi', 'Gu']) });
    check('team size limit enforced -> 400', r.status === 400 && /at most 2/.test(r.data.error), r.data.error);
    r = await call('POST', '/api/projects', { body: team('E', ['Hal', 'Ida']) });
    check('student submit within limits', r.status === 201);
    const studentId = r.data.project?.id;
    if (studentId) created.push(studentId);

    const enrolled = new Set((await call('GET', '/api/projects')).data.projects.flatMap((p) => p.members.map((m) => m.toLowerCase()))).size;
    await call('PATCH', '/api/admin/settings', { token, body: { capacity: enrolled } });
    r = await call('POST', '/api/projects', { body: team('F', ['Jo']) });
    check('capacity enforced -> 409', r.status === 409 && /capacity/i.test(r.data.error), r.data.error);

    await call('PATCH', `/api/projects/${studentId}`, { token, body: { score: 9.2 } });
    await call('PATCH', '/api/admin/settings', { token, body: { resultsPublished: false } });
    const pub = (await call('GET', '/api/projects')).data.projects.find((p) => p.id === studentId);
    const fac = (await call('GET', '/api/projects', { token })).data.projects.find((p) => p.id === studentId);
    check('hidden results: students see no score', pub.score === null && pub.status === 'pending');
    check('hidden results: faculty still see score', fac.score === 9.2);
    await call('PATCH', '/api/admin/settings', { token, body: { resultsPublished: true } });
    check('published: students see score', (await call('GET', '/api/projects')).data.projects.find((p) => p.id === studentId).score === 9.2);

    r = await call('PATCH', '/api/admin/settings', { token, body: { announcement: '  Demo   day is Friday  ', courseName: 'MDC Test' } });
    check('announcement + name normalised', r.data.settings.announcement === 'Demo day is Friday' && r.data.settings.courseName === 'MDC Test');

    check('activity unauth -> 401', (await call('GET', '/api/admin/activity')).status === 401);
    const act = (await call('GET', '/api/admin/activity?limit=60', { token })).data.activity;
    const kinds = new Set(act.map((a) => a.action));
    check('activity records actions', ['login', 'settings', 'submit', 'grade'].every((k) => kinds.has(k)), [...kinds].join(','));
    check('activity newest first', act.length > 1 && act[0].at >= act[act.length - 1].at);

    // Password changes: only the guards are exercised, so the real password is never changed.
    check('security status unauth -> 401', (await call('GET', '/api/admin/security')).status === 401);
    const sec = await call('GET', '/api/admin/security', { token });
    check('security status reports password state', sec.status === 200 && typeof sec.data.customPassword === 'boolean' && typeof sec.data.usingDefault === 'boolean');
    check('change password unauth -> 401', (await call('POST', '/api/admin/password', { body: { currentPassword: PW, newPassword: 'x' } })).status === 401);
    check('wrong current password -> 403',
      (await call('POST', '/api/admin/password', { token, body: { currentPassword: `wrong-${stamp}`, newPassword: `Fresh-${stamp}-pass` } })).status === 403);
    const weak = await call('POST', '/api/admin/password', { token, body: { currentPassword: PW, newPassword: 'short' } });
    check('weak new password -> 400', weak.status === 400, weak.data.error);
    const dflt = await call('POST', '/api/admin/password', { token, body: { currentPassword: PW, newPassword: 'mdc@teacher2026' } });
    check('default as new password -> 400', dflt.status === 400 || dflt.status === 403, dflt.data.error);

    check('reset scores needs RESET',(await call('POST', '/api/admin/reset-scores', { token, body: {} })).status === 400);
    check('delete-all needs DELETE', (await call('POST', '/api/admin/delete-all', { token, body: { confirm: 'delete' } })).status === 400);

    // Signing everyone out would disrupt real faculty, so only exercise it locally.
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:|$|\/)/.test(BASE)) {
      r = await call('POST', '/api/admin/revoke-sessions', { token });
      check('revoke sessions', r.status === 200 && r.data.count >= 1);
      check('old token rejected after revoke', (await call('GET', '/api/auth/session', { token })).data.authenticated === false);
      token = await login();
    }
  } finally {
    for (const id of created) await call('DELETE', `/api/projects/${id}`, { token });
    await call('PATCH', '/api/admin/settings', { token, body: restore });
    const end = (await call('GET', '/api/projects')).data;
    check('cleanup restored projects + settings',
      end.projects.length === initial.projects.length && JSON.stringify(end.settings) === JSON.stringify(s0));
    await call('POST', '/api/auth/logout', { token });
  }
}

(async () => {
  console.log(`Testing ${BASE}`);
  await coreSuite();
  await controlSuite();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
