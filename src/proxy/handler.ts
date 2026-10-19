import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { Config } from '../config.ts';
import type { Logger } from '../util/logger.ts';
import { UpstreamClient, BlockedDestinationError, type UpstreamRequestOptions, type UpstreamBody } from './upstream.ts';import { buildUpstreamRequestHeaders } from './headers/request.ts';
import { rewriteResponseHeaders } from './headers/response.ts';
import { hasAmbiguousFraming } from './headers/hop-by-hop.ts';
import { rewriteCookieRequestHeader, cookieNamespaceFor } from './cookies/rewrite.ts';
import { rewriteHtml, declaresBaseHref } from '../rewrite/html.ts';
import { rewriteCss } from '../rewrite/css.ts';
import { rewriteJs } from '../rewrite/js.ts';
import { rewriteManifest } from '../rewrite/manifest.ts';
import { classifyBody, type RewriteKind } from '../rewrite/kind.ts';
import { CAPTURE_AGENT_SOURCE } from '../rewrite/capture.ts';
import { routeTarget, appendRequestQuery, type CodecName } from '../rewrite/codec.ts';
import { PROXY_PREFIX, CAPTURE_PREFIX } from '../server/router.ts';
import { RUNTIME_SHIM_SOURCE } from '../shim/runtime.ts';

/**
 * The capture agent as it is injected into a page being archived.
 *
 * A fragment rather than a full document, so it rides behind the shim's
 * configuration object the rewriter already emits: the agent reads
 * `window.__PROXY_CONFIG__` for its upload target, which means one
 * implementation serves both the injected page and the console snippet.
 *
 * `captureAuto` is what separates the two. Set here, the agent collects when
 * the document settles; the snippet leaves it false and calls the returned
 * function itself, because a paste should capture immediately rather than on an
 * event that has already fired.
 */
function buildCaptureAgent(targetUrl: string, codec: CodecName): string {
  const settings = JSON.stringify({
    captureUpload: '/api/captures',
    captureTarget: targetUrl,
    captureAuto: true,
    codec,
  });
  return `window.__PROXY_CONFIG__=Object.assign(window.__PROXY_CONFIG__||{},${settings});\n${CAPTURE_AGENT_SOURCE}`;
}

/**
 * Content types whose bodies are rewritten before being returned.
 *
 * A manifest is not matched here: it needs `sec-fetch-dest` as well as the media
 * type, for the reasons in `rewrite/kind.ts`. See `#classify`.
 */
const REWRITABLE = [
  { test: (t: string) => t.includes('text/html') || t.includes('application/xhtml+xml'), kind: 'html' },
  { test: (t: string) => t.includes('text/css'), kind: 'css' },
  { test: (t: string) => t.includes('javascript') || t.includes('ecmascript'), kind: 'js' },
] as const;

/** Mutable outcome of serving a target that was inferred rather than decoded. */
interface RebaseAttempt {
  rejected: boolean;
}

/**
 * Move a rewritten `Location` into the capture namespace.
 *
 * The header rewriter knows only the default proxy prefix, because that is the
 * only namespace a *browser* navigates in. A capture is served under a deeper one,
 * `/proxy/archive/<codec>`, and the two are not interchangeable: following a
 * Location that dropped `/archive/` yields an ordinary proxied page, which is to
 * say the capture mode is lost at the first redirect — and a site that redirects
 * its own root is the common case, not an edge one.
 *
 * Rewritten in place, and only when the value really is a proxy path for this
 * codec, so an origin echoing an external Location is left alone.
 */
function retargetLocation(headers: Headers, codec: CodecName): void {
  const location = headers.get('location');
  if (location === null) return;

  // `PROXY_PREFIX` already ends in a slash, so there is deliberately no second
  // one here: `/proxy//plain/` would never match and the fix would look applied
  // while doing nothing.
  const marker = `${PROXY_PREFIX}${codec}/`;
  if (!location.startsWith(marker)) return;
  headers.set('location', `${CAPTURE_PREFIX}${codec}/${location.slice(marker.length)}`);
}

export class ProxyHandler {
  readonly #upstream: UpstreamClient;
  readonly #config: Config;
  readonly #logger: Logger;

  constructor(config: Config, logger: Logger, upstream: UpstreamClient) {
    this.#config = config;
    this.#logger = logger;
    this.#upstream = upstream;
  }

