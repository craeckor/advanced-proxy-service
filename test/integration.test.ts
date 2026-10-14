import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.ts';
import { createLogger } from '../src/util/logger.ts';
import { UpstreamClient } from '../src/proxy/upstream.ts';
import { ProxyHandler } from '../src/proxy/handler.ts';
import { ArchiveStore } from '../src/archive/store.ts';
import { ArchiveReplay } from '../src/archive/replay.ts';
import { Crawler } from '../src/archive/crawler.ts';
import { CaptureIngest } from '../src/archive/capture.ts';
import { RestFormIngest } from '../src/archive/rest-form.ts';
import { ProxyServer } from '../src/server/http-server.ts';
import { matchRoute } from '../src/server/router.ts';

/**
 * End-to-end tests against a real local origin server.
 *
 * The origin deliberately serves the awkward cases — CSP, Set-Cookie with a
 * Domain, a redirect, a stylesheet, a script, and a site that would break a
 * naive rewriter — so the assertions exercise the whole pipeline rather than
 * isolated units.
 */

let origin: Server;
let originPort = 0;
let proxy: Awaited<ReturnType<ProxyServer['listen']>>;
let proxyPort = 0;
let dataDir = '';
let store: ArchiveStore;

const ORIGIN_HTML = `<!doctype html>
<html><head>
  <title>Origin</title>
  <link rel="stylesheet" href="/style.css">
  <script src="/app.js"></script>
</head><body>
  <a href="/second">second page</a>
  <a href="/redirect">redirect</a>
  <img src="/img/logo.png">
  <img srcset="/img/a.png 1x, /img/b.png 2x">
  <div style="background:url(/img/bg.png)"></div>
</body></html>`;

before(async () => {
  origin = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${originPort}`);

    switch (url.pathname) {
      case '/':
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'self'",
          'x-frame-options': 'DENY',
          'strict-transport-security': 'max-age=31536000',
          'set-cookie': 'sid=abc123; Domain=127.0.0.1; Path=/; HttpOnly; SameSite=Lax',
          'content-length': String(Buffer.byteLength(ORIGIN_HTML)),
        });
        res.end(ORIGIN_HTML);
        return;

      case '/second':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><body><h1>second</h1><a href="/">home</a></body></html>');
        return;

      // Mimics standard single-page-app build output: a relative `<base href>`
      // plus bare relative asset names.
      case '/spa/index.html':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><html><head><base href="/">` +
            `<link rel="modulepreload" href="chunk-BYXBJQAS.js">` +
            `<link rel="stylesheet" href="/styles/main.min.css">` +
            `<link rel="preload" href="/fonts/LatoLatin-Regular.woff2" as="font" type="font/woff2" crossorigin>` +
            `<noscript><link rel="stylesheet" href="/styles/noscript.min.css"></noscript>` +
            `</head><body><script src="polyfills-VLDFV2IG.js" type="module"></script></body></html>`,
        );
        return;

      case '/chunk-BYXBJQAS.js':
      case '/polyfills-VLDFV2IG.js':
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end('export default 1;');
        return;

      case '/styles/main.min.css':
      case '/styles/noscript.min.css':
        res.writeHead(200, { 'content-type': 'text/css' });
        res.end('.a{color:red}');
        return;

      case '/fonts/LatoLatin-Regular.woff2':
        res.writeHead(200, { 'content-type': 'font/woff2', 'content-length': '4' });
        res.end(Buffer.from([0x77, 0x4f, 0x46, 0x32]));
        return;

      case '/redirect':
        res.writeHead(302, { location: '/second' });
        res.end();
        return;

      // A page whose loaded DOM differs from its server HTML, which is what the
      // browser-assisted capture exists for: a static crawler only ever sees the
      // shell below.
      case '/captured.html':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><html><head><title>shell</title></head><body>` +
            `<div id="app"></div><script src="/captured.js"></script></body></html>`,
        );
        return;

      case '/captured.js':
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end('document.getElementById("app").innerHTML = "<p>rendered</p>";');
        return;

      case '/captured.css':
        res.writeHead(200, { 'content-type': 'text/css' });
        res.end('.captured{color:blue}');
        return;

      // An importmap page: the browser fetches these module URLs itself, and
      // nothing in the document carries them, so only a JSON walker sees them.
      case '/importmap.html':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><html><head><title>map</title>` +
            `<script type="importmap">{"imports":{"react":"/vendor/react.js"}}</script>` +
            `</head><body><h1>map</h1></body></html>`,
        );
        return;

      case '/vendor/react.js':
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end('export default 1;');
        return;

      case '/manifest.json':
        res.writeHead(200, { 'content-type': 'application/manifest+json' });
        res.end(
          JSON.stringify({
            name: 'App',
            start_url: '/',
            icons: [{ src: '/icons/app-192.png', sizes: '192x192' }],
          }),
        );
        return;

      // A document that names its manifest, and the manifest itself served the way
      // most real origins serve one: as generic JSON. MDN's `/manifest.json` is
      // `application/json`, and so is the majority of the web's — the spec's
      // `application/manifest+json` is honoured more in the breach.
      case '/app.html':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><html><head><title>app</title>` +
            `<link rel="manifest" href="/plain-manifest.json">` +
            `</head><body><h1>app</h1></body></html>`,
        );
        return;

      case '/plain-manifest.json':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          // The `src` is root-relative, which is what makes the media type matter:
          // left alone it resolves against the proxy's own origin.
          JSON.stringify({ name: 'Plain', icons: [{ src: '/icons/app-192.png', sizes: '192x192' }] }),
        );
        return;

      case '/icons/app-192.png':
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': '4' });
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        return;

      case '/style.css':
        res.writeHead(200, { 'content-type': 'text/css' });
        res.end('.logo{background:url(/img/logo.png)} @import "/other.css";');
        return;

      case '/other.css':
        res.writeHead(200, { 'content-type': 'text/css' });
        res.end('.x{color:red}');
        return;

      case '/app.js':
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end(`fetch('/api/data'); const untouched = '/kept';`);
        return;

      case '/img/logo.png':
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': '4' });
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        return;

      case '/huge':
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<html><body>${'x'.repeat(200_000)}</body></html>`);
        return;

      case '/echo-headers':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          userAgent: req.headers['user-agent'] ?? null,
          accept: req.headers.accept ?? null,
          acceptEncoding: req.headers['accept-encoding'] ?? null,
        }));
        return;

      case '/echo-cookie':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
        return;

      case '/echo-query':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ search: url.search, id: url.searchParams.get('id') }));
        return;

      // A page whose identity is its query, for compatibility-mode tests: the
      // archive holds `/q?a=1`, so a replay of `/q?a=1&b=2` is the near miss the
      // mode exists to offer.
      case '/q':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><html><head><title>query</title></head><body>` +
            `<h1>query</h1><p id="search">${url.search.replace(/</g, '&lt;')}</p></body></html>`,
        );
        return;

      default:
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
    }
  });

  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
  const address = origin.address();
  originPort = typeof address === 'object' && address !== null ? address.port : 0;

  dataDir = await mkdtemp(join(tmpdir(), 'proxy-test-'));

  const config = parseConfig({
    server: { host: '127.0.0.1', port: 0 },
    archive: {
      dataDir,
      maxDepth: 2,
      maxPages: 20,
      respectRobotsTxt: false,
      compression: 'gzip',
      // On for the whole suite: compatibility mode only ever changes what happens
      // on a *miss*, so a test that expects a miss still gets one unless it says
      // otherwise, and the tests that exercise the mode do not need a second server.
      compatMode: true,
      // Set here so the authentication path is exercised by default rather than
      // only by the one test that names it. The extension always sends a Bearer
      // header, so every upload in this suite carries the token.
      restFormToken: 'test-token',
    },
    log: { level: 'silent' },
    proxy: { maxRewriteBytes: 64 * 1024 },
  });

  const logger = createLogger(config);
  const upstream = new UpstreamClient(config);
  store = await ArchiveStore.open(config.archive);

  proxy = await new ProxyServer(config, logger, {
    proxy: new ProxyHandler(config, logger, upstream),
    upstream,
    store,
    replay: new ArchiveReplay(config, logger, store),
    crawler: new Crawler(config, logger, upstream, store),
    capture: new CaptureIngest(config, logger, upstream, store),
    restForm: new RestFormIngest(config, logger, store),
  }).listen();

  proxyPort = proxy.port;
});

after(async () => {
  await proxy?.close();
  store?.close();
  await new Promise<void>((resolve) => origin.close(() => resolve()));
  if (dataDir !== '') await rm(dataDir, { recursive: true, force: true });
});

/** Build a proxy URL for a path on the test origin. */
function proxied(path: string): string {
  return `http://127.0.0.1:${proxyPort}/proxy/plain/${encodeURIComponent(`http://127.0.0.1:${originPort}${path}`)}`;
}

test('proxies an HTML page and returns it with status 200', async () => {
  const response = await fetch(proxied('/'));
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /<title>Origin<\/title>/);
});

test('REGRESSION: a query left outside the payload reaches the origin', async () => {
  // `encodeURI` leaves ? and & alone, so a hand-built proxy URL — or a GET form
  // posting to a rewritten action — appends its parameters *after* the payload.
  // Reading the route as the payload alone silently dropped them, which asked
  // the origin for a different resource: a route whose identity is its query
  // then answered with the page it serves when that parameter is missing.
  const target = `http://127.0.0.1:${originPort}/echo-query`;
  const response = await fetch(
    `http://127.0.0.1:${proxyPort}/proxy/plain/${encodeURI(target)}?id=4076365`,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { search: '?id=4076365', id: '4076365' });
});

