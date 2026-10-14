import type { IncomingMessage, ServerResponse } from 'node:http';
import { isCodecName, type CodecName } from '../rewrite/codec.ts';

/**
 * Route matching.
 *
 * Routes are recognised by a leading path segment so a proxied target can never
 * shadow an application route, and so the encoding of a target URL (which is a
 * single opaque segment) can never be confused with the proxy's own structure.
 *
 * A payload may be followed by the target's own pathname. That does not blur
 * this grammar: the router cannot tell the two apart without decoding, and it
 * does not need to, because `routeTarget` does — see its two-stage doc for why
 * the choice is deterministic rather than a guess.
 */
export type Route =
  | { kind: 'proxy'; codec: CodecName; payload: string }
  | { kind: 'capturePage'; codec: CodecName; payload: string }
  | { kind: 'captureMalformed' }
  | { kind: 'archive'; archiveId: string; codec: CodecName; payload: string }
  | { kind: 'createArchive' }
  | { kind: 'listArchives' }
  | { kind: 'getArchive'; archiveId: string }
  | { kind: 'createCapture' }
  | { kind: 'capturePreflight' }
  | { kind: 'captureSnippet'; rawUrl: string }
  | { kind: 'captureRelay' }
  | { kind: 'singleFileUpload' }
  | { kind: 'singleFilePreflight' }
  | { kind: 'health' }
  | { kind: 'index' }
  | { kind: 'notFound' };

const PROXY_PREFIX = '/proxy/';
const ARCHIVE_PREFIX = '/archive/';
/**
 * A sub-namespace of `/proxy/`, so a page captured through the proxy is still a
 * proxy URL and every existing rewriter, cookie rule and relative-reference
 * behaviour applies unchanged. Only the injection differs.
 */
const CAPTURE_PREFIX = '/proxy/archive/';

export { PROXY_PREFIX, ARCHIVE_PREFIX, CAPTURE_PREFIX };

export function matchRoute(method: string, rawUrl: string, defaultCodec: CodecName): Route {
  const path = pathOnly(rawUrl);

  if (path === '/' || path === '') return method === 'GET' ? { kind: 'index' } : { kind: 'notFound' };
  if (path === '/health') return method === 'GET' ? { kind: 'health' } : { kind: 'notFound' };

  if (path === '/api/archives') {
    if (method === 'POST') return { kind: 'createArchive' };
    if (method === 'GET') return { kind: 'listArchives' };
    return { kind: 'notFound' };
  }

  if (path === '/api/captures') {
    // OPTIONS is answered rather than rejected even though the payload is sent
    // as a safelisted type. Mobile Safari and some extensions send a preflight
    // regardless, and a 405 there would break a capture for no gain.
    if (method === 'OPTIONS') return { kind: 'capturePreflight' };
    return method === 'POST' ? { kind: 'createCapture' } : { kind: 'notFound' };
  }

  if (path === '/api/singlefile') {
    // Both verbs are claimed here rather than in the proxy namespace, and the
    // preflight is answered instead of refused: the extension always sends an
    // `Authorization` header, which is not CORS-safelisted, so a cross-origin
    // upload *always* preflights. A 405 there would break every upload from a
    // browser for no gain.
    if (method === 'OPTIONS') return { kind: 'singleFilePreflight' };
    return method === 'POST' ? { kind: 'singleFileUpload' } : { kind: 'notFound' };
  }

  if (path === '/api/capture.js') {
    // The route carries the raw request target because the snippet is built from
    // its `?url=` parameter, and `matchRoute` strips the query to match a path.
    return method === 'GET' ? { kind: 'captureSnippet', rawUrl } : { kind: 'notFound' };
  }

  if (path === '/api/capture-relay.html') {
    // The page a capture is handed to when the originating site's own policy
    // forbids the upload. Served from here because a request from this origin to
    // this origin is the one no policy can block.
    return method === 'GET' ? { kind: 'captureRelay' } : { kind: 'notFound' };
  }

  const archiveMeta = /^\/api\/archives\/([^/]+)$/.exec(path);
  if (archiveMeta !== null && method === 'GET') {
    const archiveId = archiveMeta[1];
    if (archiveId !== undefined) return { kind: 'getArchive', archiveId: decodeURIComponent(archiveId) };
  }

  // Checked before the plain proxy prefix, which it is a sub-path of.
  //
  // The codec segment is required here, unlike `/proxy/`, and the difference is
  // not cosmetic: this route inserts a fixed segment before the payload, so a
  // hand-built `/proxy/archive/https://example.com/` would be ambiguous — the
  // router could not tell a missing codec from a target that begins with the
  // word "archive". Requiring the codec keeps the grammar unambiguous without
  // weakening the tolerant form `/proxy/` already accepts.
  if (path.startsWith(CAPTURE_PREFIX)) {
    const parsed = parseProxyTail(path.slice(CAPTURE_PREFIX.length), defaultCodec, true);
    if (parsed !== null) return { kind: 'capturePage', ...parsed };
    // Its own outcome rather than `notFound`: the request is refused *because*
    // the namespace is unambiguous, and a caller needs to be told that. Falling
    // through to `notFound` would hand it to the rebase fallback, which reads a
    // path like `/proxy/archive/https://example.com/` as a relative reference on
    // the referring page and serves something else entirely.
    return { kind: 'captureMalformed' };
  }

  if (path.startsWith(PROXY_PREFIX)) {
    const parsed = parseProxyTail(path.slice(PROXY_PREFIX.length), defaultCodec);
    if (parsed !== null) return { kind: 'proxy', ...parsed };
    return { kind: 'notFound' };
  }

  if (path.startsWith(ARCHIVE_PREFIX)) {
    const rest = path.slice(ARCHIVE_PREFIX.length);
    const slash = rest.indexOf('/');
    if (slash > 0) {
      const archiveId = decodeURIComponent(rest.slice(0, slash));
      const parsed = parseProxyTail(rest.slice(slash + 1), defaultCodec);
      if (parsed !== null) return { kind: 'archive', archiveId, ...parsed };
    }
    return { kind: 'notFound' };
  }

  return { kind: 'notFound' };
}

