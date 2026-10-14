import type { Config } from '../config.ts';
import type { Logger } from '../util/logger.ts';
import type { UpstreamClient } from '../proxy/upstream.ts';
import { buildPassthroughRequestHeaders } from '../proxy/headers/request.ts';
import { readAll } from '../util/bytes.ts';
import { isCodecName, routeTarget } from '../rewrite/codec.ts';
import { ArchiveBuilder, type ArchiveBuildResult } from './builder.ts';
import type { ArchiveStore } from './store.ts';

/**
 * Server-side ingest for a browser-assisted capture.
 *
 * A page cannot upload most of what it loaded: a cross-origin image, a CDN
 * script and a web font are opaque fetches, and script is not allowed to read
 * their bytes. So the page sends two things instead — the parts it *does* own,
 * and the list of URLs it requested — and this module does the part only the
 * server can: it fetches each of those URLs itself.
 *
 * The credentials matter more than they look. Each fetch reuses the *client's
 * own* `User-Agent`, `Accept-Language`, `Referer`, `Sec-Fetch-*` and cookie jar,
 * because the point of a browser-assisted capture is to record the page the user
 * actually saw. Fetching as the crawler would record a different document — the
 * one a bot is served — which is the failure mode this whole method exists to
 * avoid.
 *
 * Inline resources are stored under synthetic keys rather than real URLs. A
 * stylesheet read out of the CSSOM has no URL a server can fetch (it may have
 * arrived through CORS, or been built entirely by script), so it is stored under
 * `inline:<kind>:<n>` in a *deduplicated* per-URL namespace, and the replay
 * serves it by URL when the URL is known. See `INLINE_KEY`.
 */

/** Prefix for a resource that has no server-fetchable URL of its own. */
export const INLINE_KEY = 'inline:';

/** Storage keys, stored as a `storage:` pseudo-URL, one entry per scope. */
export const STORAGE_KEY_PREFIX = 'storage:';

/** The payload the page-side agent posts. */
export interface CapturePayload {
  targetUrl: string;
  finalUrl?: string;
  document?: { text: string; type?: string };
  /** Inline resources, keyed by the URL they belong to when one is known. */
  inline?: Record<string, { text: string; type?: string; tag?: string }>;
  urls?: string[];
  cookies?: string;
  title?: string;
  storage?: { local?: Record<string, string>; session?: Record<string, string> };
}

export interface CaptureResult extends ArchiveBuildResult {
  /** URLs the server tried to fetch but could not. */
  failed: Array<{ url: string; message: string }>;
}

/** Upper bound on one uploaded capture, so a hostile page cannot exhaust memory. */
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

/** Upper bound on how many URLs one capture may make the server fetch. */
const MAX_URLS = 5000;

export class CaptureIngest {
  readonly #config: Config;
  readonly #logger: Logger;
  readonly #upstream: UpstreamClient;
  readonly #store: ArchiveStore;

  constructor(config: Config, logger: Logger, upstream: UpstreamClient, store: ArchiveStore) {
    this.#config = config;
    this.#logger = logger;
    this.#upstream = upstream;
    this.#store = store;
  }

  /**
   * Store a capture and fetch everything it names.
   *
   * Returns the archive identity so the caller can hand the user a replay URL.
   * The work is synchronous from the client's point of view — the caller is an
   * upload that wants to know where its archive is — which is why the response
   * carries the id rather than the client polling for it.
   */
  async ingest(
    payload: CapturePayload,
    clientHeaders: Record<string, string | string[] | undefined>,
  ): Promise<CaptureResult> {
    const seed = payload.finalUrl ?? payload.targetUrl;
    const builder = await ArchiveBuilder.open(this.#store, this.#logger, {
      seedUrl: seed,
      producer: 'browser-capture',
    });

    const failed: Array<{ url: string; message: string }> = [];
    // The cookie the page reported, which is what the user's session actually
    // carried. Forwarded only to the origin the capture belongs to; sending it
    // to a third-party CDN would leak the session for no benefit.
    const seedOrigin = safeOrigin(seed);
    const cookies = typeof payload.cookies === 'string' ? payload.cookies : '';