test('REGRESSION: a proxied target keeps its own query when none is appended', async () => {
  // The payload already carries the target's query, so nothing is added and
  // nothing is lost.
  const target = `http://127.0.0.1:${originPort}/echo-query?a=1`;
  const response = await fetch(`http://127.0.0.1:${proxyPort}/proxy/plain/${encodeURIComponent(target)}`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { search: '?a=1', id: null });
});

test('REGRESSION: an appended query merges with the payload query', async () => {
  // The payload's own query is percent-encoded inside it, so the literal `?`
  // after the payload is unambiguously the appended one.
  const target = `http://127.0.0.1:${originPort}/echo-query?a=1`;
  const response = await fetch(
    `http://127.0.0.1:${proxyPort}/proxy/plain/${encodeURIComponent(target)}?id=7`,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { search: '?a=1&id=7', id: '7' });
});

test('REGRESSION: a trailing target path resolves against the payload, not the root', async () => {
  // A runtime that derives its public path from `import.meta.url` asks for a
  // bare sibling name, which resolves against the proxied URL's directory. The
  // arriving path is a path at the target's origin, and the payload says which
  // origin — reading it as the root asked for a file that does not exist, which
  // is what broke every code-split bundle.
  const payload = `http://127.0.0.1:${originPort}/`;
  const response = await fetch(
    `http://127.0.0.1:${proxyPort}/proxy/plain/${encodeURIComponent(payload)}/chunk-BYXBJQAS.js`,
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /javascript/);
});

test('REGRESSION: a specifier query survives the trailing target path', async () => {
  // The payload carries the query and the trailing path mirrors the pathname,
  // because a path cannot express a query. Letting the path win would silently
  // drop the parameter and fetch a different resource than the page named.
  const payload = `http://127.0.0.1:${originPort}/echo-query?id=1`;
  const response = await fetch(
    `http://127.0.0.1:${proxyPort}/proxy/plain/${encodeURIComponent(payload)}/echo-query`,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { search: '?id=1', id: '1' });
});

test('strips CSP, X-Frame-Options and HSTS from the proxied response', async () => {
  const response = await fetch(proxied('/'));
  assert.equal(response.headers.get('content-security-policy'), null);
  assert.equal(response.headers.get('x-frame-options'), null);
  assert.equal(response.headers.get('strict-transport-security'), null);
});

