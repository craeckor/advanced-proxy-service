import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { parse } from 'acorn';
import { CAPTURE_AGENT_SOURCE, CAPTURE_RELAY_SOURCE, captureSnippet, CAPTURE_HOOK } from '../src/rewrite/capture.ts';

/**
 * The capture agent is delivered as a template-literal string, so `tsc` never
 * parses its contents. It is also the one script that runs on a page the proxy
 * does not fully control, including one where the user pasted it by hand, so a
 * syntax error is invisible until a user reports that "nothing happened".
 *
 * The same failure modes the shim is tested for apply here: a stray backtick
 * truncates the literal, a `</script` sequence ends the injected tag early, and
 * module syntax cannot run in a console or a classic script.
 */

test('the agent parses as a classic script', () => {
  assert.doesNotThrow(
    () => parse(CAPTURE_AGENT_SOURCE, { ecmaVersion: 'latest', sourceType: 'script' }),
    'agent source must be syntactically valid',
  );
  assert.doesNotMatch(CAPTURE_AGENT_SOURCE, /^\s*(?:import|export)\s/m, 'no module syntax');
});

test('the agent contains no backtick, which would terminate its template literal', () => {
  // Named explicitly rather than left to the parse test, because a backtick
  // produces a *truncated* string that may still parse: the failure is silent.
  assert.equal(CAPTURE_AGENT_SOURCE.includes('`'), false);
});

test('the agent never contains a bare script-closing sequence', () => {
  assert.equal(/<\/script/i.test(CAPTURE_AGENT_SOURCE), false);
});

test('the agent is a complete IIFE', () => {
  // Anchored on the opening and on a closing brace rather than on the very last
  // characters: a trailing comment is legitimate and should not fail a test
  // about whether the IIFE is balanced.
  const source = CAPTURE_AGENT_SOURCE.trim();
  assert.ok(source.startsWith('(function ()'), 'should open with an IIFE');
  assert.match(source, /\}\)\(\);/);
  assert.doesNotMatch(source, /\}\)\(\);[\s\S]*\}\)\(\);/, 'should not close twice');
});

test('the agent returns its capture function, so the console snippet can call it', () => {
  // A pasted snippet evaluates the IIFE and needs a handle on the work; without
  // a return value the paste silently captures nothing.
  assert.match(CAPTURE_AGENT_SOURCE, /return run;/);
});

test('the agent exposes the hook under the name the shim publishes', () => {
  // The two halves live in different files with no shared constant, so the
  // agreement is asserted rather than assumed: the shim installs
  // `window.__PROXY_CAPTURE__`, and the agent has to find exactly that name.
  assert.equal(CAPTURE_HOOK, '__PROXY_CAPTURE__');
  assert.ok(
    CAPTURE_AGENT_SOURCE.includes(`window.${CAPTURE_HOOK}`),
    'the agent must address the hook the shim installs',
  );
});

test('the agent reads the ledger through requests()', () => {
  assert.match(CAPTURE_AGENT_SOURCE, /hook\.requests\(\)/);
});

test('automatic collection is gated on configuration', () => {
  // The injected page sets captureAuto; a console paste must not, because the
  // `load` event it would wait for has already fired and it would never run.
  assert.match(CAPTURE_AGENT_SOURCE, /cfg\.captureAuto === true/);
});

test('the agent posts as text/plain, which is what makes CORS work', () => {
  // A JSON content type would require a preflight and CORS response headers on
  // an origin the proxy cannot know in advance. This is the detail the whole
  // cross-origin story depends on.
  assert.match(CAPTURE_AGENT_SOURCE, /type: 'text\/plain;charset=UTF-8'/);
});

test('the agent reads stylesheets through the CSSOM, which is the only way', () => {
  assert.match(CAPTURE_AGENT_SOURCE, /\.cssRules/);
});

test('the agent harvests storage without letting a policy error abort the capture', () => {
  // localStorage throws outright when a browser blocks it, and an unguarded
  // read would take the whole capture down for a page that is otherwise fine.
  assert.match(CAPTURE_AGENT_SOURCE, /localStorage/);
  assert.match(CAPTURE_AGENT_SOURCE, /catch \(e\) \{ \/\* blocked by policy \*\/ \}/);
});

