/**
 * Hop-by-hop header handling per RFC 9110 section 7.6.1.
 *
 * RFC 7230 section 6.1 is obsoleted by RFC 9110/9111/9112. The concept survives
 * in the `Connection` header field: any field name *listed inside* `Connection`
 * is itself hop-by-hop and must be removed before forwarding.
 */

/** Headers that are always hop-by-hop and never forwarded. */
export const ALWAYS_HOP_BY_HOP: readonly string[] = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

const ALWAYS_HOP_BY_HOP_SET = new Set(ALWAYS_HOP_BY_HOP);

/**
 * Collect the full set of header names that must not be forwarded, including
 * any names nominated by the `Connection` header itself.
 */
export function hopByHopNames(headers: Headers | Record<string, string | string[] | undefined>): Set<string> {
  const names = new Set<string>(ALWAYS_HOP_BY_HOP);

  const connection = readHeader(headers, 'connection');
  if (connection) {
    for (const token of connection.split(',')) {
      const name = token.trim().toLowerCase();
      if (name !== '') names.add(name);
    }
  }
  return names;
}

/**
 * Remove every hop-by-hop header from a `Headers` instance, mutating in place.
 *
 * The `Connection` header itself is also removed, which is what RFC 9110
 * requires: it describes the previous hop's connection, not the next one's.
 */
export function stripHopByHop(headers: Headers): void {
  for (const name of hopByHopNames(headers)) {
    headers.delete(name);
  }
}

/**
 * True when a message declares framing in a way that is ambiguous, which is the
 * precondition for CL.TE and TE.CL request smuggling (RFC 9112 section 6.1).
 *
 * A message carrying both `Content-Length` and `Transfer-Encoding` must be
 * rejected rather than forwarded, because the two peers may disagree about
 * where the body ends.
 */
export function hasAmbiguousFraming(headers: Headers): boolean {
  const hasLength = headers.has('content-length');
  const hasEncoding = headers.has('transfer-encoding');
  if (hasLength && hasEncoding) return true;

  // Multiple differing Content-Length values are equally ambiguous.
  const lengths = headers.get('content-length');
  if (lengths && lengths.includes(',')) {
    const values = new Set(lengths.split(',').map((v) => v.trim()));
    if (values.size > 1) return true;
  }
  return false;
}

/** Read a header from either a `Headers` instance or a plain header object. */
function readHeader(
  headers: Headers | Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue;
    if (Array.isArray(value)) return value.join(', ');
    return value ?? undefined;
  }
  return undefined;
}

export { ALWAYS_HOP_BY_HOP_SET };
