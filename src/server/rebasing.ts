import type { IncomingMessage } from 'node:http';
import { decodeTarget, isAbsoluteHttpUrl, isCodecName, routeTarget, type CodecName } from '../rewrite/codec.ts';
import { matchRoute, PROXY_PREFIX } from './router.ts';

/**
 * Server-side rebasing for requests that arrive without a proxy prefix.
 *
 * The rewriters in `src/rewrite` catch every URL that appears *literally* in
 * HTML, CSS and JavaScript. Two kinds of request escape them regardless:
 *
 *   - a root-relative path assembled from fragments at runtime, such as
 *     `base + '/assets/i18n/' + lang + '.json'`;
 *   - a root-relative path assigned through a DOM property setter rather than
 *     through an attribute, which no amount of markup rewriting can reach.
 *
 * Both resolve against the *proxy's* origin, so they arrive at the proxy root
 * as `/assets/i18n/en.json` carrying no target at all. The injected runtime shim
 * catches most of them, but it cannot catch what runs before it — and, as this
 * project has already demonstrated once, a shim with a syntax error catches
 * nothing while looking perfectly healthy.
 *
 * This module is the server-side backstop. A request with no target of its own
 * is rebased onto the site the *referring page* belongs to: the Referer is a
 * proxy URL, a proxy URL names a target, and the request path is a path on that
 * target — because the proxy is standing in for it.
 *
 * Which path on the target differs between the two shapes, and the difference
 * is not a detail: it is where the browser did the resolution.
 *
 *   - a **root-relative** reference resolves against the proxy *origin*, so the
 *     path arrives prefixless and names a path at the target's origin root;
 *   - a **relative** reference resolves against the referring URL's
 *     *directory*, and since a proxy URL's payload is a single path segment
 *     that directory is `/proxy/<codec>/` — the stand-in for the target's own
 *     directory, not its root.
 *
 * Treating both as origin-root paths silently moves a subresource one or more
 * directories up. That is exactly what breaks a code-split bundle whose runtime
 * derives its public path from `import.meta.url`: every chunk request arrives
 * as `/proxy/<codec>/<name>` and, read as origin-root, asks for a file that
 * does not exist.
 *
 * The decision is a heuristic and is treated as one. Only safe methods, only
 * live proxy referers, and the response itself gets a veto: a document in reply
 * to a guess of "this is a file" means the guess was wrong. See
 * `server/http-server.ts` for how the three are combined.
 */

/** A request with no target of its own, resolved onto the site behind its referer. */
export interface RebasedRequest {
  /** Absolute URL the request is re-issued against. */
  target: URL;
  /**
   * The archive to serve it from, when the referring page was a replay.
   *
   * Absent for a live proxy referer, where the request is re-issued against the
   * network. Present, it means the resource must come from this archive — see
   * `referringReference` for why an archive referer is admitted at all and why
   * serving from the network instead would be the wrong repair.
   */
  archiveId?: string;
}

/**
 * How a prefixless path got that way, which decides what it resolves against.
 *
 * The two shapes are visually identical — both are a path on the proxy origin —
 * and the only thing distinguishing them is what the browser resolved the
 * reference against.
 */
type Rebasing = 'origin-root' | 'referring-directory';

/**
 * Extensions that mark a path as a subresource rather than a document.
 *
 * Two separate jobs depend on this: deciding whether to rebase at all, and
 * vetoing a rebased response that turns out to be HTML. A path that looks like
 * a file but serves a document was not a file, so the guess was wrong.
 */
/**
 * Extensions that mark a path as a subresource rather than a document.
 *
 * `html` and `htm` are deliberately absent, and the reason is structural rather
 * than cosmetic: a rebase is a guess that the answer is a subresource, the
 * response veto rejects markup, and a path ending in `.html` announces markup
 * before the guess is made. Matching it would guarantee a wasted round trip and
 * then a 404 anyway.
 */
