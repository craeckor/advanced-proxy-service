import type { ServerResponse } from 'node:http';
import type { Logger } from '../util/logger.ts';
import type { Config } from '../config.ts';
import type { ArchiveRecord, ArchiveStore } from './store.ts';
import { isSelfNavigation } from './store.ts';
import { matchRoute } from '../server/router.ts';
import { rewriteHtml } from '../rewrite/html.ts';
import { rewriteCss } from '../rewrite/css.ts';
import { rewriteJs } from '../rewrite/js.ts';
import { rewriteManifest, looksLikeManifest } from '../rewrite/manifest.ts';
import { isManifest } from '../rewrite/kind.ts';
import { RUNTIME_SHIM_SOURCE } from '../shim/runtime.ts';
import { proxyPathFor, routeTarget, type CodecName } from '../rewrite/codec.ts';

/**
 * Cookie recording the reader's answer to the compatibility offer.
 *
 * Scoped to `/archive/<id>` by the caller, so consent to substitute pages in one
 * archive is not consent in another — the two have unrelated captures and
 * unrelated URLs to be confused between.
 */
export const COMPAT_COOKIE = 'apx_compat';

/** How long a compatibility decision is remembered: 30 days. */
export const COMPAT_COOKIE_MAX_AGE = 2_592_000;

/** What the caller knows about a replay request that the URL does not say. */
export interface ReplayOptions {
  /**
   * True when the browser asked for a document, from `Sec-Fetch-Dest`.
   *
   * Only a navigation may be substituted. A subresource asking for a missing
   * image or script is a genuine gap, and answering it with an HTML page would
   * break the page around it while hiding the gap — the opposite of what an
   * archive should do.
   */
  isNavigation?: boolean;
  /**
   * The reader's recorded answer, or null when they have not been asked.
   *
   * Distinguishing "not answered" from "answered no" is the whole reason this is
   * null rather than a boolean defaulting to false: an unanswered request gets
   * the chooser, and a declined one gets the plain miss.
   */
  compatAnswer?: 'on' | 'off' | null;
  /**
   * The referrer of the request, which for a navigation is the page that caused
   * it. Used to recognise a page reloading itself — see `#negotiate`.
   */
  referer?: string | undefined;
  /**
   * The codec the *referring* URL was written in, when the referrer is a replay
   * URL. A referrer is decoded with the codec it was encoded with, not with the
   * one the current request happens to use.
   */
  refererCodec?: CodecName | undefined;
}

/** What compatibility mode decided to do about a miss. */
type ReplayNegotiation =
  | { kind: 'ask'; archiveId: string; requested: string; candidates: string[]; codec: CodecName }
  | { kind: 'serve'; archiveId: string; requested: string; chosen: string };

/**
 * Serve an archived site offline by reusing the live rewriting pipeline against
 * the archive index instead of the network.
 *
 * Two deliberate design choices, both matching how pywb and wabac.js behave:
 *
 *  1. **No silent live fallback.** A resource that was not captured returns an
 *     explicit placeholder. Falling back to the live web would quietly mix
 *     archived and current content, and the resulting archive would look
 *     complete while actually being a partial capture with no way to tell.
 *
 *  2. **Rewriting happens at replay, not at capture.** The stored bytes are
 *     byte-exact what the origin served, so improving the rewriter improves
 *     every existing archive without re-crawling.
 */
/**
 * Decide whether an archived response is a web app manifest.
 *
 * Replay has less to go on than the live proxy. There is no upstream media type
 * to trust, only the type the origin sent when the page was captured, and the
 * request is a replay request rather than the browser's own fetch — so
 * `sec-fetch-dest` is present only when the client that reads the replay happens
 * to send one.
 *
 * The signals, in order of authority:
 *
 *  1. A manifest media type. Always honoured: an origin that claims this is not
 *     doing so by accident.
 *  2. `sec-fetch-dest: manifest` on the replay request. Authoritative when
 *     present, and the signal that catches the common `application/json` case.
 *  3. The stored body's shape. The fallback for a replay read by a client that
 *     sends neither — a crawler, `curl`, a screenshot tool — and the only signal
 *     that survives the manifest being requested as a plain document.
 */
