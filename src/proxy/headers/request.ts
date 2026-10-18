import type { IncomingHttpHeaders } from 'node:http';
import type { ProxyConfig } from '../../config.ts';
import { stripHopByHop } from './hop-by-hop.ts';

/**
 * Headers describing the *proxy's* own connection or identity. These must never
 * reach the origin, either because they are hop-by-hop or because forwarding
 * them would leak the proxy's existence or corrupt the origin's view of the
 * request.
 */
const NEVER_FORWARD: readonly string[] = [
  'host',
  'content-length', // recomputed by undici from the body we hand it
  'accept-encoding', // forced to identity so bodies arrive rewritable
  'via',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
];

/**
 * The `User-Agent` sent when the client supplied none.
 *
 * A request with no `User-Agent` at all is not a neutral request — it is a
 * distinctive one, and origins act on it. Adobe's edge answers it with a 7-byte
 * `OK Bot.` body and a `200`, which renders as a blank white page; other sites
 * answer with a challenge or a 403. The proxy's own fetches are the ones that
 * hit this, because a browser always sends a `User-Agent` on a navigation while
 * the crawler and the capture ingest build their headers from nothing.
 *
 * A browser string rather than a self-identifying one, and that is a deliberate
 * trade. The service already mirrors the client's own `User-Agent` when there is
 * one, precisely so an origin answers as it would to that browser; falling back
 * to `node` or to a product token would make the proxy's own fetches the only
 * ones that get a bot page, which is the bug this exists to prevent. It is not
 * an attempt to hide: `via` and the `x-forwarded-*` family are stripped for
 * unrelated reasons, and nothing here claims to be a browser to a site that
 * asked.
 *
 * Kept current deliberately — an outdated string is itself a bot signal.
 */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/**
 * Build the header set used for the upstream request.
 *
 * When `mimicClientHeaders` is on (the default) the client's own headers are
 * forwarded verbatim — User-Agent, Accept, Accept-Language, Sec-Fetch-*, and so
 * on — so the origin sees a request that looks like the real browser made it
 * directly. Only the headers the proxy must control are overridden.
 */
export function buildUpstreamRequestHeaders(
  clientHeaders: IncomingHttpHeaders,
  target: URL,
  config: ProxyConfig,
): Headers {
  const headers = new Headers();

  if (config.mimicClientHeaders) {
    for (const [rawName, value] of Object.entries(clientHeaders)) {
      if (value === undefined) continue;
      const name = rawName.toLowerCase();
      // `cookie` is supplied by the isolated jar, not the client.
      if (name === 'cookie') continue;
      const values = Array.isArray(value) ? value : [value];
      for (const entry of values) {
        if (entry === undefined) continue;
        try {
          headers.append(name, entry);
        } catch {
          // A malformed client header must not take the whole request down.
        }
      }
    }
  }

  for (const name of NEVER_FORWARD) headers.delete(name);
  stripHopByHop(headers);

  // The origin must be addressed by its own name for virtual hosting and SNI.
  headers.set('host', target.host);

  // Without this the origin may return a compressed body that the rewriters
  // cannot parse. It is also the reason `content-length` above is dropped.
  headers.set('accept-encoding', 'identity');

  // A request with no `User-Agent` is answered as a bot by a growing number of
  // origins — see `DEFAULT_USER_AGENT`. This is the crawler's and the capture
  // ingest's normal case, because they start from an empty header set.
  if (!headers.has('user-agent')) headers.set('user-agent', DEFAULT_USER_AGENT);

  return headers;
}

/**
 * Build headers for a plain (non-rewriting) passthrough request, such as a blob
 * or a streamed download. Here compression is welcome because the body is
 * relayed untouched.
 */
export function buildPassthroughRequestHeaders(
  clientHeaders: IncomingHttpHeaders,
  target: URL,
  config: ProxyConfig,
): Headers {
  const headers = buildUpstreamRequestHeaders(clientHeaders, target, config);
  if (config.mimicClientHeaders && clientHeaders['accept-encoding']) {
    const original = clientHeaders['accept-encoding'];
    headers.set('accept-encoding', Array.isArray(original) ? original.join(', ') : original);
  }
  return headers;
}
