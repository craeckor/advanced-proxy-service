import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSetCookie,
  rewriteSetCookie,
  rewriteCookieRequestHeader,
  cookieNamespaceFor,
} from '../src/proxy/cookies/rewrite.ts';

const options = {
  pathPrefix: '/',
  namespace: cookieNamespaceFor('https://example.com'),
  proxyIsSecure: false,
};

test('parses a representative Set-Cookie', () => {
  const cookie = parseSetCookie('sid=xyz; Domain=.example.com; Path=/app; Secure; HttpOnly; SameSite=Strict; Max-Age=3600');
  assert.ok(cookie);
  assert.equal(cookie.name, 'sid');
  assert.equal(cookie.value, 'xyz');
  assert.equal(cookie.domain, '.example.com');
  assert.equal(cookie.path, '/app');
  assert.equal(cookie.secure, true);
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, 'Strict');
  assert.equal(cookie.maxAge, '3600');
});

test('rejects a Set-Cookie with no name/value pair', () => {
  assert.equal(parseSetCookie('novalue'), null);
  assert.equal(parseSetCookie(''), null);
});

test('rewrites Domain away and scopes Path to the proxy', () => {
  const out = rewriteSetCookie('sid=1; Domain=example.com; Path=/deep', options);
  assert.ok(out);
  assert.doesNotMatch(out, /Domain=/);
  assert.match(out, /Path=\//);
});

test('namespaces the cookie name per origin', () => {
  const a = rewriteSetCookie('sid=1', { ...options, namespace: cookieNamespaceFor('https://a.test') });
  const b = rewriteSetCookie('sid=1', { ...options, namespace: cookieNamespaceFor('https://b.test') });
  assert.ok(a && b);
  assert.notEqual(a.split('=')[0], b.split('=')[0]);
});

test('the same origin yields a stable namespace', () => {
  assert.equal(cookieNamespaceFor('https://example.com'), cookieNamespaceFor('https://example.com'));
});

test('strips the __Host- prefix, which the browser would otherwise reject', () => {
  const out = rewriteSetCookie('__Host-sid=1; Path=/; Secure', options);
  assert.ok(out);
  assert.doesNotMatch(out, /__Host-/);
  assert.match(out, /sid=1/);
});

test('strips the __Secure- prefix', () => {
  const out = rewriteSetCookie('__Secure-token=abc; Secure', options);
  assert.ok(out);
  assert.doesNotMatch(out, /__Secure-/);
  assert.match(out, /token=abc/);
});

test('adds Secure and SameSite=None when the proxy itself is secure', () => {
  const out = rewriteSetCookie('sid=1', { ...options, proxyIsSecure: true });
  assert.ok(out);
  assert.match(out, /Secure/);
  assert.match(out, /SameSite=None/);
});

test('does not loosen SameSite when the proxy is plain HTTP', () => {
  // SameSite=None requires Secure, and declaring Secure on a plain-HTTP origin
  // means the browser drops the cookie entirely.
  const out = rewriteSetCookie('sid=1; SameSite=Strict', options);
  assert.ok(out);
  assert.doesNotMatch(out, /SameSite=None/);
  assert.match(out, /SameSite=Strict/);
});

test('preserves Max-Age and Expires', () => {
  const out = rewriteSetCookie('sid=1; Max-Age=60; Expires=Wed, 21 Oct 2026 07:28:00 GMT', options);
  assert.match(out ?? '', /Max-Age=60/);
  assert.match(out ?? '', /Expires=Wed, 21 Oct 2026 07:28:00 GMT/);
});

test('request cookies have the namespace stripped before going upstream', () => {
  const namespace = cookieNamespaceFor('https://example.com');
  const inbound = `${namespace}sid=1; other=2`;
  const out = rewriteCookieRequestHeader(inbound, namespace);
  assert.match(out, /(^|; )sid=1/);
  assert.match(out, /other=2/);
  assert.doesNotMatch(out, new RegExp(namespace));
});

test('a cookie from a different namespace is left untouched', () => {
  const namespace = cookieNamespaceFor('https://example.com');
  const other = cookieNamespaceFor('https://other.test');
  const out = rewriteCookieRequestHeader(`${other}x=1`, namespace);
  assert.equal(out, `${other}x=1`);
});