function isManifestResponse(
  contentType: string,
  fetchDest: string | string[] | undefined,
  text: string,
): boolean {
  if (isManifest(contentType, fetchDest)) return true;
  return looksLikeManifest(text);
}

export class ArchiveReplay {
  readonly #store: ArchiveStore;
  readonly #config: Config;
  readonly #logger: Logger;

  constructor(config: Config, logger: Logger, store: ArchiveStore) {
    this.#config = config;
    this.#logger = logger;
    this.#store = store;
  }

  /**
   * Serve `archiveId`'s copy of `targetUrl`.
   *
   * `targetUrl` is the *real* URL the archived page requested. The archive path
   * scheme keeps it in exactly the same encoded form as the live proxy, so a
   * single rewriting pipeline serves both.
   */
  async serve(
    archiveId: string,
    targetUrl: string,
    codec: CodecName,
    response: ServerResponse,
    fetchDest?: string | string[] | undefined,
    options: ReplayOptions = {},
  ): Promise<void> {
    const meta = this.#store.getArchive(archiveId);
    if (meta === null) {
      sendJson(response, 404, { error: 'Archive not found', archiveId });
      return;
    }

    const found = await this.#store.get(archiveId, targetUrl);
    if (found === null) {
      // A page that navigated to itself, to a URL the capture does not hold, is
      // answered with the page it was already on. See `#resolveSelfNavigation`.
      const selfNavigation = this.#resolveSelfNavigation(archiveId, targetUrl, options);
      if (selfNavigation !== null) {
        const own = await this.#store.getRecord(archiveId, selfNavigation);
        if (own !== null) {
          this.#logger.info(
            { archiveId, requested: targetUrl, served: selfNavigation },
            'archive self-navigation resolved to the page that asked',
          );
          response.setHeader('x-archive-self-navigation', '1');
          this.#writeRecord(archiveId, selfNavigation, own.record, own.body, codec, fetchDest, response);
          return;
        }
      }

      const negotiation = this.#negotiate(archiveId, targetUrl, codec, options);
      if (negotiation === null) {
        // A declined answer is remembered too, or the reader who said no is asked
        // again on the very next click.
        if (this.#config.archive.compatMode && options.compatAnswer === 'off') {
          response.setHeader('set-cookie', compatCookie(archiveId, 'off'));
        }
        this.#serveMiss(archiveId, targetUrl, response);
        return;
      }
      await this.#serveNegotiation(negotiation, codec, fetchDest, response);
      return;
    }

