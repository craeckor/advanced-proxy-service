import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRoute } from '../src/server/router.ts';

const codec = 'plain' as const;

test('routes the index and health endpoints', () => {
  assert.equal(matchRoute('GET', '/', codec).kind, 'index');
  assert.equal(matchRoute('GET', '/health', codec).kind, 'health');
});

test('parses a proxy route with an explicit codec', () => {
  const route = matchRoute('GET', '/proxy/plain/https%3A%2F%2Fexample.com%2F', codec);
  assert.equal(route.kind, 'proxy');
  if (route.kind !== 'proxy') return;
  assert.equal(route.codec, 'plain');
  assert.equal(route.payload, 'https%3A%2F%2Fexample.com%2F');
});

test('parses a proxy route with the b64 codec', () => {
  const route = matchRoute('GET', '/proxy/b64/aHR0cHM6Ly9leGFtcGxlLmNvbS8', codec);
  assert.equal(route.kind, 'proxy');
  if (route.kind !== 'proxy') return;
  assert.equal(route.codec, 'b64');
});

test('falls back to the default codec when none is named', () => {
  const route = matchRoute('GET', '/proxy/https%3A%2F%2Fexample.com%2F', codec);
  assert.equal(route.kind, 'proxy');
  if (route.kind !== 'proxy') return;
  assert.equal(route.codec, 'plain');
  assert.equal(route.payload, 'https%3A%2F%2Fexample.com%2F');
});

test('honours a non-default fallback codec', () => {
  const route = matchRoute('GET', '/proxy/aHR0cHM6Ly9leGFtcGxlLmNvbS8', 'b64');
  assert.equal(route.kind, 'proxy');
  if (route.kind !== 'proxy') return;
  assert.equal(route.codec, 'b64');
});

test('an invalid codec segment is treated as the payload, not a codec', () => {
  // "/proxy/notacodec/xyz" must not 400 on an unknown codec; it is a payload,
  // and only decoding can tell how much of it is a target rather than a path.
  const route = matchRoute('GET', '/proxy/notacodec/xyz', codec);
  assert.equal(route.kind, 'proxy');
  if (route.kind !== 'proxy') return;
  assert.equal(route.codec, 'plain');
  assert.equal(route.payload, 'notacodec/xyz');
});

test('a target path stays with the payload rather than being split off', () => {
  // Splitting needs a decode, which the router does not do; `routeTarget` owns
  // that decision because it is the only place that can make it exactly.
  const route = matchRoute(
    'GET',
    '/proxy/plain/https%3A%2F%2Fcdn.test%2Fassets%2Fentry.js/assets/chunk.js',
    codec,
  );
  assert.equal(route.kind, 'proxy');
  if (route.kind !== 'proxy') return;
  assert.equal(route.payload, 'https%3A%2F%2Fcdn.test%2Fassets%2Fentry.js/assets/chunk.js');
});

test('a codec segment is still recognised when a target path follows', () => {
  const route = matchRoute('GET', '/proxy/b64/aHR0cHM6Ly9jZG4udGVzdC9hLmpz/assets/a.css', codec);
  assert.equal(route.kind, 'proxy');
  if (route.kind !== 'proxy') return;
  assert.equal(route.codec, 'b64');
  assert.equal(route.payload, 'aHR0cHM6Ly9jZG4udGVzdC9hLmpz/assets/a.css');
});

test('ignores a query string when matching the route', () => {
  const route = matchRoute('GET', '/proxy/plain/https%3A%2F%2Fa.test%2F?x=1', codec);
  assert.equal(route.kind, 'proxy');
  if (route.kind !== 'proxy') return;
  assert.equal(route.payload, 'https%3A%2F%2Fa.test%2F');
});

test('routes archive APIs by method', () => {
  assert.equal(matchRoute('POST', '/api/archives', codec).kind, 'createArchive');
  assert.equal(matchRoute('GET', '/api/archives', codec).kind, 'listArchives');
  assert.equal(matchRoute('DELETE', '/api/archives', codec).kind, 'notFound');
});

test('routes a single archive lookup and decodes the id', () => {
  const route = matchRoute('GET', '/api/archives/abc%2Fdef', codec);
  assert.equal(route.kind, 'getArchive');
  if (route.kind !== 'getArchive') return;
  assert.equal(route.archiveId, 'abc/def');
});

test('routes archive replay with the archive id and target', () => {
  const route = matchRoute('GET', '/archive/arch-1/plain/https%3A%2F%2Fexample.com%2F', codec);
  assert.equal(route.kind, 'archive');
  if (route.kind !== 'archive') return;
  assert.equal(route.archiveId, 'arch-1');
  assert.equal(route.codec, 'plain');
  assert.equal(route.payload, 'https%3A%2F%2Fexample.com%2F');
});

test('routes the capture namespace, which requires an explicit codec', () => {
  const route = matchRoute('GET', '/proxy/archive/plain/https%3A%2F%2Fexample.com%2F', codec);
  assert.equal(route.kind, 'capturePage');
  if (route.kind !== 'capturePage') return;
  assert.equal(route.codec, 'plain');
  assert.equal(route.payload, 'https%3A%2F%2Fexample.com%2F');

  // Its own outcome rather than `notFound`, and the distinction is load-bearing:
  // a bare capture path would otherwise be handed to the referring-page rebase,
  // which reads `/proxy/archive/https://example.com/` as a relative reference on
  // the referring page and serves an unrelated resource instead of refusing.
  assert.equal(matchRoute('GET', '/proxy/archive/https://example.com/', codec).kind, 'captureMalformed');
  assert.equal(matchRoute('GET', '/proxy/archive/', codec).kind, 'captureMalformed');
  assert.equal(matchRoute('GET', '/proxy/archive/plain/', codec).kind, 'captureMalformed');
});

test('routes the capture upload, preflight, and snippet endpoints', () => {
  assert.equal(matchRoute('POST', '/api/captures', codec).kind, 'createCapture');
  assert.equal(matchRoute('OPTIONS', '/api/captures', codec).kind, 'capturePreflight');
  assert.equal(matchRoute('GET', '/api/captures', codec).kind, 'notFound');

  const snippet = matchRoute('GET', '/api/capture.js?url=https%3A%2F%2Fexample.com', codec);
  assert.equal(snippet.kind, 'captureSnippet');
  // The raw target travels with the route because the snippet is built from its
  // query, and route matching works on the path alone.
  if (snippet.kind !== 'captureSnippet') return;
  assert.equal(snippet.rawUrl, '/api/capture.js?url=https%3A%2F%2Fexample.com');
  assert.equal(matchRoute('POST', '/api/capture.js', codec).kind, 'notFound');
});

test('rejects malformed archive and proxy paths', () => {
  assert.equal(matchRoute('GET', '/proxy/', codec).kind, 'notFound');
  assert.equal(matchRoute('GET', '/archive/onlyid', codec).kind, 'notFound');
  assert.equal(matchRoute('GET', '/unknown', codec).kind, 'notFound');
});

test('an application route cannot be shadowed by a proxied target', () => {
  // A target URL can never begin with a reserved segment, because the payload
  // is always an encoded URL rather than a path.
  assert.equal(matchRoute('GET', '/health', codec).kind, 'health');
  assert.equal(matchRoute('GET', '/proxy/plain/health', codec).kind, 'proxy');
});
