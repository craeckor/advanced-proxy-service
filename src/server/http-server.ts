import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Config } from '../config.ts';
import type { Logger } from '../util/logger.ts';
import { ProxyHandler } from '../proxy/handler.ts';
import type { UpstreamClient } from '../proxy/upstream.ts';
import type { ArchiveStore } from '../archive/store.ts';
import { ArchiveReplay, COMPAT_COOKIE, type ReplayOptions } from '../archive/replay.ts';
import type { Crawler } from '../archive/crawler.ts';
import { matchRoute, notFound, methodNotAllowed, badRequest } from './router.ts';
import { resolveRebasedRequest, isProxyShapedPath } from './rebasing.ts';
import { routeTarget, appendRequestQuery, queryParameterValue, type CodecName } from '../rewrite/codec.ts';
import { parseCapture, type CaptureIngest } from '../archive/capture.ts';
import { RestFormError, type RestFormIngest } from '../archive/rest-form.ts';
import { captureSnippet, CAPTURE_RELAY_SOURCE } from '../rewrite/capture.ts';
import { GracefulShutdown } from './graceful-shutdown.ts';

/** How large an uploaded capture may be. */
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;

/**
 * The CORS headers the upload and snippet endpoints send.
 *
 * `*` is deliberate and is the reason the capture payload is `text/plain`. A
 * capture is posted from whatever page the user pasted the snippet into, which
 * is an origin this service cannot know in advance, and a wildcard for a
 * credentialless request is exactly what CORS allows.
 *
 * Nothing is authenticated by this, so the exposure is real and is bounded
 * instead: an upload can only *create* an archive from URLs the server can
 * reach, which is precisely what `POST /api/archives` already lets any caller
 * do. Deployments that expose the proxy publicly should treat these endpoints
 * the same way they treat archive creation — see the README.
 */
const CAPTURE_CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

/** Apply the capture CORS headers to a response that has not been written yet. */
function applyCaptureCors(response: ServerResponse): void {
  for (const [name, value] of Object.entries(CAPTURE_CORS_HEADERS)) {
    response.setHeader(name, value);
  }
}

/**
 * The preflight answer for the SingleFile endpoint.
 *
 * A separate set from the capture headers, and the difference is the whole
 * reason this endpoint has its own: `authorization` is not a CORS-safelisted
 * request header, so the extension's upload always preflights, and a preflight
 * that does not name it explicitly is refused by the browser before the upload
 * is ever attempted. `*` is not a substitute — browsers deliberately exclude
 * `Authorization` from a wildcard.
 *
 * `access-control-allow-origin: *` rather than the requesting origin, because
 * the request is not credentialed: the extension sends its token in a header and
 * no cookies, so a wildcard grants nothing a fixed origin would not.
 */
const SINGLEFILE_CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'authorization, accept, content-type',
  'access-control-max-age': '86400',
};

/** Apply the SingleFile CORS headers to a response that has not been written yet. */
function applySingleFileCors(response: ServerResponse): void {
  for (const [name, value] of Object.entries(SINGLEFILE_CORS_HEADERS)) {
    response.setHeader(name, value);
  }
}

export interface ServerDependencies {
  proxy: ProxyHandler;
  upstream: UpstreamClient;
  store: ArchiveStore;
  replay: ArchiveReplay;
  crawler: Crawler;
  capture: CaptureIngest;
  restForm: RestFormIngest;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

/**
 * Application HTTP server.
 *
 * Built directly on `node:http` rather than a framework because the whole point
 * of this service is control over raw request and response headers, and
 * frameworks abstract precisely that away.
 */
export class ProxyServer {
  readonly #config: Config;
  readonly #logger: Logger;
  readonly #deps: ServerDependencies;
  readonly #shutdown: GracefulShutdown;
  readonly #server;

