import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderUrlDiff } from '../src/archive/replay.ts';

/**
 * The miss page's diff.
 *
 * Unit-tested rather than only end-to-end because the interesting case needs a
 * URL longer than a test fixture would naturally produce: two URLs that agree for
 * hundreds of characters and then differ in one place. That is the exact shape
 * that reads as identical to a human, and so the exact shape the diff exists for.
 */

const PREFIX = 'https://www.google.com/search?q=send+with+curl+in+powershell&sxsrf=APpeQntYmOMQpanPG8z5k77EvwjZhDRMtQ%3A1791749301259&udm=50&vsint=&aep=1&ntc=1&cs=1&mstk=AUtExfCzJHKmRCB71Zs4';

test('a near miss is elided so the two lines stay comparable', () => {
  const requested = `${PREFIX}&csuir=1&mtid=t-zLauP7MYWD9u8PspjjKQ&sei=Fu3LarDWJMzx7_UPxKWkuA4`;
  const seed = `${PREFIX}&csuir=1&mtid=t-zLauP7MYWD9u8PspjjKQ`;

  const html = renderUrlDiff(requested, seed);

  // The shared prefix is dropped rather than repeated, so a reader is looking at
  // the neighbourhood of the difference instead of at two identical walls.
  assert.match(html, /…/, 'the elided prefix must be marked');
  assert.ok(!html.includes('1791749301259'), 'the shared middle must not be repeated');
  assert.ok(html.includes('csuir=1'), 'the divergence must be visible');
  // The two URLs differ at the end of the seed, so the longer one continues past
  // it. That continuation is the whole answer, so it must be shown.
  assert.ok(html.includes('sei=Fu3LarDWJMzx7_UPxKWkuA4'), 'the extra tail must be shown');
});

test('a difference inside the visible window is marked at the divergence', () => {
  // Two short URLs that differ in the middle: nothing is elided, and the first
  // character of the visible text is the one that differs, so it is highlighted.
  const html = renderUrlDiff('https://a.test/x', 'https://b.test/x');
  assert.doesNotMatch(html, /…/, 'a short URL needs no elision');
  assert.match(html, /<b style="color:#b00">a<\/b>/, 'the differing character is marked');
  assert.match(html, /They differ at character <strong>9<\/strong>/);
});

test('identical URLs report no difference rather than an off-by-one', () => {
  const url = 'https://example.com/a';
  const html = renderUrlDiff(url, url);
  // Saying "they differ at character 20" when there are 19 would be a lie, and
  // this branch is reachable: an archive miss can happen on an archived URL.
  assert.match(html, /identical/);
  assert.doesNotMatch(html, /<b style="color:#b00">/, 'nothing to mark when they agree');
  assert.match(html, /·/, 'the end-of-line marker is present');
});

test('a seed that is a prefix of the request is shown as short against long', () => {
  // The truncated-query case: the request continues where the seed stops. This is
  // the shape a reader has to be able to see at a glance, and the extra tail is
  // the whole answer — so the message names it rather than counting characters.
  const seed = 'https://www.google.com/search?q=a+b';
  const requested = `${seed}&udm=50&sei=xyz`;

  const html = renderUrlDiff(requested, seed);
  assert.ok(html.includes('udm=50'), 'the request must show what the seed lacks');
  assert.match(html, /then one continues/);
  // A short pair is shown whole, so there is nothing to elide.
  assert.doesNotMatch(html, /…/);
});

test('markup in a URL cannot break out of the diff', () => {
  // The URLs reach the page from a request line, so they are attacker-controlled
  // in the general case. Escaping is the difference between a diagnostics page
  // and a reflected XSS.
  const html = renderUrlDiff(
    'https://e.test/x?q=<script>alert(1)</script>',
    'https://e.test/x?q=<img src=x onerror=alert(1)>',
  );

  // Asserted as a property rather than on a spelling: after removing the tags
  // this module emits, no `<` from the input may survive. Asserting on
  // `&lt;script&gt;` would be asserting on a coincidence, since the highlight tag
  // legitimately falls between the two halves of that string.
  const withoutOwnTags = html.replace(/<\/?(?:pre|p|span|b|strong)\b[^>]*>/g, '');
  assert.doesNotMatch(withoutOwnTags, /</, 'every `<` from a URL must be escaped');
  assert.match(withoutOwnTags, /&lt;script&gt;/, 'the markup is shown as text');
  assert.doesNotMatch(html, /onerror=[^<]*>/, 'an event handler must not become real markup');
});