    const { record, body } = found;
    this.#writeRecord(archiveId, targetUrl, record, body, codec, fetchDest, response);
  }

  /**
   * The page a self-navigation was actually asking for, or null.
   *
   * The archived Google interstitial rebuilds its own URL and appends its retry
   * marker — `location.replace(href + '&sei=' + eid)` — and live that is
   * harmless, because the origin answers the URL it just built. In a replay the
   * browser's URL is the *archive's*, so the marker lands outside the encoded
   * payload and the request arrives as "the page I am already on, plus one
   * parameter". The capture does not hold that URL, so the request is a miss.
   *
   * A miss is the wrong answer here, and not only because it is unhelpful. With
   * compatibility mode on, the near miss is substituted, the substitute is the
   * same page, the page appends its marker again, and the cycle has no exit: the
   * browser reports being redirected to itself and the server logs ~6 requests a
   * second for as long as the tab is open. With compatibility mode off the same
   * navigation is a bare 404, which leaves the page visibly broken.
   *
   * The request is therefore resolved back to the page it came from. The
   * referrer is the only thing that can say which page that is, and it says it
   * exactly: a replay URL carries the target, so the referrer names the URL the
   * page is *on*, and the request names that same URL with something appended.
   *
   * Nothing is guessed. The candidate is the referrer's own target — resolved to
   * a stored URL the same way a substitution is, because a reader who accepted
   * one is looking at a stored page while the address bar shows the URL they
   * asked for — and it is only used when the archive actually holds it. So this
   * can never invent a page, and a genuine gap in the capture stays a gap. The
   * relation is checked parameter by parameter rather than as a string prefix, so
   * `a=1` is not read as a prefix of `a=10`, and the request must be *at least*
   * the referrer, so a page navigating to a shorter URL is not a self-navigation.
   *
   * This is deliberately not a compatibility-mode feature. It is not a
   * substitution and needs no consent: the reader asked for the page they are
   * already looking at, and the archive answers with that page. It is also
   * deliberately not a redirect, which would put the appended marker back in the
   * address bar and let the page append it again.
   */
  #resolveSelfNavigation(archiveId: string, targetUrl: string, options: ReplayOptions): string | null {
    if (options.referer === undefined) return null;

    const referrer = referrerTarget(options.referer, options.refererCodec ?? 'plain');
    if (referrer === null) return null;

    // The referrer has to name a page in *this* archive. A referrer from another
    // archive, or from the live proxy, says nothing about what this archive
    // holds, and serving across archives would be a different feature.
    if (referrer.archiveId !== undefined && referrer.archiveId !== archiveId) return null;

    const mayDrop = this.#config.archive.compatIgnoreParams;
    const lookup = { mayDrop, maxExtra: this.#config.archive.compatMaxExtra };

    // What the page is *showing*, which is not always what its address bar says.
    // A reader who accepted a substitution is looking at a stored URL while the
    // browser's URL is the one they asked for, so the referrer's target has to be
    // resolved to a stored URL the same way the substitution was.
    const showing = this.#store.candidates(archiveId, referrer.target, lookup)[0];
    if (showing === undefined) return null;

    // Consent is not bypassed here. Serving a URL other than the one the referrer
    // names means the page on screen is a substitute, and a substitute is only
    // ever shown with the reader's agreement — so without compatibility mode this
    // refuses, and the request stays the miss it would have been.
    if (showing !== referrer.target && !this.#config.archive.compatMode) return null;

    // The request must be that page's own URL with something appended. Checked
    // against the *stored* URL rather than the referrer's, so the appended marker
    // is measured from the page's real address.
    if (!isSelfNavigation(showing, targetUrl, mayDrop)) return null;
    return showing;
  }

  /**
   * Write one stored record out, rewriting it as its own URL requires.
   *
   * `url` is the URL the record belongs to — not necessarily the one that was
   * requested, because compatibility mode serves a substitute. That distinction
   * matters for the rewrite: a page's relative references resolve against the
   * page's own URL, so rewriting a substitute against the *requested* URL would
   * point every relative link at a path the archive does not hold.
   */
  #writeRecord(
    archiveId: string,
    url: string,
    record: ArchiveRecord,
    body: Uint8Array,
    codec: CodecName,
    fetchDest: string | string[] | undefined,
    response: ServerResponse,
  ): void {
    const contentType = record.contentType ?? 'application/octet-stream';

    // A 3xx captured from the origin still needs its Location routed through the
    // archive, or the browser leaves the replay entirely.
    if (record.status >= 300 && record.status < 400) {
      this.#serveRedirect(archiveId, record.headers, codec, response, record.status, url);
      return;
    }

    // A body the origin compressed must not go near a rewriter: `#rewriteBody`
    // would decode the compressed bytes as text, find no markup to route, and
    // store garbage. It is relayed untouched instead, with the encoding passed
    // through so the browser decompresses it — which means such a page replays
    // without the shim, so its own links stay live. That is the honest trade:
    // the alternative is a replay that renders nothing at all.
    const encoding = (record.headers['content-encoding'] ?? '').trim().toLowerCase();
    const compressed = encoding !== '' && encoding !== 'identity';

    const rewritten = compressed
      ? Buffer.from(body)
      : this.#rewriteBody(archiveId, contentType, body, url, codec, fetchDest);

    const headers: Record<string, string> = {
      'content-type': contentType,
      'content-length': String(rewritten.byteLength),
      ...(compressed ? { 'content-encoding': encoding } : {}),
      // A replay is a historical artefact; caching it is fine, but marking the
      // provenance lets a caller tell archived from live.
      'x-archive-id': archiveId,
      'x-archive-date': record.capturedAt,
      'cache-control': 'private, max-age=300',
    };

    response.writeHead(record.status, headers);
    response.end(rewritten);
  }

  #rewriteBody(
    archiveId: string,
    contentType: string,
    body: Uint8Array,
    targetUrl: string,
    codec: CodecName,
    fetchDest?: string | string[] | undefined,
  ): Buffer {
    const lower = contentType.toLowerCase();
    const isHtml = lower.includes('text/html') || lower.includes('application/xhtml+xml');
    const isCss = lower.includes('text/css');
    const isJs = lower.includes('javascript') || lower.includes('ecmascript');

    // No text-like media type and no mark on the request: the body is binary, and
    // a manifest is the one non-text kind that could still hide here. Byte-sniff
    // for a `{` before spending a decode on it, so images and fonts — the bulk of
    // any archive — never reach the JSON parse below.
    const mayBeJson = lower.includes('json') || body[0] === 0x7b;
    // A manifest stored under a generic JSON media type — which is the norm, not
    // the exception — is recognised by what the fetch was for, or failing that by
    // its shape. Without this the stored `icons[].src` values are relayed verbatim
    // and a root-relative one resolves against the proxy's own origin, so a replay
    // of a perfectly complete capture requests `/favicon-192x192.png` and 404s.
    const isManifest =
      mayBeJson &&
      isManifestResponse(
        contentType,
        fetchDest,
        new TextDecoder(charsetOf(contentType) ?? 'utf-8').decode(body),
      );

    if (!isHtml && !isCss && !isJs && !isManifest) return Buffer.from(body);

    const text = new TextDecoder(charsetOf(contentType) ?? 'utf-8').decode(body);
    // Rewritten links must stay inside the archive. Using the live `/proxy/`
    // prefix here would make an "offline" replay quietly reach the network for
    // every asset — and 404 entirely once the origin is gone.
    const prefix = `/archive/${archiveId}`;
    try {
      if (isHtml) {
        return Buffer.from(
          rewriteHtml(text, {
            codec,
            baseUrl: targetUrl,
            prefix,
            injectShim: true,
            shimSource: RUNTIME_SHIM_SOURCE,
            targetOrigin: new URL(targetUrl).origin,
          }).html,
          'utf8',
        );
      }
      if (isCss) return Buffer.from(rewriteCss(text, { codec, baseUrl: targetUrl, prefix }), 'utf8');
      // A manifest's icons are fetched by the browser itself, so a replay that
      // left them absolute would try the live origin from an "offline" capture.
      if (isManifest) {
        return Buffer.from(rewriteManifest(text, { codec, baseUrl: targetUrl, prefix }), 'utf8');
      }
      // JavaScript resolves its own references against its own URL, and a
      // code-split runtime derives that from a name that appears nowhere in the
      // source. A replay is as vulnerable to that as the live proxy is, and the
      // archive prefix makes the collapsed directory just as wrong.
      return Buffer.from(
        rewriteJs(text, { codec, baseUrl: targetUrl, prefix, directoryForm: true, rewriteImportMetaUrl: true }),
        'utf8',
      );
    } catch (error) {
      this.#logger.warn({ err: error, targetUrl }, 'archive replay rewrite failed; serving stored bytes');
      return Buffer.from(body);
    }
  }

  #serveRedirect(
    archiveId: string,
    recordHeaders: Record<string, string>,
    codec: CodecName,
    response: ServerResponse,
    status: number,
    baseUrl: string,
  ): void {    const location = recordHeaders['location'];
    if (location === undefined) {
      response.writeHead(status, { 'x-archive-id': archiveId });
      response.end();
      return;
    }
    const rewritten = rewriteArchiveRedirect(archiveId, location, codec, baseUrl);
    response.writeHead(status, { location: rewritten, 'x-archive-id': archiveId });
    response.end();
  }

  /**
   * Decide what compatibility mode should do about a miss, or null to leave it.
   *
   * Compatibility mode exists for one shape of failure: a reader asks for a URL
   * whose query differs from a captured one only at the end, so a page that is
   * *probably* the one they want is already on disk. Tracking parameters, a
   * shared link with extra fingerprinting, a paginated route with one more filter
   * — all of these *often* resolve to the same page.
   *
   * A page that navigates to *itself* is the other shape, and it is not answered
   * here. Substituting the near miss hands the page back to the page, which
   * appends its marker again, for ever — the browser reports being redirected to
   * itself and the server logs ~6 requests a second. That case is recognised and
   * answered before this runs, by `#resolveSelfNavigation`.
   *
   * The answer is therefore only ever "offer" or "serve something the reader
   * already agreed to", never "guess". Nothing here consults the network either,
   * so a gap in the capture stays a gap.
   *
   * "Often" is doing real work in that sentence. Whether a trailing parameter
   * selects content is a fact about the origin, and nothing about the two URLs can
   * establish it: `&tbm=nws` added to a search request turns a general result set
   * into news results. So this never decides on the reader's behalf. It offers —
   * with both URLs shown, the difference marked, and the substitution labelled on
   * every response — and remembers the answer so it asks once per archive.
   */
  #negotiate(
    archiveId: string,
    targetUrl: string,
    codec: CodecName,
    options: ReplayOptions,
  ): ReplayNegotiation | null {
    if (!this.#config.archive.compatMode) return null;
    if (!options.isNavigation) return null;

    // Only the query may differ. A different path is a different resource, and
    // there is no rule that makes one page a stand-in for another.
    const candidates = this.#store.candidates(archiveId, targetUrl, {
      mayDrop: this.#config.archive.compatIgnoreParams,
      maxExtra: this.#config.archive.compatMaxExtra,
    });
    if (candidates.length === 0) return null;

    const mayDrop = this.#config.archive.compatIgnoreParams;

    const substitute = candidates[0] as string;

    if (options.compatAnswer === null) {
      return { kind: 'ask', requested: targetUrl, candidates, codec, archiveId };
    }

    // A remembered answer is deliberately unopinionated about the URL: a reader
    // who opted in opted in for this page, and re-asking on every extra parameter
    // would make the mode useless. Declining is remembered with the same scope,
    // so a "no" is not a question asked again on the next click either.
    if (options.compatAnswer === 'off') {
      this.#logger.debug({ archiveId, targetUrl }, 'compat declined; replaying as a miss');
      return null;
    }

    this.#logger.info(
      { archiveId, requested: targetUrl, served: substitute, referer: options.referer },
      'compat substitute',
    );
    return { kind: 'serve', archiveId, requested: targetUrl, chosen: substitute };
  }

  /** Write the answer to a negotiation, adding consent when applicable. */
  async #serveNegotiation(
    negotiation: ReplayNegotiation,
    codec: CodecName,
    fetchDest: string | string[] | undefined,
    response: ServerResponse,
  ): Promise<void> {
    if (negotiation.kind === 'serve') {
      const found = await this.#store.getRecord(negotiation.archiveId, negotiation.chosen);
      if (found === null) {
        // Raced with a concurrent deletion; an honest miss beats a phantom.
        this.#serveMiss(negotiation.archiveId, negotiation.requested, response);
        return;
      }

      // The reader said yes, so the answer is recorded here — with the write,
      // not at the click, so a remembered answer and the page it produced are one
      // event. A cookie that outlived a failed render would leave the reader
      // opted in to something they never saw.
      response.setHeader('set-cookie', compatCookie(negotiation.archiveId, 'on'));
      // Labelled on every substituted response, so a caller can always tell a
      // stand-in from a hit without having to remember that it opted in.
      response.setHeader('x-archive-compat', 'substitute');
      response.setHeader('x-archive-requested', negotiation.requested);

      const { record, body } = found;
      this.#writeRecord(negotiation.archiveId, negotiation.chosen, record, body, codec, fetchDest, response);
      return;
    }

    const body = Buffer.from(renderCompatChooser(negotiation), 'utf8');    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(body.byteLength),
      'x-archive-id': negotiation.archiveId,
      'x-archive-miss': '1',
      'x-archive-compat': 'offer',
      // Consent is per-archive and travels in a cookie, so a cache must not hand
      // this page to a reader whose answer differs.
      vary: 'Cookie',
      'cache-control': 'no-store',
    });
    response.end(body);
  }

  /**
   * An uncaptured resource is answered explicitly rather than with a silent live
   * fetch, so a gap in the archive is always visible.
   *
   * The seed URL gets more than a paragraph, because a miss on it is nearly always
   * a different problem from a miss on an asset. An asset can genuinely have been
   * outside the crawl; the seed was fetched first and is what the archive was
   * created *from*, so a miss there means the URL being replayed is not
   * byte-for-byte the one that was archived.
   *
   * Naming both URLs is not enough to make that visible — two long URLs that
   * differ in one character read as identical, which is exactly the state of mind
   * that produced the report. So the difference is *shown*: the bodies are laid
   * out one character per column, the shared prefix is dimmed, and the first
   * place they diverge is marked. A truncated query then reads as a short line
   * against a long one rather than as two similar walls of text.
   */
  #serveMiss(archiveId: string, targetUrl: string, response: ServerResponse): void {
    this.#logger.debug({ archiveId, targetUrl }, 'archive miss');

    const meta = this.#store.getArchive(archiveId);
    const nearMiss = meta !== null && isSeedVariant(targetUrl, meta.seedUrl);

    const detail = nearMiss && meta !== null
      ? `<p>This resource is <strong>not missing from the capture</strong> — this exact URL is. The archive was ` +
        `seeded with a variant that differs only in its query, so nothing here needs re-crawling. ` +
        `<code>·</code> marks the end of a line below.</p>` +
        renderUrlDiff(targetUrl, meta.seedUrl) +
        `<p>A query cut short at an <code>&amp;</code> is the usual cause: in <code>cmd.exe</code> an unescaped ` +
        `<code>&amp;</code> ends the command, so only the part before it is ever sent. Escape each one as ` +
        `<code>^&amp;</code>, or let <code>curl</code> read the body from a file with <code>-d @body.json</code>. ` +
        `See the README's "Archiving with curl on Windows".</p>`
      : `<p>This resource was not captured when the site was archived, so it cannot be replayed offline.</p>` +
        `<p>Re-run the archive with a greater depth or a higher page limit to include it.</p>`;

    const body = Buffer.from(
      `<!doctype html><meta charset="utf-8"><title>Not in archive</title>` +
        `<body style="font:14px/1.6 system-ui;padding:2rem;max-width:46rem;margin:auto">` +
        `<h1>Not in archive</h1>` +
        detail,
      'utf8',
    );
    response.writeHead(404, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(body.byteLength),
      'x-archive-id': archiveId,
      'x-archive-miss': '1',
      'cache-control': 'no-store',
    });
    response.end(body);
  }
}