const ASSET_LIKE =
  /\.(?:7z|apk|avif|bin|bmp|bz2|cjs|csv|css|deb|dmg|eot|exe|gif|gz|ico|iso|jar|jpe?g|js|json|map|mjs|mp3|mp4|msi|ogg|otf|pdf|pkg|png|rar|rpm|svg|tar|tgz|ttf|txt|wasm|wav|webm|webp|whl|woff2?|xml|xz|zip)$/i;

/** True when a path's final segment looks like a file rather than a route. */
export function isAssetLikePath(pathname: string): boolean {
  return ASSET_LIKE.test(pathname);
}

/**
 * Fetch destinations that are always subresources, whatever the path looks like.
 *
 * The shape of a path is a weak signal, and it is the *only* signal available
 * when a request is replayed from a saved file. A browser sends a much better
 * one: by the time the document has been parsed, this service has injected a
 * shim that stamps `data-proxy-target` on every element it rewrites, so a
 * request for a root-relative image, stylesheet or script arrives carrying the
 * site in its `Sec-Fetch-Dest` — no extension needed.
 *
 * That matters because real sites serve subresources from extensionless paths.
 * MDN's own image proxy is `/pimg/<base64>.<hmac>`, and no initial guess about
 * it succeeds: it is neither file-shaped nor extensionless-but-known, so it is
 * declined and its 404 stands. With the destination known, the guess is not
 * needed in the first place.
 *
 * Deliberately *not* a list of every destination. `document`, `iframe`,
 * `embed`, `object`, `frame` and `empty` can all be a navigation, and a
 * navigation is what the response veto exists to protect: frame a page and let
 * it be mistaken for a stray subresource, and the site's HTML ends up served as
 * a (rejected) document rather than as the page it is.
 */
const ASSET_FETCH_DESTS = new Set([
  'audio',
  'font',
  'image',
  'manifest',
  'script',
  'style',
  'track',
  'video',
  'worker',
]);

/**
 * True when the browser has said this request is a subresource.
 *
 * Checked case-insensitively: the header is a token, and a client that sends
 * `Image` means the same thing as one that sends `image`.
 */
function isAssetFetchDest(request: IncomingMessage): boolean {
  const dest = request.headers['sec-fetch-dest'];
  if (typeof dest !== 'string') return false;
  return ASSET_FETCH_DESTS.has(dest.trim().toLowerCase());
}

/**
 * True when a request line names the proxy's own route namespace.
 *
 * The dispatcher uses this to tell a *malformed* target from a missing one: a
 * `/proxy/...` path carries a payload that failed to decode, which is a bad
 * request, whereas any other unknown path is simply not found.
 */
export function isProxyShapedPath(rawUrl: string): boolean {
  const pathname = pathnameOf(rawUrl);
  return pathname === '/proxy' || pathname.startsWith(PROXY_PREFIX);
}

/**
 * Work out the target a prefixless request should be re-issued against.
 *
 * Returns null whenever the request cannot be attributed confidently, which is
 * the common case and is meant to stay cheap: the caller then answers 404
 * exactly as it would have without this module.
 */
