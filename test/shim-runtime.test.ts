import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext, type Context } from 'node:vm';
import { rewriteHtml } from '../src/rewrite/html.ts';
import { RUNTIME_SHIM_SOURCE } from '../src/shim/runtime.ts';

/**
 * Behavioural tests for the runtime shim, run for real.
 *
 * `test/shim.test.ts` checks the shim as a *string* — that it parses, that it is
 * not truncated, that serialization does not escape it. That was necessary and
 * not sufficient: the shim's own logic went untested, and it shipped a bug that
 * re-proxied every URL it saw, nesting one generation deeper per pass until the
 * URL was unusable.
 *
 * So these tests execute the shim the way a browser does — extracted from the
 * *serialized* document, so serialization is covered too — inside an isolated VM
 * context with a stubbed DOM. The isolation matters: `new Function(source)` would
 * patch the test runner's own globals.
 *
 * The property under test is idempotence. The shim's element rewriter is driven
 * by a MutationObserver that fires on every insertion, so "rewrites once" is not
 * the requirement — "rewriting a rewritten URL is a no-op" is.
 */

const ORIGIN = 'https://www.hotelis.ch';
const DOCUMENT_URL = 'https://www.hotelis.ch/de/branchen/';
const PROXY_ORIGIN = 'http://localhost:8080';

interface FakeElement {
  nodeType: number;
  attrs: Record<string, string>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  querySelectorAll(selector: string): FakeElement[];
}

function fakeElement(attrs: Record<string, string> = {}): FakeElement {
  return {
    nodeType: 1,
    attrs: { ...attrs },
    getAttribute(name: string) {
      return this.attrs[name] ?? null;
    },
    setAttribute(name: string, value: string) {
      this.attrs[name] = value;
    },
    querySelectorAll() {
      return [];
    },
  };
}

/**
 * A `location` shaped like the browser's, because the shim's navigation guard
 * depends on that shape: `replace` is a property of `Location.prototype`, not of
 * the `location` instance, and `getPrototypeOf(location)` is how the shim reaches
 * it. A plain object literal with its own `replace` would let the guard install
 * and prove nothing about the real thing.
 *
 * `navigated` is the stand-in for the browser actually moving: a patched
 * `replace` that lets the call through records the URL, and a refused one records
 * nothing, which is exactly the distinction under test.
 */
function makeLocation(href: string, navigated: string[]): Record<string, string> {
  // Built with `Object.create` so `replace` genuinely lives on the prototype:
  // that is the shape the shim's guard reaches for, and the shape a plain object
  // literal would not have.
  const proto = {
    replace(url: string): void {
      navigated.push(String(url));
    },
  };
  const parsed = new URL(href);
  const instance = Object.create(proto) as Record<string, string>;
  // Read off `location` itself, exactly as the shim does in a browser; the guard
  // never writes to any of them.
  Object.defineProperties(instance, {
    href: { value: href, configurable: true },
    origin: { value: parsed.origin, configurable: true },
    host: { value: parsed.host, configurable: true },
  });
  return instance;
}

/** Extract the shim exactly as it is delivered inside a rewritten document. */
function deliveredShim(prefix?: string): string {
  const out = rewriteHtml('<html><head><title>t</title></head><body></body></html>', {
    codec: 'plain',
    baseUrl: DOCUMENT_URL,
    injectShim: true,
    shimSource: RUNTIME_SHIM_SOURCE,
    targetOrigin: ORIGIN,
    ...(prefix === undefined ? {} : { prefix }),
  }).html;

  const marker = out.indexOf('data-proxy-shim');
  assert.ok(marker !== -1, 'the shim should be injected');
  const open = out.indexOf('>', marker) + 1;
  const close = out.indexOf('</script>', open);
  const body = out.slice(open, close);
  assert.ok(body.includes('__PROXY_CONFIG__'), 'expected the shim body');
  return body;
}

