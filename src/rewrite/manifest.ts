import { proxyUrlFor, resolveTarget, type CodecName } from './codec.ts';

/**
 * Rewriting for web app manifests.
 *
 * A manifest is the one resource a browser fetches, parses for itself, and then
 * acts on without ever giving the page a chance to intervene: the icons it names
 * are downloaded straight from the listed URL. No element carries that URL, so
 * the rewriter never sees it, and the runtime shim never runs because the
 * response is not a document.
 *
 * The consequence is a leak. A manifest reached through the proxy usually lists
 * absolute URLs on a CDN — `https://cdn.example.net/assets/apple-touch-icon.png`
 * — and the browser obeys them literally. That is one request per icon leaving
 * the proxy and reaching the real origin, which is precisely what a proxy must
 * not do: the origin sees a request the user's browser should not have made.
 *
 * Only the URL-bearing members are rewritten. A manifest is also configuration,
 * and most of it resolves *relative* to the document, which already lands on the
 * target because the manifest is served from its own proxied URL. The members
 * handled here are the ones that are routinely absolute.
 *
 * Rewriting is not idempotent, and does not need to be: a manifest only ever
 * reaches this function as bytes that came from the origin, because the archive
 * stores what the origin served and the live path rewrites a response once.
 */

interface ManifestRewriteOptions {
  codec: CodecName;
  /** The manifest's own URL, which relative members resolve against. */
  baseUrl: string;
  prefix?: string;
  /**
   * Absolute URLs found while rewriting, for the archiver to follow.
   *
   * Replay rewrites a manifest's icons to archive URLs, so discovery has to
   * agree with rewriting exactly — or a capture serves a document whose own
   * icons 404. The archiver passes a sink here and lets this function be the
   * single source of truth about which members hold URLs.
   */
  discovered?: Set<string>;
}

/**
 * Whether a `<link rel="manifest">` fetch is asking for this response.
 *
 * `sec-fetch-dest` is set by the browser and names what the fetch is *for*,
 * which is the only reliable way to recognise a web app manifest. The media type
 * cannot be trusted: the spec's `application/manifest+json` is widely ignored,
 * and origins that serve `application/json` are the rule rather than the
 * exception — MDN serves `/manifest.json` as `application/json`.
 *
 * The cost of missing that is not cosmetic. An unrecognised manifest is relayed
 * byte-exact, so its `icons` `src` values reach the browser verbatim: during a
 * replay the root-relative ones resolve against the proxy's own origin
 * (`/favicon-192x192.png`) and 404, and on the live proxy they resolve against
 * the real origin, which is a leak of exactly the kind this rewriter exists to
 * prevent. The member list is the same either way, because a manifest is
 * identified as a document before its contents are read.
 */
export function isManifestFetchDest(value: string | string[] | undefined): boolean {
  if (typeof value !== 'string') return false;
  return value.trim().toLowerCase() === 'manifest';
}

/**
 * Recognise manifest *shape* when no other signal is available.
 *
 * Used by replay, where nothing on the connection marks what the response is for:
 * the request carries the browser's own `sec-fetch-dest`, but a replay can also be
 * read by a client that sends no such header. Only the members `rewriteManifest`
 * actually knows how to route count, so arbitrary JSON — an API response, a
 * coverage map, a lockfile — is never mistaken for a manifest and never rewritten.
 */
export function looksLikeManifest(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;

  const manifest = parsed as Record<string, unknown>;
  const named = ['icons', 'screenshots', 'shortcuts', 'share_target', 'protocol_handlers'];
  return named.some((key) => key in manifest);
}

/** Rewrite a manifest body so the resources it names load through the proxy. */
export function rewriteManifest(body: string, options: ManifestRewriteOptions): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }

  // A manifest that did not parse, or that is not an object, is passed through
  // exactly as delivered. Replacing it with an empty one would turn a visible
  // failure into an invisible one.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return body;

  const manifest = parsed as Record<string, unknown>;
  const prefix = options.prefix ?? '/proxy';
  let changed = false;

  const proxyUrl = (value: unknown): unknown => {
    if (typeof value !== 'string' || value === '') return value;
    const absolute = resolveTarget(options.baseUrl, value);
    if (absolute === null) return value;
    options.discovered?.add(absolute);
    // The resolved URL is absolute, so the base is no longer needed.
    const rewritten = proxyUrlFor(options.codec, null, absolute, prefix);
    if (rewritten === null || rewritten === value) return value;
    changed = true;
    return rewritten;
  };

  // Each entry below is a member whose URL is normally absolute; the shape is
  // recorded rather than guessed, because a nested `src` in a member that does
  // not have one would otherwise be silently replaced.
  const singleUrl = (
    owner: Record<string, unknown>,
    key: string,
  ): Record<string, unknown> => {
    if (!(key in owner)) return owner;
    const rewritten = proxyUrl(owner[key]);
    return rewritten === owner[key] ? owner : { ...owner, [key]: rewritten };
  };

  const iconList = (value: unknown): unknown => {
    if (!Array.isArray(value)) return value;
    return value.map((entry) =>
      typeof entry === 'object' && entry !== null
        ? singleUrl(entry as Record<string, unknown>, 'src')
        : entry,
    );
  };

  if (Array.isArray(manifest['icons'])) manifest['icons'] = iconList(manifest['icons']);
  if (Array.isArray(manifest['screenshots'])) {
    manifest['screenshots'] = iconList(manifest['screenshots']);
  }

  // `shortcuts` entries carry both a `url` and their own `icons`, so both are
  // handled — a shortcut icon is fetched by the browser exactly like a manifest
  // icon, and leaks the same way.
  if (Array.isArray(manifest['shortcuts'])) {
    manifest['shortcuts'] = (manifest['shortcuts'] as unknown[]).map((entry) => {
      if (typeof entry !== 'object' || entry === null) return entry;
      const shortcut = singleUrl(entry as Record<string, unknown>, 'url');
      if (Array.isArray(shortcut['icons'])) shortcut['icons'] = iconList(shortcut['icons']);
      return shortcut;
    });
  }

  // `share_target` posts to `action`, which is a URL the browser sends a request
  // to directly.
  if (typeof manifest['share_target'] === 'object' && manifest['share_target'] !== null) {
    manifest['share_target'] = singleUrl(
      manifest['share_target'] as Record<string, unknown>,
      'action',
    );
  }

  // `protocol_handlers` register a URL the browser navigates to.
  if (Array.isArray(manifest['protocol_handlers'])) {
    manifest['protocol_handlers'] = (manifest['protocol_handlers'] as unknown[]).map((entry) =>
      typeof entry === 'object' && entry !== null
        ? singleUrl(entry as Record<string, unknown>, 'url')
        : entry,
    );
  }

  return changed ? JSON.stringify(manifest) : body;
}
