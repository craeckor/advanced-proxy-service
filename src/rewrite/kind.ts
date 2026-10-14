import { isManifestFetchDest } from './manifest.ts';

/**
 * What kind of body a response carries, for the purposes of rewriting.
 *
 * A web app manifest is the reason this exists as its own module rather than as
 * a predicate inside each of the three places that need it. The live proxy, the
 * static crawler and the replay all have to answer "is this a manifest?" — and
 * all three used to answer it from the media type alone, which is wrong for the
 * common case. See `isManifest`.
 */

export type RewriteKind = 'html' | 'css' | 'js' | 'manifest';

/**
 * Whether a response is a web app manifest.
 *
 * Neither signal alone is sufficient:
 *
 *  - The media type is what the origin chose to claim. `application/manifest+json`
 *    is the spec's answer and is widely ignored in favour of `application/json`,
 *    so requiring it misses real manifests — MDN's `/manifest.json` is served as
 *    `application/json` — while trusting it alone is safe, because claiming to be
 *    a manifest and not being one is not a mistake an origin makes by accident.
 *
 *  - `sec-fetch-dest: manifest` is what the *browser* says the fetch is for, and
 *    it is authoritative. It is the only signal that survives an origin that
 *    serves its manifest as generic JSON, which is exactly the case that broke.
 *
 * Both are checked because they fail in opposite directions: an origin may serve
 * a manifest with the wrong type (media type misses it, fetch dest catches it),
 * and a client may send no `Sec-Fetch-*` headers at all (fetch dest misses it,
 * media type catches it).
 */
export function isManifest(contentType: string, fetchDest?: string | string[] | undefined): boolean {
  if (isManifestFetchDest(fetchDest)) return true;
  return contentType.toLowerCase().includes('manifest');
}

/**
 * Classify a response body by media type, with the manifest refinement applied.
 *
 * Order matters: HTML is tested before the manifest rule so a manifest served as
 * `text/html` with a manifest fetch destination — which no origin does, but which
 * a misconfigured one could — is still treated as a document, because serving
 * markup through a JSON rewriter would destroy the page.
 */
export function classifyBody(
  contentType: string,
  fetchDest?: string | string[] | undefined,
): RewriteKind | null {
  const lower = contentType.toLowerCase();
  if (lower.includes('text/html') || lower.includes('application/xhtml+xml')) return 'html';
  if (lower.includes('text/css')) return 'css';
  if (lower.includes('javascript') || lower.includes('ecmascript')) return 'js';
  if (isManifest(contentType, fetchDest)) return 'manifest';
  return null;
}