interface Harness {
  /** URLs the patched `fetch` was asked for. */
  fetched: string[];
  /** URLs the patched `location.replace` actually navigated to. */
  navigated: string[];
  /** Push a URL through the shim's rewriting and return what came out. */
  rewrote(input: string): string;
  /** Fire the shim's MutationObserver, as a browser would on insertion. */
  observe(nodes: FakeElement[]): void;
  /** Construct a URL through the shim's patched constructor. */
  url(input: string, base?: string | null): string;
  /** The capture ledger, which the shim publishes for the capture agent. */
  recorded(): string[];
  /** Call `location.replace` from page script. */
  replace(url: string): void;
  /** Assign `location.href` from page script. */
  assignHref(url: string): void;
}

function run(prefix = '/proxy', documentHref = `${PROXY_ORIGIN}/de/branchen/`): Harness {
  const fetched: string[] = [];
  const navigated: string[] = [];
  let observerCallback: ((records: unknown[]) => void) | null = null;
  let started = false;

  const config = {
    targetOrigin: ORIGIN,
    targetUrl: DOCUMENT_URL,
    // The rewriter strips <base href> and carries the declared value here, so
    // this is what page script observes as the base.
    declaredBase: DOCUMENT_URL,
    codec: 'plain',
    prefix,
  };

  // The shim's cookie patch only installs if this looks like a real accessor.
  function Document() {}
  Object.defineProperty(Document.prototype, 'cookie', {
    configurable: true,
    get() {
      return '';
    },
    set() {},
  });

  const sandbox: Record<string, unknown> = {
    __PROXY_CONFIG__: config,
    document: {
      baseURI: `${PROXY_ORIGIN}/de/branchen/`,
      documentElement: fakeElement(),
      body: fakeElement(),
      getElementById() {
        return null;
      },
      createElement() {
        return fakeElement();
      },
      write() {},
      writeln() {},
    },
    Document,
    location: makeLocation(documentHref, navigated),
    navigator: {},
    history: { pushState() {}, replaceState() {} },
    // A bare VM realm lacks these, and the shim touches all of them.
    URL,
    TextEncoder,
    btoa,
    fetch: async (input: unknown) => {
      fetched.push(String(input));
      return { ok: true };
    },
    MutationObserver: class {
      constructor(callback: (records: unknown[]) => void) {
        observerCallback = callback;
      }
      observe() {}
      disconnect() {}
    },
  };
  sandbox['window'] = sandbox;
  sandbox['self'] = sandbox;

  const context = createContext(sandbox) as Context;

  // The shim installs once, then every probe runs against the patched globals.
  const start = (): void => {
    if (started) return;
    // The prefix travels in the serialized config, exactly as it does in the
    // pipeline, so a mis-wired prefix would be caught here rather than assumed.
    runInContext(deliveredShim(prefix), context, { filename: 'shim.js' });
    started = true;
  };

  return {
    fetched,
    navigated,
    rewrote(input) {
      start();
      fetched.length = 0;
      runInContext(`fetch(${JSON.stringify(input)})`, context, { filename: 'probe.js' });
      const out = fetched[0];
      assert.ok(out !== undefined, `fetch was never called for ${input}`);
      return out;
    },
    observe(nodes) {
      start();
      assert.ok(observerCallback !== null, 'the shim should have installed a MutationObserver');
      observerCallback([{ addedNodes: nodes }]);
    },
    url(input, base) {
      start();
      const probe = base === undefined
        ? `new URL(${JSON.stringify(input)}).href`
        : `new URL(${JSON.stringify(input)}, ${JSON.stringify(base)}).href`;
      return runInContext(probe, context, { filename: 'probe.js' }) as string;
    },
    recorded() {
      start();
      return runInContext(
        'window.__PROXY_CAPTURE__.requests()',
        context,
        { filename: 'probe.js' },
      ) as string[];
    },
    replace(url) {
      start();
      runInContext(`location.replace(${JSON.stringify(url)})`, context, { filename: 'probe.js' });
    },
    assignHref(url) {
      start();
      runInContext(`location.href = ${JSON.stringify(url)}`, context, { filename: 'probe.js' });
    },
  };
}

const proxyPath = (url: string, prefix = '/proxy'): string =>
  `${prefix}/plain/${encodeURIComponent(url)}`;

// --- the regression ---------------------------------------------------------