  /**
   * Handle a `/proxy/<codec>/<payload>[/<target path>]` request.
   *
   * The payload is the target URL, encoded by the codec. It may be followed by
   * the target's own pathname, because that is what a browser produces when it
   * resolves a relative reference against a proxied URL — see
   * `proxyPathWithTargetPath`. A payload the rewriters generated already encodes
   * the target's path inside itself, so the two agree rather than conflict:
   * `routeTarget` prefers the trailing path only when the payload really decodes
   * to an encoded target.
   *
   * A query is re-attached rather than dropped, because a browser resolving a
   * relative reference puts the target's query there, and a hand-built proxy URL
   * does the same — `encodeURI` leaves `?` and `&` alone, and a GET form's
   * rewritten `action` receives the form's fields. See `appendRequestQuery`.
   */
  async handle(
    codec: CodecName,
    payload: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const targetUrl = routeTarget(codec, payload);
    if (targetUrl === null) {
      sendError(response, 400, 'Malformed proxy target');
      return;
    }

    // The decoded payload is known-good, but the appended query is raw client
    // input, so re-parse defensively rather than trusting it to stay valid.
    let target: URL;
    try {
      target = new URL(appendRequestQuery(targetUrl, request.url ?? ''));
    } catch {
      sendError(response, 400, 'Malformed proxy target');
      return;
    }

    await this.#serve(target, request, response, codec, null);
  }

  /**
   * Serve a target for capture: the page loads through the proxy as usual, with
   * one addition — the runtime shim is told that this document is being
   * captured, so it keeps a ledger of every URL the page asks for.
   *
   * Nothing else differs. The page is a normal proxied page, so it renders,
   * runs its own script and behaves exactly as it does in the browser; the only
   * evidence of capture is the ledger and the agent the injector adds.
   */
  async handleCapture(
    codec: CodecName,
    payload: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const targetUrl = routeTarget(codec, payload);
    if (targetUrl === null) {
      sendError(response, 400, 'Malformed capture target');
      return;
    }

    let target: URL;
    try {
      target = new URL(appendRequestQuery(targetUrl, request.url ?? ''));
    } catch {
      sendError(response, 400, 'Malformed capture target');
      return;
    }

    await this.#serve(target, request, response, codec, null, true);
  }

  /**
   * Serve a target that the caller inferred from the request's referer rather
   * than read from the request itself.
   *
   * The inference is a guess about *what kind of thing* was being fetched — a
   * subresource — so the response is allowed to disagree: a document in reply to
   * a guess of "asset" means the path was not a path on the target's origin
   * after all, and the caller is told so it can answer 404 as it originally
   * would have. Nothing is written to the response before that decision is made.
   */
  async handleRebased(
    target: URL,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<'served' | 'rejected-guess'> {
    const attempt: RebaseAttempt = { rejected: false };
    await this.#serve(target, request, response, this.#config.proxy.defaultCodec, attempt);
    return attempt.rejected ? 'rejected-guess' : 'served';
  }

  /**
   * Fetch, rewrite and deliver one target.
   *
   * `attempt` is non-null only for a request whose target was inferred rather
   * than decoded, and is how `#rewriting` reports back that the guess was wrong.
   */
  async #serve(
    target: URL,
    request: IncomingMessage,
    response: ServerResponse,
    codec: CodecName,
    attempt: RebaseAttempt | null,
    capture = false,
  ): Promise<void> {
    const method = request.method ?? 'GET';

    // A message declaring both Content-Length and Transfer-Encoding is the
    // precondition for CL.TE / TE.CL request smuggling (RFC 9112 s6.1). Refuse
    // it rather than forward an ambiguous request upstream.
    const clientHeaders = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      for (const entry of Array.isArray(value) ? value : [value]) {
        try {
          clientHeaders.append(name, entry);
        } catch { /* skip malformed */ }
      }
    }
    if (hasAmbiguousFraming(clientHeaders)) {
      sendError(response, 400, 'Ambiguous request framing');
      return;
    }

