import { proxyPathFor, type CodecName } from '../../rewrite/codec.ts';
import { stripHopByHop } from './hop-by-hop.ts';
import { rewriteSetCookie, cookieNamespaceFor } from '../cookies/rewrite.ts';

/**
 * Response headers that must be removed for a proxied page to work at the
 * proxy's origin.
 *
 * These are stripped rather than rewritten because their values are inherently
 * tied to the original origin: CSP nonces and hashes are invalidated by any
 * rewrite, and the frame/embedding policies exist precisely to stop the page
 * being framed by another origin — which is what proxying does.
 */
const STRIPPED_RESPONSE_HEADERS: readonly string[] = [
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'strict-transport-security',
  'origin-agent-cluster',
];

/**
 * Headers whose value is a URL that must be routed back through the proxy, or
 * the browser will navigate straight off-proxy.
 */
const REWRITTEN_URL_HEADERS: readonly string[] = ['location', 'content-location', 'refresh'];

export interface ResponseRewriteOptions {
  codec: CodecName;
  /** Origin of the target site, used to namespace cookies. */
  targetOrigin: string;
  /**
   * The absolute URL the response came from.
   *
   * Required because `Location` is very often a *relative* reference such as
   * `/login`, and a relative value cannot be resolved without knowing the
   * request URL. Leaving it unresolved would send the browser to a path on the
   * proxy's own origin.
   */
  targetUrl: string;
  /** Path prefix proxied cookies are scoped under. */
  cookiePathPrefix: string;
  /** Whether the proxy is being served over HTTPS. */
  proxyIsSecure: boolean;
  /** True when the body is being rewritten, so `content-length` is stale. */
  bodyRewritten: boolean;
}

/**
 * Rewrite origin response headers in place so the response is coherent when
 * delivered from the proxy's own origin.
 */
export function rewriteResponseHeaders(headers: Headers, options: ResponseRewriteOptions): void {
  stripHopByHop(headers);

  for (const name of STRIPPED_RESPONSE_HEADERS) headers.delete(name);

  for (const name of REWRITTEN_URL_HEADERS) {
    const value = headers.get(name);
    if (value === null) continue;
    const rewritten = rewriteUrlHeader(name, value, options);
    if (rewritten !== null) headers.set(name, rewritten);
  }

  const setCookies = readSetCookies(headers);
  if (setCookies.length > 0) {
    headers.delete('set-cookie');
    const namespace = cookieNamespaceFor(options.targetOrigin);
    for (const raw of setCookies) {
      const rewritten = rewriteSetCookie(raw, {
        pathPrefix: options.cookiePathPrefix,
        namespace,
        proxyIsSecure: options.proxyIsSecure,
      });
      if (rewritten !== null) headers.append('set-cookie', rewritten);
    }
  }

  // The body changes size whenever anything in it is rewritten, so a stale
  // Content-Length would truncate or hang the response.
  if (options.bodyRewritten) {
    headers.delete('content-length');
    headers.delete('content-encoding');
    headers.delete('etag');
  }
}

function rewriteUrlHeader(name: string, value: string, options: ResponseRewriteOptions): string | null {
  if (name === 'refresh') {
    // Format: "<delay>[; url=<target>]"
    const match = /^(\s*[\d.]+\s*;\s*url\s*=\s*)(.*)$/i.exec(value);
    if (!match) return null;
    const prefix = match[1] ?? '';
    const target = (match[2] ?? '').trim().replace(/^['"]|['"]$/g, '');
    const resolved = resolveAgainst(target, options.targetUrl);
    return resolved === null ? null : `${prefix}${proxyPathFor(options.codec, resolved)}`;
  }

  const resolved = resolveAgainst(value, options.targetUrl);
  return resolved === null ? null : proxyPathFor(options.codec, resolved);
}

/**
 * Resolve a possibly-relative reference against the response's own URL.
 *
 * Redirects frequently use bare paths, so resolving against the target is what
 * keeps the user on the proxy instead of bouncing them to a path on the proxy
 * origin itself.
 */
function resolveAgainst(value: string, baseUrl: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  try {
    const url = new URL(trimmed, baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Read all `Set-Cookie` values. Node's undici exposes `getSetCookie()`; the
 * fallback splits manually for header containers that do not.
 */
export function readSetCookies(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetter.getSetCookie === 'function') {
    return withGetter.getSetCookie();
  }
  const raw = headers.get('set-cookie');
  if (raw === null) return [];
  return splitSetCookieHeader(raw);
}

/**
 * Split a combined `Set-Cookie` header into individual cookies.
 *
 * A comma inside `Expires` (the only place a comma legally appears in a cookie)
 * must not be treated as a separator, so candidates are rejoined when they do
 * not look like the start of a new cookie.
 */
export function splitSetCookieHeader(raw: string): string[] {
  const parts = raw.split(',');
  const out: string[] = [];

  for (const part of parts) {
    const startsNew = /^\s*[^=;,]+=/.test(part) && !/^\s*(?:expires|max-age|path|domain|samesite|secure|httponly)/i.test(part);
    if (startsNew || out.length === 0) {
      out.push(part);
    } else {
      out[out.length - 1] += `,${part}`;
    }
  }
  return out.map((cookie) => cookie.trim()).filter((cookie) => cookie !== '');
}
