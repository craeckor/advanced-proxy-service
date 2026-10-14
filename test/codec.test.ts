import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeTarget,
  decodeTarget,
  proxyPathFor,
  proxyPathWithTargetPath,
  proxyUrlFor,
  routeTarget,
  resolveTarget,
  isAbsoluteHttpUrl,
  appendRequestQuery,
  queryParameterValue,
} from '../src/rewrite/codec.ts';

test('plain codec round-trips an absolute URL', () => {
  const target = 'https://example.com/a/b?c=d&e=f#frag';
  const encoded = encodeTarget('plain', target);
  assert.equal(decodeTarget('plain', encoded), target);
});

test('b64 codec round-trips an absolute URL', () => {
  const target = 'https://example.com/path with spaces?q=1';
  const encoded = encodeTarget('b64', target);
  assert.equal(decodeTarget('b64', encoded), target);
});

test('b64 codec rejects malformed payloads instead of returning junk', () => {
  assert.equal(decodeTarget('b64', 'not-valid-base64!!!'), null);
  assert.equal(decodeTarget('b64', 'AAAA'), null); // decodes to bytes, not a URL
});

test('plain codec rejects a payload that is not a URL', () => {
  assert.equal(decodeTarget('plain', encodeURIComponent('not a url')), null);
  assert.equal(decodeTarget('plain', encodeURIComponent('ftp://example.com/')), null);
});

test('proxyPathFor embeds the codec and target', () => {
  assert.equal(
    proxyPathFor('plain', 'https://example.com/x'),
    `/proxy/plain/${encodeURIComponent('https://example.com/x')}`,
  );
  assert.equal(proxyPathFor('b64', 'https://example.com/x'), `/proxy/b64/${encodeTarget('b64', 'https://example.com/x')}`);
});

test('proxyUrlFor resolves relative references against the base', () => {
  const base = 'https://example.com/dir/page.html';
  assert.equal(proxyUrlFor('plain', base, '/other'), proxyPathFor('plain', 'https://example.com/other'));
  assert.equal(proxyUrlFor('plain', base, 'sibling.html'), proxyPathFor('plain', 'https://example.com/dir/sibling.html'));
  assert.equal(proxyUrlFor('plain', base, '../up.html'), proxyPathFor('plain', 'https://example.com/up.html'));
});

test('proxyUrlFor handles protocol-relative references', () => {
  const base = 'https://example.com/dir/page.html';
  assert.equal(proxyUrlFor('plain', base, '//cdn.example.net/lib.js'), proxyPathFor('plain', 'https://cdn.example.net/lib.js'));
});

test('proxyUrlFor leaves non-navigational schemes alone', () => {
  const base = 'https://example.com/';
  for (const value of ['data:text/plain,hi', 'blob:https://x/1', 'javascript:void(0)', 'mailto:a@b.c', '#section', 'about:blank']) {
    assert.equal(proxyUrlFor('plain', base, value), null, `expected ${value} to be skipped`);
  }
});

test('proxyUrlFor honours an explicit <base> override', () => {
  assert.equal(
    proxyUrlFor('plain', 'https://cdn.example.net/assets/', 'img.png'),
    proxyPathFor('plain', 'https://cdn.example.net/assets/img.png'),
  );
});

test('resolveTarget returns null for an unresolvable reference', () => {
  assert.equal(resolveTarget(null, 'relative/path'), null);
  assert.equal(resolveTarget('https://example.com/', ''), null);
});

test('isAbsoluteHttpUrl only accepts http and https', () => {
  assert.equal(isAbsoluteHttpUrl('https://example.com'), true);
  assert.equal(isAbsoluteHttpUrl('http://example.com'), true);
  assert.equal(isAbsoluteHttpUrl('ws://example.com'), false);
  assert.equal(isAbsoluteHttpUrl('file:///etc/passwd'), false);
  assert.equal(isAbsoluteHttpUrl('/relative'), false);
});

test('appendRequestQuery re-attaches a query left outside the payload', () => {
  const target = 'https://example.com/wa/action';
  assert.equal(
    appendRequestQuery(target, `/proxy/plain/${encodeURIComponent(target)}?publicationId=4076365`),
    'https://example.com/wa/action?publicationId=4076365',
  );
});

test('appendRequestQuery leaves a request without a query untouched', () => {
  const target = 'https://example.com/x';
  assert.equal(appendRequestQuery(target, `/proxy/plain/${encodeURIComponent(target)}`), target);
  // A bare "?" carries nothing to attach.
  assert.equal(appendRequestQuery(target, `/proxy/plain/${encodeURIComponent(target)}?`), target);
});

