import type { Config } from '../config.ts';import type { Logger } from '../util/logger.ts';
import { readAll } from '../util/bytes.ts';
import { UpstreamClient } from '../proxy/upstream.ts';
import { buildPassthroughRequestHeaders } from '../proxy/headers/request.ts';
import { rewriteHtml } from '../rewrite/html.ts';
import { rewriteCss } from '../rewrite/css.ts';
import { rewriteJs } from '../rewrite/js.ts';
import { rewriteManifest } from '../rewrite/manifest.ts';
import { classifyBody } from '../rewrite/kind.ts';
import { ArchiveBuilder } from './builder.ts';
import type { ArchiveStore, ArchiveMeta } from './store.ts';
import { RobotsCache } from './robots.ts';

/**
 * Recursive static crawler.
 *
 * Uses the same rewriting pipeline as the live proxy to discover subresources,
 * which is important for two reasons: the two features cannot drift apart in
 * what they consider a URL, and anything the proxy would route is by definition
 * something the archive needs to hold.
 *
 * Static fetching is the deliberate choice here (no headless browser): it is
 * fast, has no browser dependency, and covers the majority of sites. The cost is
 * that JavaScript-rendered content is not captured — documented as a limitation.
 */

export interface CrawlOptions {
  seedUrl: string;
  maxDepth?: number;
  maxPages?: number;
  /** Restrict the crawl to this origin. Default: the seed's origin. */
  scopeOrigin?: string;
}

export interface CrawlResult {
  archiveId: string;
  pages: number;
  resources: number;
  bytes: number;
  errors: Array<{ url: string; message: string }>;
  durationMs: number;
}

const REWRITABLE_CONTENT = (contentType: string, pathname: string): 'html' | 'css' | 'js' | 'manifest' | null => {
  // `sec-fetch-dest` cannot help a crawler: it is a browser header, and this is a
  // server-side fetch that sets none. A manifest is therefore recognised by media
  // type, or — because origins routinely serve one as plain `application/json` —
  // by the crawl having been *pointed at it* by a `<link rel="manifest">`, which
  // only the crawler knows. See `rewrite/kind.ts` for the other two callers.
  const byMediaType = classifyBody(contentType);
  if (byMediaType !== null) return byMediaType;
  if (contentType.toLowerCase().includes('json') && isManifestPath(pathname)) return 'manifest';
  return null;
};

/**
 * Whether a URL is named like a web app manifest.
 *
 * Only consulted for a JSON body the media type did not already classify, so the
 * blast radius is small: the cost of a false positive is that a JSON file named
 * like a manifest runs through a rewriter that returns it unchanged unless it
 * holds icons, shortcuts or a share target — that is, unless it really is one.
 *
 * Relaxed rather than anchored to the exact basename, because the file is
 * commonly renamed (`/app-manifest.json`, `/site.webmanifest`) and missing one
 * costs more than the alternative: a manifest the crawler does not recognise is a
 * manifest whose icons it never follows, which replays as a document asking for
 * its own icons out of an archive that does not hold them.
 */
function isManifestPath(pathname: string): boolean {
  return /(^|[^a-z0-9])manifest\.json$/i.test(pathname) || /\.webmanifest$/i.test(pathname);
}

export class Crawler {
  readonly #config: Config;
  readonly #logger: Logger;
  readonly #upstream: UpstreamClient;
  readonly #store: ArchiveStore;
  readonly #robots: RobotsCache;

  constructor(config: Config, logger: Logger, upstream: UpstreamClient, store: ArchiveStore) {
    this.#config = config;
    this.#logger = logger;
    this.#upstream = upstream;
    this.#store = store;
    this.#robots = new RobotsCache(upstream, config.archive.respectRobotsTxt);
  }

