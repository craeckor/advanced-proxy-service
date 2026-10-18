import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteJs } from '../src/rewrite/js.ts';

const BASE = 'https://example.com/dir/page.js';
const options = { codec: 'plain' as const, baseUrl: BASE };

function rewrite(source: string): string {
  return rewriteJs(source, options);
}

test('rewrites the URL argument of fetch', () => {
  const out = rewrite(`fetch('/api/data')`);
  assert.match(out, /fetch\('\/proxy\/plain\/https%3A%2F%2Fexample\.com%2Fapi%2Fdata'\)/);
});

test('rewrites the URL argument of XMLHttpRequest.open, not the method', () => {
  // Regression: the URL is the *second* argument here. Rewriting the first
  // turns the HTTP method into a URL.
  const out = rewrite(`xhr.open('GET', '/api/x')`);
  assert.match(out, /xhr\.open\('GET', '\/proxy\/plain\/https%3A%2F%2Fexample\.com%2Fapi%2Fx'\)/);
});

test('rewrites new Worker and new EventSource targets', () => {
  assert.match(rewrite(`new Worker('/w.js')`), /proxy\/plain/);
  assert.match(rewrite(`new EventSource('/events')`), /proxy\/plain/);
});

test('does not rewrite WebSocket in source; the runtime shim owns that', () => {
  const source = `new WebSocket('wss://example.com/socket')`;
  assert.equal(rewrite(source), source);
});