/** How many characters of shared prefix to keep before the divergence. */
const DIFF_HEAD = 48;
/** How many characters to show after the divergence. */
const DIFF_TAIL = 90;

/**
 * The target a replay URL stands for, and the archive it belongs to.
 *
 * A referrer is a URL the *browser* sent, so it is a replay URL rather than a
 * target: the target is inside its payload, encoded with whichever codec that
 * URL was written in. Decoding it with the current request's codec would be
 * wrong whenever the two differ, so the codec is passed in.
 *
 * Only the two replay shapes are admitted. A referrer that is not a replay URL
 * names no target this archive could hold, and returning null for it keeps the
 * caller from having to decide what a foreign referrer means.
 */
function referrerTarget(
  referer: string,
  codec: CodecName,
): { target: string; archiveId?: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(referer);
  } catch {
    return null;
  }

  const route = matchRoute('GET', parsed.pathname + parsed.search, codec);
  if (route.kind === 'archive') {
    const target = routeTarget(route.codec, route.payload);
    return target === null ? null : { target, archiveId: route.archiveId };
  }
  if (route.kind === 'proxy') {
    const target = routeTarget(route.codec, route.payload);
    return target === null ? null : { target };
  }
  return null;
}

/**
 * Is this the seed URL with only its query changed?
 *
 * The distinction matters because the two kinds of miss need opposite advice. A
 * miss on a *path* is a resource the crawl never reached, and the fix is to
 * re-crawl deeper. A miss on the seed with a different query is usually not a
 * capture gap at all: the URL was altered before it was ever sent, and the fix is
 * in the shell.
 *
 * Comparing the whole URL would be too broad — every asset under the seed's
 * origin differs from the seed, so a missing icon would be reported as a shell
 * quoting problem, sending the reader after the wrong thing entirely. The query
 * is therefore the only part allowed to differ.
 */