  constructor(config: Config, logger: Logger, deps: ServerDependencies) {
    this.#config = config;
    this.#logger = logger;
    this.#deps = deps;

    this.#server = createServer((request, response) => {
      this.#dispatch(request, response).catch((error: unknown) => {
        this.#logger.error({ err: error }, 'unhandled request error');
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        }
        response.end(JSON.stringify({ error: 'Internal error' }));
      });
    });

    this.#server.keepAliveTimeout = config.server.keepAliveTimeoutMs;
    this.#server.headersTimeout = config.server.headersTimeoutMs;
    this.#server.requestTimeout = 0;

    this.#shutdown = new GracefulShutdown(this.#server, logger, config.server.shutdownGraceMs);
  }

  async listen(): Promise<RunningServer> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(this.#config.server.port, this.#config.server.host, () => {
        this.#server.off('error', reject);
        resolve();
      });
    });

    const address = this.#server.address();
    const port = typeof address === 'object' && address !== null ? address.port : this.#config.server.port;

    return {
      port,
      close: async () => {
        await this.#shutdown.shutdown();
        await this.#deps.upstream.close();
      },
    };
  }

  get isShuttingDown(): boolean {
    return this.#shutdown.isShuttingDown;
  }

  async #dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET';
    const url = request.url ?? '/';

    if (this.#shutdown.isShuttingDown) {
      // Readiness already failed; refuse new work so the orchestrator drains.
      response.writeHead(503, { connection: 'close', 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Server is shutting down' }));
      return;
    }

    const route = matchRoute(method, url, this.#config.proxy.defaultCodec);

    switch (route.kind) {
      case 'index':
        this.#sendIndex(response);
        return;

      case 'health':
        this.#sendJson(response, 200, { status: 'ok', uptime: process.uptime() });
        return;

      case 'proxy':
        await this.#serveProxy(route.codec, route.payload, request, response, url);
        return;

      case 'capturePage':
        await this.#serveCapturePage(route.codec, route.payload, request, response, url);
        return;

      case 'captureMalformed':
        badRequest(response, 'Malformed capture target');
        return;

      case 'createCapture':
        await this.#createCapture(request, response);
        return;

      case 'capturePreflight': {
        applyCaptureCors(response);
        response.writeHead(204, { 'content-length': '0' });
        response.end();
        return;
      }

      case 'captureSnippet':
        this.#sendCaptureSnippet(request, response, route.rawUrl);
        return;

      case 'captureRelay':
        this.#sendCaptureRelay(response);
        return;

      case 'singleFilePreflight': {
        applySingleFileCors(response);
        response.writeHead(204, { 'content-length': '0' });
        response.end();
        return;
      }

      case 'singleFileUpload':
        await this.#receiveSingleFile(request, response);
        return;

      case 'archive':
        await this.#deps.replay.serve(
          route.archiveId,
          stripCompatAnswer(
            appendRequestQuery(decodePayload(route.codec, route.payload), url),
          ),
          route.codec,
          response,
          request.headers['sec-fetch-dest'],
          replayOptions(request, route.archiveId, url),
        );
        return;

      case 'createArchive':
        await this.#createArchive(request, response);
        return;

      case 'listArchives':
        this.#sendJson(response, 200, { archives: this.#deps.store.listArchives() });
        return;

      case 'getArchive': {
        const meta = this.#deps.store.getArchive(route.archiveId);
        if (meta === null) {
          notFound(response, 'Archive not found');
          return;
        }
        // `resources` stays the *count* here, exactly as it is in the list, so
        // one archive is described by the same field names in both responses.
        // The richer per-resource listing therefore needs a name of its own:
        // `entries`, which is what these are — rows of the archive's index.
        //
        // `urls` is kept as well, because it is the pre-existing shape and is a
        // projection of `entries` in the same order, so a caller joining the two
        // by index cannot mis-attribute a size.
        const entries = this.#deps.store.resources(route.archiveId);
        this.#sendJson(response, 200, {
          ...meta,
          urls: entries.map((entry) => entry.url),
          entries,
        });
        return;
      }

      case 'notFound':
      default:
        if (route.kind === 'notFound' && (method !== 'GET' && method !== 'POST')) {
          methodNotAllowed(response, method, url);
          return;
        }
        if (route.kind === 'notFound') {
          if (this.#config.proxy.resolveUnknownPaths && (await this.#tryRebase(request, response, url))) {
            return;
          }
          // A path in the proxy's own namespace carried a payload that failed to
          // decode, which is a malformed request rather than a missing resource.
          if (isProxyShapedPath(url)) {
            badRequest(response, 'Malformed proxy target');
            return;
          }
        }
        notFound(response);
    }
  }

  /**
   * Serve a page that is being archived through the browser.
   *
   * Identical to a normal proxied page except that the shim keeps a URL ledger
   * and the capture agent is injected. The rebase fallback is deliberately not
   * offered here: a capture is a deliberate act on a known URL, and silently
   * attributing a stray request to a guessed origin would put resources in the
   * archive that the page never actually loaded.
   */
  async #serveCapturePage(
    codec: CodecName,
    payload: string,
    request: IncomingMessage,
    response: ServerResponse,
    url: string,
  ): Promise<void> {
    if (routeTarget(codec, payload) === null) {
      badRequest(response, 'Malformed capture target');
      return;
    }
    await this.#deps.proxy.handleCapture(codec, payload, request, response);
    void url;
  }

  /**
   * Accept an uploaded capture.
   *
   * The body arrives as `text/plain` on purpose — see the CORS note in the
   * README — so it is read as text and parsed as JSON rather than trusted to
   * have a JSON content type.
   */
  async #createCapture(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // A capture can be posted from a page on any origin — that is the whole
    // point of the console snippet — so the upload endpoints are the one place
    // this service is deliberately reachable cross-origin. See the README: the
    // content type is `text/plain` precisely so this stays a simple request.
    applyCaptureCors(response);

    let body: string;
    try {
      body = await readBody(request, MAX_CAPTURE_BYTES);
    } catch {
      this.#sendJson(response, 413, { error: 'Capture payload too large' });
      return;
    }

    const payload = parseCapture(body);
    if (payload === null) {
      this.#sendJson(response, 400, { error: 'Invalid capture payload' });
      return;
    }

    this.#logger.info(
      { target: payload.targetUrl, urls: payload.urls?.length ?? 0 },
      'ingesting browser capture',
    );

    try {
      const result = await this.#deps.capture.ingest(payload, request.headers);
      this.#sendJson(response, 201, {
        archiveId: result.archiveId,
        pages: result.pages,
        stored: result.resources,
        bytes: result.bytes,
        failed: result.failed.length,
        replay: `/archive/${result.archiveId}/plain/${encodeURIComponent(payload.targetUrl)}`,
      });
    } catch (error) {
      this.#logger.error({ err: error, target: payload.targetUrl }, 'capture ingest failed');
      this.#sendJson(response, 500, { error: 'Capture failed' });
    }
  }

  /**
   * Receive a page saved by the SingleFile extension.
   *
   * The one endpoint here that is not reached by a browser following this
   * service's own links: the caller is the extension's background page, on a
   * `chrome-extension://` origin, posting a page the user explicitly chose to
   * save. That shapes three decisions.
   *
   * It answers CORS, because the origin really is foreign and the extension's
   * token header forces a preflight.
   *
   * It surfaces failures as **plain text with the real status**, because the
   * client shows a non-2xx body verbatim in its popup, prefixed with
   * `(RestFormApi)`. A JSON error body would reach the reader as escaped JSON;
   * a `204` would be reported as a failure with an empty message, because the
   * client only accepts 200/201/202 *with* a JSON body as success.
   *
   * It authenticates, when configured to. The token is the only credential the
   * extension can send — the scheme is hardcoded to `Bearer` client-side — and
   * an empty configured token accepts anything, so a deployment that exposes
   * this service must set `archive.restFormToken`.
   */
  async #receiveSingleFile(request: IncomingMessage, response: ServerResponse): Promise<void> {
    applySingleFileCors(response);

    const expected = this.#config.archive.restFormToken;
    if (expected !== '' && !tokenMatches(request.headers.authorization, expected)) {
      // Deliberately the same message whether the token was absent or wrong:
      // the reader fixes it the same way, and distinguishing them tells an
      // unauthenticated caller which of the two it got.
      sendPlain(response, 401, 'invalid or missing token');
      return;
    }

    let body: Buffer;
    try {
      body = await readBinaryBody(request, this.#config.archive.restFormMaxBytes);
    } catch {
      sendPlain(response, 413, 'archive too large');
      return;
    }

    try {
      const result = await this.#deps.restForm.ingest(body, request.headers['content-type']);
      this.#logger.info(
        { archiveId: result.archiveId, sourceUrl: result.sourceUrl, bytes: result.size },
        'singlefile upload accepted',
      );
      // 201 and a JSON body: the client treats 200, 201 and 202 as success and
      // requires the body to parse as JSON. `url` is the permalink it writes
      // into a bookmark when "replace bookmark URL" is on, so it is the replay
      // URL rather than a mirror of the request.
      this.#sendJson(response, 201, {
        url: replayUrlFor(request, result.archiveId, result.sourceUrl),
        archiveId: result.archiveId,
        sourceUrl: result.sourceUrl,
        filename: result.filename,
        contentType: result.contentType,
        size: result.size,
      });
    } catch (error) {
      if (error instanceof RestFormError) {
        sendPlain(response, error.status, error.message);
        return;
      }
      this.#logger.error({ err: error }, 'singlefile upload failed');
      sendPlain(response, 500, 'archive failed');
    }
  }

  /**
   * Serve the relay page.
   *
   * Deliberately given no `Content-Security-Policy` of its own: its entire
   * purpose is to be a document on this origin that is permitted to talk to this
   * origin, for a page whose own policy forbade the upload.
   */
  #sendCaptureRelay(response: ServerResponse): void {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(Buffer.byteLength(CAPTURE_RELAY_SOURCE)),
      'cache-control': 'no-store',
      ...CAPTURE_CORS_HEADERS,
    });
    response.end(CAPTURE_RELAY_SOURCE);
  }

  /**
   * Hand out the console snippet.
   *
   * Generated rather than static so it carries this deployment's origin and the
   * URL being captured, which is what lets the same agent serve both transports.
   */
  #sendCaptureSnippet(request: IncomingMessage, response: ServerResponse, url: string): void {
    const target = queryParameterValue(url, 'url');

    if (target === null || target === '') {
      this.#sendJson(response, 400, {
        error: 'Query parameter "url" is required',
        example: '/api/capture.js?url=https%3A%2F%2Fexample.com%2F',
      });
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(target);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('scheme');
    } catch {
      this.#sendJson(response, 400, { error: 'Query parameter "url" must be an absolute http(s) URL' });
      return;
    }

    const origin = `http://${request.headers.host ?? `${this.#config.server.host}:${this.#config.server.port}`}`;
    const snippet = captureSnippet({
      origin,
      targetUrl: parsed.href,
      codec: this.#config.proxy.defaultCodec,
    });

    response.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'content-length': String(Buffer.byteLength(snippet)),
      'cache-control': 'no-store',
      // So the snippet can be fetched with `curl | clip` and, more usefully, so
      // a page can load it directly if a user prefers that to pasting.
      ...CAPTURE_CORS_HEADERS,
    });
    response.end(snippet);
  }
  /**
   * Serve a `/proxy/...` request, giving the referring-page fallback a chance at
   * payloads that do not decode.
   *
   * The router claims every `/proxy/...` path, because the payload is opaque to
   * it. Some of those paths are not proxy URLs at all: a browser that resolved a
   * relative reference against the proxy origin produces the same shape, and the
   * payload is then a target-relative path rather than an encoded URL. The
   * fallback recognises and repairs exactly those; anything else stays the bad
   * request it always was.
   */
  async #serveProxy(
    codec: CodecName,
    payload: string,
    request: IncomingMessage,
    response: ServerResponse,
    url: string,
  ): Promise<void> {
    if (
      routeTarget(codec, payload) === null &&
      this.#config.proxy.resolveUnknownPaths &&
      (await this.#tryRebase(request, response, url))
    ) {
      return;
    }
    await this.#deps.proxy.handle(codec, payload, request, response);
  }

  /**
   * Re-issue a prefixless request against the site it belong to.
   *
   * Returns false when the request is not attributable, when the guessed origin
   * refuses the guess, or when the guess fails at the transport. In every one of
   * those cases the caller falls through to the ordinary 404, so this only ever
   * converts a 404 into a success — it cannot make a previously working request
   * start failing.
   */
  async #tryRebase(
    request: IncomingMessage,
    response: ServerResponse,
    url: string,
  ): Promise<boolean> {
    const rebased = resolveRebasedRequest(request, this.#config.proxy.defaultCodec);
    if (rebased === null) return false;

    // A replay referer means the resource belongs to that archive: serve it from
    // there rather than from the network, so a repair can never turn a missing
    // capture into current content fetched from the live origin.
    //
    // This always reports the request as handled, including on a miss. Replay
    // writes a complete response either way — the resource, or its own miss
    // placeholder, which says more than the bare 404 the caller would send. A
    // `false` here would have the caller write a second response over the first,
    // which is an error rather than a nicer status.
    if (rebased.archiveId !== undefined) {
      await this.#deps.replay.serve(
        rebased.archiveId,
        rebased.target.href,
        this.#config.proxy.defaultCodec,
        response,
      );
      return true;
    }
    const outcome = await this.#deps.proxy.handleRebased(rebased.target, request, response);
    if (outcome !== 'rejected-guess') return true;

    this.#logger.debug(
      { url, target: rebased.target.href },
      'rebase produced a document; treating as not found',
    );
    return false;
  }

  /** Kick off a crawl. Returns immediately with the archive id. */
  async #createArchive(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let payload: unknown;
    try {
      payload = JSON.parse(await readBody(request, 1024 * 1024));
    } catch {
      this.#sendJson(response, 400, { error: 'Invalid JSON body' });
      return;
    }

    const seedUrl = (payload as { url?: unknown })?.url;
    if (typeof seedUrl !== 'string') {
      this.#sendJson(response, 400, { error: 'Field "url" is required' });
      return;
    }
    try {
      const parsed = new URL(seedUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('unsupported protocol');
      }
    } catch {
      this.#sendJson(response, 400, { error: 'Field "url" must be an absolute http(s) URL' });
      return;
    }

    const options = {
      seedUrl,
      ...(typeof (payload as { maxDepth?: unknown }).maxDepth === 'number'
        ? { maxDepth: (payload as { maxDepth: number }).maxDepth }
        : {}),
      ...(typeof (payload as { maxPages?: unknown }).maxPages === 'number'
        ? { maxPages: (payload as { maxPages: number }).maxPages }
        : {}),
    };

    this.#logger.info({ seedUrl }, 'starting archive crawl');

    this.#deps.crawler
      .crawl(options)
      .then((result) => {
        this.#logger.info({ archiveId: result.archiveId, pages: result.pages }, 'archive finished');
      })
      .catch((error: unknown) => {
        this.#logger.error({ err: error, seedUrl }, 'archive crawl failed');
      });

    this.#sendJson(response, 202, {
      status: 'started',
      seedUrl,
      hint: 'Poll GET /api/archives for progress, then replay at /archive/<id>/<codec>/<url>',
    });
  }

  /**
   * The route catalogue.
   *
   * Generated rather than written down separately, so it cannot drift from
   * `matchRoute`. Every entry is something the router will actually claim, and
   * anything absent here is a 404 — which makes this page the answer to "is this
   * service supposed to have that endpoint?".
   */
  #sendIndex(response: ServerResponse): void {
    this.#sendJson(response, 200, {
      name: 'advanced-proxy-service',
      codecs: ['plain', 'b64'],
      routes: [
        {
          method: 'GET',
          path: '/',
          summary: 'This catalogue: every route the service claims, the codecs, and the active posture.',
        },
        {
          method: 'GET',
          path: '/health',
          summary: 'Liveness probe. Reports status and process uptime.',
        },
        {
          method: 'GET',
          path: '/proxy/[codec/]<encoded-url>',
          summary:
            'Browse a site through the proxy. The client User-Agent and request headers are mirrored upstream, and CSP, X-Frame-Options and HSTS are stripped from the response so the page runs here. Response bodies are rewritten: HTML, CSS, JS, JSON and web app manifests, so links, assets and fetch targets stay inside the proxy.',
          example: '/proxy/plain/https%3A%2F%2Fexample.com%2F',
        },
        {
          method: 'GET',
          path: '/archive/<id>/[codec/]<encoded-url>',
          summary:
            'Replay a captured resource from an archive, rewritten to link within the archive itself. Never reaches the network: a resource the archive does not hold is an explicit miss (404 with x-archive-miss), not a live fetch. Responses carry x-archive-id and x-archive-date. When compatibility mode is on, a URL that differs from a captured one only at the end of its query answers with a chooser offering that near match, and an accepted substitution is labelled x-archive-compat: substitute. A page that navigates to its own URL with something appended — a retry marker, typically — is answered with the page it was already on, labelled x-archive-self-navigation: 1.',
          example: '/archive/<id>/plain/https%3A%2F%2Fexample.com%2F',
        },
        {
          method: 'GET',
          path: '/proxy/archive/<codec>/<encoded-url>',
          summary:
            'Open a page with the capture agent injected, to archive what the browser rendered rather than what the server served. The codec is required here, because a fixed segment precedes the payload. When the page finishes loading it uploads its DOM plus every URL it requested, and reports the replay URL back.',
          example: '/proxy/archive/plain/https%3A%2F%2Fexample.com%2F',
        },
        {
          method: 'GET',
          path: '/api/capture.js?url=<encoded-url>',
          summary:
            'The browser-assisted capture as a console snippet, generated for this deployment origin and that target. Paste it into a console on any page — including one this service never touched — and it uploads the page. Served as JavaScript with CORS, so it can also be loaded directly.',
          example: '/api/capture.js?url=https%3A%2F%2Fexample.com%2F',
        },
        {
          method: 'GET',
          path: '/api/capture-relay.html',
          summary:
            'Relay page for a capture whose upload was blocked by the originating site\'s own connect-src. It is a document on this origin talking to this origin, which is the one request no policy of the other site restricts. Deliberately served with no policy of its own.',
        },
        {
          method: 'POST',
          path: '/api/captures',
          summary:
            'Accept an uploaded capture: the rendered HTML plus the ledger of URLs the page requested. The server fetches whatever the browser could not read itself (an opaque cross-origin body, say), so the archive still holds real bytes. The body is sent as text/plain so the request stays simple and needs no preflight.',
        },
        {
          method: 'OPTIONS',
          path: '/api/captures',
          summary:
            'CORS preflight for the upload. Answered rather than rejected, because some browsers send one regardless of the safelisted content type.',
        },
        {
          method: 'POST',
          path: '/api/archives',
          summary:
            'Start a server-side crawl. Returns 202 immediately with the seed URL; the crawl continues in the background. Optional maxDepth and maxPages override the configured defaults.',
          body: { url: 'https://example.com/', maxDepth: 3, maxPages: 200 },
          example: 'curl -X POST localhost:8080/api/archives -H "content-type: application/json" -d "{\\"url\\":\\"https://example.com\\"}"',
        },
        {
          method: 'GET',
          path: '/api/archives',
          summary:
            'List archives, newest first, with status, page count, resource count and total size in bytes. Poll this after starting a crawl.',
        },
        {
          method: 'GET',
          path: '/api/archives/<id>',
          summary:
            'One archive\'s detail: the same fields as the list, plus `urls` (every captured URL) and `entries` (the same URLs in the same order, each with its size, status, media type and capture time). The per-entry sizes sum to this archive\'s `bytes`.',
        },
        {
          method: 'POST',
          path: '/api/singlefile',
          summary:
            'Accept a page saved by the SingleFile browser extension\'s "upload to a REST Form API" destination. The body is multipart/form-data: the saved page as a file part, and the URL it was saved from as a part with no filename. Field names are the client\'s own options, so the file is identified by having a filename rather than by being called anything in particular. HTML and self-extracting archives are stored as text/html; a ZIP is detected by its magic bytes and stored as application/zip, because the client labels ZIP uploads application/octet-stream. Answers 201 with JSON carrying url, the replay permalink the extension writes into a bookmark. Setting archive.restFormToken requires a matching Bearer token.',
          example: 'curl -X POST localhost:8080/api/singlefile -H "authorization: Bearer $TOKEN" -F "archive=@page.html" -F "url=https://example.com/page"',
        },
        {
          method: 'OPTIONS',
          path: '/api/singlefile',
          summary:
            'CORS preflight for the SingleFile upload. Always taken, because the extension sends an Authorization header and that is not CORS-safelisted; the answer names it explicitly, since a wildcard does not cover it. Access-Control-Allow-Origin is *, which is safe here because the request carries no credentials.',
        },
      ],
      configuration: {
        resolveUnknownPaths: this.#config.proxy.resolveUnknownPaths,
        note: this.#config.proxy.resolveUnknownPaths
          ? 'A request that names no target is rebased onto the site behind its Referer, when the path and browser metadata say it is a subresource. It can only turn a 404 into a response.'
          : 'The referring-page rebase is disabled, so a request that names no target is always a 404.',
        compatMode: this.#config.archive.compatMode,
        compatNote: this.#config.archive.compatMode
          ? 'A replay of an uncaptured URL whose query differs from a captured one only at the end answers with a chooser offering that near match. Nothing is substituted without the reader accepting, and an accepted substitution is labelled x-archive-compat: substitute.'
          : 'An uncaptured URL is a miss (404), even when the archive holds a near match differing only at the end of its query.',
      },
      security: {
        enabled: this.#config.security.enabled,
        note: this.#config.security.enabled
          ? 'SSRF and DNS-rebinding defences are active.'
          : 'Open proxy: SSRF and DNS-rebinding defences are DISABLED. This service will fetch any URL it is given, including internal addresses.',
      },
    });
  }

  #sendJson(response: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload, null, 2);
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
    });
    response.end(body);
  }
}