    try {
      // 1. The document. The origin's own bytes are preferred, and not only for
      //    fidelity: the page's DOM was serialised *after* the proxy's shim had
      //    rewritten every URL in it, so its markup points at `/proxy/...`
      //    paths. Replaying those asks the origin for a path that never existed
      //    there. The live DOM is the fallback — for the case the static crawler
      //    cannot handle at all, a client-rendered page whose server HTML is an
      //    empty shell — and `#denormalize` repairs it.
      let document: string | undefined;
      if (payload.document && typeof payload.document.text === 'string') {
        document = payload.document.text;
      }

      let documentStored = false;
      if (seed !== '') {
        try {
          documentStored = await this.#fetchOne(
            builder,
            seed,
            clientHeaders,
            cookies,
            seedOrigin,
            // Pre-denormalised: the repair is unconditional, so it happens once
            // whether the DOM ends up stored or merely stands by as a fallback.
            document === undefined ? '' : this.#denormalize(document),
          );
        } catch (error) {
          this.#logger.debug({ err: error, seed }, 'capture could not fetch the document itself');
        }
      }

      // A capture must always produce a readable document. Nothing else in the
      // archive matters if opening it shows the origin's error page.
      if (seed !== '' && (!documentStored || !builder.has(seed))) {
        await this.#storeDocument(
          builder,
          seed,
          document === undefined ? '' : this.#denormalize(document),
        );
      }

      // 2. Inline resources. Stored before the URL pass so that a URL whose
      //    fetch fails still has its inline form available to the replay.
      await this.#storeInline(builder, payload, seed);

      // 3. The URL list, which is the part no rewriter can compute: it includes
      //    URLs the page assembled at runtime from fragments.
      const targets = this.#order(payload.urls ?? [], seed);
      await this.#fetchUrls(builder, targets, clientHeaders, cookies, seedOrigin, failed);

      // 4. Storage and cookies, as data rather than as replayable resources.
      await this.#storeState(builder, payload);

      return { ...(await builder.finish()), failed };
    } catch (error) {
      await builder.fail(error);
      throw error;
    }
  }

  /**
   * Undo the proxy's own URL rewriting in a serialised DOM.
   *
   * The agent serialises the live document, and by that point the shim has
   * already been through it: every `src`, `href` and `srcset` points at
   * `/proxy/<codec>/<encoded-target>`. Stored verbatim, a replay would ask the
   * origin for those paths — a request for `/proxy/...` where the origin has
   * `/assets/...`.
   *
   * Decoding goes through `routeTarget`, the same function the live router uses,
   * so the target-path form and the trailing-directory form are both handled by
   * the code that already has tests for them rather than by a second
   * implementation that can disagree.
   *
   * Anything that does not decode to an http(s) URL is left exactly as it was.
   * A page whose own markup happens to contain the string `/proxy/` must not be
   * mangled by a heuristic that only knows how to spot a proxy path.
   */
  #denormalize(html: string): string {
    const unwrap = (value: string): string => {
      // Match the proxy prefix at the start, or after an origin, which is the
      // absolute form the shim produces for a `URL` input.
      const match = /^(?:[a-z][a-z0-9+.-]*:\/\/[^/]+)?\/proxy\/([^"'?#]+)/i.exec(value);
      if (match === null) return value;

      const tail = match[1];
      if (tail === undefined) return value;

      const slash = tail.indexOf('/');
      const codec = slash === -1 ? tail : tail.slice(0, slash);
      if (codec !== 'plain' && codec !== 'b64') return value;

      const payload = slash === -1 ? '' : tail.slice(slash + 1);
      if (payload === '') return value;

      const decoded = routeTarget(codec, payload);
      return decoded ?? value;
    };

    // Attributes only. A proxy path inside a script or a stylesheet is that
    // resource's own business, and those are stored from a separate fetch.
    const withAttributes = html.replace(
      /(\s(?:href|src|poster|action|data|cite|background)=")([^"]*)(")/gi,
      (_match, head: string, value: string, tail: string) => `${head}${unwrap(value)}${tail}`,
    );

    // `srcset` is a candidate list, so only the URL of each candidate is
    // unwrapped and its descriptor is preserved.
    return withAttributes.replace(
      /(\s(?:srcset|imagesrcset)=")([^"]*)(")/gi,
      (_match, head: string, value: string, tail: string) => {
        const rewritten = value
          .split(',')
          .map((candidate) => {
            const parts = /^(\s*)(\S+)([\s\S]*)$/.exec(candidate);
            if (parts === null) return candidate;
            return `${parts[1] ?? ''}${unwrap(parts[2] ?? '')}${parts[3] ?? ''}`;
          })
          .join(',');
        return `${head}${rewritten}${tail}`;
      },
    );
  }

  /**
   * Order the URL list so the document and its stylesheets are fetched first.
   *
   * The fetches are independent and could run in any order, but a capture that
   * is interrupted partway through is far more useful if what arrived is the
   * page and its CSS rather than a dozen analytics beacons.
   */
  #order(urls: string[], seed: string): string[] {
    const seen = new Set<string>();
    const documents: string[] = [];
    const styles: string[] = [];
    const rest: string[] = [];

    for (const raw of urls) {
      const url = normalize(raw);
      if (url === null || seen.has(url)) continue;
      seen.add(url);
      if (url === seed) continue; // already stored from the DOM above

      const path = pathnameOf(url).toLowerCase();
      if (path.endsWith('.css')) styles.push(url);
      else if (path.endsWith('.html') || path.endsWith('.htm') || path.endsWith('/')) documents.push(url);
      else rest.push(url);
    }

    return [...documents, ...styles, ...rest].slice(0, MAX_URLS);
  }

  async #fetchUrls(
    builder: ArchiveBuilder,
    urls: string[],
    clientHeaders: Record<string, string | string[] | undefined>,
    cookies: string,
    seedOrigin: string,
    failed: Array<{ url: string; message: string }>,
  ): Promise<void> {
    const concurrency = Math.max(1, this.#config.archive.concurrency);
    let next = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        const url = urls[index];
        if (url === undefined) return;
        if (builder.has(url)) continue;

        try {
          const stored = await this.#fetchOne(builder, url, clientHeaders, cookies, seedOrigin);
          if (!stored) builder.note(url);
        } catch (error) {
          // One unreachable beacon must not fail a whole capture; the archive
          // records that it was part of the page and could not be stored.
          const message = error instanceof Error ? error.message : String(error);
          failed.push({ url, message });
          builder.note(url);
          this.#logger.debug({ url, err: error }, 'capture fetch failed');
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  /**
   * Store a document the page handed over, as the page's own bytes.
   *
   * A page that cannot be fetched — or that the origin answers with an error —
   * still has its live DOM to offer, and that DOM is the more faithful record of
   * what the user read. Recorded as 200 because the archive is replaying content
   * the browser genuinely rendered, not an error the origin happened to return to
   * an anonymous request.
   */
  async #storeDocument(builder: ArchiveBuilder, url: string, html: string): Promise<void> {
    if (html === '') return;
    await builder.add(
      url,
      200,
      { 'content-type': 'text/html; charset=utf-8' },
      'text/html; charset=utf-8',
      new TextEncoder().encode(html),
      { size: byteLength(html), isDocument: true },
    );
  }

  async #fetchOne(
    builder: ArchiveBuilder,
    url: string,
    clientHeaders: Record<string, string | string[] | undefined>,
    cookies: string,
    seedOrigin: string,
    documentFallback = '',
  ): Promise<boolean> {
    const target = new URL(url);
    const headers = buildPassthroughRequestHeaders(clientHeaders, target, this.#config.proxy);

    // Unlike a passthrough relay, a capture has to *rewrite* what it stores, and
    // no rewriter can parse a compressed body. `buildPassthroughRequestHeaders`
    // deliberately restores the client's `accept-encoding` because a blob is
    // relayed untouched — which is right for browsing and wrong here. Left alone
    // it stores gzip bytes under a `text/html` content type with the
    // `content-encoding` dropped (it is not in the recorded set), so a replay
    // hands the browser compressed bytes labelled as HTML and renders gibberish.
    headers.set('accept-encoding', 'identity');

    // A cookie belongs to the site the user was on. Forwarding it to every host
    // the page happens to touch would hand the session to third parties.
    if (cookies !== '' && target.origin === seedOrigin) headers.set('cookie', cookies);

    const response = await this.#upstream.fetch(target, { method: 'GET', headers });

    // An error reply is not the page. When the browser handed over its own DOM,
    // that DOM is what the user actually read, while an anonymous request for
    // the same URL is what gets the error — an expired session, a bot wall, a
    // host that only answers with a cookie the server cannot hold. Storing the
    // error would produce a replay showing a login page where the user saw
    // content, which is precisely the fidelity this method exists to provide.
    if (documentFallback !== '' && (response.status < 200 || response.status >= 400)) {
      await this.#storeDocument(builder, url, documentFallback);
      return true;
    }

    // A redirect is recorded as the resource it resolved to, which is what the
    // replay needs: the archive key is the URL the browser asked for.
    if (response.status >= 300 && response.status < 400) {
      const headersOut = headersToRecord(response.headers);
      await builder.add(url, response.status, headersOut, response.headers.get('content-type'), new Uint8Array(0), {
        size: 0,
      });
      return true;
    }

    const body = await readAll(response.body, this.#byteCeiling());
    const contentType = response.headers.get('content-type');

    await builder.add(url, response.status, headersToRecord(response.headers), contentType, body, {
      size: body.byteLength,
      isDocument: isDocumentType(contentType),
      discovered: collectEmbeddedUrls(body, contentType, url),
    });

    return true;
  }

  /**
   * Store resources the page handed over inline.
   *
   * Each inline resource is stored twice when its URL is known: once under the
   * real URL, so the replay's normal lookup finds it without special handling,
   * and once under a synthetic key, so it survives even if the server's own
   * fetch of that URL fails. A CSSOM-read stylesheet is the reason this exists —
   * its text can be complete while its URL is unreachable from the server.
   */
  async #storeInline(builder: ArchiveBuilder, payload: CapturePayload, seed: string): Promise<void> {
    const entries = Object.entries(payload.inline ?? {});
    let synthetic = 0;

    for (const [key, value] of entries) {
      if (typeof value?.text !== 'string' || value.text === '') continue;
      const type = value.type ?? 'text/plain';

      // A key that is itself a URL means the resource has a real identity.
      const byUrl = normalize(key);
      if (byUrl !== null && !builder.has(byUrl)) {
        await builder.add(byUrl, 200, { 'content-type': type }, type, new TextEncoder().encode(value.text), {
          size: byteLength(value.text),
          isDocument: false,
        });
        continue;
      }

      const index = synthetic;
      synthetic += 1;
      const key2 = `${INLINE_KEY}${seed}#${index}:${value.tag ?? 'inline'}`;
      await builder.add(key2, 200, { 'content-type': type }, type, new TextEncoder().encode(value.text), {
        size: byteLength(value.text),
      });
    }
  }

  /** Store cookies and web storage as data, addressed by a pseudo-URL. */
  async #storeState(builder: ArchiveBuilder, payload: CapturePayload): Promise<void> {
    const write = async (name: string, value: unknown): Promise<void> => {
      const text = JSON.stringify(value);
      const key = `${STORAGE_KEY_PREFIX}${name}@${payload.finalUrl ?? payload.targetUrl}`;
      await builder.add(
        key,
        200,
        { 'content-type': 'application/json' },
        'application/json',
        new TextEncoder().encode(text),
        { size: byteLength(text) },
      );
    };

    if (typeof payload.cookies === 'string' && payload.cookies !== '') {
      await write('cookies', payload.cookies);
    }
    if (payload.storage && Object.keys(payload.storage).length > 0) {
      await write('web', payload.storage);
    }
  }

  #byteCeiling(): number {
    return Math.max(this.#config.proxy.maxRewriteBytes, 50 * 1024 * 1024);
  }
}