    const headers = buildUpstreamRequestHeaders(request.headers, target, this.#config.proxy);

    // Cookies live in an isolated per-origin jar on the client; strip the
    // namespace so the origin receives the names it originally set.
    const inboundCookies = request.headers.cookie;
    if (inboundCookies !== undefined) {
      const namespace = cookieNamespaceFor(target.origin);
      headers.set('cookie', rewriteCookieRequestHeader(inboundCookies, namespace));
    }

    const hasBody = method !== 'GET' && method !== 'HEAD';

    // `exactOptionalPropertyTypes` is off, so an explicit null body is fine and
    // undici simply sends none.
    const requestOptions: UpstreamRequestOptions = {
      method,
      headers,
      body: hasBody ? (request as unknown as UpstreamBody) : null,
      signal: AbortSignal.timeout(this.#config.proxy.timeoutMs),
    };

    let upstream;
    try {
      upstream = await this.#upstream.fetch(target, requestOptions);
    } catch (error) {
      this.#handleUpstreamError(error, target, response);
      return;
    }

    const contentType = upstream.headers.get('content-type') ?? '';
    const kind = this.#classify(contentType, request.headers['sec-fetch-dest']);

    if (kind === null) {
      await this.#passthrough(upstream, target, codec, request, response, capture);
      return;
    }

    await this.#rewriting(upstream, target, codec, kind, request, response, attempt, capture);
  }

  #classify(contentType: string, fetchDest?: string | string[] | undefined): RewriteKind | null {
    return classifyBody(contentType, fetchDest);
  }

