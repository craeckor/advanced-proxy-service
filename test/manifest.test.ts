import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteManifest, isManifestFetchDest, looksLikeManifest } from '../src/rewrite/manifest.ts';
import { isManifest } from '../src/rewrite/kind.ts';

const options = {
  codec: 'plain' as const,
  baseUrl: 'https://github.com/manifest.json',
};

const proxied = (url: string): string => `/proxy/plain/${encodeURIComponent(url)}`;

/** Parse a rewritten manifest, asserting that the rewrite produced valid JSON. */
function parse(body: string): Record<string, unknown> {
  return JSON.parse(body) as Record<string, unknown>;
}

test('rewrites an absolute icon URL, which is the leak this exists to close', () => {
  // Regression: a manifest reached through the proxy lists icons on a CDN, and
  // the browser fetches them itself. Left absolute, the real origin sees the
  // request — from outside the proxy, in a page that is supposed to be inside it.
  const out = rewriteManifest(
    JSON.stringify({
      name: 'GitHub',
      icons: [{ src: 'https://github.githubassets.com/assets/app-icon-192.png', sizes: '192x192' }],
    }),
    options,
  );

  const manifest = parse(out);
  const icons = manifest['icons'] as Array<Record<string, unknown>>;
  assert.equal(icons[0]?.['src'], proxied('https://github.githubassets.com/assets/app-icon-192.png'));
  assert.equal(icons[0]?.['sizes'], '192x192', 'other members must survive');
  assert.equal(manifest['name'], 'GitHub', 'unrelated members must survive');
});

test('a relative icon URL is resolved against the manifest, not the proxy', () => {
  const out = rewriteManifest(JSON.stringify({ icons: [{ src: '/icons/app.png' }] }), options);
  const icons = parse(out)['icons'] as Array<Record<string, unknown>>;
  assert.equal(icons[0]?.['src'], proxied('https://github.com/icons/app.png'));
});

test('rewrites screenshots, which the browser also fetches itself', () => {
  const out = rewriteManifest(
    JSON.stringify({ screenshots: [{ src: 'https://cdn.test/shot.png', sizes: '1280x720' }] }),
    options,
  );
  const shots = parse(out)['screenshots'] as Array<Record<string, unknown>>;
  assert.equal(shots[0]?.['src'], proxied('https://cdn.test/shot.png'));
});

test('rewrites a shortcut URL and the icons inside the shortcut', () => {
  const out = rewriteManifest(
    JSON.stringify({
      shortcuts: [
        {
          name: 'Issues',
          url: 'https://github.com/issues',
          icons: [{ src: 'https://cdn.test/shortcut.png' }],
        },
      ],
    }),
    options,
  );

  const shortcuts = parse(out)['shortcuts'] as Array<Record<string, unknown>>;
  assert.equal(shortcuts[0]?.['url'], proxied('https://github.com/issues'));
  const icons = shortcuts[0]?.['icons'] as Array<Record<string, unknown>>;
  assert.equal(icons[0]?.['src'], proxied('https://cdn.test/shortcut.png'));
});

test('rewrites a share target action, which the browser posts to directly', () => {
  const out = rewriteManifest(
    JSON.stringify({ share_target: { action: '/share', method: 'POST' } }),
    options,
  );
  const target = parse(out)['share_target'] as Record<string, unknown>;
  assert.equal(target['action'], proxied('https://github.com/share'));
  assert.equal(target['method'], 'POST');
});

test('rewrites a protocol handler URL, which the browser navigates to', () => {
  const out = rewriteManifest(
    JSON.stringify({ protocol_handlers: [{ protocol: 'web+git', url: '/open?url=%s' }] }),
    options,
  );
  const handlers = parse(out)['protocol_handlers'] as Array<Record<string, unknown>>;
  assert.equal(handlers[0]?.['url'], proxied('https://github.com/open?url=%s'));
});