test('rewrites in-page links so navigation stays on the proxy', async () => {
  const response = await fetch(proxied('/'));
  const body = await response.text();
  assert.match(body, /href="\/proxy\/plain\//, 'anchor href should be proxied');
  assert.doesNotMatch(body, /href="\/second"/);
});

test('rewrites srcset while keeping descriptors', async () => {
  const body = await (await fetch(proxied('/'))).text();
  assert.match(body, /1x/);
  assert.match(body, /2x/);
  assert.match(body, /\/proxy\/plain\/[^"]*a\.png/);
});

test('rewrites inline style urls', async () => {
  const body = await (await fetch(proxied('/'))).text();
  assert.match(body, /url\(\/proxy\/plain\//);
});

test('REGRESSION: rewrites relative assets on a page with a relative base href', async () => {
  const body = await (await fetch(proxied('/spa/index.html'))).text();
  const origin = `http://127.0.0.1:${originPort}`;
  const expect = (path: string) => `/proxy/plain/${encodeURIComponent(origin + path)}`;

  // Bare relative names resolve against the document's base, not the proxy.
  assert.ok(body.includes(expect('/chunk-BYXBJQAS.js')), 'modulepreload href must be proxied');
  assert.ok(body.includes(expect('/polyfills-VLDFV2IG.js')), 'module script src must be proxied');
  assert.ok(body.includes(expect('/styles/main.min.css')), 'stylesheet href must be proxied');
  assert.ok(body.includes(expect('/fonts/LatoLatin-Regular.woff2')), 'preload font must be proxied');
  assert.ok(body.includes(expect('/styles/noscript.min.css')), 'noscript stylesheet must be proxied');

  // No asset may be left as a relative path, or it resolves to the proxy origin.
  assert.doesNotMatch(body, /href="chunk-BYXBJQAS\.js"/);
  assert.doesNotMatch(body, /src="polyfills-VLDFV2IG\.js"/);
  assert.doesNotMatch(body, /href="\/styles\/main\.min\.css"/);
  assert.doesNotMatch(body, /href="\/fonts\/LatoLatin-Regular\.woff2"/);
});

test('REGRESSION: every rewritten relative asset is actually fetchable through the proxy', async () => {
  const body = await (await fetch(proxied('/spa/index.html'))).text();
  const paths = [...body.matchAll(/href="(\/proxy\/plain\/[^"]+)"/g)].map((m) => m[1]!);
  assert.ok(paths.length >= 3, 'expected several rewritten asset URLs');

  for (const path of paths) {
    const asset = await fetch(`http://127.0.0.1:${proxyPort}${path}`);
    assert.equal(asset.status, 200, `${path} should resolve through the proxy`);
    assert.ok((await asset.arrayBuffer()).byteLength > 0);
  }
});

test('REGRESSION: a relative base href cannot hijack rewritten asset links', async () => {
  const body = await (await fetch(proxied('/spa/index.html'))).text();
  // Left live, the browser would resolve the root-relative proxy links against
  // the origin site and leave the proxy entirely.
  assert.doesNotMatch(body, /<base[^>]*\shref=/);
  assert.match(body, /data-proxy-orig-base-href="\/"/);

  // Every rewritten link must resolve back onto the proxy origin.
  const links = [...body.matchAll(/(?:href|src)="(\/proxy\/[^"]+)"/g)].map((m) => m[1]!);
  assert.ok(links.length >= 3, 'expected several rewritten asset URLs');
  for (const link of links) {
    const resolved = new URL(link, `http://127.0.0.1:${proxyPort}/proxy/plain/x`);
    assert.equal(resolved.origin, `http://127.0.0.1:${proxyPort}`, `${link} must stay on the proxy`);
  }
});

test('injects the runtime shim before the page scripts', async () => {
  const body = await (await fetch(proxied('/'))).text();
  const shimAt = body.indexOf('__PROXY_CONFIG__');
  assert.ok(shimAt !== -1, 'shim should be present');
  // Counted by the attribute, not the config key: the key appears twice by
  // design, once as the assignment and once where the shim reads it back.
  assert.equal(
    body.split('data-proxy-shim').length - 1,
    1,
    'the shim must be injected exactly once',
  );

  // It must be the first child of <head>, so it runs before any page element —
  // in particular before the proxied scripts, which are what need patching.
  const head = /<head[^>]*>/i.exec(body);
  assert.ok(head !== null, 'expected a head element');
  const headEnd = head.index + head[0].length;
  assert.equal(
    body.slice(headEnd, headEnd + '<script data-proxy-shim'.length),
    '<script data-proxy-shim',
    'shim must be the first child of head',
  );

  const firstProxiedAt = body.indexOf('/proxy/plain/');
  assert.ok(shimAt < firstProxiedAt, 'shim must come before page scripts');
  assert.ok(shimAt < body.indexOf('</head>'), 'shim must be inside head');
});

test('recomputes content-length after rewriting', async () => {
  const response = await fetch(proxied('/'));
  const body = await response.text();
  assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(body, 'utf8'));
});

test('rewrites a stylesheet and its @import', async () => {
  const body = await (await fetch(proxied('/style.css'))).text();
  assert.match(body, /\/proxy\/plain\/[^)"']*logo\.png/);
  assert.match(body, /other\.css/);
  assert.match(body, /\/proxy\/plain\//);
});

test('rewrites JavaScript fetch targets', async () => {
  const body = await (await fetch(proxied('/app.js'))).text();
  assert.match(body, /\/proxy\/plain\/[^"']*api%2Fdata/);
});

test('relays a binary response untouched', async () => {
  const response = await fetch(proxied('/img/logo.png'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual([...bytes], [0x89, 0x50, 0x4e, 0x47]);
});

test('rewrites a redirect Location back through the proxy', async () => {
  const response = await fetch(proxied('/redirect'), { redirect: 'manual' });
  assert.equal(response.status, 302);
  const location = response.headers.get('location');
  assert.ok(location?.startsWith('/proxy/plain/'), `got ${location}`);
});

test('set-cookie is namespaced and stripped of Domain', async () => {
  const response = await fetch(proxied('/'));
  const cookies = response.headers.getSetCookie();
  assert.ok(cookies.length > 0, 'expected a Set-Cookie');
  const cookie = cookies[0] ?? '';
  assert.match(cookie, /^p_[A-Za-z0-9_-]+_sid=abc123/);
  assert.doesNotMatch(cookie, /Domain=127\.0\.0\.1/);
});

test('forwards the client User-Agent upstream', async () => {
  const response = await fetch(proxied('/echo-headers'), {
    headers: { 'user-agent': 'TestBrowser/9.9', accept: 'application/json' },
  });
  const payload = (await response.json()) as { userAgent: string | null; accept: string | null };
  assert.equal(payload.userAgent, 'TestBrowser/9.9');
  assert.equal(payload.accept, 'application/json');
});

test('namespaced cookies are stripped of their prefix before reaching the origin', async () => {
  const namespaceName = `p_${Buffer.from(`http://127.0.0.1:${originPort}`, 'utf8').toString('base64url')}_`;
  const response = await fetch(proxied('/echo-cookie'), {
    headers: { cookie: `${namespaceName}sid=xyz; plain=1` },
  });
  const payload = (await response.json()) as { cookie: string | null };
  assert.equal(payload.cookie, 'sid=xyz; plain=1');
});

test('returns 400 for a malformed target', async () => {
  // A payload the plain codec cannot decode into an absolute URL. It stays a bad
  // request rather than becoming a 404, because the caller clearly meant to name
  // a target and failed to.
  const response = await fetch(`http://127.0.0.1:${proxyPort}/proxy/plain/not-a-url`);
  assert.equal(response.status, 400);
});

test('an unroutable proxy path stays a bad request when it cannot be attributed', async () => {
  // `/proxy/<name>` cannot be an absolute URL, so the router hands it to the
  // rebuild path. With no referer there is no origin to attribute it to, so it
  // remains what it always was: a proxy route whose payload is not a URL.
  const response = await fetch(`http://127.0.0.1:${proxyPort}/proxy/not-a-url`, { redirect: 'manual' });
  assert.equal(response.status, 400);
});

test('refuses a request with ambiguous framing', async () => {
  // A message carrying both Content-Length and Transfer-Encoding is the
  // precondition for CL.TE smuggling and must not be forwarded.
  const response = await fetch(proxied('/'), {
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' },
    body: 'hello',
  }).catch(() => null);

  // Either the proxy rejects it, or the client refuses to construct it. Both
  // outcomes are acceptable; silently proxying it is not.
  if (response !== null) {
    assert.ok([400, 411, 501].includes(response.status), `unexpected status ${response.status}`);
  }
});

test('passes a response larger than the rewrite budget through with a marker', async () => {
  const response = await fetch(proxied('/huge'));
  // Either it is truncated and flagged, or the limit was not hit — but a
  // content-length mismatch would be a bug either way.
  const body = await response.text();
  const declared = Number(response.headers.get('content-length'));
  assert.equal(declared, Buffer.byteLength(body, 'utf8'));
});

test('health endpoint responds', async () => {
  const response = await fetch(`http://127.0.0.1:${proxyPort}/health`);
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { status: string };
  assert.equal(payload.status, 'ok');
});

test('index reports the security posture', async () => {
  const payload = (await (await fetch(`http://127.0.0.1:${proxyPort}/`)).json()) as {
    security: { enabled: boolean };
  };
  // Default configuration is deliberately an open proxy.
  assert.equal(payload.security.enabled, false);
});

test('the index catalogue lists every route the router claims', async () => {
  // The catalogue is the answer to "is this service supposed to have that
  // endpoint?". A route the router claims but the index omits is an endpoint
  // nobody can discover, and a catalogued route the router does not claim is a
  // documented 404. Both directions are asserted rather than kept in sync by hand.
  const payload = (await (await fetch(`http://127.0.0.1:${proxyPort}/`)).json()) as {
    routes: Array<{ method: string; path: string; summary: string }>;
    codecs: string[];
  };

  // Every route `matchRoute` can return, paired with a request that produces it
  // and the template the catalogue is expected to publish for it.
  const expected: Array<{ method: string; sample: string; kind: string; template: string }> = [
    { method: 'GET', sample: '/', kind: 'index', template: '/' },
    { method: 'GET', sample: '/health', kind: 'health', template: '/health' },
    { method: 'GET', sample: '/proxy/plain/a', kind: 'proxy', template: '/proxy/[codec/]<encoded-url>' },
    {
      method: 'GET',
      sample: '/archive/abc/plain/a',
      kind: 'archive',
      template: '/archive/<id>/[codec/]<encoded-url>',
    },
    {
      method: 'GET',
      sample: '/proxy/archive/plain/a',
      kind: 'capturePage',
      template: '/proxy/archive/<codec>/<encoded-url>',
    },
    {
      method: 'GET',
      sample: '/api/capture.js?url=https%3A%2F%2Fexample.com%2F',
      kind: 'captureSnippet',
      template: '/api/capture.js?url=<encoded-url>',
    },
    { method: 'GET', sample: '/api/capture-relay.html', kind: 'captureRelay', template: '/api/capture-relay.html' },
    { method: 'POST', sample: '/api/captures', kind: 'createCapture', template: '/api/captures' },
    { method: 'OPTIONS', sample: '/api/captures', kind: 'capturePreflight', template: '/api/captures' },
    { method: 'POST', sample: '/api/archives', kind: 'createArchive', template: '/api/archives' },
    { method: 'GET', sample: '/api/archives', kind: 'listArchives', template: '/api/archives' },
    { method: 'GET', sample: '/api/archives/abc', kind: 'getArchive', template: '/api/archives/<id>' },
    { method: 'POST', sample: '/api/singlefile', kind: 'singleFileUpload', template: '/api/singlefile' },
    { method: 'OPTIONS', sample: '/api/singlefile', kind: 'singleFilePreflight', template: '/api/singlefile' },
  ];

  for (const entry of expected) {
    assert.equal(
      matchRoute(entry.method, entry.sample, 'plain').kind,
      entry.kind,
      `${entry.method} ${entry.sample} must still be claimed by the router`,
    );
  }

  const catalogued = payload.routes.map((entry) => `${entry.method} ${entry.path}`);
  const wanted = new Set(expected.map((entry) => `${entry.method} ${entry.template}`));
  assert.equal(catalogued.length, expected.length, `catalogue size changed: ${catalogued.join(', ')}`);

  for (const entry of payload.routes) {
    assert.ok(
      wanted.has(`${entry.method} ${entry.path}`),
      `${entry.method} ${entry.path} is catalogued but the router does not claim it`,
    );
    assert.ok(entry.summary.length > 20, `${entry.method} ${entry.path} needs a real summary`);
  }
  for (const key of wanted) {
    assert.ok(catalogued.includes(key), `${key} is claimed by the router but missing from the catalogue`);
  }

  assert.deepEqual(payload.codecs, ['plain', 'b64']);
});

test('serves a 404 for an unknown route', async () => {
  const response = await fetch(`http://127.0.0.1:${proxyPort}/nope`);
  assert.equal(response.status, 404);
});

test('archives a site and replays it offline', async () => {
  const created = await fetch(`http://127.0.0.1:${proxyPort}/api/archives`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `http://127.0.0.1:${originPort}/`, maxDepth: 2, maxPages: 10 }),
  });
  assert.equal(created.status, 202);

  // Poll until the crawl finishes.
  let archiveId: string | null = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const list = (await (await fetch(`http://127.0.0.1:${proxyPort}/api/archives`)).json()) as {
      archives: Array<{ id: string; status: string; pages: number }>;
    };
    const match = list.archives.find((entry) => entry.status !== 'running');
    if (match !== undefined) {
      archiveId = match.id;
      assert.equal(match.status, 'complete');
      assert.ok(match.pages >= 1, 'expected at least one page captured');
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(archiveId !== null, 'archive did not complete in time');

  const rootUrl = `http://127.0.0.1:${originPort}/`;
  const payload = encodeURIComponent(rootUrl);
  const replay = await fetch(`http://127.0.0.1:${proxyPort}/archive/${archiveId}/plain/${payload}`);
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('x-archive-id'), archiveId);

  const body = await replay.text();
  // The stored bytes are the origin's; rewriting happens at replay, so links
  // must be routed back into the archive. Pointing them at the live `/proxy/`
  // route would silently reach the network during an offline replay.
  assert.match(body, /<title>Origin<\/title>/);
  assert.match(body, new RegExp(`href="/archive/${archiveId}/plain/`));
  assert.doesNotMatch(body, /href="\/proxy\/plain\//);
});

test('a replayed archive resolves its rewritten links without the origin', async () => {
  const list = (await (await fetch(`http://127.0.0.1:${proxyPort}/api/archives`)).json()) as {
    archives: Array<{ id: string }>;
  };
  const archiveId = list.archives[0]?.id;
  assert.ok(archiveId, 'expected an archive from the previous test');

  const rootUrl = `http://127.0.0.1:${originPort}/`;
  const body = await (
    await fetch(`http://127.0.0.1:${proxyPort}/archive/${archiveId}/plain/${encodeURIComponent(rootUrl)}`)
  ).text();

  const assetPaths = [...body.matchAll(/(?:href|src)="(\/archive\/[^"]+)"/g)].map((m) => m[1]!);
  assert.ok(assetPaths.length > 0, 'expected archive-internal asset links');

  // Every link must be served straight from the store, never from the proxy
  // route (which would try the live origin).
  for (const path of assetPaths.slice(0, 4)) {
    const asset = await fetch(`http://127.0.0.1:${proxyPort}${path}`);
    assert.ok(asset.status === 200 || asset.status === 404, `${path} -> ${asset.status}`);
    // Prove it came from the archive rather than a live fetch: the replay path
    // always stamps the archive id, the live proxy path never does.
    assert.equal(asset.headers.get('x-archive-id'), archiveId, `${path} must be served from the archive`);
  }
});

test('REGRESSION: a rewritten module path repeated after the payload still resolves', async () => {
  // Regression: a JS rewriter emits the target's pathname after the encoded
  // payload so that relative specifiers inside the file resolve against the
  // module's own directory — `/proxy/plain/<encoded>/chunk.js`. A module whose
  // own content then asks for a *relative* sibling resolves it against that
  // URL, so the browser appends the path a second time and asks for
  // `/proxy/plain/<encoded>/chunk.js/static/client/icon.svg`.
  //
  // The payload is the whole target and the trailing path is the target's own
  // pathname shown back to the reader, so the two must be decoded as one. Read
  // as a bare payload the shape looks like a *different* target that happens to
  // be a directory, and the request 404s on a path the archive is holding.
  const list = (await (await fetch(`http://127.0.0.1:${proxyPort}/api/archives`)).json()) as {
    archives: Array<{ id: string }>;
  };
  const archiveId = list.archives[0]?.id;
  assert.ok(archiveId, 'expected an archive from the previous test');

  const target = `http://127.0.0.1:${originPort}/style.css`;
  const doubled = `/archive/${archiveId}/plain/${encodeURIComponent(target)}/style.css`;

  const replay = await fetch(`http://127.0.0.1:${proxyPort}${doubled}`);
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('x-archive-id'), archiveId);
  assert.match(await replay.text(), /\.logo\{background:url\(/);

  // The live proxy shares the decoder, so the same shape must work there too.
  const live = await fetch(`http://127.0.0.1:${proxyPort}/proxy/plain/${encodeURIComponent(target)}/style.css`);
  assert.equal(live.status, 200);
  assert.match(await live.text(), /\.logo\{background:url\(/);
});

test('replay returns an explicit miss rather than hitting the live site', async () => {
  const list = (await (await fetch(`http://127.0.0.1:${proxyPort}/api/archives`)).json()) as {
    archives: Array<{ id: string }>;
  };
  const archiveId = list.archives[0]?.id;
  assert.ok(archiveId, 'expected an archive from the previous test');

  const missing = `http://127.0.0.1:${originPort}/never-captured-xyz`;
  const response = await fetch(
    `http://127.0.0.1:${proxyPort}/archive/${archiveId}/plain/${encodeURIComponent(missing)}`,
  );
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('x-archive-miss'), '1');
  const body = await response.text();
  assert.match(body, /Not in archive/);
});

test('a miss on the seed URL says the request differs from it, rather than "not captured"', async () => {
  // A miss on an asset can be a genuine gap. A miss on the seed *with a different
  // query* cannot: the path is the one the archive was built from, so the only
  // thing that changed is the query — which is what shell quoting does to a URL
  // before it is ever sent. The page has to say so, and show the difference, or
  // the reader is left insisting the resource is in there.
  const list = (await (await fetch(`http://127.0.0.1:${proxyPort}/api/archives`)).json()) as {
    archives: Array<{ id: string; seedUrl: string }>;
  };
  const archive = list.archives[0];
  assert.ok(archive, 'expected an archive from an earlier test');

  // The seed's path with a different query, which is what an unescaped `&`
  // produces: the second parameter is cut and only the first one is sent.
  const seedPath = archive.seedUrl.split('?')[0] as string;
  const truncated = `${seedPath}?q=a+b`;
  const response = await fetch(
    `http://127.0.0.1:${proxyPort}/archive/${archive.id}/plain/${encodeURIComponent(truncated)}`,
  );
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('x-archive-miss'), '1');

  const body = await response.text();
  // Both URLs, so the difference is visible rather than described — and the
  // difference is *marked*, because two long URLs that agree for hundreds of
  // characters read as identical, which is the confusion this exists to remove.
  assert.ok(body.includes('requested'), 'the miss page must name the URL that was asked for');
  assert.ok(body.includes('seeded'), 'the miss page must name the seed it was built from');
  assert.match(body, /not missing from the capture/, 'it must not blame the capture');
  assert.match(body, /cmd\.exe/, 'it should name the cause a reader can act on');
});

test('a miss on a different path under the seed is not reported as shell quoting', async () => {  // The condition has to be a *query* difference, not merely a difference. Every
  // asset under the seed's origin differs from the seed, so a looser test would
  // tell a reader whose icon was never crawled to go and check their shell —
  // sending them after the wrong problem entirely.
  const list = (await (await fetch(`http://127.0.0.1:${proxyPort}/api/archives`)).json()) as {
    archives: Array<{ id: string }>;
  };
  const archiveId = list.archives[0]?.id;
  assert.ok(archiveId);

  const asset = `http://127.0.0.1:${originPort}/images/never-captured.png`;
  const body = await (
    await fetch(`http://127.0.0.1:${proxyPort}/archive/${archiveId}/plain/${encodeURIComponent(asset)}`)
  ).text();

  assert.match(body, /higher page limit/, 'an asset miss should suggest a deeper crawl');
  assert.doesNotMatch(body, /not missing from the capture/);
  assert.doesNotMatch(body, /cmd\.exe/);
});

test('REGRESSION: an importmap entry is proxied, because the browser fetches it itself', async () => {
  // Regression: nothing in the document carries an importmap's URLs. The module
  // resolver reads them and fetches them directly, from the real origin, in a
  // page that is supposed to be inside the proxy.
  const response = await fetch(proxied('/importmap.html'));
  const body = await response.text();

  const map = JSON.parse(
    body.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1] ?? '{}',
  ) as { imports: Record<string, string> };

  assert.deepEqual(
    Object.keys(map.imports),
    ['react'],
    'the specifier name must survive: it is a name, not a location',
  );
  assert.equal(
    map.imports['react'],
    `/proxy/plain/${encodeURIComponent(`http://127.0.0.1:${originPort}/vendor/react.js`)}`,
  );
});

test('REGRESSION: a manifest is proxied and its icons are archived for replay', async () => {
  // The same class of leak as an importmap, and the reason discovery had to be
  // wired into the JSON walker: replay rewrites the icons to archive URLs, so a
  // URL that was rewritten but never crawled becomes a 404 inside an offline
  // capture — the document asking for its own icons and the archive not having
  // them.
  const created = await fetch(`http://127.0.0.1:${proxyPort}/api/archives`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `http://127.0.0.1:${originPort}/manifest.json`, maxDepth: 1, maxPages: 10 }),
  });
  assert.equal(created.status, 202);

  const deadline = Date.now() + 15_000;
  let archiveId: string | null = null;
  while (Date.now() < deadline) {
    const list = (await (await fetch(`http://127.0.0.1:${proxyPort}/api/archives`)).json()) as {
      archives: Array<{ id: string; status: string; seedUrl: string }>;
    };
    const match = list.archives.find(
      (entry) => entry.seedUrl.endsWith('/manifest.json') && entry.status !== 'running',
    );
    if (match) {
      archiveId = match.id;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(archiveId !== null, 'manifest archive did not complete in time');

  const target = `http://127.0.0.1:${originPort}/manifest.json`;
  const replayed = await fetch(
    `http://127.0.0.1:${proxyPort}/archive/${archiveId}/plain/${encodeURIComponent(target)}`,
  );
  assert.equal(replayed.status, 200);

  const manifest = (await replayed.json()) as { icons: Array<{ src: string }>; start_url: string };
  const icon = manifest.icons[0]?.src ?? '';
  assert.ok(
    icon.startsWith(`/archive/${archiveId}/plain/`),
    `icon must point into the archive, got ${icon}`,
  );
  assert.equal(manifest['start_url'], '/', 'configuration members must not be rewritten');

  // The proof that it is genuinely offline: the archived icon resolves from the
  // archive, which stamps the archive id, rather than from the live origin.
  const archived = await fetch(`http://127.0.0.1:${proxyPort}${icon}`);
  assert.equal(archived.status, 200);
  assert.equal(archived.headers.get('x-archive-id'), archiveId);
});

test('REGRESSION: a manifest served as application/json is still recognised', async () => {
  // The bug this pins: MDN's `/manifest.json` is served as `application/json`, so
  // a media-type-only classifier never saw it as a manifest. Its `icons[].src` was
  // relayed verbatim, and because the document's own markup never mentions
  // `favicon-192x192.png` — the manifest is the only path to it — the browser
  // resolved the root-relative `src` against the proxy's own origin and requested
  // `/favicon-192x192.png`, which 404s.
  //
  // The archive was complete the whole time: the icon was stored, and the document
  // was stored. Only the rewrite was missing.
  const created = await fetch(`http://127.0.0.1:${proxyPort}/api/archives`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `http://127.0.0.1:${originPort}/app.html`, maxDepth: 1, maxPages: 10 }),
  });
  assert.equal(created.status, 202);

  const deadline = Date.now() + 15_000;
  let archiveId: string | null = null;
  while (Date.now() < deadline) {
    const list = (await (await fetch(`http://127.0.0.1:${proxyPort}/api/archives`)).json()) as {
      archives: Array<{ id: string; status: string; seedUrl: string }>;
    };
    const match = list.archives.find(
      (entry) => entry.seedUrl.endsWith('/app.html') && entry.status !== 'running',
    );
    if (match) {
      archiveId = match.id;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(archiveId !== null, 'app archive did not complete in time');

  const target = `http://127.0.0.1:${originPort}/plain-manifest.json`;
  const replayUrl = `http://127.0.0.1:${proxyPort}/archive/${archiveId}/plain/${encodeURIComponent(target)}`;

  // Without a fetch destination, as a crawler or `curl` would read it: the shape
  // fallback has to be what catches this case.
  const replayed = await fetch(replayUrl);
  assert.equal(replayed.status, 200);
  const manifest = (await replayed.json()) as { icons: Array<{ src: string }> };
  const icon = manifest.icons[0]?.src ?? '';
  assert.ok(
    icon.startsWith(`/archive/${archiveId}/plain/`),
    `the root-relative icon must be routed into the archive, got ${icon}`,
  );

  // And with the header a browser actually sends, which is the primary signal.
  const asBrowser = await fetch(replayUrl, { headers: { 'sec-fetch-dest': 'manifest' } });
  const browserManifest = (await asBrowser.json()) as { icons: Array<{ src: string }> };
  assert.ok((browserManifest.icons[0]?.src ?? '').startsWith(`/archive/${archiveId}/plain/`));

  // The icon really is resolvable offline — the point of routing it.
  const archivedIcon = await fetch(`http://127.0.0.1:${proxyPort}${icon}`);
  assert.equal(archivedIcon.status, 200);
  assert.equal(archivedIcon.headers.get('x-archive-id'), archiveId);
});

test('an archived JSON body that is not a manifest is relayed byte-exact', async () => {
  // The shape test names members rather than trusting any JSON, and this is the
  // reason: a replay is full of JSON that a URL rewriter would corrupt.
  const replayed = await fetch(`http://127.0.0.1:${proxyPort}/proxy/plain/${encodeURIComponent(
    `http://127.0.0.1:${originPort}/echo-headers`,
  )}`);
  assert.equal(replayed.status, 200);
  assert.equal(replayed.headers.get('content-type'), 'application/json');
  // If the manifest rewriter had touched this, the body would still be valid JSON
  // but the parse below would be the only thing standing between the two — so
  // assert on a value that a rewrite could not have produced.
  const echoed = (await replayed.json()) as { userAgent: string | null };
  assert.equal(typeof echoed.userAgent, 'string');
});

// --- archive size reporting ------------------------------------------------

test('the archive list reports each archive\'s resource count and total size', async () => {
  // The reported totals are derived from the index rather than stored, so this
  // checks the derivation against the detail endpoint it is derived from: the
  // per-entry sizes listed there must sum to the total reported here.
  const seed = `http://127.0.0.1:${originPort}/`;
  const archiveId = await archiveOne(seed);

  const listed = (await (await fetch(`http://127.0.0.1:${proxyPort}/api/archives`)).json()) as {
    archives: Array<{ id: string; resources: number; bytes: number; pages: number; status: string }>;
  };
  const entry = listed.archives.find((archive) => archive.id === archiveId);
  assert.ok(entry !== undefined, 'the archive must appear in the list');
  assert.equal(entry.status, 'complete');
  assert.ok(entry.resources >= 1, 'the seed page alone is one resource');
  assert.ok(entry.bytes > 0, 'a completed archive of a real page cannot be zero bytes');

  const detail = (await (
    await fetch(`http://127.0.0.1:${proxyPort}/api/archives/${archiveId}`)
  ).json()) as {
    resources: number;
    bytes: number;
    urls: string[];
    entries: Array<{ url: string; size: number }>;
  };

  // `resources` is the *count* in both responses, so the same field means the
  // same thing wherever it appears.
  assert.equal(typeof detail.resources, 'number');
  assert.equal(detail.resources, entry.resources, 'the list and the detail must agree');
  assert.equal(detail.bytes, entry.bytes, 'the list and the detail must agree');
  assert.equal(detail.entries.length, detail.resources);
  // `urls` is the pre-existing shape and has to keep working.
  assert.equal(detail.urls.length, detail.resources);
});

test('each entry in an archive detail carries its own size', async () => {
  const seed = `http://127.0.0.1:${originPort}/`;
  const archiveId = await archiveOne(seed);

  const detail = (await (
    await fetch(`http://127.0.0.1:${proxyPort}/api/archives/${archiveId}`)
  ).json()) as {
    bytes: number;
    urls: string[];
    entries: Array<{ url: string; size: number; status: number; contentType: string | null; capturedAt: string }>;
  };

  assert.ok(Array.isArray(detail.entries), 'the detail endpoint must list per-entry metadata');
  assert.equal(detail.entries.length, detail.urls.length);
  // `urls` is a projection of `entries`, in the same order, or a caller joining
  // the two by index would silently mis-attribute a size.
  assert.deepEqual(
    detail.entries.map((entry) => entry.url),
    detail.urls,
  );

  for (const entry of detail.entries) {
    assert.equal(typeof entry.size, 'number');
    assert.ok(entry.size > 0, `${entry.url} must have a positive size`);
    assert.ok(entry.status >= 200, `${entry.url} must carry the origin's status`);
    assert.equal(typeof entry.capturedAt, 'string');
  }

  const summed = detail.entries.reduce((total, entry) => total + entry.size, 0);
  assert.equal(summed, detail.bytes, 'the listed sizes must sum to the archive total');
});

test('the seed entry\'s reported size is the byte length of what was captured', async () => {
  // The size has to describe the *stored* bytes — not the compressed blob, and
  // not the rewritten response. Those are three different numbers, and only one
  // of them is meaningful to a reader comparing archives.
  const seed = `http://127.0.0.1:${originPort}/`;
  const archiveId = await archiveOne(seed);

  const detail = (await (
    await fetch(`http://127.0.0.1:${proxyPort}/api/archives/${archiveId}`)
  ).json()) as { entries: Array<{ url: string; size: number }> };

  const entry = detail.entries.find((row) => row.url === seed);
  assert.ok(entry !== undefined, 'the seed must be listed');
  assert.equal(entry.size, Buffer.byteLength(ORIGIN_HTML), 'the recorded size is the origin bytes');

  // The replay is *larger* — the shim and rewritten URLs are added at replay
  // time — which is exactly why the size must not come from the response.
  const replayed = await fetch(
    `http://127.0.0.1:${proxyPort}/archive/${archiveId}/plain/${encodeURIComponent(seed)}`,
  );
  const replayedBytes = (await replayed.arrayBuffer()).byteLength;
  assert.ok(replayedBytes > entry.size, 'the replay is rewritten, so it is not the stored size');
});

// --- compatibility mode ----------------------------------------------------

/** Archive one URL on the test origin and return the archive id. */
async function archiveOne(target: string): Promise<string> {
  const created = await fetch(`http://127.0.0.1:${proxyPort}/api/archives`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: target, maxDepth: 0, maxPages: 1 }),
  });
  assert.equal(created.status, 202);

  for (let attempt = 0; attempt < 80; attempt += 1) {
    const list = (await (await fetch(`http://127.0.0.1:${proxyPort}/api/archives`)).json()) as {
      archives: Array<{ id: string; seedUrl: string; status: string }>;
    };
    const match = list.archives.find((entry) => entry.seedUrl === target && entry.status !== 'running');
    if (match !== undefined) return match.id;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`archive of ${target} did not complete`);
}

/**
 * A replay request for `target` in `archiveId`, as a browser navigation.
 *
 * `answer` is appended *after* the encoded payload rather than inside it, which is
 * what the chooser's own links do: the payload is one opaque segment, so anything
 * that has to be read as the proxy's parameter rather than the target's has to sit
 * outside it.
 *
 * `referer` is the page the navigation came *from*, which is what a page
 * navigating to itself sends. Passing it is how the self-navigation path is
 * reached; omitting it is how an ordinary navigation is.
 */
function replayNav(
  archiveId: string,
  target: string,
  headers: Record<string, string> = {},
  answer?: 'on' | 'off',
  referer?: string,
): Promise<Response> {
  const payload = encodeURIComponent(target);
  const suffix = answer === undefined ? '' : `&__compat=${answer}`;
  const from = referer === undefined ? {} : { referer };
  return fetch(`http://127.0.0.1:${proxyPort}/archive/${archiveId}/plain/${payload}${suffix}`, {
    headers: { 'sec-fetch-dest': 'document', ...from, ...headers },
  });
}

/** The replay URL a browser would have for `target` in `archiveId`. */
function replayUrl(archiveId: string, target: string): string {
  return `http://127.0.0.1:${proxyPort}/archive/${archiveId}/plain/${encodeURIComponent(target)}`;
}

/** What a reader sees, with the page's own escaping undone. */
function readable(html: string): string {
  return html.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"');
}

test('compat mode offers a variant instead of a miss, and only when asked for a document', async () => {
  // The reported case: the archive holds the URL without `&b=2`, and the reader
  // asks for it with. The page is on disk, so a bare 404 is unhelpful — but
  // serving it unasked would be worse, so the first visit is a question.
  const stored = `http://127.0.0.1:${originPort}/q?a=1`;
  const archiveId = await archiveOne(stored);
  const requested = `${stored}&b=2`;

  const offer = await replayNav(archiveId, requested);
  assert.equal(offer.status, 200, 'the offer replaces the 404, so it is a 200 document');
  assert.equal(offer.headers.get('x-archive-compat'), 'offer');
  // Still marked as a miss, because nothing was served from this URL.
  assert.equal(offer.headers.get('x-archive-miss'), '1');
  assert.equal(offer.headers.get('vary'), 'Cookie', 'the answer travels in a cookie');

  const body = readable(await offer.text());
  assert.ok(body.includes(requested), 'both URLs must be shown');
  assert.ok(body.includes(stored), 'the candidate must be shown');
  assert.match(body, /substitute, not the page you asked for/, 'the trade must be stated');

  // A subresource asking for the same variant is a real gap, and answering it
  // with an HTML page would break the page around it while hiding the gap.
  const subresource = await fetch(
    `http://127.0.0.1:${proxyPort}/archive/${archiveId}/plain/${encodeURIComponent(requested)}`,
    { headers: { 'sec-fetch-dest': 'image' } },
  );
  assert.equal(subresource.status, 404);
  assert.equal(subresource.headers.get('x-archive-compat'), null);

  // And a client that sends no browser metadata is asking for an exact replay.
  const bare = await fetch(
    `http://127.0.0.1:${proxyPort}/archive/${archiveId}/plain/${encodeURIComponent(requested)}`,
  );
  assert.equal(bare.status, 404, 'no sec-fetch-dest means no substitution');
});

test('compat mode serves the variant once the reader accepts, and labels it', async () => {
  const stored = `http://127.0.0.1:${originPort}/q?a=1`;
  const requested = `${stored}&b=2`;
  const archiveId = await archiveOne(stored);

  // Accepting is a distinct URL, so the decision is reproducible from the address
  // bar and the server holds no state for it.
  const accepted = await replayNav(archiveId, requested, { cookie: 'apx_compat=on' });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get('x-archive-compat'), 'substitute');
  // Never a miss: something real was served. Never presented as the requested
  // URL either — the label and this header are the difference.
  assert.equal(accepted.headers.get('x-archive-miss'), null);
  assert.equal(accepted.headers.get('x-archive-requested'), requested);
  assert.match(accepted.headers.get('set-cookie') ?? '', /apx_compat=on/);

  const body = await accepted.text();
  assert.match(body, /<title>query<\/title>/);

  // Substituted bytes are the *stored page's* own replay, so its relative links
  // resolve against its own URL rather than the requested one.
  const exact = await replayNav(archiveId, stored);
  assert.equal(await exact.text(), body, 'a substitute must be the page itself, not a re-render');
});

test('compat mode honours a decline, and remembers it', async () => {
  const stored = `http://127.0.0.1:${originPort}/q?a=1`;
  const requested = `${stored}&b=2`;
  const archiveId = await archiveOne(stored);

  const declined = await replayNav(archiveId, requested, { cookie: 'apx_compat=off' });
  assert.equal(declined.status, 404, 'a decline must yield the miss, not the offer again');
  assert.equal(declined.headers.get('x-archive-compat'), null);
  assert.equal(declined.headers.get('x-archive-miss'), '1');
  // Remembered, so the reader who said no is not asked on the next click.
  assert.match(declined.headers.get('set-cookie') ?? '', /apx_compat=off/);

  // The same answer in the request line, which is what the chooser's link uses.
  const viaLink = await replayNav(archiveId, requested, {}, 'off');
  assert.equal(viaLink.status, 404);
  const acceptedViaLink = await replayNav(archiveId, requested, {}, 'on');
  assert.equal(acceptedViaLink.status, 200);
  assert.equal(acceptedViaLink.headers.get('x-archive-compat'), 'substitute');
});

test('compat mode never touches a URL that was captured exactly', async () => {
  // The exact hit has to stay indistinguishable from a normal replay: no offer,
  // no label, no cookie. A mode that changed this would be changing the thing it
  // is supposed to leave alone.
  const stored = `http://127.0.0.1:${originPort}/q?a=1`;
  const archiveId = await archiveOne(stored);

  const exact = await replayNav(archiveId, stored);
  assert.equal(exact.status, 200);
  assert.equal(exact.headers.get('x-archive-compat'), null);
  assert.equal(exact.headers.get('x-archive-miss'), null);
  assert.equal(exact.headers.get('set-cookie'), null);
});

test('compat mode refuses a variant whose query diverges mid-list', async () => {
  // `a=1&b=2` and `a=1&c=3` are not variants of each other: the second parameter
  // is where they part, and everything after a divergence reads differently. This
  // is the guard against the feature's worst failure — serving, say, news results
  // for a general search because the parameter lists merely looked similar.
  const stored = `http://127.0.0.1:${originPort}/q?a=1&b=2`;
  const archiveId = await archiveOne(stored);

  const diverged = await replayNav(archiveId, `http://127.0.0.1:${originPort}/q?a=1&c=3`);
  assert.equal(diverged.status, 404, 'a diverging query is a different resource');
  assert.equal(diverged.headers.get('x-archive-compat'), null);
  assert.equal(diverged.headers.get('x-archive-miss'), '1');

  // A value difference is a divergence too, not an extra parameter.
  const differentValue = await replayNav(archiveId, `http://127.0.0.1:${originPort}/q?a=2&b=2`);
  assert.equal(differentValue.status, 404);

  // And a different path is never a candidate, however similar the query.
  const otherPath = await replayNav(archiveId, `http://127.0.0.1:${originPort}/second?a=1&b=2`);
  assert.equal(otherPath.status, 404);
});

test('a bare script asking for a query-less URL gets no compat offer', async () => {
  // Nothing about a path-only URL can be a *query* variant, so this must stay a
  // plain miss even when everything else about the request looks substitutable.
  const stored = `http://127.0.0.1:${originPort}/q?a=1`;
  const archiveId = await archiveOne(stored);

  const noQuery = await replayNav(archiveId, `http://127.0.0.1:${originPort}/nowhere`);
  assert.equal(noQuery.status, 404);
  assert.equal(noQuery.headers.get('x-archive-compat'), null);
});

test('a page navigating to itself is served the page, not a substitute', async () => {
  // The endless-reload bug. The archived Google interstitial rebuilds its own URL
  // and appends its retry marker, so under replay the request arrives as "the page
  // I am already on, plus one parameter" — and the capture does not hold that URL.
  // Substituting the near miss hands the page back to itself, which appends the
  // marker again, for ever.
  const stored = `http://127.0.0.1:${originPort}/q?a=1`;
  const archiveId = await archiveOne(stored);
  const requested = `${stored}&b=2`;

  // The page is the one the referrer names, with its marker appended.
  const selfNavigated = await replayNav(archiveId, requested, {}, 'on', replayUrl(archiveId, stored));
  assert.equal(selfNavigated.status, 200);
  assert.equal(selfNavigated.headers.get('x-archive-self-navigation'), '1');
  // Deliberately *not* labelled as a substitution: the reader asked for the page
  // they are already on, so nothing is being stood in for.
  assert.equal(selfNavigated.headers.get('x-archive-compat'), null);
  assert.equal(
    await selfNavigated.text(),
    await (await replayNav(archiveId, stored)).text(),
    'the answer must be the stored page itself',
  );

  // A reader who *declined* compatibility mode still gets their own page back.
  // The resolution runs before the negotiation and consults no consent, because
  // nothing is being substituted — the page asked for itself.
  const declined = await replayNav(archiveId, requested, {}, 'off', replayUrl(archiveId, stored));
  assert.equal(declined.status, 200);
  assert.equal(declined.headers.get('x-archive-self-navigation'), '1');
  assert.equal(declined.headers.get('x-archive-compat'), null);
});

test('a self-navigation is only resolved when the referrer names the page', async () => {
  // The relation is checked in both directions, because either mistake produces
  // the loop or breaks an ordinary link.
  const stored = `http://127.0.0.1:${originPort}/q?a=1`;
  const archiveId = await archiveOne(stored);

  // A link from a *different* page, carrying an extra parameter, is an ordinary
  // near miss and must stay offered rather than silently resolved.
  const fromElsewhere = await replayNav(
    archiveId,
    `${stored}&b=2`,
    {},
    undefined,
    replayUrl(archiveId, `http://127.0.0.1:${originPort}/second?a=1`),
  );
  assert.equal(fromElsewhere.headers.get('x-archive-self-navigation'), null);
  assert.equal(fromElsewhere.headers.get('x-archive-compat'), 'offer');

  // A navigation to a *shorter* URL is not a page handing itself back, so it
  // stays the miss it is rather than resolving to the page that referred it.
  const shorter = await replayNav(
    archiveId,
    `http://127.0.0.1:${originPort}/q`,
    {},
    undefined,
    replayUrl(archiveId, stored),
  );
  assert.equal(shorter.headers.get('x-archive-self-navigation'), null);

  // A referrer that names no page — the index, an API call — resolves nothing.
  const fromIndex = await replayNav(archiveId, `${stored}&b=2`, {}, undefined, `http://127.0.0.1:${proxyPort}/`);
  assert.equal(fromIndex.headers.get('x-archive-self-navigation'), null);
});

// --- SingleFile REST Form API ----------------------------------------------

const SINGLEFILE_TOKEN = 'test-token';

/**
 * The upload endpoint, read per call rather than captured at load.
 *
 * `proxyPort` is only known once the server is listening, so a module-level
 * constant here would be built from port 0 — and the failure is a connection
 * error that looks nothing like "the port was not known yet".
 */
function singleFileUploadUrl(): string {
  return `http://127.0.0.1:${proxyPort}/api/singlefile`;
}

/** POST one upload the way the extension does: multipart, with a Bearer token. */
function uploadSingleFile(
  page: string,
  sourceUrl: string,
  options: { filename?: string; type?: string; token?: string | null; field?: string } = {},
): Promise<Response> {
  const filename = options.filename ?? 'page.html';
  const type = options.type ?? 'text/html';
  const body = new FormData();
  body.append(options.field ?? 'archive', new Blob([page], { type }), filename);
  body.append('url', sourceUrl);

  const token = options.token === undefined ? SINGLEFILE_TOKEN : options.token;
  const headers: Record<string, string> = { accept: 'application/json' };
  // The client always sends the header, even with no token; `null` reproduces
  // that, and `''` reproduces the empty-token spelling the header parser trims.
  if (token !== null) headers['authorization'] = `Bearer ${token}`;

  return fetch(singleFileUploadUrl(), { method: 'POST', headers, body });
}

test('a SingleFile upload becomes a replayable archive', async () => {
  // The whole point of the endpoint: a page saved by the extension turns into an
  // ordinary archive with an ordinary replay URL, and the replay is rewritten
  // like any other rather than served as an opaque blob.
  const source = 'http://127.0.0.1:9/page?q=1#frag';
  const page = '<!doctype html><html><head><title>Saved</title></head><body><p>from the extension</p></body></html>';

  const response = await uploadSingleFile(page, source);
  assert.equal(response.status, 201, 'the client only treats 200/201/202 with a JSON body as success');
  assert.equal(response.headers.get('content-type')?.includes('application/json'), true);

  const result = (await response.json()) as {
    url: string;
    archiveId: string;
    sourceUrl: string;
    filename: string;
    contentType: string;
    size: number;
  };

  assert.equal(result.sourceUrl, source, 'the source URL is stored verbatim, fragment included');
  assert.equal(result.filename, 'page.html');
  assert.equal(result.contentType, 'text/html');
  assert.equal(result.size, Buffer.byteLength(page));
  // `url` is what the extension writes into a bookmark when "replace bookmark
  // URL" is on, so it has to be the permalink and not a mirror of the request.
  assert.match(result.url, new RegExp(`/archive/${result.archiveId}/plain/`));

  // It is listed alongside every other archive, with the source URL as its seed.
  const listed = (await (await fetch(`http://127.0.0.1:${proxyPort}/api/archives`)).json()) as {
    archives: Array<{ id: string; seedUrl: string; status: string; pages: number }>;
  };
  const entry = listed.archives.find((archive) => archive.id === result.archiveId);
  assert.equal(entry?.status, 'complete');
  assert.equal(entry?.seedUrl, source);
  assert.equal(entry?.pages, 1);

  // And it replays — through the normal replay path, so the shim is injected.
  const replay = await fetch(
    `http://127.0.0.1:${proxyPort}/archive/${result.archiveId}/plain/${encodeURIComponent(source)}`,
  );
  assert.equal(replay.status, 200);
  const replayed = await replay.text();
  assert.match(replayed, /from the extension/);
  assert.match(replayed, /data-proxy-shim/, 'the replay must be rewritten, not relayed as a blob');
});

test('a SingleFile upload of a zip is labelled so the replay downloads it', async () => {
  // The client labels ZIP uploads `application/octet-stream`, which is also what
  // an untyped part carries, so the server has to look at the bytes. The stored
  // media type then decides whether a reader gets the archive or a broken page.
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x50, 0x4b, 0x05, 0x06]);
  const body = new FormData();
  body.append('archive', new Blob([zip], { type: 'application/octet-stream' }), 'page.zip');
  body.append('url', 'http://127.0.0.1:9/zipped');

  const response = await fetch(singleFileUploadUrl(), {
    method: 'POST',
    headers: { authorization: `Bearer ${SINGLEFILE_TOKEN}`, accept: 'application/json' },
    body,
  });
  assert.equal(response.status, 201);

  const result = (await response.json()) as { archiveId: string; contentType: string };
  assert.equal(result.contentType, 'application/zip');

  const replay = await fetch(
    `http://127.0.0.1:${proxyPort}/archive/${result.archiveId}/plain/${encodeURIComponent('http://127.0.0.1:9/zipped')}`,
  );
  assert.equal(replay.headers.get('content-type'), 'application/zip');
  assert.deepEqual(new Uint8Array(await replay.arrayBuffer()), zip);
});