test('the snippet is self-contained and invokes the capture', () => {
  const snippet = captureSnippet({
    origin: 'http://localhost:8080',
    targetUrl: 'https://example.com/page',
  });

  assert.doesNotThrow(() => parse(snippet, { ecmaVersion: 'latest', sourceType: 'script' }));
  assert.equal(snippet.includes('`'), false, 'a pasted snippet must not carry a stray backtick');
  assert.match(snippet, /http:\/\/localhost:8080\/api\/captures/);
  assert.match(snippet, /https:\/\/example\.com\/page/);
  // It must call the function the agent returns, or pasting does nothing.
  assert.match(snippet, /return capture\(\);/);
  assert.match(snippet, /captureAuto: false/);
});

test('the snippet trims a trailing slash on the origin so the path is well formed', () => {
  const snippet = captureSnippet({ origin: 'http://localhost:8080///', targetUrl: 'https://example.com/' });
  assert.match(snippet, /http:\/\/localhost:8080\/api\/captures/);
  assert.equal(/8080\/\/api/.test(snippet), false);
});

test('the relay and the agent agree on the message protocol', () => {
  // The two halves are in one file but are separate scripts with no shared
  // constant, so the names are asserted rather than assumed: the relay announces
  // readiness, the agent answers with a payload, and the relay replies with a
  // result. A rename on one side would otherwise be silent.
  for (const name of ['proxy-capture', 'proxy-capture-ready', 'proxy-capture-result']) {
    assert.ok(CAPTURE_AGENT_SOURCE.includes(name), `the agent must speak "${name}"`);
    assert.ok(CAPTURE_RELAY_SOURCE.includes(name), `the relay must speak "${name}"`);
  }
});

test('the agent and the relay both post the payload as text/plain', () => {
  // The relay is same-origin with the service and could use application/json,
  // but it shares the endpoint with the cross-origin transports, and a content
  // type that skipped the parse path would be a second code path to keep right.
  assert.ok(CAPTURE_RELAY_SOURCE.includes('text/plain;charset=UTF-8'));
  assert.ok(CAPTURE_AGENT_SOURCE.includes('text/plain;charset=UTF-8'));
});

test('the relay is served from the service origin and carries no policy of its own', () => {
  // Its whole purpose is to be a document this service will accept an upload
  // from, so a policy of its own would defeat it.
  assert.equal(/content-security-policy/i.test(CAPTURE_RELAY_SOURCE), false);
  assert.ok(CAPTURE_RELAY_SOURCE.startsWith('<!DOCTYPE html>'));
  assert.ok(CAPTURE_RELAY_SOURCE.trimEnd().endsWith('</html>'));
});