test('members the proxy must not touch are left alone', () => {
  // These are configuration, not locations. Rewriting them would change what
  // the site does rather than where it is fetched from, and they are relative
  // by convention — the manifest is served from its own proxied URL, so they
  // already resolve onto the target.
  const source = JSON.stringify({
    name: 'App',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: '#24292f',
    background_color: '#ffffff',
  });
  assert.equal(rewriteManifest(source, options), source);
});

test('a manifest with nothing to rewrite is returned byte-identical', () => {
  const source = JSON.stringify({ name: 'App', display: 'standalone' });
  assert.equal(rewriteManifest(source, options), source);
});

test('a body that is not valid JSON is passed through untouched', () => {
  for (const source of ['', 'not json', '{"icons":', '<html></html>']) {
    assert.equal(rewriteManifest(source, options), source, `must be untouched: ${source}`);
  }
});

test('a JSON body that is not an object is passed through untouched', () => {
  for (const source of ['[]', '"a string"', '42', 'null', 'true']) {
    assert.equal(rewriteManifest(source, options), source, `must be untouched: ${source}`);
  }
});

test('a URL that does not resolve is left as written rather than dropped', () => {
  // An unresolvable member is the origin's business, not the proxy's. Substituting
  // something would hide the breakage.
  const source = JSON.stringify({ icons: [{ src: 'javascript:alert(1)' }] });
  assert.equal(rewriteManifest(source, options), source);
});

test('a data URL is left alone, because it is not a fetch the proxy can serve', () => {
  const source = JSON.stringify({ icons: [{ src: 'data:image/png;base64,AAAA' }] });
  assert.equal(rewriteManifest(source, options), source);
});

test('an icon entry that is not an object is skipped rather than coerced', () => {
  const source = JSON.stringify({ icons: ['https://cdn.test/a.png', null, 7] });
  assert.equal(rewriteManifest(source, options), source);
});

test('a member that is not the expected shape does not throw', () => {
  const sources = [
    JSON.stringify({ icons: 'not-an-array' }),
    JSON.stringify({ shortcuts: [null, 'x', 5] }),
    JSON.stringify({ share_target: 'nope' }),
    JSON.stringify({ share_target: null }),
    JSON.stringify({ protocol_handlers: [{ protocol: 'x' }] }),
  ];
  for (const source of sources) {
    const out = rewriteManifest(source, options);
    assert.doesNotThrow(() => JSON.parse(out));
  }
  assert.equal(rewriteManifest(sources[0]!, options), sources[0]!);
});

test('the archive prefix is used when one is supplied', () => {
  const out = rewriteManifest(
    JSON.stringify({ icons: [{ src: '/a.png' }] }),
    { ...options, prefix: '/archive/abc123' },
  );
  const icons = parse(out)['icons'] as Array<Record<string, unknown>>;
  assert.equal(icons[0]?.['src'], `/archive/abc123/plain/${encodeURIComponent('https://github.com/a.png')}`);
});

test('every URL it rewrites is also reported as discovered', () => {
  // Discovery and replay have to agree. Replay rewrites a manifest's icons to
  // archive URLs, so a URL that was rewritten but never reported to the crawler
  // becomes a 404 inside an "offline" capture — the document asking for its own
  // icons and the archive not having them.
  const discovered = new Set<string>();
  const source = JSON.stringify({
    icons: [{ src: 'https://cdn.test/a.png' }, { src: '/b.png' }],
    screenshots: [{ src: 'https://cdn.test/shot.png' }],
    shortcuts: [{ url: '/s', icons: [{ src: 'https://cdn.test/c.png' }] }],
    share_target: { action: '/share' },
    protocol_handlers: [{ protocol: 'web+x', url: '/open?u=%s' }],
  });

  rewriteManifest(source, { ...options, discovered });

  for (const expected of [
    'https://cdn.test/a.png',
    'https://github.com/b.png',
    'https://cdn.test/shot.png',
    'https://github.com/s',
    'https://cdn.test/c.png',
    'https://github.com/share',
    'https://github.com/open?u=%s',
  ]) {
    assert.ok(discovered.has(expected), `expected ${expected} to be reported`);
  }
});