test('REGRESSION: toProxyUrl is idempotent for every already-proxied shape', () => {
  // The rewriter emits proxy links in the origin's own path space, so a
  // root-relative /proxy/plain/... is indistinguishable from an origin path
  // unless the check happens *before* resolution. It did not, so every link the
  // page inserted was wrapped again, and the observer wrapped it again on the
  // pass after that.
  const h = run();
  const inputs = [
    proxyPath(DOCUMENT_URL),
    `${PROXY_ORIGIN}${proxyPath(DOCUMENT_URL)}`,
    proxyPath(`${ORIGIN}/wp-content/uploads/picto.png`),
    proxyPath(`${ORIGIN}/x.js?q=1&r=2`),
  ];

  for (const input of inputs) {
    assert.equal(h.rewrote(input), input, `must pass through unchanged: ${input}`);
  }
});

test('REGRESSION: repeated rewriting cannot nest the encoding', () => {
  const start = `${ORIGIN}/wp-content/uploads/2025/09/picto-catering-1.png`;
  const h = run();
  let current = start;

  for (let pass = 0; pass < 8; pass++) {
    current = h.rewrote(current);
    assert.doesNotMatch(current, /%25/, `pass ${pass} double-encoded: ${current}`);
    const decoded = decodeURIComponent(current);
    assert.equal(
      decoded.split('/proxy/plain/').length - 1,
      1,
      `pass ${pass} nested the proxy prefix: ${current}`,
    );
  }

  assert.equal(
    current,
    proxyPath(start),
    'eight passes must still produce exactly one level of proxying',
  );
});

test('REGRESSION: an element whose URL is already proxied is left untouched', () => {
  // The exact path the nesting came through: markup the server already rewrote
  // is inserted into the DOM, and the observer sees it.
  const h = run();
  const proxied = proxyPath(`${ORIGIN}/de/branchen/hotellerie/`);
  const element = fakeElement({ href: proxied, src: `${PROXY_ORIGIN}${proxied}` });

  h.observe([element]);

  assert.equal(element.attrs['href'], proxied, 'href must not be re-proxied');
  assert.equal(
    element.attrs['src'],
    `${PROXY_ORIGIN}${proxied}`,
    'an absolute proxied URL must not be re-proxied either',
  );
});

test('an element with an unproxied URL is still rewritten', () => {
  const h = run();
  const element = fakeElement({ href: 'hotellerie/', src: '/wp-content/x.png' });

  h.observe([element]);

  assert.equal(
    element.attrs['href'],
    proxyPath(`${ORIGIN}/de/branchen/hotellerie/`),
  );
  assert.equal(element.attrs['src'], proxyPath(`${ORIGIN}/wp-content/x.png`));
});

test('the archive prefix is recognised, so replay cannot nest either', () => {
  // Replay emits /archive/<id>/... links, and the shim takes its prefix from
  // config. A prefix that failed to reach the shim would re-proxy replay links
  // exactly as the live ones were re-proxied before.
  const prefix = '/archive/abc123';
  const h = run(prefix);

  // The config the shim actually read must name the archive prefix, not /proxy.
  const serialized = deliveredShim(prefix);
  assert.match(
    serialized,
    /"prefix":"\/archive\/abc123"/,
    'the replay prefix must reach the shim through the serialized config',
  );

  const already = `${prefix}/plain/${encodeURIComponent(DOCUMENT_URL)}`;
  assert.equal(h.rewrote(already), already);
  assert.equal(
    h.rewrote('x.css'),
    `${prefix}/plain/${encodeURIComponent(`${ORIGIN}/de/branchen/x.css`)}`,
    'a reference that is not yet proxied must still be routed under the replay prefix',
  );
});

test('srcset candidates are rewritten without touching their descriptors', () => {
  const h = run();
  const element = fakeElement({
    srcset: `${proxyPath(`${ORIGIN}/a-150x150.png`)} 150w, /b.png 200w`,
  });

  h.observe([element]);

  const value = element.attrs['srcset'] ?? '';
  assert.match(value, /150w/);
  assert.match(value, /200w/);
  assert.equal(
    value.split(',').filter((candidate) => candidate.includes('proxy/plain')).length,
    2,
    'both candidates should be proxied',
  );
  assert.doesNotMatch(value, /%25/, 'the already-proxied candidate must not be re-encoded');
});

