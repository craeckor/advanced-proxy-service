import { proxyUrlFor, resolveTarget, type CodecName } from './codec.ts';

/**
 * Rewriting for JSON data blocks the browser fetches from on its own.
 *
 * Three kinds of inline JSON name resources that the browser retrieves without
 * the document's involvement, and without giving the page any chance to
 * intervene:
 *
 *   - an importmap's `imports`/`scopes` values, which the module resolver fetches
 *     directly — the page never sees the URL, so no element carries it and the
 *     rewriter's attribute pass cannot reach it;
 *   - a speculationrules block's `urls`, which the browser prefetches or
 *     prerenders on its own initiative;
 *   - a JSON-LD block, which is *not* fetched but is frequently the only place a
 *     page names its canonical URL or an image, so leaving it absolute points
 *     structured-data consumers at the real origin.
 *
 * All three are JSON, so all three are walked as JSON. Handing them to the
 * JavaScript rewriter would be a mistake twice over: the body is not a script,
 * and a leading `{` would be parsed as a block statement.
 */

interface JsonRewriteOptions {
  codec: CodecName;
  /** The document URL, which relative references resolve against. */
  baseUrl: string;
  prefix?: string;
  /**
   * Absolute URLs found while rewriting, for the archiver to follow.
   *
   * Rewriting and discovering are separate jobs but happen in one pass, so an
   * importmap that is proxied here has to be reported here too — otherwise the
   * replay rewrites a URL to a resource the capture never stored, and an
   * "offline" archive 404s the modules its own document asks for.
   */
  discovered?: Set<string>;
}

/** Build the URL-rewriting closure shared by every JSON walker below. */
function urlRewriter(options: JsonRewriteOptions): { rewrite: (value: string) => string | null } {
  const prefix = options.prefix ?? '/proxy';
  return {
    rewrite(value: string): string | null {
      const absolute = resolveTarget(options.baseUrl, value);
      if (absolute === null) return null;
      options.discovered?.add(absolute);
      return proxyUrlFor(options.codec, null, absolute, prefix);
    },
  };
}

/**
 * Rewrite an importmap.
 *
 * Only the URL *values* are touched. The specifier keys are the names modules
 * import by and must survive verbatim: replacing `"react"` with a proxied URL
 * would break every `import 'react'` in the page, because the key is matched
 * against the specifier the script wrote, not resolved.
 */
export function rewriteImportMap(body: string, options: JsonRewriteOptions): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }

  if (!isPlainObject(parsed) || !isPlainObject(parsed['imports'])) return body;

  const { rewrite } = urlRewriter(options);
  let changed = false;

  const rewriteMap = (map: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [specifier, value] of Object.entries(map)) {
      if (typeof value !== 'string') {
        out[specifier] = value;
        continue;
      }
      const rewritten = rewrite(value);
      if (rewritten === null) out[specifier] = value;
      else {
        out[specifier] = rewritten;
        changed = true;
      }
    }
    return out;
  };

  const result: Record<string, unknown> = { ...parsed };
  result['imports'] = rewriteMap(parsed['imports'] as Record<string, unknown>);

  // Scopes hold the same specifier-to-URL shape, keyed by a scope prefix.
  const scopes = parsed['scopes'];
  if (isPlainObject(scopes)) {
    const out: Record<string, unknown> = {};
    for (const [scope, map] of Object.entries(scopes)) {
      out[scope] = isPlainObject(map) ? rewriteMap(map as Record<string, unknown>) : map;
    }
    result['scopes'] = out;
  }

  return changed ? JSON.stringify(result) : body;
}

/**
 * The key under which a speculationrules block lists candidate URLs.
 *
 * Deliberately the only key touched. A rule also carries `source`, but that is
 * an enum — `"list"` or `"document"` — and a `where` clause carries match
 * patterns rather than locations. Rewriting either would change what the rule
 * matches instead of where it fetches from.
 */
const SPECULATION_URL_KEY = 'urls';

/**
 * Rewrite a speculationrules block.
 *
 * A block is either a list of rules or an object holding `prefetch`/`prerender`
 * lists, so both shapes are walked without assuming which arrived.
 */
export function rewriteSpeculationRules(body: string, options: JsonRewriteOptions): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }

  if (typeof parsed !== 'object' || parsed === null) return body;

  const { rewrite } = urlRewriter(options);
  let changed = false;

  const rewriteRule = (rule: unknown): unknown => {
    if (typeof rule !== 'object' || rule === null) return rule;
    const out: Record<string, unknown> = { ...(rule as Record<string, unknown>) };
    const value = out[SPECULATION_URL_KEY];

    if (typeof value === 'string') {
      const rewritten = rewrite(value);
      if (rewritten !== null) {
        out[SPECULATION_URL_KEY] = rewritten;
        changed = true;
      }
    } else if (Array.isArray(value)) {
      out[SPECULATION_URL_KEY] = value.map((entry: unknown) => {
        if (typeof entry !== 'string') return entry;
        const rewritten = rewrite(entry);
        if (rewritten === null) return entry;
        changed = true;
        return rewritten;
      });
    }
    return out;
  };

  if (Array.isArray(parsed)) {
    const rewritten = parsed.map(rewriteRule);
    return changed ? JSON.stringify(rewritten) : body;
  }

  const out: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
  for (const key of ['prefetch', 'prerender'] as const) {
    const value = out[key];
    if (Array.isArray(value)) out[key] = value.map(rewriteRule);
    else if (typeof value === 'object' && value !== null) out[key] = rewriteRule(value);
  }

  return changed ? JSON.stringify(out) : body;
}

/** A conservative object check: JSON objects only, never arrays. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/*
 * Why there is no general "rewrite every URL in a JSON data block" pass.
 *
 * It was written, and it broke a real page, and the reason is worth recording
 * because the idea is tempting and will be proposed again.
 *
 * A JSON data block is the page's own *state*, not a document. A URL in it is
 * as likely to be an identity as a location, and the two are indistinguishable
 * by value — both are absolute `http(s)` URLs. Running the walk over digitec's
 * `__NEXT_DATA__` changed 22 values, and only some of them were locations:
 *
 *   - `shopClientConfig.domain` is the site's own name. The application compares
 *     it against `location.origin` to decide whether it is running on its real
 *     host; rewritten to a proxy path, the comparison fails and the app throws
 *     `Cannot read properties of undefined (reading 'split')` during hydration.
 *   - `shopClientConfig.monolithInternal` and four sibling `*.host` entries are
 *     cluster-internal service addresses. They are not fetched by the browser at
 *     all, so routing them accomplishes nothing and only corrupts config.
 *   - `alternateLinksByPath.links[].absoluteUrl` is a *complete* URL, but the
 *     directory form appended its pathname a second time — `/de` became
 *     `/de/de` — because the form exists for values that are prefixes.
 *
 * The last point is the general one: a JSON value gives no signal about whether
 * it is a prefix that will be concatenated onto or a complete URL, and the two
 * need different rewrites. Guessing wrong is silent corruption.
 *
 * So the two blocks that are rewritten are the two where the *browser* is the
 * consumer and the schema is fixed by a specification — an importmap and a
 * speculationrules block. Everything else is left alone, and the runtime shim
 * handles the requests the page actually makes.
 */
