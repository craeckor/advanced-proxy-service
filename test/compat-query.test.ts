import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryVariantDistance, isSelfNavigation } from '../src/archive/store.ts';

/**
 * The query-variant rule behind compatibility mode.
 *
 * Unit-tested because it is the one part of the feature that can be *wrong*
 * rather than merely unhelpful: a false match offers the reader a page the origin
 * would not have shown them, and the reader has no way to tell. Every case below
 * is a shape that must be refused.
 */

test('a parameter added at the end is a variant', () => {
  // The reported case: the archive holds the URL without `&sei=`, the reader asks
  // with it. This is what the feature exists for.
  assert.equal(queryVariantDistance('q=x&udm=50', 'q=x&udm=50&sei=abc'), 1);
  // Symmetric in the query sense: a stored URL with one extra parameter is just as
  // strange to the reader, and is offered on the same terms.
  assert.equal(queryVariantDistance('q=x&udm=50&sei=abc', 'q=x&udm=50'), 1);
  assert.equal(queryVariantDistance('a=1', 'a=1&b=2&c=3'), 2);
});

test('a divergence mid-list is not a variant', () => {
  // The failure this guard exists for. Everything after a divergence reads
  // differently, so `a=1&b=2` says nothing about what `a=1&c=3` would return.
  assert.equal(queryVariantDistance('a=1&b=2', 'a=1&c=3'), null);
  assert.equal(queryVariantDistance('a=1', 'b=2'), null);
  assert.equal(queryVariantDistance('q=x&udm=50', 'q=x&tbm=nws'), null);
});

test('a differing value is a divergence, not an extra parameter', () => {
  // The distinction the parameter split has to make: `a=2` is a different filter
  // from `a=1`, while `&b=2` is a different question entirely. Treating them the
  // same would offer the reader results for a search they did not make.
  assert.equal(queryVariantDistance('a=1', 'a=2'), null);
  assert.equal(queryVariantDistance('q=x', 'q=y&page=2'), null);
});

test('an exact match is a distance of zero, and never offered', () => {
  // The caller treats a non-null answer as a candidate, and the store is only
  // consulted after the exact lookup already missed — so a zero must stay
  // distinguishable from "no variant" for the ranking, not for the decision.
  assert.equal(queryVariantDistance('a=1', 'a=1'), 0);
  assert.equal(queryVariantDistance('', ''), 0);
});

test('the differing parameter may be the whole query', () => {
  assert.equal(queryVariantDistance('a=1', 'a=1&b=2'), 1);
  assert.equal(queryVariantDistance('a=1&b=2', 'a=1'), 1);
});

test('ignorable parameters are removed from both sides before comparing', () => {
  // For an origin that demonstrably ignores a cache-buster, the noise should not
  // count toward the budget. A shared parameter is still required, so these keep
  // the `a=1` both sides actually agree on.
  assert.equal(queryVariantDistance('a=1&_=9', 'a=1&_=8', ['_']), 0);
  assert.equal(queryVariantDistance('a=1', 'a=1&_=9', ['_']), 0);
  // Removing noise must not remove meaning: the real extra is still counted.
  assert.equal(queryVariantDistance('a=1&_=9', 'a=1&b=2', ['_']), 1);
  // And an ignorable parameter cannot paper over a genuine divergence. Note the
  // divergence has to *survive* the dropping: `a=1&_=9` against `a=1&c=3` becomes
  // `a=1` against `a=1&c=3` once the noise is gone, which is a real variant.
  assert.equal(queryVariantDistance('a=1&b=2&_=9', 'a=1&c=3', ['_']), null);
});

test('dropping ignorable parameters cannot make two queries look related', () => {
  // A guard against a vacuous comparison: with nothing left on one side, the
  // prefix test would succeed against anything, so `_=9` would look like a
  // variant of `x=1` purely because its only parameter was ignored. A parameter
  // in common is required.
  assert.equal(queryVariantDistance('_=9', 'x=1', ['_']), null);
  assert.equal(queryVariantDistance('x=1', '_=9', ['_']), null);
  assert.equal(queryVariantDistance('_=9', 'x=1&y=2', ['_']), null);
});

test('empty parameters are not counted as differences', () => {
  // A trailing `&` or a doubled `&&` is a formatting artefact, not a parameter.
  assert.equal(queryVariantDistance('a=1&', 'a=1'), 0);
  assert.equal(queryVariantDistance('a=1&&b=2', 'a=1&b=2'), 0);
});

test('a parameter value containing an equals sign is compared whole', () => {
  // Base64 padding and nested URLs both put `=` inside a value, so splitting on
  // it rather than on `&` would corrupt the comparison.
  assert.equal(queryVariantDistance('u=a=b', 'u=a=b&c=1'), 1);
  assert.equal(queryVariantDistance('u=a=b', 'u=a=b'), 0);
  assert.equal(queryVariantDistance('u=a=b', 'u=a=c'), null);
});