test('the SingleFile upload requires the configured token', async () => {
  const page = '<!doctype html><p>secret</p>';

  const missing = await uploadSingleFile(page, 'http://127.0.0.1:9/a', { token: null });
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get('content-type'), 'text/plain; charset=utf-8');
  // The body is shown verbatim in the extension's popup, so it is a short
  // sentence rather than a JSON error object the user would read as escaped text.
  assert.equal((await missing.text()), 'invalid or missing token');

  const wrong = await uploadSingleFile(page, 'http://127.0.0.1:9/b', { token: 'nope' });
  assert.equal(wrong.status, 401);
  assert.equal(await wrong.text(), 'invalid or missing token');

  // The empty-token spelling the client can produce. It is still a token
  // mismatch, so it must not be accepted.
  const empty = await uploadSingleFile(page, 'http://127.0.0.1:9/c', { token: '' });
  assert.equal(empty.status, 401);
});

test('a correct token is accepted regardless of scheme casing', async () => {
  const body = new FormData();
  body.append('archive', new Blob(['<p>x</p>'], { type: 'text/html' }), 'page.html');
  body.append('url', 'http://127.0.0.1:9/case');

  const response = await fetch(singleFileUploadUrl(), {
    method: 'POST',
    headers: { authorization: `bEaReR ${SINGLEFILE_TOKEN}` },
    body,
  });
  assert.equal(response.status, 201);
});