  /** Crawl a site from its seed URL and store everything reachable. */
  async crawl(options: CrawlOptions): Promise<CrawlResult> {
    const started = Date.now();

    const seed = new URL(options.seedUrl);
    const scopeOrigin = options.scopeOrigin ?? seed.origin;
    const maxDepth = options.maxDepth ?? this.#config.archive.maxDepth;
    const maxPages = options.maxPages ?? this.#config.archive.maxPages;

    const builder = await ArchiveBuilder.open(this.#store, this.#logger, {
      seedUrl: seed.href,
      producer: 'crawler',
    });

    const errors: Array<{ url: string; message: string }> = [];
    const seen = new Set<string>();
    let pages = 0;

    // Breadth-first frontier of [url, depth].
    const frontier: Array<{ url: string; depth: number }> = [{ url: normalizeUrl(seed.href), depth: 0 }];
    seen.add(normalizeUrl(seed.href));

    try {
      while (frontier.length > 0 && pages < maxPages) {
        const batch = frontier.splice(0, this.#config.archive.concurrency);

        const outcomes = await Promise.all(
          batch.map(async (item) => this.#captureUrl(item.url, builder)),
        );

        for (let i = 0; i < outcomes.length; i += 1) {
          const outcome = outcomes[i];
          const item = batch[i];
          if (outcome === undefined || item === undefined) continue;

          if (!outcome.ok) {
            errors.push({ url: item.url, message: outcome.message });
            continue;
          }

          const isDocument = outcome.kind === 'html';
          if (isDocument) pages += 1;

          if (item.depth >= maxDepth) continue;

          for (const discovered of outcome.discovered) {
            const normalized = normalizeUrl(discovered);
            if (seen.has(normalized)) continue;

            // Subresources are always fetched; *new pages* are restricted to the
            // crawl scope so following links cannot wander off the site.
            const isPageLink = outcome.linkedPages.has(normalized);
            if (isPageLink && !inScope(normalized, scopeOrigin, this.#config.archive.includeCrossOrigin)) {
              continue;
            }
            if (!isPageLink && !this.#config.archive.includeCrossOrigin && !inScope(normalized, scopeOrigin, false)) {
              continue;
            }
            if (pages + frontier.length >= maxPages && isPageLink) continue;

            seen.add(normalized);
            frontier.push({ url: normalized, depth: item.depth + (isPageLink ? 1 : 0) });

            if (this.#config.archive.politenessDelayMs > 0) {
              await delay(this.#config.archive.politenessDelayMs);
            }
          }
        }
      }

      const built = await builder.finish();

      return {
        archiveId: built.archiveId,
        pages: built.pages,
        resources: built.resources,
        bytes: built.bytes,
        errors,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      await builder.fail(error);
      throw error;
    }
  }

  async #captureUrl(
    url: string,
    builder: ArchiveBuilder,
  ): Promise<
    | { ok: true; kind: 'html' | 'css' | 'js' | 'manifest' | null; size: number; discovered: Set<string>; linkedPages: Set<string> }
    | { ok: false; message: string }
  > {
    const target = new URL(url);

    if (!(await this.#robots.allowed(target))) {
      return { ok: false, message: 'disallowed by robots.txt' };
    }

    try {
      const headers = buildPassthroughRequestHeaders({}, target, this.#config.proxy);
      const response = await this.#upstream.fetch(target, { method: 'GET', headers });

      const body = await readAll(response.body, this.#byteCeiling());
      const contentType = response.headers.get('content-type');
      const kind = contentType === null ? null : REWRITABLE_CONTENT(contentType, target.pathname);

      let discovered = new Set<string>();
      const linkedPages = new Set<string>();

      if (kind !== null) {
        const text = new TextDecoder(charsetOf(contentType) ?? 'utf-8').decode(body);
        try {
          if (kind === 'html') {
            const result = rewriteHtml(text, { codec: 'plain', baseUrl: url });
            discovered = result.discovered;
            for (const candidate of collectPageLinks(text, url)) linkedPages.add(candidate);
          } else if (kind === 'css') {
            discovered = collectCssUrls(text, url);
          } else if (kind === 'manifest') {
            // Replay rewrites a manifest's icons to archive URLs, so a capture
            // that did not follow them would 404 its own document's icons.
            discovered = collectManifestUrls(text, url);
          } else {
            discovered = collectJsUrls(text, url);
          }
        } catch (error) {
          this.#logger.debug({ err: error, url }, 'discovery parse failed');
        }
      }

      // Express the stored body in its original form: the archive holds what the
      // origin served, and rewriting happens at replay time. That keeps the
      // capture faithful and lets the rewriter change without re-crawling.
      await builder.add(
        url,
        response.status,
        headersToRecord(response.headers),
        contentType,
        body,
        { size: body.byteLength, isDocument: kind === 'html' },
      );

      return { ok: true, kind, size: body.byteLength, discovered, linkedPages };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message };
    }
  }

  #byteCeiling(): number {
    return Math.max(this.#config.proxy.maxRewriteBytes, 50 * 1024 * 1024);
  }
}

/** Extract navigational links from HTML, which drive crawl depth. */
function collectPageLinks(html: string, base: string): Set<string> {
  const out = new Set<string>();
  const re = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const href = match[2];
    if (href === undefined) continue;
    const resolved = safeResolve(href, base);
    if (resolved !== null) out.add(resolved);
  }
  return out;
}

/**
 * Extract URLs from CSS source.
 *
 * A regex is acceptable here because this is *discovery* for the crawler, not
 * the live rewrite path: a missed URL means one asset is not archived, whereas
 * the same mistake in the live path would corrupt the stylesheet.
 */
function collectCssUrls(css: string, base: string): Set<string> {
  const out = new Set<string>();
  const re = /url\(\s*(["']?)([^"')]+)\1\s*\)|@import\s+(["'])([^"']+)\3/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css)) !== null) {
    const candidate = match[2] ?? match[4];
    if (candidate === undefined) continue;
    const resolved = safeResolve(candidate.trim(), base);
    if (resolved !== null) out.add(resolved);
  }
  return out;
}

/** Extract string literals that look like URLs from JavaScript source. */
function collectJsUrls(js: string, base: string): Set<string> {
  const out = new Set<string>();
  const re = /(["'`])((?:https?:)?\/\/[^"'`\s]+|\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+)\1/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(js)) !== null) {
    const candidate = match[2];
    if (candidate === undefined) continue;
    const resolved = safeResolve(candidate, base);
    if (resolved !== null) out.add(resolved);
  }
  return out;
}

/**
 * Extract the URLs a web app manifest names.
 *
 * A manifest's icons are fetched by the browser itself, and replay rewrites them
 * to archive URLs. Discovery therefore has to agree with replay exactly, or an
 * offline capture serves a document whose own icons 404 — which looks like a
 * broken archive rather than a missing crawl.
 *
 * The way to guarantee that agreement is to reuse the replay rewriter itself,
 * with the collector as its sink, rather than walking the members a second time
 * and hoping the two walks stay in step.
 */
function collectManifestUrls(body: string, base: string): Set<string> {
  const out = new Set<string>();
  rewriteManifest(body, { codec: 'plain', baseUrl: base, discovered: out });
  return out;
}

function safeResolve(reference: string, base: string): string | null {
  const trimmed = reference.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;
  if (/^(?:data|blob|javascript|mailto|tel|about):/i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Drop the fragment, which does not change what the server returns. */
function normalizeUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = '';
  return parsed.href;
}

function inScope(url: string, scopeOrigin: string, allowCrossOrigin: boolean): boolean {
  if (allowCrossOrigin) return true;
  try {
    return new URL(url).origin === scopeOrigin;
  } catch {
    return false;
  }
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    if (name === 'set-cookie') continue;
    out[name] = value;
  }
  return out;
}

function charsetOf(contentType: string | null): string | null {
  if (contentType === null) return null;
  const match = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType);
  return match?.[1] ?? null;
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { ArchiveMeta };