function isSeedVariant(requested: string, seed: string): boolean {
  if (requested === seed) return false;
  const cut = (value: string): string => {
    const query = value.indexOf('?');
    return query === -1 ? value : value.slice(0, query);
  };
  return cut(requested) === cut(seed);
}

/**
 * Render two URLs so their difference is visible rather than described.
 *
 * Two URLs that agree for three hundred characters and then diverge are read as
 * identical by a human, which is the exact confusion this exists to remove. So
 * the shared prefix is elided and the character where they first part company is
 * marked, leaving a reader looking at the neighbourhood of the difference instead
 * of at two near-identical walls of text.
 */
export function renderUrlDiff(requested: string, seed: string): string {
  let shared = 0;
  while (shared < requested.length && shared < seed.length && requested[shared] === seed[shared]) shared += 1;

  // Only elide when there is genuinely a long prefix to hide; keeping a short one
  // shows more context for free.
  const showFrom = shared <= DIFF_HEAD ? 0 : shared - DIFF_HEAD;

  const shortest = Math.min(requested.length, seed.length);
  const verdict =
    shared === requested.length && shared === seed.length
      ? `The two URLs are identical, so this is a genuinely missing resource rather than a near miss.`
      : shared === shortest
        ? `They agree for all <strong>${shared}</strong> characters of the shorter one, then one continues. ` +
          `The extra part on the longer line is what was asked for and never captured.`
        : `They differ at character <strong>${shared + 1}</strong>.`;

  return (
    `<pre style="overflow-x:auto;background:#f6f6f6;padding:.75rem;border-radius:4px">` +
    diffRow('requested', requested, showFrom, shared) +
    diffRow('seeded   ', seed, showFrom, shared) +
    `</pre><p>${verdict}</p>`
  );
}