test('a member that needs no rewriting reports nothing', () => {
  const discovered = new Set<string>();
  rewriteManifest(JSON.stringify({ name: 'App', start_url: '/' }), { ...options, discovered });
  assert.equal(discovered.size, 0);
});

test('a URL with a query and a fragment keeps both through the rewrite', () => {
  const out = rewriteManifest(
    JSON.stringify({ icons: [{ src: 'https://cdn.test/a.png?v=3#frag' }] }),
    options,
  );
  const icons = parse(out)['icons'] as Array<Record<string, unknown>>;
  const src = String(icons[0]?.['src']);
  assert.ok(src.includes(encodeURIComponent('https://cdn.test/a.png?v=3#frag')), src);
});

/**
 * A manifest is routinely served under a media type that does not name it.
 *
 * This is the bug that made a complete archive look broken: MDN archives its
 * `/manifest.json` (381 bytes, `application/json`), its `favicon-192x192.png`
 * (2171 bytes, `image/png`) and its document — but the manifest was never
 * recognised as one, so its `"src": "/favicon-192x192.png"` was relayed verbatim
 * and the browser resolved it against the proxy's own origin, requesting
 * `http://localhost:8080/favicon-192x192.png` and getting the 404 placeholder.
 * Nothing was missing from the archive; the rewriter simply never ran.
 */
test('REGRESSION: sec-fetch-dest identifies a manifest served as application/json', () => {
  assert.equal(isManifest('application/json', 'manifest'), true);
  assert.equal(isManifest('application/json; charset=utf-8', 'manifest'), true);
  assert.equal(isManifest('application/json', 'MANIFEST'), true, 'the header is a token');
  assert.equal(isManifest('application/json', ' manifest '), true, 'and may be padded');
});

test('a manifest media type is still honoured when the fetch dest is absent', () => {
  assert.equal(isManifest('application/manifest+json', undefined), true);
  assert.equal(isManifest('application/manifest+json', 'document'), true);
});

test('an image fetch is not turned into a manifest by the dest header alone', () => {
  assert.equal(isManifest('image/png', 'image'), false);
  assert.equal(isManifest('text/html', 'document'), false);
  assert.equal(isManifest('application/json', undefined), false);
});

test('looksLikeManifest catches the shape when no request signal exists', () => {
  // The case a client that sends no Sec-Fetch-* headers hits: a replay read by
  // curl, a crawler, or a screenshot tool.
  assert.equal(looksLikeManifest('{"icons":[{"src":"/favicon-192x192.png"}]}'), true);
  assert.equal(looksLikeManifest('{"shortcuts":[{"url":"/a"}]}'), true);
  assert.equal(looksLikeManifest('{"share_target":{"action":"/share"}}'), true);
});

test('looksLikeManifest refuses arbitrary JSON, so an API response is not rewritten', () => {
  // The whole reason the shape test names members rather than trusting any JSON:
  // an archive is full of JSON that is not a manifest, and running it through a
  // URL rewriter would corrupt it.
  assert.equal(looksLikeManifest('{"users":[{"id":1}]}'), false);
  assert.equal(looksLikeManifest('{"coverage":{"total":12}}'), false);
  assert.equal(looksLikeManifest('[1,2,3]'), false);
  assert.equal(looksLikeManifest('"a string"'), false);
  assert.equal(looksLikeManifest('not json at all'), false);
  assert.equal(looksLikeManifest(''), false);
});

test('the manifest fetch dest is read as a single token, never an array', () => {
  // Node gives a repeated header as an array; a manifest fetch is not repeatable,
  // so an array here is not a manifest rather than a reason to guess.
  assert.equal(isManifestFetchDest('manifest'), true);
  assert.equal(isManifestFetchDest(['manifest']), false);
  assert.equal(isManifestFetchDest(undefined), false);
  assert.equal(isManifestFetchDest(''), false);
});
