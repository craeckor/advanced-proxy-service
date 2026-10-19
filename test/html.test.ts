import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteHtml } from '../src/rewrite/html.ts';

const BASE = 'https://example.com/dir/page.html';
const options = { codec: 'plain' as const, baseUrl: BASE };

function rewrite(html: string, extra: Partial<typeof options> = {}): string {
  return rewriteHtml(html, { ...options, ...extra }).html;
}

test('rewrites href, src, action and poster attributes', () => {
  const out = rewrite(
    '<a href="/a">a</a><img src="b.png"><form action="/submit"></form><video poster="/p.jpg"></video>',
  );
  assert.match(out, /href="\/proxy\/plain\/https%3A%2F%2Fexample\.com%2Fa"/);
  assert.match(out, /src="\/proxy\/plain\/https%3A%2F%2Fexample\.com%2Fdir%2Fb\.png"/);
  assert.match(out, /action="\/proxy\/plain\/https%3A%2F%2Fexample\.com%2Fsubmit"/);
  assert.match(out, /poster="\/proxy\/plain\/https%3A%2F%2Fexample\.com%2Fp\.jpg"/);
});

test('rewrites srcset URLs while preserving their descriptors', () => {
  const out = rewrite('<img srcset="a.png 1x, b.png 2x, /c.png 640w">');
  assert.match(out, /1x/);
  assert.match(out, /2x/);
  assert.match(out, /640w/);
  assert.match(out, /https%3A%2F%2Fexample\.com%2Fdir%2Fa\.png/);
  assert.match(out, /https%3A%2F%2Fexample\.com%2Fc\.png/);
});

test('rewrites urls inside inline style and style blocks', () => {
  const inline = rewrite('<div style="background:url(/bg.png)"></div>');
  assert.match(inline, /https%3A%2F%2Fexample\.com%2Fbg\.png/);

  const block = rewrite('<style>@import "/base.css"; .a{background:url(../x.png)}</style>');
  assert.match(block, /https%3A%2F%2Fexample\.com%2Fbase\.css/);
  assert.match(block, /https%3A%2F%2Fexample\.com%2Fx\.png/);
});

test('rewrites urls inside inline event handlers', () => {
  const out = rewrite(`<button onclick="fetch('/api/x')">go</button>`);
  assert.match(out, /proxy\/plain/);
  assert.match(out, /https%3A%2F%2Fexample\.com%2Fapi%2Fx/);
});

test('renames integrity, nonce, sandbox and crossorigin rather than deleting them', () => {
  const out = rewrite('<script src="/a.js" integrity="sha384-abc" crossorigin="anonymous" nonce="n1"></script>');
  assert.doesNotMatch(out, /\sintegrity=/);
  assert.doesNotMatch(out, /\snonce=/);
  assert.match(out, /data-proxy-orig-integrity="sha384-abc"/);
  assert.match(out, /data-proxy-orig-nonce="n1"/);
  assert.match(out, /data-proxy-orig-crossorigin="anonymous"/);
});

test('renames meta http-equiv so CSP and refresh are not enforced', () => {
  const csp = rewrite('<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">');
  assert.doesNotMatch(csp, /\shttp-equiv="Content-Security-Policy"/);
  assert.match(csp, /data-proxy-orig-http-equiv/);
});

test('rewrites meta refresh targets to keep the user on the proxy', () => {
  const out = rewrite('<meta http-equiv="refresh" content="0; url=/next">');
  assert.match(out, /url=\/proxy\/plain\/https%3A%2F%2Fexample\.com%2Fnext/);
});

test('respects an explicit base href when resolving relative urls', () => {
  const out = rewrite('<base href="https://cdn.example.net/assets/"><img src="logo.png">');
  assert.match(out, /https%3A%2F%2Fcdn\.example\.net%2Fassets%2Flogo\.png/);
});

test('rewrites srcdoc recursively', () => {
  const out = rewrite('<iframe srcdoc="&lt;a href=&quot;/inner&quot;&gt;x&lt;/a&gt;"></iframe>');
  assert.match(out, /https%3A%2F%2Fexample\.com%2Finner/);
});