/**
 * Split `[codec/]payload` into its parts.
 *
 * The codec segment is optional and defaults to the configured one, so a plain
 * `/proxy/<url>` link works without the caller knowing about codecs. Anything
 * the codec does not claim stays in the payload, including further slashes —
 * only `routeTarget` can tell a target's path from the rest of a payload, and
 * only by decoding it.
 *
 * `requireCodec` is for the capture sub-namespace, where the payload is preceded
 * by a fixed segment and an absent codec would be indistinguishable from a
 * target whose URL happens to start with the same word.
 */
function parseProxyTail(
  tail: string,
  defaultCodec: CodecName,
  requireCodec = false,
): { codec: CodecName; payload: string } | null {
  if (tail === '') return null;

  const slash = tail.indexOf('/');
  if (slash > 0) {
    const maybeCodec = tail.slice(0, slash);
    if (isCodecName(maybeCodec)) {
      const payload = tail.slice(slash + 1);
      return payload === '' ? null : { codec: maybeCodec, payload };
    }
  }

  if (requireCodec) return null;
  return { codec: defaultCodec, payload: tail };
}

function pathOnly(rawUrl: string): string {
  const query = rawUrl.indexOf('?');
  const hash = rawUrl.indexOf('#');
  let end = rawUrl.length;
  if (query !== -1) end = Math.min(end, query);
  if (hash !== -1) end = Math.min(end, hash);
  return rawUrl.slice(0, end);
}

export function notFound(response: ServerResponse, message = 'Not found'): void {
  const body = JSON.stringify({ error: message });
  response.writeHead(404, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
  });
  response.end(body);
}

export function badRequest(response: ServerResponse, message = 'Bad request'): void {
  const body = JSON.stringify({ error: message });
  response.writeHead(400, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
  });
  response.end(body);
}

export function methodNotAllowed(response: ServerResponse, method: string, url: string): void {
  const body = JSON.stringify({ error: `Method ${method} not allowed for ${url}` });
  response.writeHead(405, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    allow: 'GET, POST',
  });
  response.end(body);
}

export type { IncomingMessage };
