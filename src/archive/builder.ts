import { randomUUID } from 'node:crypto';
import type { Logger } from '../util/logger.ts';
import type { ArchiveStore } from './store.ts';

/**
 * Shared accumulation logic for anything that fills an archive.
 *
 * Two very different producers write archives: the static crawler, which fetches
 * a site itself, and the browser-assisted capture, where a page reports what it
 * loaded and the server fetches the rest. They discover resources in completely
 * different ways, but everything *after* discovery is identical — dedupe, store,
 * count, and finish — and getting that part wrong is subtle in a way that does
 * not show up until a replay is opened.
 *
 * Keeping it in one place also fixes a bug the crawl path had: it called
 * `finishArchive('complete')` *before* `flush()`, so a replay started the moment
 * a crawl reported completion could find the index entry but not the blob. The
 * window is small, but it is exactly the window a user hits if they open the
 * replay link as soon as the status flips. Finishing here always flushes first.
 */

/** Per-resource outcome a producer reports back to the builder. */
export interface ResourceOutcome {
  /** Bytes stored, or 0 when the resource was skipped. */
  size: number;
  /** Absolute URLs this resource referenced, to be fetched in turn. */
  discovered?: Iterable<string>;
  /**
   * Whether this resource is a document.
   *
   * Documents count toward `pages`, and only documents are allowed to discover
   * *new pages* — a stylesheet naming a URL does not turn it into a page to
   * crawl, which is what keeps a crawl from wandering off through asset links.
   */
  isDocument?: boolean;
}

/** Result of a completed archive. */
export interface ArchiveBuildResult {
  archiveId: string;
  pages: number;
  resources: number;
  bytes: number;
  /** Absolute URLs actually stored, in the order they were added. */
  urls: string[];
}

export interface ArchiveBuilderOptions {
  /** A seed the archive is associated with, shown when listing archives. */
  seedUrl: string;
  /** Label used in log lines, so the two producers are distinguishable. */
  producer: string;
}

export class ArchiveBuilder {
  readonly #store: ArchiveStore;
  readonly #logger: Logger;
  readonly #options: ArchiveBuilderOptions;

  #archiveId: string;
  #pages = 0;
  #resources = 0;
  #bytes = 0;
  readonly #urls: string[] = [];
  /** URLs already accounted for, so a repeated report is not double-counted. */
  readonly #seen = new Set<string>();
  #finished = false;

  private constructor(store: ArchiveStore, logger: Logger, options: ArchiveBuilderOptions) {
    this.#store = store;
    this.#logger = logger;
    this.#options = options;
    this.#archiveId = randomUUID();
  }

  /**
   * Open an archive and register it immediately.
   *
   * Registering before anything is written is deliberate: a capture is visible
   * as `running` from the moment it starts, so a client that loses its
   * connection still leaves a record of the attempt rather than nothing at all.
   */
  static async open(
    store: ArchiveStore,
    logger: Logger,
    options: ArchiveBuilderOptions,
  ): Promise<ArchiveBuilder> {
    const builder = new ArchiveBuilder(store, logger, options);
    store.createArchive(builder.#archiveId, options.seedUrl);
    return builder;
  }

  get archiveId(): string {
    return this.#archiveId;
  }

  get pages(): number {
    return this.#pages;
  }

  get resources(): number {
    return this.#resources;
  }

  /** True when this URL has already been stored in this archive. */
  has(url: string): boolean {
    return this.#seen.has(url);
  }

  /**
   * Store one resource.
   *
   * Returns false when it was already present: a page that reports the same
   * asset twice, or a URL that was both reported and discovered, must not be
   * counted twice, because the counts are what a user reads to judge whether a
   * capture is complete.
   */
  async add(
    url: string,
    status: number,
    headers: Record<string, string>,
    contentType: string | null,
    body: Uint8Array,
    outcome: ResourceOutcome = { size: body.byteLength },
  ): Promise<boolean> {
    if (this.#seen.has(url)) return false;
    this.#seen.add(url);

    await this.#store.put(this.#archiveId, url, status, headers, contentType, body);

    this.#urls.push(url);
    this.#resources += 1;
    this.#bytes += outcome.size;
    if (outcome.isDocument === true) this.#pages += 1;
    return true;
  }

  /**
   * Record a URL as known without storing a body.
   *
   * Used for a URL the browser requested and the server could not fetch — a
   * beacon, a stream, an origin that refused. The archive remembers it was part
   * of the page, which is what makes a coverage report honest, without claiming
   * to have a copy of it.
   */
  note(url: string): void {
    this.#seen.add(url);
    this.#urls.push(url);
  }

  /** The URLs stored so far. */
  urls(): string[] {
    return [...this.#urls];
  }

  /**
   * Flush the staged blobs and mark the archive complete.
   *
   * Order matters and is the reason this method exists: the blobs must be on
   * disk before the index says the archive is finished, or a replay started on
   * seeing `complete` can read an index row whose blob is not there yet.
   */
  async finish(): Promise<ArchiveBuildResult> {
    if (this.#finished) {
      return {
        archiveId: this.#archiveId,
        pages: this.#pages,
        resources: this.#resources,
        bytes: this.#bytes,
        urls: this.urls(),
      };
    }
    this.#finished = true;

    const written = await this.#store.flush();
    this.#store.finishArchive(this.#archiveId, 'complete', this.#pages);

    this.#logger.info(
      {
        archiveId: this.#archiveId,
        producer: this.#options.producer,
        pages: this.#pages,
        resources: this.#resources,
        blobs: written,
        bytes: this.#bytes,
      },
      'archive complete',
    );

    return {
      archiveId: this.#archiveId,
      pages: this.#pages,
      resources: this.#resources,
      bytes: this.#bytes,
      urls: this.urls(),
    };
  }

  /**
   * Mark the archive failed, keeping whatever was already captured.
   *
   * A partial archive is still worth reading, so the staged blobs are flushed
   * rather than discarded — the same reasoning the crawler already applied when
   * a crawl threw partway through.
   */
  async fail(error: unknown): Promise<void> {
    if (this.#finished) return;
    this.#finished = true;

    const message = error instanceof Error ? error.message : String(error);
    this.#store.finishArchive(this.#archiveId, 'failed', this.#pages, message);
    await this.#store.flush().catch(() => undefined);

    this.#logger.error(
      { archiveId: this.#archiveId, producer: this.#options.producer, err: error },
      'archive failed',
    );
  }
}
