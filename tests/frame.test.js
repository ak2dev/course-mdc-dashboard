'use strict';

// Unit tests for the iframe embedding check (X-Frame-Options and CSP frame-ancestors).
// Run with: npm run test:unit

const test = require('node:test');
const assert = require('node:assert/strict');
const { embedVerdict } = require('../lib/frame');

const DASH = 'https://course-dash.vercel.app';
const SITE = 'https://team-site.vercel.app/';
const verdict = (headers, embedder = DASH, site = SITE) => embedVerdict(headers, site, embedder);
const allowed = (csp, embedder) => verdict({ csp }, embedder).embeddable;

test('no framing headers: embeddable', () => {
  assert.deepEqual(verdict({}), { embeddable: true });
});

test('X-Frame-Options DENY and SAMEORIGIN block a different origin', () => {
  assert.deepEqual(verdict({ xfo: 'DENY' }), { embeddable: false, blockedBy: 'x-frame-options', header: 'DENY' });
  assert.equal(verdict({ xfo: 'sameorigin' }).embeddable, false);
  assert.equal(verdict({ xfo: 'DENY, SAMEORIGIN' }).embeddable, false);
  // SAMEORIGIN still allows the site's own origin; ALLOW-FROM is obsolete and ignored by browsers.
  assert.equal(verdict({ xfo: 'SAMEORIGIN' }, 'https://team-site.vercel.app').embeddable, true);
  assert.equal(verdict({ xfo: 'ALLOW-FROM https://course-dash.vercel.app' }).embeddable, true);
});

test("frame-ancestors 'none', 'self' and an empty list block the dashboard", () => {
  assert.deepEqual(verdict({ csp: "default-src 'self'; frame-ancestors 'none'" }),
    { embeddable: false, blockedBy: 'frame-ancestors', header: "frame-ancestors 'none'" });
  assert.equal(allowed("frame-ancestors 'self'"), false);
  assert.equal(allowed('frame-ancestors'), false);
});

test('frame-ancestors that lists the dashboard is embeddable', () => {
  assert.equal(allowed(`frame-ancestors 'self' ${DASH}`), true);
  assert.equal(allowed('frame-ancestors course-dash.vercel.app'), true);   // scheme taken from the site
  assert.equal(allowed('frame-ancestors https://*.vercel.app'), true);
  assert.equal(allowed('frame-ancestors https:'), true);
  assert.equal(allowed('frame-ancestors *'), true);
  assert.equal(allowed("frame-ancestors 'self' https://COURSE-DASH.vercel.app/"), true);
});

test('frame-ancestors rules that do not match the dashboard origin', () => {
  assert.equal(allowed('frame-ancestors https://other.vercel.app'), false);
  assert.equal(allowed('frame-ancestors *.vercel.app', 'https://vercel.app'), false);   // subdomains only
  assert.equal(allowed('frame-ancestors https://course-dash.vercel.app:8443'), false);
  assert.equal(allowed('frame-ancestors http:', 'https://course-dash.vercel.app'), true); // http upgrades to https
  assert.equal(allowed('frame-ancestors https:', 'http://localhost:3000'), false);
  assert.equal(allowed('frame-ancestors http://localhost:3000', 'http://localhost:3000'), true);
  assert.equal(allowed('frame-ancestors http://localhost', 'http://localhost:3000'), false);
  assert.equal(allowed('frame-ancestors localhost:*', 'http://localhost:3000'), false);  // takes the site's https
  assert.equal(allowed('frame-ancestors localhost:*', 'https://localhost:3000'), true);
  // Ancestors are matched as origins, so a source with a deeper path never matches.
  assert.equal(allowed('frame-ancestors https://course-dash.vercel.app/grading'), false);
});

test('frame-ancestors overrides X-Frame-Options, and every policy must allow', () => {
  assert.equal(verdict({ csp: `frame-ancestors ${DASH}`, xfo: 'DENY' }).embeddable, true);
  assert.equal(verdict({ csp: `frame-ancestors ${DASH}, frame-ancestors 'none'` }).embeddable, false);
  assert.equal(verdict({ csp: `default-src 'self', frame-ancestors ${DASH}` }).embeddable, true);
  // Only the first frame-ancestors directive in a policy counts.
  assert.equal(verdict({ csp: `frame-ancestors ${DASH}; frame-ancestors 'none'` }).embeddable, true);
});

test('unknown embedder origin: only a bare * allows embedding', () => {
  assert.equal(allowed(`frame-ancestors ${DASH}`, ''), false);
  assert.equal(allowed('frame-ancestors *', ''), true);
});