  /** Relay a non-rewritable response (images, fonts, video) untouched. */
  async #passthrough(
    upstream: Awaited<ReturnType<UpstreamClient['fetch']>>,
    target: URL,
    codec: CodecName,
    request: IncomingMessage,
    response: ServerResponse,
    capture = false,
    /**
     * A body already read from `upstream.body`.
     *
     * The rewriting path has to read the body to decide whether it can rewrite
     * it, so by the time it discovers it cannot, the stream is spent. Passing
     * the bytes here is what lets it fall back to a relay instead of losing the
     * response.
     */
    buffered?: Uint8Array,
  ): Promise<void> {
    const headers = upstream.headers;
    const isRedirect = upstream.status >= 300 && upstream.status < 400;
    rewriteResponseHeaders(headers, {
      codec,
      targetOrigin: target.origin,
      targetUrl: target.href,
      cookiePathPrefix: '/',
      proxyIsSecure: isSecure(request),
      bodyRewritten: false,
    });

    // A redirect must stay inside the mode it arrived in. `rewriteResponseHeaders`
    // rewrites a Location into the default proxy namespace, so an origin that
    // bounces `/` to `/en-US/` would move a capture out of `/proxy/archive/`
    // entirely: the follow-up request is then an ordinary proxied page with no
    // agent and no ledger, and the capture silently stops before it starts.
    // Re-pointing the Location restores the namespace the request asked for.
    if (capture && isRedirect) retargetLocation(headers, codec);

    if (buffered !== undefined) {
      headers.set('content-length', String(buffered.byteLength));
      response.writeHead(upstream.status, headersToObject(headers));
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      response.end(Buffer.from(buffered));
      return;
    }

    response.writeHead(upstream.status, headersToObject(headers));

    if (upstream.body === null || request.method === 'HEAD') {
      response.end();
      return;
    }
    await pipeNodeToNode(upstream.body, response);
  }

  /** Buffer, rewrite and return a textual response. */
  async #rewriting(
    upstream: Awaited<ReturnType<UpstreamClient['fetch']>>,
    target: URL,
    codec: CodecName,
    kind: RewriteKind,
    request: IncomingMessage,
    response: ServerResponse,
    attempt: RebaseAttempt | null,
    capture = false,
  ): Promise<void> {
    // A guess of "this path is a file on the target" is contradicted by markup
    // in reply. Nothing has been written yet, so the caller can still answer
    // 404 — and refusing here is what keeps the guess from turning into a
    // misattributed document.
    if (kind === 'html' && attempt !== null) {
      attempt.rejected = true;
      discard(upstream.body);
      return;
    }

    const limit = this.#config.proxy.maxRewriteBytes;

    // An origin is asked for `identity`, and most honour it — but not all, and
    // the ones that do not are not always honest about it. Two shapes occur:
    //
    //   1. the body is compressed and `content-encoding` says so;
    //   2. the body is compressed and `content-encoding` is **absent** — which
    //      is what `static03.galaxus.com` does, serving 300 KB of gzip labelled
    //      `text/javascript` with no encoding header at all.
    //
    // The second shape is why the header alone is not enough. Decoding those
    // bytes as text produces mojibake, and the rewriting path then strips
    // `content-encoding` (because the body it *meant* to send was uncompressed),
    // so the browser receives binary garbage labelled `application/javascript`.
    // That is the reported symptom: a script that is sometimes binary and
    // sometimes fine, depending on which edge node answered.
    //
    // So the bytes are checked as well as the header. A compressed body is
    // relayed untouched, exactly as the passthrough path already does. The cost
    // is that such a response is not rewritten — its URLs stay absolute — which
    // is the honest trade: a script that runs unrewritten is better than one
    // that does not parse at all.
    const encoding = (upstream.headers.get('content-encoding') ?? '').trim().toLowerCase();
    const declaredCompressed = encoding !== '' && encoding !== 'identity';
    if (declaredCompressed) {
      this.#logger.debug(
        { url: target.href, encoding, kind },
        'origin compressed a rewritable body; relaying it unrewritten',
      );
      await this.#passthrough(upstream, target, codec, request, response, capture);
      return;
    }

    let bytes: Uint8Array;
    try {
      bytes = await readAll(upstream.body, limit);
    } catch (error) {      if ((error as Error).message === 'BODY_TOO_LARGE') {
        // Over the rewrite budget: relay what was read unchanged rather than
        // failing the request outright. The bytes stop at the limit, so this is
        // a truncated response rather than a hung one, and the log says so.
        this.#logger.warn({ url: target.href, limit }, 'response exceeds rewrite budget; relaying truncated body');
        const headers = upstream.headers;
        rewriteResponseHeaders(headers, {
          codec,
          targetOrigin: target.origin,
          targetUrl: target.href,
          cookiePathPrefix: '/',
          proxyIsSecure: isSecure(request),
          bodyRewritten: false,
        });
        const partial = (error as Error & { partial?: Uint8Array }).partial ?? new Uint8Array();
        headers.set('content-length', String(partial.byteLength));
        headers.set('x-proxy-truncated', '1');
        response.writeHead(upstream.status, headersToObject(headers));
        response.end(Buffer.from(partial));
        return;
      }
      throw error;
    }

    // The header said nothing, but the bytes may still be compressed — see the
    // note above. Checked here rather than before the read because the signature
    // is in the body, and a body that is already in memory costs nothing to
    // inspect.
    const sniffed = sniffCompression(bytes);
    if (sniffed !== null) {
      this.#logger.debug(
        { url: target.href, sniffed, kind },
        'origin sent a compressed body with no content-encoding; relaying it unrewritten',
      );
      // The header is set so the browser decompresses what it is given. Without
      // it the bytes are delivered as-is and the script does not parse.
      upstream.headers.set('content-encoding', sniffed);
      upstream.headers.delete('content-length');
      await this.#passthrough(upstream, target, codec, request, response, capture, bytes);
      return;
    }

    // Charset handling: decode what we can recognise, default to UTF-8.
    const charset = charsetOf(upstream.headers.get('content-type')) ?? 'utf-8';
    let text: string;
    try {
      text = new TextDecoder(charset).decode(bytes);
    } catch {
      text = new TextDecoder('utf-8').decode(bytes);
    }

    const baseUrl = target.href;

    // A narrower veto, of the same kind as refusing markup. `<base href>` is
    // removed from rewritten documents so it cannot hijack the root-relative
    // links the rewriter emits, and the price is that those links — along with
    // the page's own root-relative ones — resolve against the *document's
    // directory* instead. On the live web that directory is the target's, so the
    // page works; under replay it is the archive's, so serving the page at an
    // unreachable URL would start pointing them at the wrong resources. Refusing
    // costs little, because a capture runs these same rewriters: a page that
    // needed this rebase was never captured with reachable links anyway.
    if (kind === 'html' && attempt !== null && declaresBaseHref(text)) {
      attempt.rejected = true;
      discard(upstream.body);
      return;
    }

    let rewritten: string;
    try {
      if (kind === 'html') {
        rewritten = rewriteHtml(text, {
          codec,
          baseUrl,
          injectShim: true,
          shimSource: RUNTIME_SHIM_SOURCE,
          // Only a capture asks for the agent and the ledger. A page being
          // browsed pays nothing for a feature it is not using.
          ...(capture
            ? {
                captureAgent: buildCaptureAgent(target.href, codec),
                shimConfig: { captureLedger: true },
              }
            : {}),
          cookiePathPrefix: '/',
          targetOrigin: target.origin,
          proxyOrigin: proxyOrigin(request),
        }).html;
      } else if (kind === 'css') {
        rewritten = rewriteCss(text, { codec, baseUrl });
      } else if (kind === 'manifest') {
        // A manifest is not part of the document, so nothing else can reach it:
        // the browser reads it and acts on the URLs itself. Its icon URLs are
        // normally absolute, and left alone they are fetched from the real
        // origin — from outside the proxy, in a page that is supposed to be
        // inside it.
        rewritten = rewriteManifest(text, { codec, baseUrl });
      } else {
        // JavaScript is the one body kind that resolves its own references
        // against *its own URL* rather than against the document, and a
        // code-split runtime derives that from a name that appears nowhere in
        // the source. Both halves are needed: the target path is what makes a
        // bare chunk name resolve somewhere sane, and `import.meta.url` is what
        // the runtime reads to form the name in the first place. Neither is
        // detectable from the source, which is why both are unconditional.
        rewritten = rewriteJs(text, {
          codec,
          baseUrl,
          directoryForm: true,
          rewriteImportMetaUrl: true,
          rewriteUrlLiterals: true,
          proxyOrigin: proxyOrigin(request),
        });
      }
    } catch (error) {
      this.#logger.error({ err: error, url: baseUrl, kind }, 'rewrite failed; returning original body');
      rewritten = text;
    }

    const out = Buffer.from(rewritten, 'utf8');

    const headers = upstream.headers;
    rewriteResponseHeaders(headers, {
      codec,
      targetOrigin: target.origin,
      targetUrl: target.href,
      cookiePathPrefix: '/',
      proxyIsSecure: isSecure(request),
      bodyRewritten: true,
    });
    headers.set('content-length', String(out.byteLength));

    response.writeHead(upstream.status, headersToObject(headers));
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    response.end(out);
  }

  #handleUpstreamError(error: unknown, target: URL, response: ServerResponse): void {
    if (error instanceof BlockedDestinationError) {
      this.#logger.warn({ url: target.href }, 'destination blocked by security policy');
      sendError(response, 403, 'Destination blocked');
      return;
    }
    const cause = error as { code?: string; message?: string };
    if (cause.code === 'UND_ERR_CONNECT_TIMEOUT' || cause.code === 'ABORT_ERR') {
      sendError(response, 504, 'Upstream timed out');
      return;
    }
    this.#logger.error({ err: error, url: target.href }, 'upstream request failed');
    sendError(response, 502, `Upstream request failed: ${cause.code ?? cause.message ?? 'unknown'}`);
  }
}