test('relative references resolve against the origin base, not the proxy', () => {
  // The rewriter strips <base href>; the shim carries the declared value so page
  // script resolving against it lands on the origin rather than the proxy.
  const h = run();
  assert.equal(
    h.rewrote('chunk-BYXBJQAS.js'),
    proxyPath(`${ORIGIN}/de/branchen/chunk-BYXBJQAS.js`),
  );
  assert.equal(h.rewrote('./x.css'), proxyPath(`${ORIGIN}/de/branchen/x.css`));
});

test('opaque schemes are never proxied', () => {
  const h = run();
  for (const input of ['data:text/plain,hi', 'blob:http://localhost:8080/x', 'about:blank']) {
    assert.equal(h.rewrote(input), input, `${input} must be left alone`);
  }
});

test('REGRESSION: a root-relative base is accepted by the patched URL', () => {
  // Regression: the rewriter emits root-relative proxy URLs on purpose, and
  // `import.meta.url` is rewritten to one because it is contractually absolute.
  // Feeding that value to `new URL(x, import.meta.url)` — exactly what webpack's
  // runtime does to derive its public path — threw "Invalid base URL" and took
  // the chunk loader down with it. A real browser treats a relative base as
  // relative to the document, so the proxy must too.
  const h = run();
  assert.equal(
    h.url('./', '/proxy/plain/https%3A%2F%2Fwww.hotelis.ch%2Fassets%2Fentry.js/assets/entry.js'),
    `${PROXY_ORIGIN}/proxy/plain/https%3A%2F%2Fwww.hotelis.ch%2Fassets%2Fentry.js/assets/`,
  );
  // The no-base form has to keep working: it is how the shim reads a page's own
  // absolute URLs, and those are the only ones that may omit a base.
  assert.equal(h.url(`${ORIGIN}/de/branchen/`), `${ORIGIN}/de/branchen/`);
});

test('REGRESSION: an absolute URL on the proxy origin is never proxied', () => {
  // The capture upload posts to the proxy's own /api/captures. Treated as a
  // target URL it was encoded into a proxy path, and the proxy then asked the
  // *site* for its own endpoint — a 404 from the origin, delivered silently
  // because the beacon transport reported success regardless. A same-origin
  // absolute URL on a proxied page can only name the proxy, since that is what
  // served the page, so it must pass through untouched and stay out of the
  // ledger: this service's endpoints are not part of the captured site.
  //
  // Only the absolute form is asserted. A relative path is resolved against the
  // page's declared base, which is the *target* — that is what native resolution
  // does, and why the agent resolves its own upload endpoint before use rather
  // than handing over a path.
  const h = run();
  assert.equal(h.url(`${PROXY_ORIGIN}/api/captures`), `${PROXY_ORIGIN}/api/captures`);
  assert.equal(h.url(`${PROXY_ORIGIN}/archive/abc/plain/x`), `${PROXY_ORIGIN}/archive/abc/plain/x`);
  // Length rather than a deep comparison: the ledger is built inside the VM
  // realm, so its Array prototype differs from the test's.
  assert.equal(h.recorded().length, 0);
});

test('REGRESSION: a null base falls back to the origin instead of throwing', () => {
  // `new URL(x, optionalBase)` with a nullish base is a legal call that means
  // "use the document base", and libraries reach for it by spreading an
  // optional parameter through. Native resolution would stringify null into an
  // invalid base and throw; the proxy's base is the origin, as before.
  const h = run();
  assert.equal(
    h.url('chunk-BYXBJQAS.js', null),
    `${ORIGIN}/de/branchen/chunk-BYXBJQAS.js`,
  );
});

test('the shim leaves navigation alone', () => {
  // It deliberately does not patch `location` beyond what is reachable, and the
  // endless-reload bug that was once blamed on navigation turned out to be the
  // archive serving a substitute for a request that only repeated a parameter the
  // candidate already carried — a server-side decision, fixed in
  // `ArchiveReplay#negotiate`. Asserted here so the shim is not "fixed" for it
  // again: any future guard bolted onto `location` would have to break this test
  // first, which is the point.
  const h = run();
  const destination = `${PROXY_ORIGIN}/de/branchen/next`;
  h.replace(destination);

  assert.deepEqual(h.navigated, [destination]);
});