test('collects every discovered absolute URL', () => {
  const result = rewriteHtml('<a href="/a">a</a><img src="https://cdn.example.net/i.png">', options);
  assert.ok(result.discovered.has('https://example.com/a'));
  assert.ok(result.discovered.has('https://cdn.example.net/i.png'));
});

test('REGRESSION: an importmap URL is discovered, so a replay can serve it', () => {
  // Regression: rewriting and discovery are separate jobs that happen in one
  // pass. An importmap that was rewritten but not reported produced a replay
  // whose document asked for a module the capture had never stored — an
  // "offline" archive failing on its own links.
  const result = rewriteHtml(
    '<script type="importmap">{"imports":{"react":"https://cdn.example.net/react.js"}}</script>',
    options,
  );
  assert.ok(
    result.discovered.has('https://cdn.example.net/react.js'),
    `expected discovery, got ${[...result.discovered].join(', ')}`,
  );
});

test('an importmap URL is proxied and its specifier key is preserved', () => {
  const out = rewrite(
    '<script type="importmap">{"imports":{"react":"https://cdn.example.net/react.js"}}</script>',
  );
  assert.match(out, /https%3A%2F%2Fcdn\.example\.net%2Freact\.js/);
  assert.match(out, /"react":/, 'the specifier name must survive, it is not a location');
});

test('a speculationrules URL is discovered as well as rewritten', () => {
  const result = rewriteHtml(
    '<script type="speculationrules">{"prefetch":[{"source":"list","urls":["/next"]}]}</script>',
    options,
  );
  assert.ok(result.discovered.has('https://example.com/next'));
});

test('REGRESSION: a client-hints delegation list is dropped, not left pointing at the origin', () => {
  // `<meta http-equiv="delegate-ch">` names the origins the browser may send
  // client hints to, and the browser acts on it without the page's involvement.
  // Left absolute, the browser contacts the real origin directly from a page
  // that is supposed to be inside the proxy — the reported symptom was a CORS
  // failure against `ud.digitec.ch` that no rewriter could reach.
  const source =
    '<meta http-equiv="delegate-ch" content="sec-ch-ua https://ud.example.com; sec-ch-ua-mobile https://ud.example.com">';
  const out = rewriteHtml(source, options).html;

  assert.equal(out.includes('ud.example.com'), false, 'the delegation list must not survive');
  // The rest of the document is untouched.
  assert.match(out, /<meta/);
});

test('a JSON-LD block is left byte-exact, because nothing fetches it', () => {
  // It is a data block, and rewriting it would corrupt structured data a
  // consumer is meant to read verbatim.
  const source = '<script type="application/ld+json">{"url":"https://example.com/a"}</script>';
  assert.equal(rewriteHtml(source, options).html.includes('https%3A'), false);
});

test('REGRESSION: an application/json data block is left byte-exact', () => {
  // A general "rewrite every URL in a JSON block" pass was written and reverted,
  // because a data block is the page's own state rather than a document: a URL
  // in it is as likely to be an identity as a location, and the two are
  // indistinguishable by value.
  //
  // On digitec's `__NEXT_DATA__` it rewrote `shopClientConfig.domain` — the
  // site's own name, which the app compares against `location.origin` — and the
  // page died during hydration with `Cannot read properties of undefined
  // (reading 'split')`. It also appended a pathname to values that were already
  // complete URLs, turning `/de` into `/de/de`.
  const source =
    '<script id="__NEXT_DATA__" type="application/json">' +
    '{"assetPrefix":"https://cdn.example.net","domain":"https://example.com"}' +
    '</script>';
  const out = rewriteHtml(source, options).html;

  assert.match(out, /"assetPrefix":"https:\/\/cdn\.example\.net"/, 'a data block must not be rewritten');
  assert.match(out, /"domain":"https:\/\/example\.com"/);
  assert.equal(out.includes('https%3A'), false);
});

