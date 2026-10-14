import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCapture, INLINE_KEY, STORAGE_KEY_PREFIX } from '../src/archive/capture.ts';

/**
 * Payload parsing for a browser-assisted capture.
 *
 * The body arrives as `text/plain` from an arbitrary origin, so every field is
 * untrusted and every shape has to be tolerated rather than assumed. The
 * failures that matter are the quiet ones: a payload that parses but whose
 * fields were silently dropped produces an archive that looks fine and is empty.
 */

const minimal = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ targetUrl: 'https://example.com/', ...extra });

test('parses a minimal payload', () => {
  const parsed = parseCapture(minimal());
  assert.ok(parsed !== null);
  assert.equal(parsed.targetUrl, 'https://example.com/');
});

test('a payload without a usable target is refused', () => {
  // The target is what every stored key and the replay URL derive from, so a
  // capture without one cannot be stored at all.
  const cases = [
    '{}',
    JSON.stringify({ targetUrl: '' }),
    JSON.stringify({ targetUrl: 'not a url' }),
    JSON.stringify({ targetUrl: 'javascript:alert(1)' }),
    JSON.stringify({ targetUrl: 'data:text/html,x' }),
    JSON.stringify({ targetUrl: 42 }),
    '[]',
    'null',
    '"a string"',
    'not json at all',
    '',
  ];
  for (const body of cases) {
    assert.equal(parseCapture(body), null, `must refuse: ${body}`);
  }
});

test('collects the URL list and drops entries that are not fetchable', () => {
  const parsed = parseCapture(
    minimal({
      urls: [
        'https://example.com/a.js',
        'https://cdn.example.net/b.css',
        'data:text/plain,x',
        'javascript:void(0)',
        '#fragment',
        '',
        42,
        null,
        'https://example.com/a.js', // duplicate
      ],
    }),
  );
  assert.ok(parsed !== null);
  assert.deepEqual(parsed.urls, [
    'https://example.com/a.js',
    'https://cdn.example.net/b.css',
  ]);
});

test('a URL is normalised, with its fragment dropped', () => {
  // The fragment never reaches the server, so two URLs differing only by one are
  // the same resource and must not be stored twice.
  const parsed = parseCapture(minimal({ urls: ['https://example.com/a#one', 'https://example.com/a#two'] }));
  assert.ok(parsed !== null);
  assert.deepEqual(parsed.urls, ['https://example.com/a']);
});

test('relative URLs are dropped rather than resolved', () => {
  // A relative entry in the list means the agent misresolved it. Guessing a base
  // here would invent a URL the page never requested.
  const parsed = parseCapture(minimal({ urls: ['/assets/a.js', 'a.js'] }));
  assert.ok(parsed !== null);
  assert.equal(parsed.urls, undefined);
});

test('keeps inline resources and ignores malformed ones', () => {
  const parsed = parseCapture(
    minimal({
      inline: {
        'https://example.com/a.css': { text: '.a{}', type: 'text/css', tag: 'link' },
        'inline:style:0': { text: '.b{}', type: 'text/css', tag: 'style' },
        bad1: { notText: true },
        bad2: 'a string',
        bad3: null,
      },
    }),
  );
  assert.ok(parsed !== null);
  assert.deepEqual(Object.keys(parsed.inline ?? {}).sort(), [
    'https://example.com/a.css',
    'inline:style:0',
  ]);
});

test('keeps the document only when it has text', () => {
  const withText = parseCapture(minimal({ document: { text: '<html></html>' } }));
  assert.equal(withText?.document?.text, '<html></html>');

  const withoutText = parseCapture(minimal({ document: { type: 'text/html' } }));
  assert.equal(withoutText?.document, undefined);
});

test('keeps cookies, title and storage when present', () => {
  const parsed = parseCapture(
    minimal({
      cookies: 'sid=abc',
      title: 'Example',
      storage: { local: { a: '1' }, session: { b: '2' } },
    }),
  );
  assert.ok(parsed !== null);
  assert.equal(parsed.cookies, 'sid=abc');
  assert.equal(parsed.title, 'Example');
  assert.deepEqual(parsed.storage, { local: { a: '1' }, session: { b: '2' } });
});

test('prefers finalUrl as the archive key when a page redirected', () => {
  // The archive is keyed by what actually served the document, which is what the
  // replay has to reconstruct.
  const parsed = parseCapture(
    JSON.stringify({ targetUrl: 'https://example.com/old', finalUrl: 'https://example.com/new' }),
  );
  assert.ok(parsed !== null);
  assert.equal(parsed.finalUrl, 'https://example.com/new');
});

test('an oversized payload is refused rather than truncated', () => {
  // A truncated JSON body parses about half the time, and storing half a capture
  // without saying so is worse than rejecting it.
  const huge = JSON.stringify({ targetUrl: 'https://example.com/', filler: 'x'.repeat(65 * 1024 * 1024) });
  assert.equal(parseCapture(huge), null);
});

test('the pseudo-URL prefixes are the ones the ingest uses', () => {
  // Replay and ingest agree on these by string, with no shared type between
  // them, so the values are pinned here.
  assert.equal(INLINE_KEY, 'inline:');
  assert.equal(STORAGE_KEY_PREFIX, 'storage:');
});