/**
 * Drop a response body the proxy has decided not to deliver.
 *
 * `destroy()` aborts the stream, which undici reports by emitting an error on
 * it; with no listener attached that error reaches the process as an unhandled
 * exception, long after the request that caused it. Listening turns a discarded
 * body into what it should be — nothing.
 */
function discard(stream: Readable | null): void {
  if (stream === null) return;
  stream.on('error', () => {
    /* expected: the body is being thrown away */
  });
  stream.destroy();
}

/**
 * Read an entire Node stream into memory, enforcing a byte ceiling.
 *
 * Uses async iteration rather than a web-stream reader because undici supplies
 * a Node `Readable`. On overflow the stream is destroyed and whatever was read
 * so far is attached to the error, so the caller can still relay a partial body
 * instead of returning nothing.
 */
async function readAll(stream: Readable | null, limit: number): Promise<Uint8Array> {
  if (stream === null) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for await (const chunk of stream) {
      const value = chunk as Uint8Array;
      total += value.byteLength;
      if (total > limit) {
        stream.destroy();
        const error = new Error('BODY_TOO_LARGE') as Error & { partial?: Uint8Array };
        error.partial = concat(chunks, total);
        throw error;
      }
      chunks.push(value);
    }
  } catch (error) {
    if ((error as Error).message === 'BODY_TOO_LARGE') throw error;
    // A transport failure mid-body still yields what arrived before it failed.
    const wrapped = new Error('BODY_READ_FAILED') as Error & { partial?: Uint8Array; cause?: unknown };
    wrapped.partial = concat(chunks, total);
    wrapped.cause = error;
    throw wrapped;
  }

  return concat(chunks, total);
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Relay a Node stream into a Node response with backpressure and cleanup. */
async function pipeNodeToNode(source: Readable, response: ServerResponse): Promise<void> {
  await new Promise<void>((resolve) => {
    source.on('error', () => {
      response.destroy();
      resolve();
    });
    response.on('close', () => {
      source.destroy();
      resolve();
    });
    source.pipe(response);
    source.on('end', resolve);
  });
}

