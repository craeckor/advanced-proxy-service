import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { IncomingMessage } from 'node:http';
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
import { isAssetLikePath, resolveRebasedRequest } from '../src/server/rebasing.ts';

/**
 * The referring-page fallback: requests that reach the proxy root with no
 * target of their own, re-issued against the site the browser was already on.
 *
 * Every refusal matters as much as every success here. The fallback only ever
 * converts a 404 into a real response, so the interesting assertions are the
 * ones proving it stays out of the way when the guess is not well founded.
 */

let origin: Server;
let originPort = 0;
let proxy: Awaited<ReturnType<ProxyServer['listen']>>;
let proxyPort = 0;
let dataDir = '';
let store: ArchiveStore;

/** Paths the origin was actually asked for, so leaks can be detected. */
let originHits: string[] = [];

before(async () => {
  origin = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${originPort}`);
    originHits.push(url.pathname);

    const json = (payload: unknown) => {
      const body = JSON.stringify(payload);
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(body.length) });
      res.end(body);
    };

    switch (url.pathname) {
      case '/page.html':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><head><base href="/"></head><body>page</body></html>');
        return;

      // A document sitting at an extension that claims it is a file.
      // A document path is not an asset, and `html`/`htm` are deliberately not
      // in `ASSET_LIKE`: a rebase that would be vetoed on every successful
      // answer is not worth attempting.
      case '/assets/bait.exe':
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': 'bait=1; Path=/',
        });
        res.end('<!doctype html><html><body>not a file</body></html>');
        return;

      case '/assets/i18n/en.json':
        json({ locale: 'en', greeting: 'hello' });
        return;

      // The shape a real site uses for its own image proxy: extensionless, with
      // an opaque payload. MDN serves `/pimg/<base64>.<hmac>` this way, and no
      // guess about the path can recognise it — which is the whole reason the
      // browser's own fetch destination is used instead of the path's shape.
      case '/pimg/aHR0cHM6LmpwZw':
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': '4' });
        res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
        return;

      case '/assets/main.js':
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end('export default 1;');
        return;

      case '/about':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><body>about</body></html>');
        return;

      default:
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('origin 404');
    }
  });

  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
  const address = origin.address();
  originPort = typeof address === 'object' && address !== null ? address.port : 0;

  dataDir = await mkdtemp(join(tmpdir(), 'proxy-rebase-test-'));

  const config = parseConfig({
    server: { host: '127.0.0.1', port: 0 },
    archive: { dataDir, respectRobotsTxt: false },
    log: { level: 'silent' },
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
  for (const response of open) {
    // A status-only assertion leaves the body unread, which keeps a connection
    // alive until close() aborts it.
    try {
      await response.body?.cancel();
    } catch {
      /* already consumed or aborted */
    }
  }
  await proxy?.close();
  store?.close();
  await new Promise<void>((resolve) => origin.close(() => resolve()));
  if (dataDir !== '') await rm(dataDir, { recursive: true, force: true });
});

const ORIGIN = (): string => `http://127.0.0.1:${originPort}`;
const PROXY = (): string => `http://127.0.0.1:${proxyPort}`;
const proxyRoot = (path: string): string => `${PROXY()}${path}`;

/** The live proxy URL for a page on the test origin. */
function pageUrl(path: string): string {
  return `${PROXY()}/proxy/plain/${encodeURIComponent(`${ORIGIN()}${path}`)}`;
}

/**
 * Responses whose bodies were never read.
 *
 * An unread body holds an open connection, and closing the servers at the end of
 * the run aborts it — which surfaces as an uncaught exception long after the
 * test that caused it has passed. Cancelling them all in `after` keeps that
 * noise out of the results without every status-only assertion having to
 * remember to drain.
 */
const open: Response[] = [];

async function request(url: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, { redirect: 'manual', ...init });
  open.push(response);
  return response;
}

/** Issue a request the way a browser would: prefixless, with a referer. */
async function subresource(
  path: string,
  referer: string | null,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (referer !== null) headers.set('referer', referer);
  return request(proxyRoot(path), { ...init, headers });
}

// --- classification ---------------------------------------------------------

test('file-shaped paths are assets, routes are not', () => {
  assert.equal(isAssetLikePath('/assets/i18n/en.json'), true);
  assert.equal(isAssetLikePath('/js/main.js'), true);
  assert.equal(isAssetLikePath('/logo.svg'), true);
  assert.equal(isAssetLikePath('/img/photo.WEBP'), true);
  assert.equal(isAssetLikePath('/about'), false);
  assert.equal(isAssetLikePath('/'), false);
  assert.equal(isAssetLikePath('/assets/v1.2/thing'), false);
});

// --- the case the fallback exists for ---------------------------------------

test('REGRESSION: a runtime-assembled asset path is rebased onto the referring page origin', async () => {
  // `base + "/assets/i18n/" + lang + ".json"` never appears in any document, so
  // no rewriter can see it, and it arrives at the proxy root.
  originHits = [];
  const response = await subresource('/assets/i18n/en.json?hash=51e881e', pageUrl('/page.html'));

  assert.equal(response.status, 200);
  const body = (await response.json()) as { locale: string };
  assert.equal(body.locale, 'en');
  assert.deepEqual(originHits, ['/assets/i18n/en.json']);
});

test('the rebased response is side-effect free: no shim, no proxied links', async () => {
  // The document that is *not* the user's navigation context must not have the
  // runtime shim injected or its own URLs rewritten into proxy links; it is a
  // subresource, and mutating it would be visible to the page.
  const response = await subresource('/assets/main.js', pageUrl('/page.html'));
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.doesNotMatch(body, /data-proxy-shim/);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('REGRESSION: an extensionless subresource is rebased when the browser says it is one', async () => {
  // The reported case: a third-party ad path reaches the proxy root with the
  // referer of the page that framed it, and no extension to go on. The shape of
  // the path cannot recognise it — but the browser already said what it asked
  // for, so no guess is needed.
  originHits = [];
  const response = await subresource('/pimg/aHR0cHM6LmpwZw', pageUrl('/page.html'), {
    headers: { 'sec-fetch-dest': 'image', 'sec-fetch-site': 'same-origin' },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(originHits, ['/pimg/aHR0cHM6LmpwZw']);
});

test('the fetch destination is read case-insensitively', async () => {
  originHits = [];
  const response = await subresource('/pimg/aHR0cHM6LmpwZw', pageUrl('/page.html'), {
    headers: { 'sec-fetch-dest': ' Image ', 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(originHits, ['/pimg/aHR0cHM6LmpwZw']);
});

test('every subresource destination qualifies, not just images', async () => {
  // A stylesheet and a script from an extensionless path are exactly as
  // unrecognisable as the image, and exactly as legitimate.
  for (const dest of ['style', 'script', 'font', 'manifest', 'worker', 'video', 'audio', 'track']) {
    originHits = [];
    const response = await subresource('/pimg/aHR0cHM6LmpwZw', pageUrl('/page.html'), {
      headers: { 'sec-fetch-dest': dest, 'sec-fetch-site': 'same-origin' },
    });
    assert.equal(response.status, 200, `${dest} must be rebased`);
    assert.equal(originHits.length, 1, `${dest} must reach the origin`);
  }
});

test('a navigation destination is never treated as a subresource', async () => {
  // A frame or a popup can point at the same path, and a navigation is not this
  // fallback's business: it would serve the site's HTML as though it were a
  // stray subresource, which is the one outcome the response veto exists to
  // prevent. Declining keeps it the 404 it is.
  originHits = [];
  for (const dest of ['document', 'iframe', 'frame', 'embed', 'object', 'empty']) {
    const response = await subresource('/pimg/aHR0cHM6LmpwZw', pageUrl('/page.html'), {
      headers: { 'sec-fetch-dest': dest, 'sec-fetch-site': 'same-origin' },
    });
    assert.equal(response.status, 404, `${dest} must not be rebased`);
  }
  assert.deepEqual(originHits, [], 'no navigation-shaped request may reach the origin');
});

test('a cross-site request is refused outright, even for a subresource', async () => {
  // The page declared this fetch as being for another origin, so the referer's
  // site is not its target. Rebased, it would be re-issued against that site as
  // whatever the path happens to name — the leak this service exists to avoid.
  originHits = [];
  const response = await subresource('/pimg/aHR0cHM6LmpwZw', pageUrl('/page.html'), {
    headers: { 'sec-fetch-dest': 'image', 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(response.status, 404);
  assert.deepEqual(originHits, []);
});

test('a same-origin and a browser-less client are both still admitted', async () => {
  // `same-origin`, `same-site` and `none` all describe a request the page is
  // making on the site's behalf. A replayed request carries no `Sec-Fetch-Site`
  // at all and must not be refused for the absence.
  for (const site of ['same-origin', 'same-site', 'none', undefined]) {
    originHits = [];
    const headers = new Headers({ 'sec-fetch-dest': 'image' });
    if (site !== undefined) headers.set('sec-fetch-site', site);
    const response = await subresource('/pimg/aHR0cHM6LmpwZw', pageUrl('/page.html'), { headers });
    assert.equal(response.status, 200, `sec-fetch-site=${site} must be admitted`);
  }
});

test('a destination of "subresource" does not override the HTML response veto', async () => {
  // The destination is a statement of what the page asked for. The origin can
  // still answer with a document, which means the guess was wrong — and the
  // destination gives no protection against that, so the veto has to.
  originHits = [];
  const response = await subresource('/about', pageUrl('/page.html'), {
    headers: { 'sec-fetch-dest': 'image', 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(response.status, 404);
  assert.match(await response.text(), /Not found/);
  assert.deepEqual(originHits, ['/about'], 'the origin was asked, then the answer rejected');
});

test('a document path with no destination is still declined', async () => {
  originHits = [];
  const response = await subresource('/about', pageUrl('/page.html'));
  assert.equal(response.status, 404);
  assert.deepEqual(originHits, []);
});

test('the exact reported URL is served rather than 403 or 404', async () => {
  // The original symptom: /assets/favicon/manifest.json routed to the proxy root
  // and died there with a 403 from the origin's CDN, because the request never
  // had a target. A .json path is file-shaped, so it is now rebased.
  originHits = [];
  const response = await subresource(
    '/assets/favicon/manifest.json',
    pageUrl('/page.html'),
  );

  // The test origin has no such file, so an honest 404 is the correct answer —
  // what matters is that the request was attributed and reached the origin
  // rather than being answered by the proxy's own not-found handler.
  assert.equal(response.status, 404);
  assert.deepEqual(originHits, ['/assets/favicon/manifest.json']);
});

// --- the base-href repair ---------------------------------------------------

test('a path aimed at /proxy/<name> by a <base href> is repaired', async () => {
  // After `<base href>` removal the rewritten value is `/proxy`. A browser
  // resolving `chunk.js` against it produces `/proxy/chunk.js`, which the router
  // cannot read as a target. The remainder is a path on the origin.
  originHits = [];
  const response = await subresource('/proxy/plain/assets/main.js', pageUrl('/page.html'));

  assert.equal(response.status, 200);
  assert.deepEqual(originHits, ['/assets/main.js']);
});

test('a path aimed at /proxy/<codec>/<name> is repaired by dropping the codec', async () => {
  originHits = [];
  const response = await subresource('/proxy/b64/assets/main.js', pageUrl('/page.html'));

  assert.equal(response.status, 200);
  assert.deepEqual(originHits, ['/assets/main.js']);
});

test('an unroutable /proxy path is repaired rather than left as a 404', async () => {
  // Without a codec segment the payload is not an absolute URL, so the router
  // rejects it. It is still a path the browser resolved against the origin.
  originHits = [];
  const response = await subresource('/proxy/assets/main.js', pageUrl('/page.html'));

  assert.equal(response.status, 200);
  assert.deepEqual(originHits, ['/assets/main.js']);
});

// --- refusals ---------------------------------------------------------------

test('a prefixless asset with no referer is refused', async () => {
  originHits = [];
  const response = await subresource('/assets/i18n/en.json', null);
  assert.equal(response.status, 404);
  assert.equal(originHits.length, 0);
});

test('a referer from another origin is refused', async () => {
  // Otherwise any page on the web could aim this proxy at arbitrary targets by
  // setting a Referer header.
  originHits = [];
  const response = await subresource('/assets/i18n/en.json', 'http://evil.example/proxy/plain/x');
  assert.equal(response.status, 404);
  assert.equal(originHits.length, 0);
});

test('a referer that is not a live proxy route is refused', async () => {
  originHits = [];
  const index = await subresource('/assets/i18n/en.json', `${PROXY()}/`);
  assert.equal(index.status, 404);

  // A referer the router cannot attribute — here the proxy's own index page —
  // names no target at all, so there is nothing to rebase onto and the request
  // stays the 404 it already was.
  const unattributable = await subresource('/assets/i18n/en.json', `${PROXY()}/api/archives`);
  assert.equal(unattributable.status, 404);

  assert.equal(originHits.length, 0, 'nothing may be re-issued against the origin');
});

/**
 * An archive referer is admitted, and served *from the archive*.
 *
 * This used to be refused on the grounds that "a replay has no live origin to
 * rebase onto". The target a replay referer names is derivable in exactly the
 * same way a live one is, so the real question was never whether the target can
 * be found — it is where the resource comes from. Answering that from the
 * archive keeps the offline promise intact, and it repairs a genuine loss: a
 * single-file archive whose JavaScript resolves icon URLs against
 * `document.baseURI` asks the proxy root for a path the archive holds under the
 * target's origin.
 */
test('an archive referer rebases a root-relative request onto the archived origin', async () => {
  const archiveId = 'rebase-archive-1';
  store.createArchive(archiveId, `${ORIGIN()}/page.html`);
  await store.put(
    archiveId,
    `${ORIGIN()}/icon.svg`,
    200,
    { 'content-type': 'image/svg+xml' },
    'image/svg+xml',
    new TextEncoder().encode('<svg/>'),
  );
  await store.flush();
  store.finishArchive(archiveId, 'complete', 1);

  originHits = [];
  const response = await subresource(
    '/icon.svg',
    `${PROXY()}/archive/${archiveId}/plain/${encodeURIComponent(`${ORIGIN()}/page.html`)}`,
    { headers: { 'sec-fetch-dest': 'image' } },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/svg+xml');
  assert.equal(response.headers.get('x-archive-id'), archiveId);
  // The whole point: repaired from the archive, not re-fetched. A replay that
  // reached for the origin would be silently mixing live content into a capture.
  assert.equal(originHits.length, 0, 'a replay repair must never reach the origin');
});

test('an archive referer still 404s for a resource the archive does not hold', async () => {
  const archiveId = 'rebase-archive-2';
  store.createArchive(archiveId, `${ORIGIN()}/page.html`);
  store.finishArchive(archiveId, 'complete', 1);

  originHits = [];
  const response = await subresource(
    '/never-captured.json',
    `${PROXY()}/archive/${archiveId}/plain/${encodeURIComponent(`${ORIGIN()}/page.html`)}`,
  );

  // A miss must stay a miss. Falling back to the network here would turn an
  // incomplete capture into one that looks complete while serving current
  // content, which is the single thing the archive path exists to prevent.
  assert.equal(response.status, 404);
  assert.equal(originHits.length, 0, 'a miss must not fall back to the network');
});

test('an archive referer is checked against Host like any other', async () => {
  const archiveId = 'rebase-archive-3';
  store.createArchive(archiveId, `${ORIGIN()}/page.html`);
  store.finishArchive(archiveId, 'complete', 1);

  originHits = [];
  const response = await subresource(
    '/icon.svg',
    `http://elsewhere.test/archive/${archiveId}/plain/${encodeURIComponent(`${ORIGIN()}/page.html`)}`,
  );

  assert.equal(response.status, 404);
  assert.equal(originHits.length, 0);
});

test('the archive id survives on the resolved request, so the caller can source it', () => {
  const request = {
    method: 'GET',
    url: '/icon.svg',
    headers: {
      host: `127.0.0.1:${proxyPort}`,
      referer: `${PROXY()}/archive/abc/plain/${encodeURIComponent(`${ORIGIN()}/page.html`)}`,
      'sec-fetch-dest': 'image',
    },
  } as unknown as IncomingMessage;

  const resolved = resolveRebasedRequest(request, 'plain');
  assert.ok(resolved !== null);
  assert.equal(resolved.archiveId, 'abc');
  assert.equal(resolved.target.href, `${ORIGIN()}/icon.svg`);
  assert.equal(resolved.target.origin, ORIGIN());

  // And a live proxy referer must not acquire an archive id, or the live proxy
  // would start trying to serve from an archive that does not exist.
  const live = { ...request, headers: { ...request.headers, referer: pageUrl('/page.html') } } as unknown as IncomingMessage;
  const liveResolved = resolveRebasedRequest(live, 'plain');
  assert.ok(liveResolved !== null);
  assert.equal(liveResolved.archiveId, undefined);
});

test('a non-asset path is refused', async () => {
  const response = await subresource('/about', pageUrl('/page.html'));
  assert.equal(response.status, 404);
});

test('an unsafe method is refused', async () => {
  originHits = [];
  const response = await subresource('/assets/i18n/en.json', pageUrl('/page.html'), {
    method: 'POST',
    body: 'x',
  });
  assert.equal(response.status, 404);
  assert.equal(originHits.length, 0);
});

test('an absolute request-target is refused rather than forward-proxied', async () => {
  const response = await request(proxyRoot(`/${ORIGIN()}/assets/i18n/en.json`), {
    headers: { referer: pageUrl('/page.html') },
  });
  assert.equal(response.status, 404);
});

test('the response vetoes the guess when the origin answers with a document', async () => {
  // The fallback guesses "this path is a file". Markup in reply contradicts it,
  // so the caller answers 404 rather than handing a misattributed document to
  // the page — and it does so before committing any status or headers.
  originHits = [];
  const response = await subresource('/assets/bait.exe', pageUrl('/page.html'));

  assert.equal(response.status, 404);
  const body = await response.text();
  assert.doesNotMatch(body, /not a file/, 'the rejected document must not be delivered');
  // The origin sent a cookie with it. A rejected guess commits nothing, so that
  // cookie must never cross the HTTP boundary.
  assert.equal(response.headers.get('set-cookie'), null, 'a rejected guess must not set cookies');
  assert.deepEqual(originHits, ['/assets/bait.exe'], 'the guess is still worth trying');
});

test('a document path is refused before it is even attempted', async () => {
  // `html`/`htm` are not asset-like, because the response veto would reject the
  // answer anyway — so the round trip is not worth making.
  originHits = [];
  const response = await subresource('/assets/page.html', pageUrl('/page.html'));
  assert.equal(response.status, 404);
  assert.equal(originHits.length, 0);
});

test('an honest 404 from the origin is relayed as a 404', async () => {
  const response = await subresource('/assets/missing.json', pageUrl('/page.html'));
  assert.equal(response.status, 404);
});

test('an existing proxied request is unaffected', async () => {
  const response = await fetch(pageUrl('/page.html'));
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /data-proxy-shim/);
});

test('archive replay of an uncaptured resource still 404s rather than reaching the network', async () => {
  originHits = [];
  const response = await request(
    `${PROXY()}/archive/does-not-exist/plain/${encodeURIComponent(`${ORIGIN()}/page.html`)}`,
  );
  assert.equal(response.status, 404);
  assert.equal(originHits.length, 0);
});

// --- unit-level checks on the resolver --------------------------------------

test('resolveRebasedRequest requires a referer and a file-shaped path', () => {
  const request = (headers: Record<string, string>, url = '/assets/x.json'): IncomingMessage =>
    ({ method: 'GET', url, headers: { host: `127.0.0.1:${proxyPort}`, ...headers } }) as IncomingMessage;

  const live = `/proxy/plain/${encodeURIComponent(`${ORIGIN()}/page.html`)}`;
  assert.ok(resolveRebasedRequest(request({ referer: `http://127.0.0.1:${proxyPort}${live}` }), 'plain'));
  assert.equal(resolveRebasedRequest(request({}), 'plain'), null);
  assert.equal(resolveRebasedRequest(request({ referer: `http://127.0.0.1:${proxyPort}${live}` }, '/about'), 'plain'), null);
});