// --- self-navigation --------------------------------------------------------

/**
 * The relation that recognises a page handing itself back.
 *
 * This is the *decision*, so a false positive silently serves a page nobody asked
 * for, and a false negative brings back the unbounded reload loop. The two are
 * not symmetric, which is why the direction is fixed and every case below is
 * checked for the side it must fall on rather than merely for a boolean.
 */

const PAGE = 'https://www.google.com/search?q=x&udm=50';

test('the page with a marker appended is a self-navigation', () => {
  // The reported case, from the archived Google interstitial: it rebuilds its own
  // href and appends its session marker, which the capture does not hold.
  assert.equal(isSelfNavigation(PAGE, `${PAGE}&sei=Fu3LarDWJMzx7`), true);
  // Appended twice, which is what the second pass of the same page produces.
  assert.equal(isSelfNavigation(PAGE, `${PAGE}&sei=A&sei=A`), true);
  assert.equal(isSelfNavigation(PAGE, `${PAGE}&sei=A&_=9`), true);
});

test('a page with no query cannot be navigated to itself with one appended', () => {
  // Nothing to append *to*: the built URL is already the page's own URL, so it is
  // an exact match and reaches this code path not at all.
  assert.equal(isSelfNavigation('https://example.test/q', 'https://example.test/q'), false);
  assert.equal(isSelfNavigation('https://example.test/q', 'https://example.test/q?b=2'), false);
});

test('a navigation to a shorter URL is not a self-navigation', () => {
  // The direction that keeps an ordinary "back" navigation, and a page linking to
  // its own parent path, out of this. Only *appending* is a page rebuilding itself.
  assert.equal(isSelfNavigation(PAGE, 'https://www.google.com/search?q=x'), false);
  assert.equal(isSelfNavigation(PAGE, 'https://www.google.com/search'), false);
});

test('a different path is never a self-navigation, however many parameters match', () => {
  assert.equal(isSelfNavigation(PAGE, 'https://www.google.com/other?q=x&udm=50&sei=A'), false);
  assert.equal(isSelfNavigation(PAGE, 'https://other.test/search?q=x&udm=50&sei=A'), false);
});

test('a divergence among the shared parameters is not a self-navigation', () => {
  // The request must carry the page's own parameters *unchanged*, in order. A
  // differing value is a different question, and answering it with the page would
  // be exactly the substitution this path does not ask consent for.
  assert.equal(isSelfNavigation(PAGE, 'https://www.google.com/search?q=x&udm=50&sei=A'), true);
  assert.equal(isSelfNavigation(PAGE, 'https://www.google.com/search?q=y&udm=50&sei=A'), false);
  assert.equal(isSelfNavigation(PAGE, 'https://www.google.com/search?q=x&tbm=nws&sei=A'), false);
  // Reordered is not unchanged: `udm=50&q=x` is a different query string.
  assert.equal(isSelfNavigation(PAGE, 'https://www.google.com/search?udm=50&q=x&sei=A'), false);
});

test('a parameter value that merely starts the same is not a prefix', () => {
  // Compared parameter by parameter rather than as raw text, or `a=1` would look
  // like a prefix of `a=10` and the page would be served for a different query.
  assert.equal(isSelfNavigation('https://t.test/p?a=1', 'https://t.test/p?a=1&b=2'), true);
  assert.equal(isSelfNavigation('https://t.test/p?a=1', 'https://t.test/p?a=10'), false);
});

test('an unparseable or non-http URL is not a self-navigation', () => {
  // Both sides are parsed, so a `data:` or `javascript:` URL cannot be read as
  // the page's own address.
  assert.equal(isSelfNavigation(PAGE, 'not a url'), false);
  assert.equal(isSelfNavigation('not a url', PAGE), false);
  assert.equal(isSelfNavigation(PAGE, 'javascript:alert(1)'), false);
  assert.equal(isSelfNavigation(PAGE, 'data:text/html,x'), false);
});

test('a fragment or a default port is not a difference', () => {
  // Both are erased before comparing, so a page that appends its marker to a URL
  // carrying a fragment is still recognised.
  assert.equal(isSelfNavigation('https://t.test/p?a=1#x', 'https://t.test/p?a=1&b=2'), true);
  assert.equal(isSelfNavigation('https://t.test:443/p?a=1', 'https://t.test/p?a=1&b=2'), true);
});

test('ignorable parameters are dropped from both sides before comparing', () => {
  // An origin that demonstrably ignores a cache-buster should not have it count
  // toward the appended tail.
  assert.equal(isSelfNavigation('https://t.test/p?a=1&_=9', 'https://t.test/p?a=1&b=2', ['_']), true);
  assert.equal(isSelfNavigation('https://t.test/p?a=1&_=9', 'https://t.test/p?a=1&_=8', ['_']), false);
});