test('REGRESSION: the agent keeps the beacon out of the upload path', () => {
  // sendBeacon was tried and removed. It reports success when CSP has blocked the
  // request, so a blocked upload looked like a completed capture and the relay
  // never ran — the exact defect this feature exists to work around. Asserted on
  // the *call*, since the comment above send() names it deliberately.
  assert.equal(/navigator\.sendBeacon\s*\(/.test(CAPTURE_AGENT_SOURCE), false);
});

test('the relay is announced to the agent as a fallback URL', () => {
  const snippet = captureSnippet({ origin: 'http://localhost:8080', targetUrl: 'https://example.com/' });
  assert.match(snippet, /captureRelay: "http:\/\/localhost:8080\/api\/capture-relay\.html"/);
});

test('the snippet escapes a URL that would otherwise break out of the string', () => {
  // The target comes from a query parameter, so it is attacker-influenced. The
  // property that matters is not "the quote is absent" — an escaped quote still
  // contains the quote — but that the generated code parses and the value
  // survives exactly. This is checked by running it, because that is the only
  // way to tell escaping from injection.
  const hostile = 'https://example.com/?a=";window.__pwned=1;//';
  const snippet = captureSnippet({ origin: 'http://localhost:8080', targetUrl: hostile });

  assert.doesNotThrow(() => parse(snippet, { ecmaVersion: 'latest', sourceType: 'script' }));

  const sandbox: Record<string, unknown> = {
    window: {
      __PROXY_CONFIG__: undefined as unknown,
      addEventListener() {},
      console: { log() {}, warn() {} },
    },
    document: {
      baseURI: 'https://example.com/',
      readyState: 'loading',
      title: '',
      cookie: '',
      doctype: null,
      documentElement: { outerHTML: '<html></html>' },
      querySelectorAll: () => [],
    },
    location: { href: 'https://example.com/' },
    performance: { getEntriesByType: () => [] },
    navigator: {},
    localStorage: { length: 0, key: () => null, getItem: () => null },
    sessionStorage: { length: 0, key: () => null, getItem: () => null },
    URL,
    Blob: class {},
    btoa: (v: string) => v,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    setTimeout,
    Object,
    JSON,
    String,
    RegExp,
    Array,
  };
  sandbox['globalThis'] = sandbox;
  sandbox['undefined'] = undefined;
  sandbox['__pwned'] = undefined;

  const context = createContext(sandbox);
  runInContext(snippet, context, { filename: 'snippet.js' });

  const config = (sandbox['window'] as Record<string, unknown>)['__PROXY_CONFIG__'] as Record<string, unknown>;
  assert.equal(config['captureTarget'], hostile, 'the URL must survive verbatim, not be truncated');
  assert.equal(sandbox['__pwned'], undefined, 'no injected statement may have executed');
});

test('REGRESSION: the agent resolves markup URLs against the target, not the proxy', () => {
  // The document is served by the proxy, so a relative URL in its markup resolves
  // to a path *on the proxy* where it means a path on the target site. The shim
  // hides this by rewriting the attributes it reaches, but a node it misses — one
  // inserted after its last pass — sent the capture to fetch /wp-content/... from
  // the proxy itself, storing a 404 in place of the image. A URL the shim *did*
  // rewrite names the target only after its payload is decoded, so both forms are
  // checked here; they are the two ways a URL reaches the archive's URL list.
  const PROXY = 'http://localhost:8080';
  const TARGET = 'https://www.hotelis.ch/de/';
  const proxied = `${PROXY}/proxy/archive/plain/${encodeURIComponent(TARGET)}`;

  const elements = [
    { href: '/wp-content/uploads/icon.png' },
    { href: `/proxy/plain/${encodeURIComponent('https://cdn.example.com/a.js')}` },
  ];
  const empty = { length: 0 };
  for (const name of ['0', '1']) {
    Object.assign(elements[Number(name)] as object, {
      getAttribute(key: string) {
        const value = (this as { [k: string]: unknown })[key];
        return typeof value === 'string' ? value : null;
      },
    });
  }

  const sandbox: Record<string, unknown> = {
    window: {
      __PROXY_CONFIG__: {
        targetOrigin: 'https://www.hotelis.ch',
        targetUrl: TARGET,
        declaredBase: TARGET,
        codec: 'plain',
        prefix: '/proxy',
        captureTarget: TARGET,
        captureAuto: false,
      },
      addEventListener() {},
      console: { log() {}, warn() {} },
    },
    document: {
      baseURI: proxied,
      readyState: 'complete',
      title: '',
      cookie: '',
      doctype: null,
      documentElement: { outerHTML: '<html></html>' },
      querySelectorAll: (selector: string) =>
        selector.startsWith('[') ? Object.assign(elements, { length: 2 }) : empty,
    },
    location: { href: proxied, origin: PROXY },
    performance: { getEntriesByType: () => [] },
    navigator: {},
    localStorage: { length: 0, key: () => null, getItem: () => null },
    sessionStorage: { length: 0, key: () => null, getItem: () => null },
    URL,
    Blob: class {},
    btoa: (v: string) => v,
    setTimeout,
    Object,
    JSON,
    String,
    RegExp,
    Array,
    decodeURIComponent,
  };
  sandbox['globalThis'] = sandbox;

  const context = createContext(sandbox);
  runInContext(CAPTURE_AGENT_SOURCE, context, { filename: 'agent.js' });

  const payload = runInContext(
    'window.__PROXY_CAPTURE__.payload()',
    context,
    { filename: 'probe.js' },
  ) as { urls: string[] };

  const urls = [...payload.urls];
  assert.ok(urls.includes('https://www.hotelis.ch/wp-content/uploads/icon.png'),
    `a relative markup URL must belong to the target, got: ${urls.join(', ')}`);
  assert.ok(urls.includes('https://cdn.example.com/a.js'),
    `a shim-rewritten URL must be decoded, got: ${urls.join(', ')}`);
  assert.equal(urls.some((u) => u.includes(PROXY)), false,
    'nothing on the proxy origin may enter the target URL list');
});