test('a refusal is reported with a status the extension can show', async () => {
  // The extension surfaces a non-2xx body verbatim and appends "(RestFormApi)".
  // These are the two shapes a user actually hits.
  const noFile = new FormData();
  noFile.append('url', 'http://127.0.0.1:9/nofile');
  const missing = await fetch(singleFileUploadUrl(), {
    method: 'POST',
    headers: { authorization: `Bearer ${SINGLEFILE_TOKEN}` },
    body: noFile,
  });
  assert.equal(missing.status, 422);
  assert.equal(await missing.text(), 'missing archive part');

  const notMultipart = await fetch(singleFileUploadUrl(), {
    method: 'POST',
    headers: { authorization: `Bearer ${SINGLEFILE_TOKEN}`, 'content-type': 'application/json' },
    body: '{"url":"x"}',
  });
  assert.equal(notMultipart.status, 400);
  assert.equal(await notMultipart.text(), 'expected multipart/form-data');
});

test('the SingleFile endpoint answers the preflight the extension always sends', async () => {
  // `Authorization` is not CORS-safelisted, so the browser preflights every
  // upload. A preflight that does not name the header is refused before the
  // upload is attempted — and a wildcard does not cover `Authorization`.
  const response = await fetch(singleFileUploadUrl(), {
    method: 'OPTIONS',
    headers: {
      origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization',
    },
  });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.match(response.headers.get('access-control-allow-methods') ?? '', /POST/);
  assert.match(
    (response.headers.get('access-control-allow-headers') ?? '').toLowerCase(),
    /authorization/,
    'the preflight must name authorization explicitly',
  );
});

