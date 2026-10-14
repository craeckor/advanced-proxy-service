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