/** Decode the payload segment for archive replay.
 *
 * This is `routeTarget`, not a plain decode, because an archive URL has the same
 * grammar as a proxy URL — *and the same failure mode*. A relative module
 * reference inside an archived bundle reaches play as
 * `<payload:…/chunk.js>/assets/chunk.js`: the browser resolved `./chunk.js`
 * against the proxied module URL and appended the target path again. Decoding the
 * whole tail as one payload yields `…/chunk.js/assets/chunk.js`, which names
 * nothing and 404s, so a single-file archive of a real bundle appears to be
 * missing its own modules. `routeTarget` recognises the two-part shape and
 * collapses it to the resource that is actually stored.
 *
 * The live proxy has always routed through `routeTarget`; replay used to decode
 * the payload itself and so diverged from it. Sharing the function is the point:
 * the two paths encode the same targets and must decode them identically.
 */
function decodePayload(codec: CodecName, payload: string): string {
  return routeTarget(codec, payload) ?? payload;
}

/**
 * Gather what compatibility mode needs from a replay request.
 *
 * Two signals, both from the request itself rather than from configuration:
 *
 *  - `Sec-Fetch-Dest` says whether the browser wants a document. Only a
 *    navigation may be substituted; a missing subresource is a real gap and
 *    deserves a real miss.
 *  - The answer says whether the reader already decided — from the request line
 *    when they just clicked, or from the cookie when they decided earlier. A
 *    *declined* answer has to be distinguishable from no answer, because one
 *    should skip the chooser and the other should show it.
 */