test('appendRequestQuery merges with a query the target already carries', () => {
  const target = 'https://example.com/x?a=1';
  assert.equal(appendRequestQuery(target, '/proxy/plain/x?b=2'), 'https://example.com/x?a=1&b=2');
});

test('appendRequestQuery keeps the query ahead of the target fragment', () => {
  const target = 'https://example.com/x#top';
  assert.equal(appendRequestQuery(target, '/proxy/plain/x?id=7'), 'https://example.com/x?id=7#top');
});

// --- the target-path form ----------------------------------------------------

test('the target-path form mirrors the target path after the payload', () => {
  const target = 'https://cdn.example.net/assets/entry.js';
  assert.equal(
    proxyPathWithTargetPath('plain', target),
    `/proxy/plain/${encodeURIComponent(target)}/assets/entry.js`,
  );
});

test('the target-path form is skipped when the target is at the origin root', () => {
  // Appending `/` would say nothing the flat form does not already say.
  const target = 'https://example.com/';
  assert.equal(proxyPathWithTargetPath('plain', target), proxyPathFor('plain', target));
});

test('the flat payload never contains the boundary slash', () => {
  // This is what keeps the payload/path boundary unambiguous for both codecs.
  for (const target of ['https://example.com/a/b/c.js?d=1#e', 'https://x.test/p/']) {
    assert.equal(encodeTarget('plain', target).includes('/'), false, target);
    assert.equal(encodeTarget('b64', target).includes('/'), false, target);
  }
});

test('a request that carries no target path decodes from the payload alone', () => {
  const target = 'https://example.com/a/b/c.js';
  assert.equal(routeTarget('plain', encodeTarget('plain', target)), target);
});

test('REGRESSION: a bare chunk name resolves against the target directory', () => {
  // What a runtime deriving its public path from `import.meta.url` produces.
  // The browser resolved it against the proxied URL, so the arriving path is
  // already a path at the target's origin — there is nothing to guess.
  const target = 'https://cdn.example.net/assets/deep/entry.js';
  assert.equal(
    routeTarget('plain', `${encodeTarget('plain', target)}/assets/deep/chunk-ABC123.js`),
    'https://cdn.example.net/assets/deep/chunk-ABC123.js',
  );
});

test('REGRESSION: a specifier query survives its trailing path', () => {
  // A rewriter emits both for a specifier that has a query: the payload carries
  // the query, the trailing path mirrors the pathname. The path cannot express a
  // query, so letting it win would silently drop the version and ask the origin
  // for a different resource.
  const target = 'https://cdn.example.net/assets/chunk.js?v=3';
  assert.equal(
    routeTarget('plain', `${encodeTarget('plain', target)}/assets/chunk.js`),
    'https://cdn.example.net/assets/chunk.js?v=3',
  );
});

test('a trailing path that names a different resource still wins', () => {
  // The runtime-computed chunk case: the payload is whatever document the
  // runtime lived in, and the trailing path is the chunk it asked for.
  const target = 'https://cdn.example.net/assets/entry.js';
  assert.equal(
    routeTarget('plain', `${encodeTarget('plain', target)}/assets/lazy-9f2.js`),
    'https://cdn.example.net/assets/lazy-9f2.js',
  );
});

test('a query on the trailing reference is kept', () => {
  const target = 'https://cdn.example.net/assets/entry.js';
  assert.equal(
    routeTarget('plain', `${encodeTarget('plain', target)}/assets/chunk.js?r=3&x=1`),
    'https://cdn.example.net/assets/chunk.js?r=3&x=1',
  );
});

test('requesting the target path itself serves that path', () => {
  // The path the rewriter appended, requested verbatim: it must resolve to the
  // same target the payload alone names, not to a doubled path.
  const target = 'https://cdn.example.net/assets/entry.js';
  assert.equal(routeTarget('plain', `${encodeTarget('plain', target)}/assets/entry.js`), target);
});

test('REGRESSION: a hand-encoded payload is not split at its slashes', () => {
  // `encodeURI` leaves `/` alone, so a hand-built proxy URL has the same slash
  // pattern as payload-plus-path. The prefix here (`https:`) is not an encoded
  // target, so the whole tail is read as the payload.
  const target = 'https://cdn.example.net/assets/entry.js';
  assert.equal(routeTarget('plain', `https://cdn.example.net/assets/entry.js`), target);
  assert.equal(routeTarget('plain', `https://example.com/a/b/c.js`), 'https://example.com/a/b/c.js');
});