test('leaves data: and javascript: references untouched', () => {
  const out = rewrite('<img src="data:image/png;base64,AAAA"><a href="javascript:void(0)">x</a>');
  assert.match(out, /src="data:image\/png;base64,AAAA"/);
  assert.match(out, /href="javascript:void\(0\)"/);
});

test('injects the runtime shim into head when asked', () => {
  const out = rewriteHtml('<html><head><title>t</title></head><body></body></html>', {
    ...options,
    injectShim: true,
    shimSource: '/*SHIM*/',
    targetOrigin: 'https://example.com',
  }).html;
  assert.match(out, /\/\*SHIM\*\//);
  assert.match(out, /__PROXY_CONFIG__/);
  // The shim must precede the page's own scripts.
  assert.ok(out.indexOf('/*SHIM*/') < out.indexOf('<title>'));
});

test('does not rewrite a JSON script block as JavaScript', () => {
  const out = rewrite('<script type="application/json">{"url":"/not-a-route"}</script>');
  assert.doesNotMatch(out, /proxy\/plain/);
  assert.match(out, /"url":"\/not-a-route"/);
});

test('handles a document with no head element', () => {
  const out = rewriteHtml('<div>hi</div>', { ...options, injectShim: true, shimSource: '/*S*/' }).html;
  assert.match(out, /\/\*S\*\//);
});

// --- regression: relative URLs were resolving against the proxy origin -----

test('REGRESSION: rewrites relative URLs when <base href> is relative', () => {
  // `<base href="/">` is standard single-page-app output. Using it raw as the
  // resolution base made every relative URL unrewritable, so the browser
  // resolved them against the proxy origin instead.
  const out = rewrite(
    '<base href="/"><link rel="stylesheet" href="/styles/main.min.0409b4e8ca.css">' +
      '<script src="polyfills-VLDFV2IG.js" type="module"></script>',
  );
  assert.match(out, /https%3A%2F%2Fexample\.com%2Fstyles%2Fmain\.min\.0409b4e8ca\.css/);
  assert.match(out, /https%3A%2F%2Fexample\.com%2Fpolyfills-VLDFV2IG\.js/);
  assert.doesNotMatch(out, /href="\/styles\/main\.min/);
  assert.doesNotMatch(out, /src="polyfills-VLDFV2IG\.js"/);
});

test('REGRESSION: rewrites bare relative assets with no base element at all', () => {
  const out = rewrite(
    '<link rel="modulepreload" href="chunk-BYXBJQAS.js">' +
      '<link rel="preload" href="/fonts/LatoLatin-Regular.woff2" as="font" type="font/woff2" crossorigin>' +
      '<script src="main-Q4IHNLTK.js" type="module"></script>',
  );
  // Relative to the document URL's directory.
  assert.match(out, /https%3A%2F%2Fexample\.com%2Fdir%2Fchunk-BYXBJQAS\.js/);
  assert.match(out, /https%3A%2F%2Fexample\.com%2Fdir%2Fmain-Q4IHNLTK\.js/);
  // Root-relative to the origin.
  assert.match(out, /https%3A%2F%2Fexample\.com%2Ffonts%2FLatoLatin-Regular\.woff2/);
  assert.doesNotMatch(out, /href="chunk-BYXBJQAS\.js"/);
  assert.doesNotMatch(out, /src="main-Q4IHNLTK\.js"/);
});

test('REGRESSION: <base href> is removed so it cannot re-point proxy links', () => {
  const out = rewrite('<base href="/"><img src="a.png">');
  // The value is preserved for inspection, but the element must not carry a
  // live href: rewritten links are root-relative, and a <base href> applies to
  // those too, which would send the browser to the origin site.
  assert.match(out, /data-proxy-orig-base-href="\/"/);
  assert.doesNotMatch(out, /<base[^>]*\shref=/);
  assert.match(out, /https%3A%2F%2Fexample\.com%2Fa\.png/);
});

test('REGRESSION: a target-origin base href cannot hijack rewritten proxy links', () => {
  // This is the yallo.ch failure: with `<base href="/">` rewritten to the
  // target origin, the browser resolved `/proxy/plain/<target>` against
  // https://example.com and hit the real site instead of the proxy.
  const out = rewrite('<base href="/"><link rel="manifest" href="/assets/m.json">');
  assert.doesNotMatch(out, /<base[^>]*\shref="https:\/\/example\.com/);
  assert.doesNotMatch(out, /<base[^>]*\shref=/);

  // Simulate the browser resolving the rewritten link against the document base.
  const link = /href="(\/proxy\/[^"]+)"/.exec(out)?.[1];
  assert.ok(link, 'expected a rewritten asset link');
  const resolved = new URL(link, 'https://proxy.local/proxy/plain/x');
  assert.equal(resolved.origin, 'https://proxy.local', 'rewritten link must stay on the proxy');
});

test('REGRESSION: rewrites markup inside <noscript>, which parses as raw text', () => {
  const out = rewrite('<head><noscript><link rel="stylesheet" href="/styles/main.min.css"></noscript></head>');
  assert.match(out, /https%3A%2F%2Fexample\.com%2Fstyles%2Fmain\.min\.css/);
  assert.doesNotMatch(out, /<noscript><link rel="stylesheet" href="\/styles/);
  // The markup must survive as markup, not as escaped visible text.
  assert.doesNotMatch(out, /&lt;link/);
});

test('REGRESSION: rewrites markup inside <template>, which parses into a fragment', () => {
  const out = rewrite('<template><link rel="modulepreload" href="chunk-A.js"><img src="/i.png"></template>');
  assert.match(out, /https%3A%2F%2Fexample\.com%2Fdir%2Fchunk-A\.js/);
  assert.match(out, /https%3A%2F%2Fexample\.com%2Fi\.png/);
});

test('an absolute <base href> is removed too, with its value preserved', () => {
  const out = rewrite('<base href="https://cdn.example.net/assets/"><img src="logo.png">');
  // The declared base is still *applied* when resolving, so the image resolves
  // against the CDN rather than the document.
  assert.match(out, /https%3A%2F%2Fcdn\.example\.net%2Fassets%2Flogo\.png/);
  // But the element itself must not keep a live href.
  assert.match(out, /data-proxy-orig-base-href="https:\/\/cdn\.example\.net\/assets\/"/);
  assert.doesNotMatch(out, /<base[^>]*\shref=/);
});

test('the shim config carries the declared base for page script', () => {
  const out = rewriteHtml('<base href="/app/"><p>x</p>', {
    ...options,
    injectShim: true,
    shimSource: '/*S*/',
    targetOrigin: 'https://example.com',
  }).html;
  const cfg = /__PROXY_CONFIG__=(\{[^}]*\})/.exec(out)?.[1];
  assert.ok(cfg, 'expected shim config');
  assert.equal((JSON.parse(cfg) as { declaredBase: string }).declaredBase, 'https://example.com/app/');
});

test('resolves urls against a protocol-relative base href', () => {
  const out = rewrite('<base href="//cdn.example.net/x/"><img src="logo.png">');
  assert.match(out, /https%3A%2F%2Fcdn\.example\.net%2Fx%2Flogo\.png/);
});

test('a base href that cannot be resolved falls back to the document URL', () => {
  const out = rewrite('<base href="javascript:void(0)"><img src="a.png">');
  assert.match(out, /https%3A%2F%2Fexample\.com%2Fdir%2Fa\.png/);
});

test('rewrites preload font and modulepreload links', () => {
  const out = rewrite(
    '<link rel="preload" href="f.woff2" as="font" crossorigin>' +
      '<link rel="modulepreload" href="m.js">' +
      '<link rel="preload" imagesrcset="a.png 1x, b.png 2x" as="image">',
  );
  assert.match(out, /https%3A%2F%2Fexample\.com%2Fdir%2Ff\.woff2/);
  assert.match(out, /https%3A%2F%2Fexample\.com%2Fdir%2Fm\.js/);
  assert.match(out, /https%3A%2F%2Fexample\.com%2Fdir%2Fa\.png/);
  assert.match(out, /https%3A%2F%2Fexample\.com%2Fdir%2Fb\.png/);
  assert.match(out, /2x/);
});