function replayOptions(request: IncomingMessage, archiveId: string, rawUrl: string): ReplayOptions {
  const referer = request.headers.referer;
  return {
    isNavigation: request.headers['sec-fetch-dest'] === 'document',
    compatAnswer: compatAnswerFrom(rawUrl) ?? readCompatAnswer(request, archiveId),
    referer: typeof referer === 'string' ? referer : undefined,
    // The referrer is decoded with the codec *it* was written in, which is not
    // necessarily the one this request uses.
    refererCodec: typeof referer === 'string' ? refererCodecOf(referer) : undefined,
  };
}

/** The codec a replay URL was written in, or undefined when it is not one. */
function refererCodecOf(referer: string): CodecName | undefined {
  let parsed: URL;
  try {
    parsed = new URL(referer);
  } catch {
    return undefined;
  }
  const route = matchRoute('GET', parsed.pathname + parsed.search, 'plain');
  return route.kind === 'archive' || route.kind === 'proxy' ? route.codec : undefined;
}
/** The recorded answer for this archive, or null when the reader was never asked. */
function readCompatAnswer(request: IncomingMessage, archiveId: string): 'on' | 'off' | null {
  const raw = request.headers.cookie;
  if (raw === undefined) return null;

  // Scanned rather than parsed: a cookie header is a `;`-separated list and the
  // only value needed is one flag, so a full parser would be more code for the
  // same answer. The name is compared exactly, so `apx_compat_other` is not a hit.
  for (const part of raw.split(';')) {
    const equals = part.indexOf('=');
    if (equals === -1) continue;
    if (part.slice(0, equals).trim() !== COMPAT_COOKIE) continue;
    const value = part.slice(equals + 1).trim();
    if (value === 'on' || value === 'off') return value;
  }
  return null;
}

