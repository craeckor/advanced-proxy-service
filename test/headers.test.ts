import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hopByHopNames,
  stripHopByHop,
  hasAmbiguousFraming,
  ALWAYS_HOP_BY_HOP,
} from '../src/proxy/headers/hop-by-hop.ts';
import { rewriteResponseHeaders } from '../src/proxy/headers/response.ts';
import { splitSetCookieHeader } from '../src/proxy/headers/response.ts';
import { buildPassthroughRequestHeaders } from '../src/proxy/headers/request.ts';
import { parseConfig } from '../src/config.ts';

test('strips the canonical hop-by-hop set', () => {
  const headers = new Headers();
  for (const name of ALWAYS_HOP_BY_HOP) headers.set(name, 'x');
  headers.set('content-type', 'text/html');

  stripHopByHop(headers);

  for (const name of ALWAYS_HOP_BY_HOP) {
    assert.equal(headers.has(name), false, `${name} should have been stripped`);
  }
  assert.equal(headers.get('content-type'), 'text/html');
});

test('strips headers nominated inside the Connection header', () => {
  const headers = new Headers();
  headers.set('connection', 'close, x-custom-hop');
  headers.set('x-custom-hop', 'secret');
  headers.set('x-keep', 'yes');

  stripHopByHop(headers);

  assert.equal(headers.has('x-custom-hop'), false);
  assert.equal(headers.get('x-keep'), 'yes');
});

test('hopByHopNames reads from a plain header object case-insensitively', () => {
  const names = hopByHopNames({ Connection: 'X-Foo', 'Content-Type': 'text/html' });
  assert.ok(names.has('x-foo'));
  assert.ok(names.has('content-type') === false);
});

test('detects CL.TE and TE.CL ambiguity', () => {
  const both = new Headers();
  both.set('content-length', '10');
  both.set('transfer-encoding', 'chunked');
  assert.equal(hasAmbiguousFraming(both), true);

  const onlyLength = new Headers();
  onlyLength.set('content-length', '10');
  assert.equal(hasAmbiguousFraming(onlyLength), false);

  const onlyEncoding = new Headers();
  onlyEncoding.set('transfer-encoding', 'chunked');
  assert.equal(hasAmbiguousFraming(onlyEncoding), false);
});

test('detects conflicting duplicate Content-Length values', () => {
  const headers = new Headers();
  headers.set('content-length', '10, 20');
  assert.equal(hasAmbiguousFraming(headers), true);

  const agreeing = new Headers();
  agreeing.set('content-length', '10, 10');
  assert.equal(hasAmbiguousFraming(agreeing), false);
});

const rewriteOptions = {
  codec: 'plain' as const,
  targetOrigin: 'https://example.com',
  targetUrl: 'https://example.com/original/page',
  cookiePathPrefix: '/',
  proxyIsSecure: false,
  bodyRewritten: true,
};

test('strips CSP, XFO, COOP, COEP, CORP and HSTS from responses', () => {
  const headers = new Headers();
  headers.set('content-security-policy', "default-src 'self'");
  headers.set('content-security-policy-report-only', "default-src 'self'");
  headers.set('x-frame-options', 'DENY');
  headers.set('cross-origin-opener-policy', 'same-origin');
  headers.set('cross-origin-embedder-policy', 'require-corp');
  headers.set('cross-origin-resource-policy', 'same-origin');
  headers.set('strict-transport-security', 'max-age=31536000');

  rewriteResponseHeaders(headers, rewriteOptions);

  for (const name of [
    'content-security-policy',
    'content-security-policy-report-only',
    'x-frame-options',
    'cross-origin-opener-policy',
    'cross-origin-embedder-policy',
    'cross-origin-resource-policy',
    'strict-transport-security',
  ]) {
    assert.equal(headers.has(name), false, `${name} should have been stripped`);
  }
});

test('rewrites Location so the client stays on the proxy', () => {
  const headers = new Headers();
  headers.set('location', 'https://example.com/elsewhere');

  rewriteResponseHeaders(headers, rewriteOptions);

  const location = headers.get('location');
  assert.ok(location?.startsWith('/proxy/plain/'), `got ${location}`);
  assert.match(location ?? '', /https%3A%2F%2Fexample\.com%2Felsewhere/);
});

test('rewrites a relative Location by resolving it against the request URL', () => {
  // Regression: redirects very often use a bare path. Resolving it against the
  // proxy's own origin instead of the target would strand the browser.
  const headers = new Headers();
  headers.set('location', '/login');

  rewriteResponseHeaders(headers, rewriteOptions);

  const location = headers.get('location');
  assert.ok(location?.startsWith('/proxy/plain/'), `got ${location}`);
  assert.match(location ?? '', /https%3A%2F%2Fexample\.com%2Flogin/);
});

test('rewrites a relative Location with a path segment', () => {
  const headers = new Headers();
  headers.set('location', 'sibling');

  rewriteResponseHeaders(headers, rewriteOptions);

  assert.match(headers.get('location') ?? '', /https%3A%2F%2Fexample\.com%2Foriginal%2Fsibling/);
});