function diffRow(label: string, value: string, showFrom: number, shared: number): string {
  const visible = value.slice(showFrom, showFrom + DIFF_TAIL);
  const prefix = showFrom > 0 ? '…' : '';
  // `·` ends a line that was not truncated; `…` continues one that was.
  const suffix = value.length > showFrom + visible.length ? '…' : '·';

  // The divergence, if it falls inside this window. Marking the *first* character
  // unconditionally would flag a difference at every position of a URL pair that
  // has none.
  const at = shared - showFrom;
  const body =
    at >= 0 && at < visible.length
      ? escapeHtml(visible.slice(0, at)) +
        `<b style="color:#b00">${escapeHtml(visible[at] as string)}</b>` +
        escapeHtml(visible.slice(at + 1))
      : escapeHtml(visible);

  return `<span style="color:#666">${label} </span>${escapeHtml(prefix)}${body}${escapeHtml(suffix)}\n`;
}

/**
 * Route a redirect target back into the archive.
 *
 * The target is resolved against the response's own URL first, because a
 * redirect very often uses a bare relative path.
 *
 * A target that was never captured is still routed into the archive rather than
 * passed through, because sending the browser to the live site at this point
 * would silently end the offline session.
 */
export function rewriteArchiveRedirect(
  archiveId: string,
  location: string,
  codec: CodecName,
  baseUrl?: string,
): string {
  let absolute: URL;
  try {
    absolute = baseUrl === undefined ? new URL(location) : new URL(location, baseUrl);
  } catch {
    return location;
  }
  if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return location;

  return `/archive/${archiveId}${proxyPathFor(codec, absolute, '')}`;
}