test('REGRESSION: never rewrites the left-hand side of an assignment', () => {
  // Blind text replacement turns this into `"/proxy/..." = '/x'`, a syntax
  // error that takes the whole page down. Only the literal in call position
  // may be touched.
  const source = `window.location.href = '/next'`;
  const out = rewrite(source);
  assert.equal(out, source);
  assert.doesNotMatch(out, /^\s*"/);
});

test('does not rewrite an unrelated string assignment', () => {
  const source = `const path = '/api/x';`;
  assert.equal(rewrite(source), source);
});

test('leaves a template literal containing interpolation alone', () => {
  const source = 'fetch(`/api/${id}`)';
  assert.equal(rewrite(source), source);
});

test('rewrites a static template literal', () => {
  const out = rewrite('fetch(`/api/static`)');
  assert.match(out, /proxy\/plain/);
});

test('returns unparseable source unchanged rather than corrupting it', () => {
  const broken = 'function ( { ) { ]';
  assert.equal(rewrite(broken), broken);
});

test('preserves source when there is no URL to rewrite', () => {
  const source = 'const x = 1 + 2; console.log(x);';
  assert.equal(rewrite(source), source);
});

test('rewrites dynamic import specifiers', () => {
  const out = rewrite(`import('/mod.js')`);
  assert.match(out, /proxy\/plain/);
});

// --- regression: static module specifiers were never rewritten --------------

test('REGRESSION: rewrites static import declarations', () => {
  // Browsers resolve these against the *module's* URL, so an unrewritten
  // `./chunk-X.js` in a module served from /proxy/plain/<encoded> resolves to
  // /proxy/plain/chunk-X.js and 404s.
  const out = rewrite(
    ['import "./chunk-A.js";', 'import {a} from "./chunk-B.js";', 'import * as ns from "./chunk-C.js";'].join('\n'),
  );
  assert.doesNotMatch(out, /from "\.\/chunk/);
  assert.doesNotMatch(out, /^import "\.\/chunk/m);
  assert.match(out, /import "\/proxy\/plain\/https%3A%2F%2Fexample\.com%2Fdir%2Fchunk-A\.js"/);
  assert.match(out, /https%3A%2F%2Fexample\.com%2Fdir%2Fchunk-B\.js/);
  assert.match(out, /https%3A%2F%2Fexample\.com%2Fdir%2Fchunk-C\.js/);
});

test('REGRESSION: rewrites static export declarations', () => {
  const out = rewrite(['export { x } from "./chunk-D.js";', 'export * from "./chunk-E.js";'].join('\n'));
  assert.doesNotMatch(out, /from "\.\/chunk/);
  assert.match(out, /https%3A%2F%2Fexample\.com%2Fdir%2Fchunk-D\.js/);
  assert.match(out, /https%3A%2F%2Fexample\.com%2Fdir%2Fchunk-E\.js/);
});

test('REGRESSION: leaves bare module specifiers alone', () => {
  // A bare specifier is a *name*, not a location. Rewriting it makes the browser
  // load a URL called "react" relative to the module, which can never resolve.
  const out = rewrite(
    [
      'import "react";',
      'import { useState } from "react";',
      'import map from "lodash/fp";',
      'import "#internal";',
    ].join('\n'),
  );
  assert.doesNotMatch(out, /proxy/);
  assert.match(out, /import "react"/);
  assert.match(out, /from "react"/);
  assert.match(out, /from "lodash\/fp"/);
  assert.match(out, /import "#internal"/);
});

test('REGRESSION: specifier rules do not suppress other URL contexts in the same module', () => {
  // `import 'react'` must be skipped while `fetch('data.json')` in the same
  // module is still routed; a per-file flag would break one or the other.
  const out = rewrite(
    [
      'import { useState } from "react";',
      'fetch("/api/data.json");',
      'new Worker("./worker.js");',
    ].join('\n'),
  );
  assert.match(out, /from "react"/);
  assert.match(out, /https%3A%2F%2Fexample\.com%2Fapi%2Fdata\.json/);
  assert.match(out, /https%3A%2F%2Fexample\.com%2Fdir%2Fworker\.js/);
});

test('rewrites rooted and absolute module specifiers', () => {
  const out = rewrite(
    ['import {b} from "/abs/m.js";', 'import {c} from "https://cdn.example.net/m.js";'].join('\n'),
  );
  assert.match(out, /https%3A%2F%2Fexample\.com%2Fabs%2Fm\.js/);
  assert.match(out, /https%3A%2F%2Fcdn\.example\.net%2Fm\.js/);
});

test('leaves a non-http module specifier untouched', () => {
  const out = rewrite('import x from "node:fs";');
  assert.match(out, /from "node:fs"/);
  assert.doesNotMatch(out, /proxy/);
});

test('handles a full script with mixed rewritable and untouched code', () => {
  const source = `
    const base = '/api';
    async function load() {
      const res = await fetch('/api/items');
      const other = '/not/touched';
      return res.json();
    }
  `;
  const out = rewrite(source);
  assert.match(out, /proxy\/plain\/https%3A%2F%2Fexample\.com%2Fapi%2Fitems/);
  // The plain string assignment must survive verbatim.
  assert.match(out, /const other = '\/not\/touched';/);
  assert.match(out, /const base = '\/api';/);
});

// --- the target-path form ---------------------------------------------------

test('the target-path form keeps a module specifier query', () => {
  // A payload cannot express a query that a relative reference needs to carry,
  // so the specifier is resolved and encoded whole. The trailing path is only
  // there to give the proxied URL a directory and a query cannot live in one.
  const out = rewriteJs(`import './chunk.js?v=3'`, { ...options, directoryForm: true });
  assert.match(out, /^import '\/proxy\/plain\/https%3A%2F%2Fexample\.com%2Fdir%2Fchunk\.js%3Fv%3D3\/dir\/chunk\.js'$/);
});

test('the target-path form appends the target path after the payload', () => {
  const out = rewriteJs(`import './chunk.js'`, { ...options, directoryForm: true });
  assert.match(out, /^import '\/proxy\/plain\/https%3A%2F%2Fexample\.com%2Fdir%2Fchunk\.js\/dir\/chunk\.js'$/);
});

test('the target-path form is off by default, so other callers are unaffected', () => {
  const out = rewrite(`import './chunk.js'`);
  assert.match(out, /^import '\/proxy\/plain\/https%3A%2F%2Fexample\.com%2Fdir%2Fchunk\.js'$/);
});

test('the target-path form still leaves bare specifiers alone', () => {
  const source = `import 'react';\nimport './chunk.js';`;
  const out = rewriteJs(source, { ...options, directoryForm: true });
  assert.match(out, /import 'react'/);
  assert.match(out, /chunk\.js\/dir\/chunk\.js'/);
});

test('the target-path form leaves a non-URL call argument alone', () => {
  // `fetch` takes a location, so it gets the appended path too — but nothing
  // else in the file should be touched.
  const source = `const name = './not-a-url';\nfetch('./data.json');`;
  const out = rewriteJs(source, { ...options, directoryForm: true });
  assert.match(out, /const name = '\.\/not-a-url';/);
  assert.match(out, /fetch\('\/proxy\/plain\/https%3A%2F%2Fexample\.com%2Fdir%2Fdata\.json\/dir\/data\.json'\)/);
});

// --- import.meta.url --------------------------------------------------------

test('REGRESSION: import.meta.url is rewritten to this module\u2019s proxy URL', () => {
  // A build runtime reads it to discover where its chunks live. Left alone it
  // reports the proxied URL, whose directory is the payload's, so the runtime
  // forms `<prefix>/<codec>/` as its public path and asks for bare chunk names.
  const out = rewriteJs(`var u = import.meta.url;`, { ...options, rewriteImportMetaUrl: true });
  assert.equal(out, 'var u = "/proxy/plain/https%3A%2F%2Fexample.com%2Fdir%2Fpage.js";');
});

test('import.meta.url is left alone unless the caller opts in', () => {
  const source = `var u = import.meta.url;`;
  assert.equal(rewrite(source), source);
});

test('import.meta.url carries the target path when the form is in use', () => {
  // Webpack normalises this to a directory by stripping the last path segment.
  // With the target path appended, that directory is the module's real one, so
  // `n.p + chunkName` lands on the target instead of on the proxy's own root.
  const out = rewriteJs(`var u = import.meta.url;`, {
    ...options,
    directoryForm: true,
    rewriteImportMetaUrl: true,
  });
  assert.equal(out, 'var u = "/proxy/plain/https%3A%2F%2Fexample.com%2Fdir%2Fpage.js/dir/page.js";');
});

test('other import.meta members are untouched', () => {
  // `import.meta.resolve` and `import.meta.env` are not URLs, and a build tool
  // that reads them must keep reading them.
  const source = `var r = import.meta.resolve;\nvar e = import.meta.env;`;
  const out = rewriteJs(source, { ...options, rewriteImportMetaUrl: true });
  assert.equal(out, source);
});

test('a computed or renamed member is not mistaken for import.meta.url', () => {
  const source = `var a = import.meta["url"];\nvar b = other.meta.url;`;
  const out = rewriteJs(source, { ...options, rewriteImportMetaUrl: true });
  assert.equal(out, source);
});

test('import.meta.url in a module with specifiers rewrites both', () => {
  const source = `import './chunk.js';\nvar p = import.meta.url;`;
  const out = rewriteJs(source, { ...options, directoryForm: true, rewriteImportMetaUrl: true });
  assert.match(out, /import '\/proxy\/plain\/[^']*chunk\.js\/dir\/chunk\.js';/);
  assert.match(out, /var p = "\/proxy\/plain\/[^"]*page\.js\/dir\/page\.js";/);
});

// --- absolute URL literals anywhere in the file -----------------------------

/**
 * The "hidden URL builder" pass.
 *
 * A page that keeps its API base in a variable and concatenates names a location
 * in a position no API signature predicts, so the pass cannot use position as
 * its filter — it uses the value instead, and only absolute `http(s)` URLs
 * qualify. These tests are therefore as much about what is *refused* as about
 * what is rewritten: a false positive here silently corrupts data or renames a
 * property, and neither shows up until the page misbehaves at runtime.
 */

const literalOptions = { ...options, rewriteUrlLiterals: true };

function rewriteLiterals(source: string): string {
  return rewriteJs(source, literalOptions);
}

test('a URL held in a variable is rewritten, so concatenation stays inside the proxy', () => {
  // The reported case: the base is a literal, the request is built from it.
  const source = `var API = "https://api.example.com/v1";\nfetch(API + "/users");`;
  const out = rewriteLiterals(source);
  assert.match(out, /var API = "\/proxy\/plain\/https%3A%2F%2Fapi\.example\.com%2Fv1\/v1";/);
  // The concatenation is untouched — it is the *base* that had to move.
  assert.match(out, /fetch\(API \+ "\/users"\);/);
});

test('a subdomain of the page origin is rewritten like any other absolute URL', () => {
  // The distinction the request was about: `something.google.com` is a different
  // origin from `www.google.com`, and nothing about the page's own origin makes
  // it special. Every absolute URL is routed, whatever host it names.
  const source = `var u = "https://something.google.com/v1";`;
  const out = rewriteLiterals(source);
  assert.match(out, /"\/proxy\/plain\/https%3A%2F%2Fsomething\.google\.com%2Fv1\/v1"/);
});

test('a URL in an object value is rewritten', () => {
  const source = `var cfg = { endpoint: "https://api.example.com/v2" };`;
  const out = rewriteLiterals(source);
  assert.match(out, /endpoint: "\/proxy\/plain\/https%3A%2F%2Fapi\.example\.com%2Fv2\/v2"/);
});

test('a URL in an array is rewritten', () => {
  const source = `var hosts = ["https://a.example.com/x", "https://b.example.com/y"];`;
  const out = rewriteLiterals(source);
  assert.match(out, /"\/proxy\/plain\/https%3A%2F%2Fa\.example\.com%2Fx\/x"/);
  assert.match(out, /"\/proxy\/plain\/https%3A%2F%2Fb\.example\.com%2Fy\/y"/);
});

test('a URL assigned to location is rewritten', () => {
  const source = `location.href = "https://api.example.com/v1";`;
  const out = rewriteLiterals(source);
  assert.match(out, /location\.href = "\/proxy\/plain\/https%3A%2F%2Fapi\.example\.com%2Fv1\/v1";/);
});

test('REGRESSION: a single-argument new URL is never rewritten', () => {
  // The native constructor requires an absolute URL when no base is given, so a
  // proxy path there throws `Invalid URL` and takes the page down. This is the
  // one position where a proxy path is not a substitute for the URL it stands
  // for — reported from a real site as
  // `TypeError: Failed to construct 'URL': Invalid URL`.
  const source = `var u = new URL("https://api.example.com/v1");`;
  assert.equal(rewriteLiterals(source), source);
});

test('REGRESSION: a single-argument new Request is never rewritten', () => {
  // Same contract as `new URL`: one argument, and it must be absolute.
  const source = `var r = new Request("https://api.example.com/v1");`;
  assert.equal(rewriteLiterals(source), source);
});

test('REGRESSION: URL.parse is never rewritten', () => {
  const source = `var u = URL.parse("https://api.example.com/v1");`;
  assert.equal(rewriteLiterals(source), source);
});

test('a new URL with a base is rewritten, because a relative path is legal there', () => {
  const source = `var u = new URL("https://api.example.com/v1", "https://b.example.com/");`;
  const out = rewriteLiterals(source);
  assert.match(out, /new URL\("\/proxy\/plain\/https%3A%2F%2Fapi\.example\.com%2Fv1\/v1",/);
});

test('a new Request with an init object is rewritten', () => {
  const source = `var r = new Request("https://api.example.com/v1", { method: "GET" });`;
  const out = rewriteLiterals(source);
  assert.match(out, /new Request\("\/proxy\/plain\/https%3A%2F%2Fapi\.example\.com%2Fv1\/v1",/);
});

test('a URL in a switch case is rewritten, so the branch still matches', () => {
  // Deliberately the opposite of the comparison rule below: a case label and its
  // subject are produced by the same code, so both move together.
  const source = `switch (u) { case "https://api.example.com/v1": break; }`;
  const out = rewriteLiterals(source);
  assert.match(out, /case "\/proxy\/plain\/https%3A%2F%2Fapi\.example\.com%2Fv1\/v1":/);
});

test('a URL literal is not rewritten twice when it is also a fetch argument', () => {
  // The two passes overlap here. Without the claimed-range check the second pass
  // would see the proxy path the first one produced and wrap it again.
  //
  // The *argument* pass wins, so the result is the flat form: a fetch argument
  // is a complete URL, not a base to concatenate onto, and the flat form is the
  // shorter of the two.
  const source = `fetch("https://api.example.com/x");`;
  const out = rewriteLiterals(source);
  assert.equal(out, `fetch("/proxy/plain/https%3A%2F%2Fapi.example.com%2Fx");`);
  assert.doesNotMatch(out, /%25/, 'the payload must not be double-encoded');
  assert.equal(out.split('/proxy/plain/').length - 1, 1, 'exactly one level of proxying');
});

test('a property key is never rewritten', () => {
  // Rewriting a key renames the property, so the lookup that follows misses.
  const source = `var m = { "https://api.example.com/v1": 1 };`;
  assert.equal(rewriteLiterals(source), source);
});

test('a computed member name is never rewritten', () => {
  const source = `var v = obj["https://api.example.com/v1"];`;
  assert.equal(rewriteLiterals(source), source);
});

test('a comparison operand is never rewritten', () => {
  // The other side is usually a value the page read from `location.href`, which
  // the shim already presents in the origin's own URL space. Rewriting one side
  // makes a comparison that used to succeed fail.
  for (const operator of ['===', '!==', '==', '!=']) {
    const source = `if (x ${operator} "https://api.example.com/v1") {}`;
    assert.equal(rewriteLiterals(source), source, `${operator} must be left alone`);
  }
});

test('a regular expression is never rewritten', () => {
  // A pattern matches text; a proxy path in one matches nothing.
  const ctor = `var r = new RegExp("https://api.example.com");`;
  assert.equal(rewriteLiterals(ctor), ctor);
  const literal = `var r = /https:\\/\\/api\\.example\\.com/;`;
  assert.equal(rewriteLiterals(literal), literal);
});

test('a relative literal is never rewritten', () => {
  // A relative string is a location only in a URL position — `"users"` is a path
  // in `fetch("users")` and a key in `{ users: 1 }`. Rewriting those everywhere
  // would corrupt ordinary data, which is why only absolute URLs qualify.
  const source = `var p = "users";\nvar q = { users: 1 };`;
  assert.equal(rewriteLiterals(source), source);
});

test('a template literal with an expression is left to the shim', () => {
  const source = 'var u = `https://api.example.com/${id}`;';
  assert.equal(rewriteLiterals(source), source);
});

test('a plain template literal is rewritten', () => {
  const source = 'var u = `https://api.example.com/v1`;';
  const out = rewriteLiterals(source);
  assert.match(out, /`\/proxy\/plain\/https%3A%2F%2Fapi\.example\.com%2Fv1\/v1`/);
});

test('the pass is off unless the caller opts in', () => {
  // Every existing caller keeps its behaviour: only the proxy and the inline
  // script path ask for this.
  const source = `var API = "https://api.example.com/v1";`;
  assert.equal(rewrite(source), source);
});

test('a file with no absolute URL is returned unchanged', () => {
  const source = `var x = 1;\nfunction f(a) { return a + 1; }`;
  assert.equal(rewriteLiterals(source), source);
});

test('a syntax error still yields the input untouched', () => {
  const source = `var API = "https://api.example.com/v1" function (`;
  assert.equal(rewriteLiterals(source), source);
});