/**
 * The compression a body is actually in, judged by its first bytes.
 *
 * Needed because an origin can compress a response and omit `content-encoding`
 * entirely — `static03.galaxus.com` serves 300 KB of gzip labelled
 * `text/javascript` with no encoding header. Trusting the header there means
 * decoding a gzip stream as text, which produces mojibake that no rewriter can
 * parse and that the browser cannot decompress either.
 *
 * **Only gzip and zlib-deflate are recognised, and that is deliberate.** Both
 * have a real signature: gzip starts `1f 8b`, and a zlib stream's two-byte
 * header is a multiple of 31 with a deflate method nibble. Brotli has no magic
 * number at all — its first byte is a window-size code, and the low nibble of
 * that byte is `0x0b` or `0x1b` for ordinary ASCII characters like `{`, `+`,
 * `;`, `K`, `[` and `k`. An earlier version of this function guessed at brotli
 * that way and mislabelled a JSON manifest as brotli, which the browser then
 * refused to decode (`ERR_CONTENT_DECODING_FAILED`).
 *
 * So brotli is not sniffed. A brotli body that arrives without a header is
 * relayed as-is and fails to parse, which is the same outcome as before this
 * function existed — but a *text* body is never mislabelled, and that is the
 * failure that actually broke a page.
 *
 * A body matching neither signature returns null and goes down the normal
 * rewriting path.
 */
function sniffCompression(bytes: Uint8Array): 'gzip' | 'deflate' | null {
  if (bytes.byteLength < 2) return null;

  // gzip: 1f 8b, then a deflate method byte of 08.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return 'gzip';

  // zlib-wrapped deflate: a CMF byte whose low nibble is 8 (deflate) and whose
  // two-byte header is a multiple of 31. Raw deflate has no header at all and is
  // deliberately not guessed at — it is indistinguishable from arbitrary bytes.
  const cmf = bytes[0] as number;
  const flg = bytes[1] as number;
  if ((cmf & 0x0f) === 0x08 && ((cmf << 8) | flg) % 31 === 0) return 'deflate';

  return null;
}

function charsetOf(contentType: string | null): string | null {
  if (contentType === null) return null;
  const match = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType);
  return match?.[1] ?? null;
}

/**
 * Whether this proxy is serving over TLS, so a rewritten cookie can be marked
 * `Secure`.
 *
 * `request.socket` is read defensively, and that is the whole point of this
 * function. Node nils it out when it destroys an `IncomingMessage` — see
 * `internal/streams/destroy.js`, which does `stream.socket = null` for a server
 * request — and a client that disconnects mid-request is destroyed exactly that
 * way. Every caller of this function reaches it *after* awaiting the upstream
 * response, so the disconnect has had a whole round trip in which to happen:
 * `request.socket` is null by the time a rewritten response is being built, and
 * an unguarded `.encrypted` on it is a `TypeError` for a request nobody is
 * waiting for.
 *
 * The distinction is deliberate rather than defensive noise. A socket that is
 * null means the client is gone, not that the connection was insecure, so
 * returning false is not a guess — the flag it feeds only matters if the
 * response is read, and it will not be.
 *
 * `?.` is not enough on its own: `request.socket` may be non-null with
 * `encrypted` absent, which is the ordinary HTTP case, and that must stay false
 * rather than becoming undefined.
 */
function isSecure(request: IncomingMessage): boolean {
  return (request.socket as { encrypted?: boolean } | null)?.encrypted === true;
}

/**
 * The origin this proxy is being reached at, as the browser sees it.
 *
 * Taken from the request's `Host` header rather than from configuration,
 * because the two differ whenever the proxy is reached by a name other than the
 * one it binds to — `localhost` versus `127.0.0.1` is the everyday case, and a
 * rewritten literal that names the wrong one is a cross-origin URL to the
 * browser, which is exactly what the rewrite exists to avoid.
 *
 * The scheme follows `isSecure`, so a proxy behind TLS emits `https:` URLs.
 */
function proxyOrigin(request: IncomingMessage): string {
  const host = request.headers.host;
  if (host === undefined || host === '') return 'http://localhost';
  return `${isSecure(request) ? 'https' : 'http'}://${host}`;
}

/** Convert a `Headers` instance into a plain object Node will accept. */
export function headersToObject(headers: Headers): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of headers.entries()) {
    if (name === 'set-cookie') continue;
    out[name] = value;
  }
  const cookies = readSetCookiesSafely(headers);
  if (cookies.length > 0) out['set-cookie'] = cookies;
  return out;
}

function readSetCookiesSafely(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetter.getSetCookie === 'function') return withGetter.getSetCookie();
  return [];
}

function sendError(response: ServerResponse, status: number, message: string): void {
  const body = JSON.stringify({ error: message, status });
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
  });
  response.end(body);
}
