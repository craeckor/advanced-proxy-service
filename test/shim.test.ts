import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { RUNTIME_SHIM_SOURCE } from '../src/shim/runtime.ts';
import { rewriteHtml } from '../src/rewrite/html.ts';

/**
 * The runtime shim is delivered as a template-literal string, so `tsc` never
 * type-checks or fully parses its contents, and one more step — parse5
 * serialization — sits between that string and the browser. A defect in either
 * stage ships clean through typecheck and only breaks at runtime, in the
 * browser, after the page has loaded.
 *
 * Both failure modes are covered here, and both are drawn from real breakage:
 * a backtick in a shim comment truncated the literal, and a missing parentNode
 * back-reference made the serializer HTML-escape the injected script, which is a
 * syntax error inside `<script>` and killed every runtime patch.
 */

test('the shim parses as valid JavaScript', () => {
  assert.doesNotThrow(
    () => parse(RUNTIME_SHIM_SOURCE, { ecmaVersion: 'latest', sourceType: 'script' }),
    'shim source must be syntactically valid',
  );
});

test('the shim is a complete IIFE rather than a truncated string', () => {
  const source = RUNTIME_SHIM_SOURCE.trim();
  assert.ok(source.startsWith('(function ()'), 'shim should open with an IIFE');
  assert.ok(source.endsWith('})();'), 'shim should close the IIFE it opened');
  // A truncation cut would leave an unbalanced brace count.
  const opens = (source.match(/\{/g) ?? []).length;
  const closes = (source.match(/\}/g) ?? []).length;
  assert.equal(opens, closes, 'shim braces must balance');
});

test('the shim contains no backtick, which would terminate its template literal', () => {
  assert.equal(
    RUNTIME_SHIM_SOURCE.includes('`'),
    false,
    'a backtick anywhere in the shim truncates RUNTIME_SHIM_SOURCE',
  );
});

test('the shim references every config key the rewriter emits', () => {
  const out = rewriteHtml('<base href="/"><p>x</p>', {
    codec: 'plain',
    baseUrl: 'https://example.com/dir/page.html',
    prefix: '/archive/abc',
    injectShim: true,
    shimSource: RUNTIME_SHIM_SOURCE,
    targetOrigin: 'https://example.com',
  }).html;

  const raw = /__PROXY_CONFIG__=(\{[^}]*\})/.exec(out)?.[1];
  assert.ok(raw, 'expected a shim config object');

  const config = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(config['codec'], 'plain');
  assert.equal(config['prefix'], '/archive/abc');
  assert.equal(config['targetOrigin'], 'https://example.com');
  // The document URL is what cookie namespacing keys off; the declared base is
  // what relative URL resolution uses. They differ whenever the page sets
  // <base href>, and conflating them breaks one or the other.
  assert.equal(config['targetUrl'], 'https://example.com/dir/page.html');
  assert.equal(config['declaredBase'], 'https://example.com/');

  for (const key of Object.keys(config)) {
    assert.ok(RUNTIME_SHIM_SOURCE.includes(key), `shim should read the ${key} config key`);
  }
});

test('the shim never contains a bare script-closing sequence', () => {
  // The shim is injected inline. An embedded `</script` would end the element
  // early and dump the remainder as page text.
  assert.doesNotMatch(RUNTIME_SHIM_SOURCE, /<\/script/i);
});

// --- regression: the injected shim must survive serialization unescaped -----

test('REGRESSION: the serialized shim is not HTML-escaped', () => {
  // This shipped broken once. parse5's serializer decides whether a text node
  // is raw by inspecting its *parent*, so a synthesized <script> whose text
  // node lacks a parentNode gets escaped: `i < n` becomes `i &lt; n`. In a
  // script that is a syntax error, not a cosmetic problem, because entities are
  // never decoded inside <script> — the whole shim died and every runtime patch
  // (fetch, XHR, URL) silently stopped existing.
  const out = rewriteHtml('<html><head><title>t</title></head><body></body></html>', {
    codec: 'plain',
    baseUrl: 'https://example.com/',
    injectShim: true,
    shimSource: RUNTIME_SHIM_SOURCE,
  }).html;

  const start = out.indexOf('data-proxy-shim');
  assert.ok(start !== -1, 'shim should be injected');
  const end = out.indexOf('</script>', start);
  const injected = out.slice(start, end);

  assert.doesNotMatch(injected, /&lt;/, 'shim must not contain escaped <');
  assert.doesNotMatch(injected, /&gt;/, 'shim must not contain escaped >');
  assert.doesNotMatch(injected, /&amp;/, 'shim must not contain escaped &');
  assert.doesNotMatch(injected, /&quot;/, 'shim must not contain escaped "');
});

test('REGRESSION: the injected shim body parses as valid JavaScript', () => {
  const out = rewriteHtml('<html><head></head><body></body></html>', {
    codec: 'plain',
    baseUrl: 'https://example.com/',
    injectShim: true,
    shimSource: RUNTIME_SHIM_SOURCE,
  }).html;

  const start = out.indexOf('data-proxy-shim');
  const open = out.indexOf('>', start) + 1;
  const close = out.indexOf('</script>', open);
  const body = out.slice(open, close);

  assert.doesNotThrow(
    () => parse(body, { ecmaVersion: 'latest', sourceType: 'script' }),
    'the shim as delivered must parse',
  );
});

test('REGRESSION: shim text is emitted raw while a title is still escaped', () => {
  // Both must hold at once: script content raw, ordinary text escaped.
  const out = rewriteHtml('<html><head><title>a &amp; b</title></head><body></body></html>', {
    codec: 'plain',
    baseUrl: 'https://example.com/',
    injectShim: true,
    shimSource: 'if (1 < 2 && 3 > 2) {}',
  }).html;

  assert.match(out, /if \(1 < 2 && 3 > 2\) \{\}/);
  assert.doesNotMatch(out, /&lt; 2/);
  assert.match(out, /<title>a &amp; b<\/title>/, 'ordinary text must still be escaped');
});

test('the shim does not use syntax an inline classic script cannot run', () => {
  // Inline classic scripts cannot use import/export or top-level await.
  assert.doesNotThrow(() =>
    parse(RUNTIME_SHIM_SOURCE, { ecmaVersion: 'latest', sourceType: 'script' }),
  );
  assert.doesNotMatch(RUNTIME_SHIM_SOURCE, /^\s*(?:import|export)\s/m);
});