/**
 * Parse a posted capture.
 *
 * The body is strict JSON even though it arrives as `text/plain`, because the
 * content type is chosen for cross-origin reach rather than for its meaning. An
 * oversized body is refused rather than truncated: a truncated payload is valid
 * JSON about half the time, and storing half a capture silently is worse than
 * rejecting it.
 */
export function parseCapture(body: string): CapturePayload | null {
  if (byteLength(body) > MAX_PAYLOAD_BYTES) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const target = record['targetUrl'];
  if (typeof target !== 'string' || normalize(target) === null) return null;

  const urls: string[] = [];
  if (Array.isArray(record['urls'])) {
    // Deduplicated here rather than at fetch time. A page routinely names the
    // same asset in markup, in a preload hint and in its own script, and the
    // agent also reports what it saw requested — so duplicates are the normal
    // case, not an edge case. The stored counts are what a user reads to judge
    // whether a capture is complete, so they must not be inflated by repeats.
    const seen = new Set<string>();
    for (const entry of record['urls']) {
      const url = normalize(entry);
      if (url === null || seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }
  }

  const inline: Record<string, { text: string; type?: string; tag?: string }> = {};
  const rawInline = record['inline'];
  if (typeof rawInline === 'object' && rawInline !== null && !Array.isArray(rawInline)) {
    for (const [key, value] of Object.entries(rawInline as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry['text'] !== 'string') continue;
      inline[key] = {
        text: entry['text'],
        ...(typeof entry['type'] === 'string' ? { type: entry['type'] } : {}),
        ...(typeof entry['tag'] === 'string' ? { tag: entry['tag'] } : {}),
      };
    }
  }

  const document = record['document'];
  const storage = record['storage'];

  return {
    targetUrl: target,
    ...(typeof record['finalUrl'] === 'string' ? { finalUrl: record['finalUrl'] } : {}),
    ...(typeof document === 'object' && document !== null &&
    typeof (document as Record<string, unknown>)['text'] === 'string'
      ? {
          document: {
            text: (document as Record<string, unknown>)['text'] as string,
            ...(typeof (document as Record<string, unknown>)['type'] === 'string'
              ? { type: (document as Record<string, unknown>)['type'] as string }
              : {}),
          },
        }
      : {}),
    ...(Object.keys(inline).length > 0 ? { inline } : {}),
    ...(urls.length > 0 ? { urls } : {}),
    ...(typeof record['cookies'] === 'string' ? { cookies: record['cookies'] } : {}),
    ...(typeof record['title'] === 'string' ? { title: record['title'] } : {}),
    ...(typeof storage === 'object' && storage !== null
      ? { storage: storage as CapturePayload['storage'] }
      : {}),
  };
}

/**
 * Find URLs inside a fetched body so a capture follows one level further.
 *
 * Reuses the same shape of discovery the crawler does, but only reports it — the
 * caller decides whether to fetch. A brace-heavy minified script can produce
 * false positives, which costs one wasted fetch rather than a corrupt archive,
 * because nothing here rewrites anything.
 */
function collectEmbeddedUrls(body: Uint8Array, contentType: string | null, base: string): Set<string> {
  const out = new Set<string>();
  const lower = (contentType ?? '').toLowerCase();

  const isText =
    lower.includes('html') ||
    lower.includes('css') ||
    lower.includes('javascript') ||
    lower.includes('json');
  if (!isText) return out;

  // Only the first 2 MB of a body is scanned: a discovery miss costs one asset,
  // and a 50 MB bundle is not worth the regex time on the request path.
  const text = new TextDecoder('utf-8', { fatal: false }).decode(body.subarray(0, 2 * 1024 * 1024));
  const re = /(["'(])((?:https?:)?\/\/[^"'()\s]+|\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{2,})\1/g;

  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const resolved = normalize(match[2], base);
    if (resolved !== null) out.add(resolved);
  }
  return out;
}

/** True when a content type means "this is a page". */
function isDocumentType(contentType: string | null): boolean {
  const lower = (contentType ?? '').toLowerCase();
  return lower.includes('text/html') || lower.includes('application/xhtml+xml');
}

/**
 * Keep only the headers a replay actually needs.
 *
 * `content-encoding` is recorded rather than dropped, and not because the
 * rewriters want it — they do not, and #rewriteBody only routes types it can
 * parse, so a body arriving compressed is relayed byte-for-byte. Recording it is
 * what keeps that relay honest: without it the browser would receive compressed
 * bytes under a `content-type` that says otherwise. Origins do compress despite
 * an identity request often enough — some ignore it, and a few always send br —
 * that the alternative is a replay that silently renders garbage.
 */
function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [
    'content-type',
    'content-encoding',
    'content-language',
    'last-modified',
    'etag',
    'cache-control',
  ]) {
    const value = headers.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}

/** Resolve a candidate to an absolute http(s) URL, or null. */
function normalize(raw: unknown, base?: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;
  if (/^(?:data|blob|javascript|mailto|tel|about|chrome|file|ws|wss):/i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed, base ?? undefined);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    // A page captured through the proxy reports the URLs it asked for *after*
    // the shim rewrote them, so the list the browser hands over is full of
    // `/proxy/plain/<encoded>` paths. Those name a resource on this service, not
    // on the origin, and storing them would put a replay URL in the archive in
    // place of the real asset. Unwrapping here rather than at each call site
    // keeps every consumer of this function — ordering, inline storage, state —
    // agreeing on one spelling of a URL.
    const unwrapped = unwrapProxyPath(url);
    if (unwrapped !== null) return unwrapped;

    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Reverse the proxy's own URL form, or return null when this is not one.
 *
 * The evidence that this is a proxy path is the decode itself: `routeTarget`
 * only returns a value when the payload expands to an absolute http(s) URL, so a
 * site that merely happens to serve a path under `/proxy/plain/` is left alone
 * unless the final segment really is a whole URL. Note that the decoded origin is
 * deliberately *not* required to match the proxy's own — that is the entire point
 * of this service, and requiring it would unwrap nothing.
 */
function unwrapProxyPath(url: URL): string | null {
  const match = /^\/proxy\/(plain|b64)\/(.+)$/.exec(url.pathname);
  if (match === null) return null;

  const codec = match[1];
  const payload = match[2];
  if (codec === undefined || payload === undefined || !isCodecName(codec)) return null;

  const decoded = routeTarget(codec, payload);
  if (decoded === null) return null;

  try {
    const target = new URL(decoded);
    target.search = url.search;
    target.hash = '';
    return target.href;
  } catch {
    return null;
  }
}

function safeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

function pathnameOf(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return '';
  }
}

/** UTF-8 byte length, which is what the store records. */
function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}