/**
 * The reader's answer, read straight from the request line.
 *
 * Matched with a regex rather than `queryParameterValue`, because the archive URL
 * grammar puts everything after the codec into an opaque payload, so the chooser's
 * parameter is appended with `&` and there may be no `?` in the request line at
 * all. A `queryParameterValue` call would find nothing to scan.
 *
 * Reading it cannot misfire on a proxied target's own parameter: the payload is
 * percent-encoded, so a `__compat` inside it arrives as `%26__compat%3D`, which
 * this pattern does not match.
 */
export function compatAnswerFrom(rawUrl: string): 'on' | 'off' | null {
  const match = /[?&]__compat=(on|off)(?:&|#|$)/.exec(rawUrl);
  return match?.[1] === 'on' || match?.[1] === 'off' ? match[1] : null;
}

const COMPAT_PARAM = '__compat';

/**
 * Remove the compatibility answer's own parameter from a replay target.
 *
 * The chooser's links carry `__compat=on` so the answer arrives as a plain GET,
 * which means the parameter travels in the request line and `appendRequestQuery`
 * would otherwise attach it to the *target* — turning `…&udm=50` into
 * `…&udm=50&__compat=on` and guaranteeing that the URL being looked up is not the
 * captured one, which is the exact problem the mode exists to solve. It is read
 * separately, so it is removed here rather than forwarded.
 */
function stripCompatAnswer(target: string): string {
  // A `?` left with nothing after it names a different URL than none at all.
  return target.replace(new RegExp(`[?&]${COMPAT_PARAM}=[^&#]*`, 'g'), '');
}

async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > limit) throw new Error('body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Read a request body as bytes, stopping at `limit`.
 *
 * Separate from `readBody` rather than a flag on it because the two callers want
 * opposite failure behaviour. A JSON request that is too large is a client
 * error worth naming; an upload that is too large has already been streamed
 * past the point where the body could be recovered, so the caller answers 413
 * and the connection is closed. Neither wants the other's semantics.
 *
 * Bytes rather than text because this body is a page, possibly a ZIP: decoding
 * it as UTF-8 to re-encode it would corrupt every byte above U+007F in an
 * archive and silently change the stored hash.
 */
async function readBinaryBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of request) {
      const buffer = chunk as Buffer;
      total += buffer.byteLength;
      if (total > limit) {
        request.destroy();
        throw new Error('body too large');
      }
      chunks.push(buffer);
    }
  } catch (error) {
    // A client that disconnected mid-upload is a cancellation, not a failure to
    // report: the extension's own cancel button aborts the fetch, so this is the
    // expected path for a user who changed their mind.
    if (request.destroyed) throw new Error('upload aborted');
    throw error;
  }
  return Buffer.concat(chunks);
}

