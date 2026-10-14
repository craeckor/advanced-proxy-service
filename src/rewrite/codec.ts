import { toBase64Url, fromBase64Url } from '../util/bytes.ts';

/**
 * The URL codec turns an absolute target URL into a path segment the proxy can
 * route on, and back again.
 *
 * A proxied request looks like:
 *   /proxy/<codec>/<payload>[?query]
 *
 * The codec is pluggable so an obfuscating scheme can be added later without
 * touching the rewriting pipeline.
 */
export type CodecName = 'plain' | 'b64';

export const CODEC_NAMES: readonly CodecName[] = ['plain', 'b64'];

export function isCodecName(value: string): value is CodecName {
  return (CODEC_NAMES as readonly string[]).includes(value);
}

/** Encode an already-absolute URL into the payload segment for a codec. */
export function encodeTarget(codec: CodecName, absoluteUrl: string): string {
  switch (codec) {
    case 'plain':
      // encodeURIComponent keeps the segment readable, which matters a lot when
      // debugging a rewriting proxy in a browser address bar.
      return encodeURIComponent(absoluteUrl);
    case 'b64':
      return toBase64Url(absoluteUrl);
  }
}

/** Decode a payload segment back into an absolute URL, or null if malformed. */
export function decodeTarget(codec: CodecName, payload: string): string | null {
  switch (codec) {
    case 'plain': {
      let decoded: string;
      try {
        decoded = decodeURIComponent(payload);
      } catch {
        return null;
      }
      return isAbsoluteHttpUrl(decoded) ? decoded : null;
    }
    case 'b64': {
      const decoded = fromBase64Url(payload);
      if (decoded === null) return null;
      return isAbsoluteHttpUrl(decoded) ? decoded : null;
    }
  }
}

/** True when the string parses as an http(s) URL. */
export function isAbsoluteHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/**
 * Extract `name`'s value from a request line's query, verbatim.
 *
 * `URLSearchParams` is deliberately avoided. It splits the query on `&` and
 * decodes `+` as a space, which is right for a form body and wrong here, because
 * a request line's query may *contain* an unescaped target URL. Asking it for
 * `url` in
 *
 *     ?url=https://example.com/search?q=a+b&udm=50
 *
 * separates the query into `url`, `udm` and any other parameter that target
 * happens to carry, and answers with `https://example.com/search?q=a b` — the
 * target silently truncated at its first `&`, with its `+` turned into a space.
 * Since an unescaped URL is exactly the convenient form a caller reaches for, and
 * a search result, a filtered listing or any paginated route will have a second
 * parameter sooner or later, that is not a rare shape to get wrong.
 *
 * Two rules keep the value intact:
 *
 *  - the query is cut at the first `#`, because a fragment is not part of it;
 *  - `name`'s value begins after the first `=` and runs either to the *next*
 *    `&name=` or to the end. Stopping at the next `&name=` — rather than at the
 *    next `&` — leaves every `&` inside the value alone while still ending where
 *    a second copy of the same parameter would begin.
 */
export function queryParameterValue(rawUrl: string, name: string): string | null {
  const start = rawUrl.indexOf('?');
  if (start === -1) return null;
  const hash = rawUrl.indexOf('#');
  const query = rawUrl.slice(start + 1, hash === -1 ? rawUrl.length : hash);
  if (query === '') return null;

  const prefix = `${name}=`;
  for (let at = 0; at < query.length; at += 1) {
    // A parameter begins the query or follows an `&`. Requiring that boundary
    // stops `?other=url=https://…` from being read as a `url` parameter.
    if (at !== 0 && query[at - 1] !== '&') continue;
    if (!query.startsWith(prefix, at)) continue;

    const rest = query.slice(at + prefix.length);
    // `&name=` ends this value; every other `&` is part of it, which is what
    // keeps a target's own query intact.
    const next = rest.indexOf(`&${prefix}`);
    return decodeQueryComponent(next === -1 ? rest : rest.slice(0, next));
  }
  return null;
}

/**
 * Percent-decode a query parameter value without turning `+` into a space.
 *
 * `+` means space in a form body and nothing at all in a request line, and the
 * library decoder only implements the first. A target URL is full of `+` that
 * must survive — `/search?q=a+b` is a query, not two words — so only the `%`
 * escapes are decoded here.
 */
function decodeQueryComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A stray `%` is a malformed escape, not a reason to refuse the request.
    return value;
  }
}

/**
 * Attach a request line's query to an already-decoded target.
 *
 * A payload is self-contained: the rewriters encode a target's own query inside
 * it, so a request that the proxy itself produced carries no query of its own.
 * A caller that builds a proxy URL by hand — with `encodeURI`, by submitting a
 * GET form whose `action` was rewritten, or by appending to an existing proxied
 * URL — leaves its parameters *after* the payload, where the route grammar
 * reads them as the proxy's own and the router discards them.
 *
 * Discarding them is not harmless: it silently asks the origin for a different
 * resource. A route whose identity lives in its query then answers with the
 * page it serves when that parameter is missing, which is indistinguishable
 * from the proxy having mangled the request. Appending instead reproduces
 * exactly what the browser would have sent had the URL been used unproxied.
 *
 * The query is attached whatever the target's own shape, so the caller does not
 * have to decide whether a given target's query is "its own" — a target that
 * already has one gets this query appended to it, which is what the browser
 * would have sent for the same unproxied request.
 */
export function appendRequestQuery(absoluteUrl: string, rawUrl: string): string {
  const start = rawUrl.indexOf('?');
  if (start === -1) return absoluteUrl;

  const hash = rawUrl.indexOf('#');
  const query = rawUrl.slice(start + 1, hash === -1 ? rawUrl.length : hash);
  if (query === '') return absoluteUrl;

  // Insert ahead of the target's own fragment so the query stays in the query.
  const fragment = absoluteUrl.indexOf('#');
  const body = fragment === -1 ? absoluteUrl : absoluteUrl.slice(0, fragment);
  const rest = fragment === -1 ? '' : absoluteUrl.slice(fragment);
  return `${body}${body.includes('?') ? '&' : '?'}${query}${rest}`;
}

export function proxyPathFor(codec: CodecName, target: URL | string, prefix = '/proxy'): string {
  const absolute = typeof target === 'string' ? target : target.href;
  return `${prefix}/${codec}/${encodeTarget(codec, absolute)}`;
}

/**
 * Build a proxy path that carries the target's path *structurally*.
 *
 * A flat proxy path is one opaque segment, so a proxied URL's directory is
 * always `<prefix>/<codec>/` no matter where the target lives. That is a lie
 * about the target, and anything that treats a proxied URL as a location rather
 * than as an envelope discovers the lie:
 *
 *   - a relative reference resolves against the *directory*, so `./chunk-a.js`
 *     found in `https://cdn.example.net/assets/entry.js` arrives as
 *     `<prefix>/<codec>/chunk-a.js` — the `/assets/` segment is simply gone;
 *   - a build runtime that reads `import.meta.url` to discover its own base —
 *     which every webpack and rspack code-split build does — computes
 *     `<prefix>/<codec>/` and asks for bare chunk names. Those names appear
 *     nowhere in the source, so no amount of specifier rewriting can see them.
 *
 * Appending the target's pathname, unencoded, makes the proxied path mirror the
 * target's path. The target's directory then arrives intact, and a bare chunk
 * name is recoverable without guessing, because the trailing path is already the
 * target's own path — see `routeTarget`.
 *
 * The appended path must not be encoded, and that is what makes it work: both
 * codecs escape `/` inside their segment (percent-encoding escapes it, base64url
 * has no such character), so an unencoded slash can only be the boundary between
 * the payload and the path. It also has to be *structural* rather than one more
 * opaque segment, or `..` could not climb into it: a reference that walks up one
 * level has to remove one path segment, and there is no way to remove part of an
 * opaque one.
 *
 * A target whose path is already `/` gains nothing and would only be lengthened,
 * so it keeps the flat form.
 */
export function proxyPathWithTargetPath(
  codec: CodecName,
  target: URL | string,
  prefix = '/proxy',
): string {
  const absolute = typeof target === 'string' ? target : target.href;
  const payload = proxyPathFor(codec, absolute, prefix);

  let pathname: string;
  try {
    pathname = new URL(absolute).pathname;
  } catch {
    return payload;
  }

  return pathname === '/' ? payload : `${payload}${pathname}`;
}

