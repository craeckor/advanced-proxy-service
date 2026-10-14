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