test('leaves a non-http Location scheme untouched', () => {
  const headers = new Headers();
  headers.set('location', 'mailto:admin@example.com');

  rewriteResponseHeaders(headers, rewriteOptions);

  assert.equal(headers.get('location'), 'mailto:admin@example.com');
});

test('drops framing headers when the body was rewritten', () => {
  const headers = new Headers();
  headers.set('content-length', '1234');
  headers.set('content-encoding', 'gzip');
  headers.set('etag', '"abc"');

  rewriteResponseHeaders(headers, rewriteOptions);

  assert.equal(headers.has('content-length'), false);
  assert.equal(headers.has('content-encoding'), false);
  assert.equal(headers.has('etag'), false);
});

test('keeps content-length when the body is untouched', () => {
  const headers = new Headers();
  headers.set('content-length', '1234');

  rewriteResponseHeaders(headers, { ...rewriteOptions, bodyRewritten: false });

  assert.equal(headers.get('content-length'), '1234');
});

test('rewrites Set-Cookie into a namespaced, proxy-scoped cookie', () => {
  const headers = new Headers();
  headers.append('set-cookie', 'session=abc; Domain=example.com; Path=/; HttpOnly; SameSite=Lax');

  rewriteResponseHeaders(headers, rewriteOptions);

  const cookies = headers.getSetCookie();
  assert.equal(cookies.length, 1);
  const cookie = cookies[0] ?? '';
  assert.match(cookie, /^p_[A-Za-z0-9_-]+_session=abc/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /HttpOnly/);
  // An unmodified Domain would be rejected by the browser as host-mismatched.
  assert.doesNotMatch(cookie, /Domain=example\.com/);
});

test('preserves repeated Set-Cookie headers rather than collapsing them', () => {
  const headers = new Headers();
  headers.append('set-cookie', 'a=1; Path=/');
  headers.append('set-cookie', 'b=2; Path=/');

  rewriteResponseHeaders(headers, rewriteOptions);

  assert.equal(headers.getSetCookie().length, 2);
});

test('splitSetCookieHeader does not split on a comma inside Expires', () => {
  const raw = 'a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT, b=2; Path=/';
  const parts = splitSetCookieHeader(raw);
  assert.equal(parts.length, 2);
  assert.match(parts[0] ?? '', /Expires=Wed, 21 Oct 2026 07:28:00 GMT/);
  assert.match(parts[1] ?? '', /^b=2/);
});

test('rewrites a Refresh header target', () => {
  const headers = new Headers();
  headers.set('refresh', '5; url=https://example.com/next');

  rewriteResponseHeaders(headers, rewriteOptions);

  const refresh = headers.get('refresh');
  assert.match(refresh ?? '', /^5; url=\/proxy\/plain\//);
});

test('leaves Access-Control and Referrer-Policy headers untouched', () => {
  const headers = new Headers();
  headers.set('access-control-allow-origin', '*');
  headers.set('referrer-policy', 'no-referrer');

  rewriteResponseHeaders(headers, rewriteOptions);

  assert.equal(headers.get('access-control-allow-origin'), '*');
  assert.equal(headers.get('referrer-policy'), 'no-referrer');
});

// --- the default User-Agent -------------------------------------------------

/**
 * A request with no `User-Agent` is not a neutral request.
 *
 * Adobe's edge answers one with a 7-byte `OK Bot.` body and a `200`, which
 * renders as a blank white page. The proxy's own fetches are the ones that hit
 * it: a browser always sends a `User-Agent` on a navigation, while the crawler
 * and the capture ingest build their headers from an empty set.
 */

const proxyConfig = parseConfig({ log: { level: 'silent' } }).proxy;

test('REGRESSION: a request with no client User-Agent still sends one upstream', () => {
  // The crawler's exact call: an empty client-header set.
  const headers = buildPassthroughRequestHeaders({}, new URL('https://www.adobe.com/'), proxyConfig);
  const ua = headers.get('user-agent');
  assert.ok(ua !== null, 'a User-Agent must always be sent');
  assert.match(ua, /Mozilla\/5\.0/, 'it must be a browser string, not a product token');
  assert.doesNotMatch(ua, /^node$/i, 'undici\'s default is exactly what origins reject');
});

test('a client User-Agent is forwarded unchanged, not replaced', () => {
  // The whole point of mimicking the client is that the origin answers as it
  // would to that browser, so the default must never override a real one.
  const headers = buildPassthroughRequestHeaders(
    { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Custom/1.0' },
    new URL('https://example.com/'),
    proxyConfig,
  );
  assert.equal(headers.get('user-agent'), 'Mozilla/5.0 (X11; Linux x86_64) Custom/1.0');
});

test('the default User-Agent applies even when header mimicry is off', () => {
  // Deliberately unconditional. `mimicClientHeaders: false` means "do not copy
  // the client's headers", not "send a request no browser would send" — and a
  // request with no `User-Agent` is exactly the one origins answer with a bot
  // page. The crawler and the capture ingest both start from an empty header
  // set, so this is their normal path rather than an edge case.
  const off = parseConfig({ log: { level: 'silent' }, proxy: { mimicClientHeaders: false } }).proxy;
  const headers = buildPassthroughRequestHeaders({}, new URL('https://example.com/'), off);
  assert.match(headers.get('user-agent') ?? '', /Mozilla\/5\.0/);
});