export function resolveRebasedRequest(
  request: IncomingMessage,
  defaultCodec: CodecName,
): RebasedRequest | null {
  const method = request.method ?? 'GET';
  // Only safe methods. Replaying a POST against a guessed origin is how a
  // fallback like this turns a 404 into data loss somewhere else.
  if (method !== 'GET' && method !== 'HEAD') return null;

  const raw = request.url ?? '/';
  // Absolute request-targets are the classic forward-proxy form. They are left
  // alone on purpose: the router does not route them and this heuristic must
  // not quietly turn the service into a transparent forward proxy.
  if (isAbsoluteHttpUrl(raw)) return null;

  // A request the page itself declared is cross-origin is not the site's to
  // answer. Left alone it stays the 404 it is; rebased it would be re-issued
  // against the referer's origin as whatever the path happens to name, which is
  // how a request for an unrelated CDN turns into a request for some other page.
  // The shim keeps the browser's own path working by rewriting such a URL to
  // `?url=`, so nothing legitimate depends on this being allowed through.
  const fetchSite = request.headers['sec-fetch-site'];
  if (typeof fetchSite === 'string' && fetchSite.trim().toLowerCase() === 'cross-site') {
    return null;
  }

  const pathname = pathnameOf(raw);

  let reference: { rest: string; up: number };
  let rebasing: Rebasing;

  if (!pathname.startsWith(PROXY_PREFIX) && (isAssetLikePath(pathname) || isAssetFetchDest(request))) {
    // A root-relative reference: resolved against the proxy *origin*, so the
    // path it produced is a path at the target's origin root.
    //
    // The shape test admits a request replayed from a saved file, which carries
    // no browser metadata; the destination test admits the extensionless
    // subresource a real browser asks for. Either is enough on its own.
    reference = { rest: pathname.slice(1), up: 0 };
    rebasing = 'origin-root';
  } else {
    const misplaced = misplacedProxyReference(pathname);
    if (misplaced === null) return null;
    reference = misplaced;
    // Decided by noting that a *relative* reference resolves against the
    // referring URL's directory, and a proxy URL's directory is `/proxy/<codec>/`
    // — its stand-in for the target's own directory. A programmed runtime that
    // derives the site's base from `import.meta.url` lands here, because the
    // unrewritten token resolves to the module's own proxied URL.
    rebasing = 'referring-directory';
  }

  const referring = referringReference(request, defaultCodec);
  if (referring === null) return null;

  const query = queryOf(raw);
  const built =
    rebasing === 'origin-root'
      ? buildTarget(`/${reference.rest}${query}`, referring.referrer.origin)
      : buildTarget(`./${reference.rest}${query}`, climbed(referring.referrer.href, reference.up));

  if (built === null) return null;
  return referring.archiveId === undefined
    ? { target: built.target }
    : { target: built.target, archiveId: referring.archiveId };
}

/** The referring URL with `up` directories climbed, which a relative reference did. */
function climbed(href: string, up: number): string {
  let base = href;
  for (let i = 0; i < up; i++) base = new URL('..', base).href;
  return base;
}