/**
 * Compare a client's `Authorization` header against the configured token.
 *
 * The scheme is matched case-insensitively, because it is a token rather than a
 * credential and RFC 7235 says so — but the token itself is compared exactly,
 * and compared without an early exit. The extension cannot send `Basic` or an
 * API-key header at all, so `Bearer` is the only shape to accept.
 */
function tokenMatches(header: string | undefined, expected: string): boolean {
  if (header === undefined) return false;
  const match = /^\s*bearer\s+(.*)$/i.exec(header);
  const presented = match?.[1];
  if (presented === undefined) return false;

  // Length-checked first so the comparison below never indexes past the shorter
  // string, then folded over the whole length to keep the timing flat.
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/**
 * The replay URL to hand back as the upload's permalink.
 *
 * Built from the request's own `Host` rather than from configuration, matching
 * how the console snippet is generated: behind a TLS terminator this process
 * never observes the scheme, and the host the extension reached is by
 * definition the host it can reach again.
 */
function replayUrlFor(request: IncomingMessage, archiveId: string, sourceUrl: string): string {
  const host = request.headers.host ?? 'localhost';
  const target = sourceUrl === '' ? '/' : sourceUrl;
  return `http://${host}/archive/${archiveId}/plain/${encodeURIComponent(target)}`;
}

/** A refusal the SingleFile extension will show verbatim, so keep it short. */
function sendPlain(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  const body = Buffer.from(message, 'utf8');
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(body.byteLength),
    ...SINGLEFILE_CORS_HEADERS,
  });
  response.end(body);
}
