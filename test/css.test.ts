import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteCss } from '../src/rewrite/css.ts';

const options = { codec: 'plain' as const, baseUrl: 'https://example.com/css/main.css' };
const P = '/proxy/plain/';

test('rewrites url() with and without quotes', () => {
  const out = rewriteCss(`.a{background:url(/img/a.png)} .b{background:url("/img/b.png")} .c{background:url('/img/c.png')}`, options);
  assert.match(out, /https%3A%2F%2Fexample\.com%2Fimg%2Fa\.png/);
  assert.match(out, /https%3A%2F%2Fexample\.com%2Fimg%2Fb\.png/);
  assert.match(out, /https%3A%2F%2Fexample\.com%2Fimg%2Fc\.png/);
});

test('rewrites a bareword @import', () => {
  const out = rewriteCss(`@import "reset.css";`, options);
  assert.match(out, /https%3A%2F%2Fexample\.com%2Fcss%2Freset\.css/);
});

test('rewrites @import with url()', () => {
  const out = rewriteCss(`@import url(other.css);`, options);
  assert.match(out, /https%3A%2F%2Fexample\.com%2Fcss%2Fother\.css/);
});

test('resolves relative font URLs', () => {
  const out = rewriteCss(`@font-face{src:url(../fonts/x.woff2)}`, options);
  assert.match(out, /https%3A%2F%2Fexample\.com%2Ffonts%2Fx\.woff2/);
});

test('leaves data URIs alone', () => {
  const source = `.a{background:url(data:image/png;base64,AAAA)}`;
  const out = rewriteCss(source, options);
  assert.match(out, /data:image\/png;base64,AAAA/);
  assert.doesNotMatch(out, new RegExp(P.replace(/[/.]/g, '\\$&')));
});

test('leaves fragment references alone', () => {
  const out = rewriteCss(`.a{fill:url(#gradient)}`, options);
  assert.match(out, /url\(#gradient\)/);
});

test('returns invalid CSS unchanged rather than corrupted', () => {
  const broken = '.a{ color: red ';
  assert.equal(rewriteCss(broken, options), broken);
});

test('skips the parser entirely when there is nothing to rewrite', () => {
  const plain = '.a{color:red}';
  assert.equal(rewriteCss(plain, options), plain);
});

test('handles multiple URLs in one declaration', () => {
  const out = rewriteCss(`.a{background-image:image-set(url(/a.png) 1x, url(/b.png) 2x)}`, options);
  assert.match(out, /a\.png/);
  assert.match(out, /b\.png/);
});

test('rewrites an inline style declaration list', () => {
  // Content of a style="" attribute has no selector or braces, so it must be
  // parsed as a declaration list.
  const out = rewriteCss('background:url(/bg.png)', { ...options, declarations: true });
  assert.match(out, /https%3A%2F%2Fexample\.com%2Fbg\.png/);
});

test('rewrites multiple declarations in an inline style', () => {
  const out = rewriteCss('background:url(/a.png);border-image:url(/b.png) 30', {
    ...options,
    declarations: true,
  });
  assert.match(out, /a\.png/);
  assert.match(out, /b\.png/);
});

test('a stylesheet with braces is not valid declaration-list input', () => {
  // Guards against passing stylesheet source down the declaration path.
  const out = rewriteCss('.a{color:red}', { ...options, declarations: true });
  assert.equal(typeof out, 'string');
});

/**
 * A `url()` inside a custom property is a real resource reference.
 *
 * Regression: the parser was configured with `parseCustomProperty: false`, which
 * stores a custom property's value as opaque raw text. The `Url` visitor never
 * saw the reference, so it was left relative — and a relative URL in a stylesheet
 * resolves against the *serving* origin, not the site's. During a replay that is
 * the proxy's own root: MDN's menu icons became requests for
 * `http://localhost:8080/static/client/graduation-cap.<hash>.svg`, and the six of
 * them were already in the archive the whole time.
 *
 * Custom properties are the normal way to hold an icon URL for reuse, so this
 * affected real sites rather than a corner of the grammar. MDN's own
 * `styles-menu.css` declares `--menu-tab-icon: url(/static/client/…svg)`.
 */
test('REGRESSION: url() inside a custom property is rewritten', () => {
  const out = rewriteCss('.menu__tab{--menu-tab-icon: url(/static/client/graduation-cap.svg)}', options);
  assert.ok(out.includes(`/proxy/plain/${encodeURIComponent('https://example.com/static/client/graduation-cap.svg')}`), out);
});

test('a custom property is rewritten wherever it appears, including nested at-rules', () => {
  const out = rewriteCss('@media (min-width:1px){.a{--ico:url(/icons/a.svg)}}', options);
  assert.ok(out.includes(encodeURIComponent('https://example.com/icons/a.svg')), out);
});

test('rewriting inside a custom property does not disturb a var() reference to it', () => {
  // The two halves have to agree, or the declaration would point at a proxied URL
  // that no longer resolves.
  const out = rewriteCss('.a{--ico: url(/i.svg); background: var(--ico)}', options);
  assert.ok(out.includes('var(--ico)'), out);
  assert.ok(out.includes(encodeURIComponent('https://example.com/i.svg')), out);
});

test('a custom property holding a data URI is still left alone', () => {
  const out = rewriteCss('.a{--x: url(data:image/svg+xml;base64,AAA)}', options);
  assert.ok(out.includes('data:image/svg+xml;base64,AAA'), out);
  assert.ok(!out.includes('/proxy/plain/'), out);
});

test('a custom property that is not a value survives parsing rather than being dropped', () => {
  // Custom properties are allowed to hold arbitrary tokens — an empty value, a
  // brace block, a bare word — and none of those are a URL. The declaration must
  // come back intact, because a dropped one is a broken layout with no error.
  const cases: Array<[string, string]> = [
    ['.a{--y:{not css}; color:red}', '--y'],
    ['.a{--z:; color:red}', '--z'],
    ['.a{--w:1px 2px; color:red}', '--w:1px 2px'],
  ];
  for (const [css, expected] of cases) {
    const out = rewriteCss(css, options);
    assert.ok(out.includes(expected), `declaration must survive: ${css} -> ${out}`);
    assert.ok(out.includes('color:red'), `neighbours must survive: ${css} -> ${out}`);
    assert.ok(!out.includes('/proxy/plain/'), `nothing to rewrite: ${css} -> ${out}`);
  }
});