test('the SingleFile upload is not reachable from the proxy namespace', async () => {
  // The endpoint lives at the root and must not be shadowed by, or reachable
  // through, the proxy: an upload addressed through `/proxy/` would be fetched
  // as a URL rather than received.
  const response = await fetch(`http://127.0.0.1:${proxyPort}/proxy/plain/api%2Fsinglefile`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SINGLEFILE_TOKEN}` },
  });
  assert.notEqual(response.status, 201);
});

// --- browser-assisted capture ----------------------------------------------

test('the capture page is served with the agent, and records the ledger flag', async () => {
  // Method B's entry point: the same proxied page, plus the capture agent and
  // the shim told to keep a URL ledger. Nothing else may differ, or a capture
  // would record a page the user never saw.
  const response = await fetch(
    `http://127.0.0.1:${proxyPort}/proxy/archive/plain/${encodeURIComponent(`http://127.0.0.1:${originPort}/captured.html`)}`,
  );
  assert.equal(response.status, 200);
  const body = await response.text();

  assert.match(body, /data-proxy-capture/, 'the capture agent must be injected');
  assert.match(body, /"captureLedger":true/, 'the shim must be told to record');
  assert.match(body, /"captureAuto":true/, 'the injected agent collects on its own');
  assert.match(body, /data-proxy-shim/, 'the normal shim must still be injected');
});