/**
 * Decode a routed payload — which may be followed by the target's path — into
 * the target it names.
 *
 * Two shapes are accepted, and they are tried in an order that makes the choice
 * deterministic rather than a guess. A payload is *either* an encoded URL on its
 * own, or an encoded URL followed by the target's pathname:
 *
 *   1. split at the first unencoded slash; if the part before it decodes to a
 *      URL, it is the payload and the rest is the target's path at that URL's
 *      origin — this is the shape the rewriters emit and the shape a browser
 *      produces when it resolves a relative reference against a proxied URL;
 *   2. otherwise the whole tail is the payload.
 *
 * Step 2 exists because a caller that builds a proxy URL by hand tends to use
 * `encodeURI`, which leaves `/` alone — see `appendRequestQuery` for the query
 * half of the same tolerance. Step 1 cannot misread such a URL as
 * payload-plus-path: `encodeURI('https://a.test/b')` would split to a "payload"
 * of `https:`, which is not a URL, so it falls through to step 2 and decodes
 * whole. The split only wins when the prefix really is an encoded target.
 *
 * The payload wins when the trailing path names the *same* resource, because a
 * path cannot carry a query and the payload can. A rewriter emits exactly that
 * shape for a specifier that has one — `<payload:.../chunk.js?v=3>/assets/chunk.js`
 * — and letting the path override it would quietly drop the version, asking the
 * origin for a different resource than the page named.
 *
 * The resulting path is confined to the payload's origin. The payload is what
 * names the target, so a trailing path may move within that origin — which is
 * exactly what a relative reference does — but may not replace it.
 */
export function routeTarget(codec: CodecName, tail: string): string | null {
  const slash = tail.indexOf('/');
  if (slash > 0) {
    const payload = tail.slice(0, slash);
    const base = decodeTarget(codec, payload);
    if (base !== null) {
      const resolved = resolveTargetPath(base, tail.slice(slash));
      if (resolved !== null) return sameResource(base, resolved) ? base : resolved;
    }
  }
  return decodeTarget(codec, tail);
}

/**
 * True when two URLs name the same resource, ignoring the query.
 *
 * The query is deliberately excluded: it is what the payload can express and a
 * path cannot, so a payload and a path that agree on origin and pathname are two
 * spellings of one request rather than two requests.
 */
function sameResource(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.origin === right.origin && left.pathname === right.pathname;
  } catch {
    return false;
  }
}

/** Resolve a request's trailing path against the origin its payload named. */
function resolveTargetPath(base: string, suffix: string): string | null {
  if (suffix === '') return null;

  let origin: string;
  try {
    origin = new URL(base).origin;
  } catch {
    return null;
  }

  // `base` is known-good, but the suffix is raw client input, so it is parsed
  // rather than trusted to be a path.
  let url: URL;
  try {
    url = new URL(suffix, origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.origin === origin ? url.href : null;
}

/**
 * Build a proxy URL for a target, preserving nothing from the proxy's own
 * origin except the path. Relative targets are resolved against `base` first.
 */
export function proxyUrlFor(
  codec: CodecName,
  base: URL | string | null,
  target: string,
  prefix = '/proxy',
): string | null {
  const resolved = resolveTarget(base, target);
  if (resolved === null) return null;
  return proxyPathFor(codec, resolved, prefix);
}

/**
 * Resolve a URL reference found inside proxied content against the real
 * (unproxied) base URL.
 *
 * Returns null for references the proxy cannot or should not rewrite, which
 * the caller signals by leaving them untouched.
 */
export function resolveTarget(base: URL | string | null, target: string): string | null {
  const trimmed = target.trim();
  if (trimmed === '') return null;

  // Non-navigational and opaque schemes have no remote resource to fetch, or
  // must not be rewritten at all.
  if (/^(?:data|blob|javascript|mailto|tel|sms|about|chrome|file|ws|wss):/i.test(trimmed)) {
    return null;
  }
  // Fragment-only references stay on the current page.
  if (trimmed.startsWith('#')) return null;

  // An absolute target needs no base, which also keeps this working when the
  // base is missing or unusable.
  if (isAbsoluteHttpUrl(trimmed)) return new URL(trimmed).href;

  if (base === null) return null;

  let url: URL;
  try {
    url = new URL(trimmed, base);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.href;
}
