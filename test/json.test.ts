import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteImportMap, rewriteSpeculationRules } from '../src/rewrite/json.ts';

const options = { codec: 'plain' as const, baseUrl: 'https://github.com/x/y' };
const proxied = (url: string): string => `/proxy/plain/${encodeURIComponent(url)}`;

test('REGRESSION: an importmap value is proxied, because the browser fetches it itself', () => {
  // The leak this exists to close: the module resolver fetches an importmap's
  // URL directly. No element carries it, the page never sees it, and the runtime
  // shim cannot run for a response that is not a document — so left alone, every
  // entry is one request to the real origin.
  const out = rewriteImportMap(
    JSON.stringify({ imports: { react: 'https://cdn.test/react.js' } }),
    options,
  );
  const map = JSON.parse(out) as { imports: Record<string, string> };
  assert.equal(map.imports['react'], proxied('https://cdn.test/react.js'));
});

test('the specifier keys survive verbatim, because they are names modules import by', () => {
  // Rewriting a key would break every `import 'react'` in the page: the key is
  // matched against the specifier the script wrote, not resolved to a location.
  const out = rewriteImportMap(
    JSON.stringify({
      imports: { react: 'https://cdn.test/react.js', 'react-dom/client': 'https://cdn.test/c.js' },
    }),
    options,
  );
  const map = JSON.parse(out) as { imports: Record<string, string> };
  assert.deepEqual(Object.keys(map.imports).sort(), ['react', 'react-dom/client']);
});

test('a scope prefix is left alone while the URLs inside it are rewritten', () => {
  // The scope key is a *match pattern*, not a location: it decides which
  // specifiers the mapping applies to, so rewriting it would change behaviour.
  const out = rewriteImportMap(
    JSON.stringify({ imports: {}, scopes: { '/app/': { a: 'https://cdn.test/a.js' } } }),
    options,
  );
  const map = JSON.parse(out) as { scopes: Record<string, Record<string, string>> };
  assert.deepEqual(Object.keys(map.scopes), ['/app/']);
  assert.equal(map.scopes['/app/']?.['a'], proxied('https://cdn.test/a.js'));
});

test('a relative importmap value resolves against the document', () => {
  const out = rewriteImportMap(JSON.stringify({ imports: { a: './a.js' } }), options);
  const map = JSON.parse(out) as { imports: Record<string, string> };
  assert.equal(map.imports['a'], proxied('https://github.com/x/a.js'));
});

test('an importmap with nothing to rewrite is returned byte-identical', () => {
  for (const source of ['{}', '{"imports":{}}', '{"imports":{},"scopes":{}}', 'nonsense']) {
    assert.equal(rewriteImportMap(source, options), source, `must be untouched: ${source}`);
  }
});

test('an importmap body that is not the expected shape is passed through', () => {
  for (const source of ['[]', 'null', '3', '"x"', '{"imports":"nope"}']) {
    assert.equal(rewriteImportMap(source, options), source, `must be untouched: ${source}`);
  }
});

test('a non-string importmap value is preserved rather than coerced', () => {
  const source = JSON.stringify({ imports: { a: 5, b: null } });
  assert.equal(rewriteImportMap(source, options), source);
});

test('REGRESSION: a speculationrules source is an enum, not a URL', () => {
  // Caught in a smoke test: `source` reads like a location and is not one. It
  // is `"list"` or `"document"`, and rewriting it produced a rule the browser
  // silently discards — the prefetch stopped working with no visible error.
  const out = rewriteSpeculationRules(
    JSON.stringify({ prefetch: [{ source: 'list', urls: ['/a'] }] }),
    options,
  );
  const rules = JSON.parse(out) as { prefetch: Array<{ source: string; urls: string[] }> };
  assert.equal(rules.prefetch[0]?.source, 'list');
  assert.equal(rules.prefetch[0]?.urls[0], proxied('https://github.com/a'));
});

test('a speculationrules document rule keeps its enum and rewrites its URLs', () => {
  const out = rewriteSpeculationRules(
    JSON.stringify({ prerender: [{ source: 'document', urls: ['/p'] }] }),
    options,
  );
  const rules = JSON.parse(out) as { prerender: Array<{ source: string; urls: string[] }> };
  assert.equal(rules.prerender[0]?.source, 'document');
  assert.equal(rules.prerender[0]?.urls[0], proxied('https://github.com/p'));
});

test('a speculationrules block in list form is walked as a list', () => {
  const out = rewriteSpeculationRules(
    JSON.stringify([{ source: 'list', urls: ['https://cdn.test/a'] }]),
    options,
  );
  const rules = JSON.parse(out) as Array<{ urls: string[] }>;
  assert.equal(rules[0]?.urls[0], proxied('https://cdn.test/a'));
});

test('a speculationrules url list keeps the other entries and their order', () => {
  const out = rewriteSpeculationRules(
    JSON.stringify({ prefetch: [{ urls: ['/b', '/a'] }] }),
    options,
  );
  const rules = JSON.parse(out) as { prefetch: Array<{ urls: string[] }> };
  assert.deepEqual(rules.prefetch[0]?.urls, [
    proxied('https://github.com/b'),
    proxied('https://github.com/a'),
  ]);
});

test('a speculationrules block with no urls is returned byte-identical', () => {
  for (const source of ['{}', '{"prefetch":[]}', '{"prerender":[{"source":"document"}]}', 'bad json']) {
    assert.equal(rewriteSpeculationRules(source, options), source, `must be untouched: ${source}`);
  }
});

test('a speculationrules body that is not an object or list is passed through', () => {
  for (const source of ['null', '5', '"x"']) {
    assert.equal(rewriteSpeculationRules(source, options), source, `must be untouched: ${source}`);
  }
});

test('the archive prefix is honoured, so a replay cannot reach the origin', () => {
  const out = rewriteImportMap(
    JSON.stringify({ imports: { react: 'https://cdn.test/react.js' } }),
    { ...options, prefix: '/archive/abc' },
  );
  const map = JSON.parse(out) as { imports: Record<string, string> };
  assert.equal(map.imports['react'], `/archive/abc/plain/${encodeURIComponent('https://cdn.test/react.js')}`);
});

test('a data URL inside an importmap is left alone rather than proxied', () => {
  const source = JSON.stringify({ imports: { a: 'data:text/javascript,export default 1' } });
  assert.equal(rewriteImportMap(source, options), source);
});