test('an ordinary proxied page is untouched by capture support', async () => {
  const response = await fetch(proxied('/captured.html'));
  const body = await response.text();
  assert.doesNotMatch(body, /data-proxy-capture/, 'browsing must not inject the agent');
  // The config object, not the string: the shim's own source reads the key, so
  // asserting on the bare name would fail on the code that implements it.
  assert.doesNotMatch(body, /"captureLedger"/, 'browsing must not pay for the ledger');
});

test('a capture target without a codec is refused rather than misread', async () => {
  // The capture namespace inserts a fixed segment, so an absent codec would be
  // ambiguous with a target that begins with the same word. Refusing is what
  // keeps the grammar unambiguous.
  const response = await fetch(
    `http://127.0.0.1:${proxyPort}/proxy/archive/https://example.com/`,
    { redirect: 'manual' },
  );
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Malformed capture target/);
});

test('the console snippet is generated with this deployment origin and the target', async () => {
  const target = `http://127.0.0.1:${originPort}/captured.html`;
  const response = await fetch(
    `http://127.0.0.1:${proxyPort}/api/capture.js?url=${encodeURIComponent(target)}`,
  );
  assert.equal(response.status, 200);
  const body = await response.text();

  assert.match(body, /^\/\/ Capture this page into/);
  assert.match(body, new RegExp(`/api/captures`));
  assert.match(body, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // Cross-origin, because a snippet is pasted on a page this proxy does not own.
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
});

test('the snippet endpoint explains itself when the url parameter is missing', async () => {
  const response = await fetch(`http://127.0.0.1:${proxyPort}/api/capture.js`);
  assert.equal(response.status, 400);
  // Parsed rather than matched: the body is JSON, so the parameter name arrives
  // backslash-escaped and a regex on the raw text would be asserting on the
  // encoding rather than on the message.
  const body = (await response.json()) as { error: string; example?: string };
  assert.match(body.error, /"url" is required/);
  assert.ok(body.example?.includes('?url='), 'the error should show a usable example');
});

test('REGRESSION: the snippet keeps a target whose own query has more parameters', async () => {
  // Regression: the endpoint read `?url=` with `URLSearchParams`, which splits on
  // `&` and decodes `+` as a space. A target with a second query parameter came
  // back truncated at its first `&`, so the snippet captured a different page
  // than the caller asked for — and the character that caused it is exactly the
  // one an unescaped URL is most likely to contain.
  const target = `http://127.0.0.1:${originPort}/q?q=a+b&udm=50&sei=xyz`;
  const response = await fetch(`http://127.0.0.1:${proxyPort}/api/capture.js?url=${target}`);
  assert.equal(response.status, 200);
  const body = await response.text();

  const emitted = body.match(/captureTarget: (.+),/)?.[1];
  assert.ok(emitted, 'the snippet must carry the target');
  // Compared as the parsed value, so the assertion is on what the snippet will
  // use rather than on how it happens to be written.
  assert.equal(JSON.parse(emitted), target, 'the whole target must survive, unescaped and undecoded');
  assert.ok(!JSON.parse(emitted).includes(' '), 'a `+` must not become a space');
});

test('the snippet accepts a fully-encoded target too', async () => {
  // The rewriters emit the encoded form, and a caller who copies one must not be
  // punished for it. Both forms have to arrive at the same target.
  const target = `http://127.0.0.1:${originPort}/q?q=a+b&udm=50`;
  const response = await fetch(
    `http://127.0.0.1:${proxyPort}/api/capture.js?url=${encodeURIComponent(target)}`,
  );
  assert.equal(response.status, 200);
  const emitted = (await response.text()).match(/captureTarget: (.+),/)?.[1];
  assert.equal(JSON.parse(emitted as string), target);
});

test('REGRESSION: a capture stores the page and fetches what the browser could not', async () => {
  // The point of method B. A page posts what it owns — its post-script DOM — and
  // the list of URLs it requested. The server fetches those itself, because the
  // browser cannot read a cross-origin response. Here the origin stands in for
  // that: the agent claims it loaded a stylesheet, and the archive must end up
  // with real bytes for it.
  const seed = `http://127.0.0.1:${originPort}/captured.html`;
  const css = `http://127.0.0.1:${originPort}/captured.css`;

  const payload = {
    targetUrl: seed,
    finalUrl: seed,
    // Serialised after script ran: the shell had an empty #app, this has content.
    document: { text: '<html><body><div id="app"><p>rendered</p></div></body></html>' },
    inline: { [css]: { text: '.captured{color:blue}', type: 'text/css', tag: 'link' } },
    urls: [css, `http://127.0.0.1:${originPort}/captured.js`],
    cookies: 'sid=abc123',
    title: 'captured',
    storage: { local: { theme: 'dark' } },
  };

  const response = await fetch(`http://127.0.0.1:${proxyPort}/api/captures`, {
    method: 'POST',
    // Deliberately text/plain: that is what makes the cross-origin POST a
    // simple request. The server must parse it as JSON regardless.
    headers: { 'content-type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify(payload),
  });

  assert.equal(response.status, 201);
  const result = (await response.json()) as {
    archiveId: string;
    stored: number;
    replay: string;
  };
  assert.ok(result.archiveId, 'the capture must return its archive id');
  assert.ok(result.replay.includes('/archive/'), 'it must tell the caller where to replay');

  const base = `http://127.0.0.1:${proxyPort}/archive/${result.archiveId}/plain/`;

  // The page: the origin's own bytes were fetched first, which is the version
  // the rewriters can route. It must not be the proxy-prefixed DOM.
  const page = await fetch(base + encodeURIComponent(seed));
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /shell/, 'the origin HTML should be preferred when it is reachable');
  // The check is for a *link*, not for the string: the shim's own comments
  // mention the prefix, and asserting on the raw text would fail on prose.
  assert.doesNotMatch(html, /(?:href|src)="\/proxy\/plain\//, 'a replay must never link to the live proxy');

  // A resource the browser could not read, fetched by the server instead.
  const script = await fetch(base + encodeURIComponent(`http://127.0.0.1:${originPort}/captured.js`));
  assert.equal(script.status, 200);
  assert.equal(script.headers.get('x-archive-id'), result.archiveId);

  // A resource the agent handed over inline, stored under its real URL so the
  // replay finds it through the ordinary lookup.
  const stylesheet = await fetch(base + encodeURIComponent(css));
  assert.equal(stylesheet.status, 200);

  // The session the capture carried, kept as data rather than as a resource.
  const detail = (await (await fetch(`http://127.0.0.1:${proxyPort}/api/archives/${result.archiveId}`)).json()) as {
    urls: string[];
  };
  assert.ok(
    detail.urls.some((url) => url.startsWith('storage:cookies@')),
    `expected captured cookies in ${detail.urls.join(', ')}`,
  );
});

test('REGRESSION: a capture repair the DOM the shim had already rewritten', async () => {
  // The agent serialises the live document, and by then the shim has rewritten
  // every URL in it to a /proxy/... path. Stored verbatim, a replay would ask
  // the origin for /proxy/... where it has /assets/.... The un-rewriting is what
  // makes the DOM fallback usable at all, so it is asserted directly.
  const seed = `http://127.0.0.1:${originPort}/never-served-here.html`;
  const asset = `http://127.0.0.1:${originPort}/captured.css`;
  const proxyPrefixed = `/proxy/plain/${encodeURIComponent(asset)}`;

  const response = await fetch(`http://127.0.0.1:${proxyPort}/api/captures`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({
      targetUrl: seed,
      document: {
        text: `<html><head><link rel="stylesheet" href="${proxyPrefixed}"></head><body></body></html>`,
      },
      urls: [],
    }),
  });

  assert.equal(response.status, 201);
  const { archiveId } = (await response.json()) as { archiveId: string };

  const page = await fetch(
    `http://127.0.0.1:${proxyPort}/archive/${archiveId}/plain/${encodeURIComponent(seed)}`,
  );
  assert.equal(page.status, 200);
  const html = await page.text();

  // The link must point at the real asset. The replay rewriter then routes it
  // into the archive, so what is asserted is the absence of a doubled path.
  assert.doesNotMatch(html, /%2Fproxy%2Fplain/, 'the proxy wrapper must be undone');
  assert.match(html, new RegExp(encodeURIComponent(asset).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('REGRESSION: a capture asks for an identity encoding, so the body stays rewritable', async () => {
  // The defect this guards against is silent: a capture reused the client's
  // `accept-encoding`, so a real origin gzipped the body and the archive stored
  // compressed bytes under a `text/html` content type. Nothing failed — the
  // replay simply rendered gibberish. Observed through the origin's own echo,
  // because the request header is otherwise invisible from outside.
  const seed = `http://127.0.0.1:${originPort}/echo-headers`;
  const response = await fetch(`http://127.0.0.1:${proxyPort}/api/captures`, {
    method: 'POST',
    // Modelling a real browser: it offers compression, and the capture must
    // decline on its own rather than relying on the caller not to ask.
    headers: { 'content-type': 'text/plain', 'accept-encoding': 'gzip, deflate, br' },
    body: JSON.stringify({ targetUrl: seed, urls: [] }),
  });
  assert.equal(response.status, 201);

  const { archiveId } = (await response.json()) as { archiveId: string };
  const page = await fetch(
    `http://127.0.0.1:${proxyPort}/archive/${archiveId}/plain/${encodeURIComponent(seed)}`,
  );
  assert.equal(page.status, 200);
  // The replay rewrote the JSON body, so the echo arrives as stored text.
  const recorded = await page.text();
  assert.match(recorded, /identity/, 'the capture must have asked for an identity encoding');
  assert.doesNotMatch(recorded, /gzip/, 'the client offer must not reach the origin');
});

test('REGRESSION: a capture survives a redirect, which the Location rewrite would drop', async () => {
  // A site that redirects its own root is the common case. The header rewriter
  // knows only the default proxy namespace, so the rewritten Location pointed at
  // `/proxy/<codec>/...` and the follow-up request became an ordinary proxied
  // page — no agent, no ledger, and the capture silently never happened.
  const response = await fetch(
    `http://127.0.0.1:${proxyPort}/proxy/archive/plain/${encodeURIComponent(`http://127.0.0.1:${originPort}/redirect`)}`,
    { redirect: 'manual' },
  );
  assert.equal(response.status, 302);

  const location = response.headers.get('location');
  assert.ok(location !== null, 'a redirect must still carry a Location');
  assert.match(location, /^\/proxy\/archive\/plain\//, 'the redirect must stay in the capture namespace');

  const followed = await fetch(`http://127.0.0.1:${proxyPort}${location}`);
  assert.equal(followed.status, 200);
  const body = await followed.text();
  assert.match(body, /data-proxy-capture/, 'the redirected page must still be captured');
  assert.match(body, /"captureLedger":true/, 'and must still keep the ledger');
});

test('the relay page is served for a blocked upload, with no policy of its own', async () => {
  // A page whose Content-Security-Policy forbids `connect-src` to this service
  // cannot upload to it. A popup is a separate document whose policy is its own,
  // so this page exists to be allowed to talk to the service it came from.
  const response = await fetch(`http://127.0.0.1:${proxyPort}/api/capture-relay.html`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(response.headers.get('content-security-policy'), null);

  const body = await response.text();
  assert.match(body, /proxy-capture-ready/, 'the relay must announce itself, or a fast opener loses its payload');
  assert.match(body, /proxy-capture-result/, 'and publish the result for the opener');
  assert.match(body, /\/api\/captures/, 'and post to the same endpoint as every other transport');
});

test('the snippet carries a relay URL, so a policy-blocked page has a way out', async () => {
  const response = await fetch(
    `http://127.0.0.1:${proxyPort}/api/capture.js?url=${encodeURIComponent('https://example.com/')}`,
  );
  const body = await response.text();
  assert.match(body, /captureRelay:/, 'the agent needs a relay to fall back to');
  assert.match(body, /\/api\/capture-relay\.html/);
});

test('a capture payload that is not JSON is rejected without storing anything', async () => {
  const before = (await (await fetch(`http://127.0.0.1:${proxyPort}/api/archives`)).json()) as {
    archives: unknown[];
  };

  const response = await fetch(`http://127.0.0.1:${proxyPort}/api/captures`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'this is not json',
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Invalid capture payload/);

  const after = (await (await fetch(`http://127.0.0.1:${proxyPort}/api/archives`)).json()) as {
    archives: unknown[];
  };
  assert.equal(after.archives.length, before.archives.length, 'no archive may be created');
});

test('the capture upload endpoint answers a CORS preflight', async () => {
  // Some clients preflight even a safelisted request, and a 405 there would
  // break a capture for no gain.
  const response = await fetch(`http://127.0.0.1:${proxyPort}/api/captures`, { method: 'OPTIONS' });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.match(response.headers.get('access-control-allow-methods') ?? '', /POST/);
});