test('a hand-encoded payload keeps its own query', () => {
  const target = 'https://example.com/a/b?c=d';
  assert.equal(routeTarget('plain', 'https://example.com/a/b?c=d'), target);
});

test('a climbing reference is normalised against the origin root', () => {
  // `../shared.js` from `/assets/deep/` reaches `/assets/`, and the traversal
  // is resolved by the URL parser rather than by string surgery.
  const target = 'https://cdn.example.net/assets/deep/entry.js';
  assert.equal(
    routeTarget('plain', `${encodeTarget('plain', target)}/assets/deep/../shared.js`),
    'https://cdn.example.net/assets/shared.js',
  );
});

test('a climbing reference may reach the origin root', () => {
  const target = 'https://cdn.example.net/assets/deep/entry.js';
  assert.equal(
    routeTarget('plain', `${encodeTarget('plain', target)}/../../shared.js`),
    'https://cdn.example.net/shared.js',
  );
});

test('a trailing path cannot move the target to another origin', () => {
  // The payload names the target, so the trailing path may move within that
  // origin — which is what a relative reference does — but may not replace it.
  const target = 'https://cdn.example.net/assets/entry.js';
  for (const suffix of ['//evil.test/x.js', '/../..//evil.test/x.js']) {
    const resolved = routeTarget('plain', `${encodeTarget('plain', target)}${suffix}`);
    assert.notEqual(resolved, null, suffix);
    assert.equal(new URL(resolved as string).origin, 'https://cdn.example.net', suffix);
  }
});

test('a malformed payload is refused rather than guessed at', () => {
  assert.equal(routeTarget('plain', 'notencoded'), null);
  assert.equal(routeTarget('b64', 'not-valid-base64!!!'), null);
});

test('REGRESSION: a query parameter keeps the ampersands inside its value', () => {
  // Regression: reading this with `URLSearchParams` splits the query on `&`,
  // which is right for a form body and wrong for a request line, because a
  // request line's query may *contain* an unescaped target URL. The value came
  // back truncated at the target's first `&`, so a search result or any
  // paginated route silently became a request for a different page.
  const target = 'https://www.google.com/search?q=a&udm=50&sei=xyz';
  const raw = `/api/capture.js?url=${target}`;

  assert.equal(queryParameterValue(raw, 'url'), target);
  // The regression, stated as the wrong answer so the assertion above has a shape.
  assert.notEqual(queryParameterValue(raw, 'url'), 'https://www.google.com/search?q=a');
});

test('a query parameter value is not decoded as a form field', () => {
  // `+` means space in a form body and nothing at all in a request line. The
  // library decoder implements only the first, and a target URL is full of `+`
  // that has to survive — `/search?q=a+b` is a query, not two words.
  assert.equal(
    queryParameterValue('/api/capture.js?url=https://example.com/s?q=a+b&x=1', 'url'),
    'https://example.com/s?q=a+b&x=1',
  );
});

test('a query parameter value is percent-decoded, and only that', () => {
  // The fully-encoded form is what the rewriters emit, and it still decodes —
  // including an escape for a character that is *inside* the target's own query.
  const encoded = encodeURIComponent('https://example.com/search?q=a&b=c:d');
  assert.equal(
    queryParameterValue(`/api/capture.js?url=${encoded}`, 'url'),
    'https://example.com/search?q=a&b=c:d',
  );
  // A malformed escape is not a reason to refuse the request.
  assert.equal(queryParameterValue('/api/capture.js?url=https://e.com/%zz', 'url'), 'https://e.com/%zz');
});

test('the query parameter boundary is an ampersand or the start of the query', () => {
  const target = 'https://example.com/';
  const raw = `/api/capture.js?other=url=${target}&url=${target}`;
  // `other=url=…` must not be read as `url`, and the second one must be found.
  assert.equal(queryParameterValue(raw, 'url'), target);
  // A parameter that is absent, and one at the very end of the query.
  assert.equal(queryParameterValue('/api/capture.js?x=1', 'url'), null);
  assert.equal(queryParameterValue('/api/capture.js?a=1&url=https://e.com/', 'url'), 'https://e.com/');
  // A fragment is not part of the query.
  assert.equal(queryParameterValue('/api/capture.js?url=https://e.com/#frag', 'url'), 'https://e.com/');
  assert.equal(queryParameterValue('', 'url'), null);
  assert.equal(queryParameterValue('/api/capture.js?', 'url'), null);
});