function buildTarget(raw: string, origin: string): RebasedRequest | null {
  let target: URL;
  try {
    target = new URL(raw, origin);
  } catch {
    return null;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
  return { target };
}

/**
 * Reduce a path the browser resolved against the proxy origin to the path that
 * belongs to the target, together with how many directories up the reference
 * travelled.
 *
 * The proxy's URL grammar is `[codec/]payload`, with the codec optional and
 * first, so undoing it is a matter of dropping the prefix and then dropping the
 * codec if one is present. What is left is a reference *relative to the
 * document's own directory*, and the number of levels it climbed is read off
 * the same split:
 *
 *   - `/proxy/plain/chunk.js` → `chunk.js`, no climb — the shape a relative
 *     reference produces, because the document URL's directory is
 *     `/proxy/plain/`;
 *   - `/proxy/chunk.js` → `chunk.js`, one climb — `../chunk.js` leaves the
 *     codec segment behind;
 *   - `/proxy` and `/proxy/` on their own carry no path at all, so they are
 *     refused rather than guessed at.
 */
function misplacedProxyReference(pathname: string): { rest: string; up: number } | null {
  if (!pathname.startsWith(PROXY_PREFIX)) return null;

  let rest = pathname.slice(PROXY_PREFIX.length);
  if (rest === '') return null;

  const slash = rest.indexOf('/');
  if (slash !== -1 && isCodecName(rest.slice(0, slash))) {
    rest = rest.slice(slash + 1);
    return rest === '' ? null : { rest, up: 0 };
  }

  return { rest, up: 1 };
}

/**
 * Split the path from a request line.
 *
 * Percent-escapes are decoded before the path is judged, because the shape
 * being recognised is *proxy URL grammar* and a browser percent-encodes a
 * reference before resolving it. `chunk.js` arrives as `/proxy/chunk.js`, but a
 * name with a space arrives as `/proxy/My%20File.js` — matching over the
 * encoded form would handle the first and miss the second. Decoding here is
 * what keeps the repair independent of the name.
 */
function pathnameOf(raw: string): string {
  const end = raw.search(/[?#]/);
  const path = end === -1 ? raw : raw.slice(0, end);
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

/** The query of a request line, re-attached to a repaired path. */
function queryOf(raw: string): string {
  const start = raw.indexOf('?');
  if (start === -1) return '';
  const hash = raw.indexOf('#');
  return raw.slice(start, hash === -1 ? raw.length : hash);
}

/**
 * The target the *referring* URL stands for, and the archive to serve it from.
 *
 * The Referer is the only reliable link between a prefixless request and a
 * target: the browser sends the referring page's URL, and a proxy or archive URL
 * carries the target. It is checked against the request's own `Host` so that a
 * page on some unrelated site cannot aim this proxy elsewhere by setting a
 * Referer.
 *
 * Both referer shapes are admitted, and they differ in *where the resource comes
 * from* rather than in how the target is derived:
 *
 *  - a **live proxy** referer names a target that is fetched, as before;
 *  - an **archive replay** referer names the same kind of target, but the
 *    resource has to come from that archive.
 *
 * Refusing the second was costing a real class of resource. A single-file
 * archive of a JavaScript application resolves icon URLs at runtime against
 * `document.baseURI`, which under replay is the proxy origin, so the page
 * requests `/static/client/icon.svg` at the root — while the archive holds
 * `https://site.test/static/client/icon.svg` and the manifest, stylesheet and
 * module that name it all agree with each other. The bytes are already on disk;
 * only the request has no way to say which archive and which origin it belongs
 * to, and the Referer says both.
 *
 * Sourcing it from the archive rather than from the network is the part that
 * matters. The target can be derived from either kind of referer, so admitting
 * an archive referer is not a network risk — but *serving* it by fetching would
 * be: a replay that quietly reaches for the live origin is exactly what the
 * archive path promises never to do, and it would paper over a genuinely
 * missing capture with current content.
 *
 * Only the *target* and the *archive* are taken from the referer. The request's
 * own path is what names the resource, and it is interpreted against those two
 * by the caller — see `misplacedProxyReference` for why a request path and a
 * referer path are read differently.
 *
 * The whole URL is returned rather than just its origin, because the referring
 * *directory* is what a relative reference resolved against and the origin alone
 * cannot reconstruct it.
 */
function referringReference(
  request: IncomingMessage,
  defaultCodec: CodecName,
): { referrer: URL; archiveId?: string } | null {
  const referer = request.headers.referer;
  if (referer === undefined || referer === '') return null;

  let parsed: URL;
  try {
    parsed = new URL(referer);
  } catch {
    return null;
  }

  // Compared by Host rather than by scheme: the proxy is routinely deployed
  // behind a TLS terminator whose encryption this process never observes.
  const host = request.headers.host;
  if (host !== undefined && parsed.host !== host) return null;

  // Reuse the real router so the referer is decoded exactly like a navigation
  // would be. Anything that names no target — the index page, an API call —
  // refuses the rebase rather than guessing at one.
  const route = matchRoute('GET', parsed.pathname + parsed.search, defaultCodec);

  if (route.kind === 'archive') {
    const target = routeTarget(route.codec, route.payload);
    if (target === null) return null;
    const referrer = parseTarget(target);
    if (referrer === null) return null;
    return { referrer, archiveId: route.archiveId };
  }

  if (route.kind !== 'proxy') return null;

  const target = routeTarget(route.codec, route.payload);
  if (target === null) return null;
  const referrer = parseTarget(target);
  if (referrer === null) return null;
  return { referrer };
}

/** Parse a decoded target, refusing anything that is not http(s). */
function parseTarget(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}
