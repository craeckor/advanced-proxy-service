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
