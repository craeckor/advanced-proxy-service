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

test('REGRESSION: a keepalive Request is rebuilt, not passed through unproxied', () => {
  // `new Request(proxiedUrl, existingRequest)` throws when the source has
  // `keepalive: true`, because the constructor reads the body as a stream and a
  // stream body is illegal alongside keepalive. The old code caught that and
  // fell back to the *original* request — a silent bypass of the proxy for every
  // keepalive request on the page.
  //
  // The reported symptom was a CORS failure against `ud.digitec.ch`: snowplow
  // builds `new Request(collectorUrl, { keepalive: true })` and the beacon left
  // the proxy on every page view. Nothing in the document named the URL, so no
  // rewriter could reach it.
  assert.match(RUNTIME_SHIM_SOURCE, /keepalive: false/, 'keepalive must be dropped, not preserved');
  // The body must be buffered, not streamed. A browser only sends a streaming
  // request body over HTTP/2 or better, and the proxy is reached over plain
  // HTTP/1.1, so `duplex: 'half'` fails at the network layer with a bare
  // "Failed to fetch" — no status, no console detail. This was the second half
  // of the same bug and it is invisible in any test that only checks the URL.
  assert.match(
    RUNTIME_SHIM_SOURCE,
    /input\.arrayBuffer\(\)|new Response\(body\)\.arrayBuffer\(\)/,
    'the body must be buffered, because a stream body cannot cross HTTP/1.1',
  );
  assert.equal(
    /duplex: 'half'/.test(RUNTIME_SHIM_SOURCE),
    false,
    'a streamed body cannot be sent to an HTTP/1.1 proxy',
  );
  assert.match(
    RUNTIME_SHIM_SOURCE,
    /Promise\.reject\(new TypeError\('proxy: request body cannot be re-read'\)\)/,
    'a body that cannot be rebuilt must fail rather than leak',
  );
  // The old bypass must be gone: no fallback that sends the original request.
  assert.equal(
    /catch \(e\) \{\s*return nativeFetch\(input, init\);/.test(RUNTIME_SHIM_SOURCE),
    false,
    'the unproxied fallback must not come back',
  );
});

test('REGRESSION: an init.body overrides the source body without leaking a stream', () => {
  // `fetch(request, { body })` replaces the request's body outright. The
  // replacement may itself be a stream, which cannot cross HTTP/1.1, so it has
  // to be buffered like any other. The sanitised init must also drop `body`,
  // otherwise the original stream would be re-applied on top of the buffered
  // replacement and the request would fail for the reason just fixed.
  assert.match(
    RUNTIME_SHIM_SOURCE,
    /key === 'keepalive' \|\| key === 'duplex' \|\| key === 'body'/,
    'init.body must be stripped from the sanitised init',
  );
  assert.match(
    RUNTIME_SHIM_SOURCE,
    /init && init\.body !== undefined && init\.body !== null \? init\.body : input\.body/,
    'an explicit init.body must take precedence over the source body',
  );
});

test('the shim patches sendBeacon, which is a network API that is easy to miss', () => {
  // A beacon is a fire-and-forget POST the browser sends on the page's behalf.
  // It is not a constructor and returns no promise, so it is the one network API
  // that gets forgotten — and analytics libraries reach for it precisely because
  // it survives unload.
  //
  // The reported symptom was a CORS failure against `ud.digitec.ch`: the page's
  // config names that host as a bare hostname, the analytics library builds a
  // URL from it, and the beacon left the proxy on every page view. Nothing in
  // the document carried the URL, so no rewriter could reach it.
  assert.match(RUNTIME_SHIM_SOURCE, /navigator\.sendBeacon/, 'sendBeacon must be patched');
  assert.match(
    RUNTIME_SHIM_SOURCE,
    /nativeSendBeacon\.call\(navigator, toProxyUrl\(url\), data\)/,
    'the beacon URL must be routed through the proxy',
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