/**
 * The consent page shown when compatibility mode could serve a substitute.
 *
 * This is the whole interaction: one question, the exact URL it would serve, and
 * a link for each answer. It is a page rather than an automatic substitution
 * because a reader who asked for one URL and silently received another has lost
 * the only guarantee the archive path makes, and a page rather than a redirect
 * because there is nowhere to redirect *to* — the choice has to be made before
 * the resource exists.
 *
 * The links are ordinary GETs back to the requested URL. "Yes" is a distinct URL
 * that the server reads as consent, so the mode stays stateless on the server and
 * the decision is visible in the address if anyone has to reproduce it.
 */
export function renderCompatChooser(negotiation: Extract<ReplayNegotiation, { kind: 'ask' }>): string {
  const { archiveId, requested, candidates, codec } = negotiation;
  const encode = (url: string): string => `/archive/${archiveId}${proxyPathFor(codec, url, '')}`;

  const alternatives = candidates
    .slice(0, 9)
    .map((candidate) => {
      const shared = sharedLength(requested, candidate);
      return (
        `<li style="margin:.25rem 0"><a href="${escapeHtml(encode(candidate))}">${escapeHtml(candidate)}</a>` +
        `<br><span style="color:#666">matches the requested URL for ${shared} of ` +
        `${Math.max(requested.length, candidate.length)} characters</span></li>`
      );
    })
    .join('');

  const yes = `${encode(requested)}${requested.includes('?') ? '&' : '?'}__compat=on`;
  const no = `${encode(requested)}${requested.includes('?') ? '&' : '?'}__compat=off`;

  return (
    `<!doctype html><meta charset="utf-8"><title>Compatibility mode</title>` +
    `<body style="font:15px/1.6 system-ui;padding:2rem;max-width:52rem;margin:auto">` +
    `<h1 style="font-size:1.4rem">This exact URL was not captured</h1>` +
    `<p>The archive has a page that matches it for everything but part of the query. ` +
    `Compatibility mode can serve that page instead of a miss.</p>` +
    `<p><strong>Requested</strong><br><code style="word-break:break-all">${escapeHtml(requested)}</code></p>` +
    `<p><strong>Would be served</strong><br><code style="word-break:break-all">${escapeHtml(candidates[0] as string)}</code></p>` +
    `<p>This is a <strong>substitute, not the page you asked for</strong>. The extra parameters the request ` +
    `carries are not the ones that select this page's content, which is why the archive can answer at all — ` +
    `but nothing here verifies that against the origin, so what renders may differ from what you would have ` +
    `seen live.</p>` +
    `<p style="margin:1.5rem 0">` +
    `<a href="${escapeHtml(yes)}" style="background:#1a7f37;color:#fff;padding:.5rem 1rem;border-radius:4px;text-decoration:none">` +
    `Serve the substitute</a> &nbsp; ` +
    `<a href="${escapeHtml(no)}" style="background:#eee;color:#111;padding:.5rem 1rem;border-radius:4px;text-decoration:none">` +
    `Show the ordinary miss instead</a></p>` +
    `<p style="color:#666">Your answer is remembered for this archive, so later pages will not ask again. ` +
    `It is stored in a cookie scoped to <code>/archive/${escapeHtml(archiveId)}</code>; clear cookies for this ` +
    `site to be asked again.</p>` +
    (candidates.length > 1
      ? `<details style="margin-top:1rem"><summary>${candidates.length} matches, closest first</summary>` +
        `<ul style="padding-left:1.2rem">${alternatives}</ul></details>`
      : `<details style="margin-top:1rem"><summary>The match</summary><ul style="padding-left:1.2rem">${alternatives}</ul></details>`) +
    `</body>`
  );
}

/** How many leading characters two URLs share, for ranking a match in the list. */
function sharedLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

/** The consent cookie for one archive, scoped so one archive's answer is not another's. */
function compatCookie(archiveId: string, answer: 'on' | 'off'): string {
  return (
    `${COMPAT_COOKIE}=${answer}; Path=/archive/${archiveId}; ` +
    `Max-Age=${COMPAT_COOKIE_MAX_AGE}; SameSite=Lax`
  );
}

function charsetOf(contentType: string): string | null {
  const match = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType);
  return match?.[1] ?? null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
  });
  response.end(body);
}

export { escapeHtml };
