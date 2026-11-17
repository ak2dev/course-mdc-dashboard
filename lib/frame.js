'use strict';

// Decides from a site's response headers whether a browser will let the dashboard
// show it in an iframe. Follows CSP Level 3 frame-ancestors matching: when any
// enforced policy has frame-ancestors, X-Frame-Options is ignored, as browsers do.

const SCHEME_SOURCE = /^[a-z][a-z0-9+.-]*:$/;
const HOST_SOURCE = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\d+|\*))?(\/.*)?$/;

const defaultPort = (protocol) => ({ 'http:': '80', 'https:': '443' })[protocol] || '';

// A scheme matches itself, and http also matches https (the CSP upgrade rule).
const schemeMatches = (scheme, protocol) => scheme === protocol || (scheme === 'http:' && protocol === 'https:');

// Does one frame-ancestors source expression allow the embedding page's origin?
function sourceAllows(source, ancestor, framed) {
  const src = source.toLowerCase();
  if (src === "'none'") return false;
  if (src === "'self'") return ancestor.origin === framed.origin;
  if (src === '*') return ancestor.protocol === 'http:' || ancestor.protocol === 'https:';
  if (SCHEME_SOURCE.test(src)) return schemeMatches(src, ancestor.protocol);

  const m = HOST_SOURCE.exec(src);
  if (!m) return false;
  const [, scheme, host, port, path] = m;
  // Ancestors are compared as bare origins (path "/"), so a source with a deeper path never matches.
  if (path && path !== '/') return false;
  // A source without a scheme takes the framed site's scheme.
  if (!schemeMatches(scheme ? `${scheme}:` : framed.protocol, ancestor.protocol)) return false;
  const name = ancestor.hostname;
  // "*.example.com" matches subdomains only, never example.com itself.
  if (host !== '*' && !(host.startsWith('*.') ? name.endsWith(host.slice(1)) : name === host)) return false;
  if (port === '*') return true;
  // No port in the source means the ancestor must use its scheme's default port.
  return port ? port === (ancestor.port || defaultPort(ancestor.protocol)) : !ancestor.port;
}

/**
 * @param {{ csp?: string, xfo?: string }} headers  Content-Security-Policy and X-Frame-Options values
 *   (several headers of one name arrive joined with ", ").
 * @param {string} framedUrl  Final URL of the framed page, after redirects.
 * @param {string} embedderOrigin  Origin of the page that hosts the iframe, e.g. https://example.vercel.app.
 * @returns {{ embeddable: boolean, blockedBy?: 'frame-ancestors' | 'x-frame-options', header?: string }}
 */
function embedVerdict({ csp = '', xfo = '' }, framedUrl, embedderOrigin) {
  const framed = new URL(framedUrl);
  let ancestor = null;
  try {
    ancestor = new URL(embedderOrigin);
  } catch { /* unknown embedder: only a bare * can allow it */ }
  const allows = (src) => (ancestor ? sourceAllows(src, ancestor, framed) : src === '*');

  // Each comma-separated policy is enforced on its own; the first frame-ancestors in a policy counts.
  const directives = csp.split(',')
    .map((policy) => policy.split(';').map((d) => d.trim()).find((d) => /^frame-ancestors(\s|$)/i.test(d)))
    .filter(Boolean);
  if (directives.length) {
    const blocking = directives.find((d) => !d.split(/\s+/).slice(1).some(allows));
    return blocking ? { embeddable: false, blockedBy: 'frame-ancestors', header: blocking } : { embeddable: true };
  }

  const value = xfo.trim().toLowerCase();
  const sameOrigin = Boolean(ancestor) && ancestor.origin === framed.origin;
  if (value.includes('deny') || (value.includes('sameorigin') && !sameOrigin)) {
    return { embeddable: false, blockedBy: 'x-frame-options', header: xfo.trim().toUpperCase() };
  }
  return { embeddable: true };
}

module.exports = { embedVerdict };
