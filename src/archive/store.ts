import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gzipSync, gunzipSync, brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import type { ArchiveConfig } from '../config.ts';

/**
 * Content-addressed blob store plus a SQLite index.
 *
 * Blobs are named by the SHA-256 of their *uncompressed* bytes, so the same
 * asset captured from two different pages is stored exactly once and its
 * integrity can be checked by re-hashing. The index is a plain SQLite database
 * via Node's built-in `node:sqlite`, which needs no native build step.
 */

export interface ArchiveRecord {
  archiveId: string;
  url: string;
  status: number;
  headers: Record<string, string>;
  contentType: string | null;
  /** SHA-256 of the uncompressed body. */
  blobHash: string;
  /** Compression actually applied to the stored blob. */
  compression: 'none' | 'gzip' | 'brotli';
  /** Size of the uncompressed body in bytes. */
  size: number;
  capturedAt: string;
}

export interface ArchiveMeta {
  id: string;
  seedUrl: string;
  createdAt: string;
  status: 'running' | 'complete' | 'failed';
  pages: number;
  /** Resources stored in this archive. Derived from the index, not stored. */
  resources: number;
  /**
   * Sum of every resource's size, in bytes.
   *
   * Uncompressed, which is what the recorded `size` means, so it is the size of
   * what a replay hands back rather than what the blob occupies on disk. Two
   * reasons to report that one: it is comparable between archives regardless of
   * the compression they were stored with, and it is the same figure
   * `ArchiveBuildResult.bytes` already reports at the end of a build — so the
   * number a caller saw when the archive finished is the number it sees later.
   */
  bytes: number;
  error?: string;
}

/** One stored resource, as listed by `GET /api/archives/<id>`. */
export interface ResourceMeta {
  url: string;
  /** The status the origin answered with when this was captured. */
  status: number;
  contentType: string | null;
  /** Uncompressed body size in bytes, matching the archive's total. */
  size: number;
  capturedAt: string;
}

/**
 * Build an archive's metadata from one aggregated row.
 *
 * Shared by the single-archive and list queries so the two cannot report the
 * same archive differently — they select the same columns by hand, and a field
 * added to one and not the other is a defect that would only show up as a
 * missing key in one of the two responses.
 */
function toMeta(row: Record<string, unknown>): ArchiveMeta {
  return {
    id: String(row['id']),
    seedUrl: String(row['seed_url']),
    createdAt: String(row['created_at']),
    status: String(row['status']) as ArchiveMeta['status'],
    pages: Number(row['pages']),
    resources: Number(row['resources']),
    bytes: Number(row['bytes']),
    ...(row['error'] ? { error: String(row['error']) } : {}),
  };
}

export class ArchiveStore {
  readonly #config: ArchiveConfig;
  readonly #db: DatabaseSync;
  readonly #blobDir: string;
  /** Hash -> compressed bytes, so a crawl does not recompress a shared asset. */
  readonly #pending = new Map<string, Buffer>();

  private constructor(config: ArchiveConfig, db: DatabaseSync, blobDir: string) {
    this.#config = config;
    this.#db = db;
    this.#blobDir = blobDir;
  }

  static async open(config: ArchiveConfig): Promise<ArchiveStore> {
    const root = config.dataDir;
    const blobDir = join(root, 'blobs');
    await mkdir(blobDir, { recursive: true });
    await mkdir(join(root, 'archives'), { recursive: true });

    const db = new DatabaseSync(join(root, 'index.sqlite'));
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS archives (
        id         TEXT PRIMARY KEY,
        seed_url   TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status     TEXT NOT NULL,
        pages      INTEGER NOT NULL DEFAULT 0,
        error      TEXT
      );

      CREATE TABLE IF NOT EXISTS resources (
        archive_id   TEXT NOT NULL,
        url          TEXT NOT NULL,
        status       INTEGER NOT NULL,
        headers      TEXT NOT NULL,
        content_type TEXT,
        blob_hash    TEXT NOT NULL,
        compression  TEXT NOT NULL,
        size         INTEGER NOT NULL,
        captured_at  TEXT NOT NULL,
        PRIMARY KEY (archive_id, url),
        FOREIGN KEY (archive_id) REFERENCES archives(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_resources_blob ON resources(blob_hash);
    `);

    return new ArchiveStore(config, db, blobDir);
  }

  createArchive(id: string, seedUrl: string): void {
    this.#db
      .prepare('INSERT INTO archives (id, seed_url, created_at, status, pages) VALUES (?, ?, ?, ?, 0)')
      .run(id, seedUrl, new Date().toISOString(), 'running');
  }

  finishArchive(id: string, status: ArchiveMeta['status'], pages: number, error?: string): void {
    this.#db
      .prepare('UPDATE archives SET status = ?, pages = ?, error = ? WHERE id = ?')
      .run(status, pages, error ?? null, id);
  }

  /**
   * One archive's metadata, with its resource count and total size.
   *
   * The count and the size are aggregated from the index rather than stored on
   * the archive row. That is not only to avoid a migration on existing
   * databases: a stored total is a second source of truth for something the
   * index already knows, and the two drift the first time a resource is written
   * without the row being updated. The aggregation is one indexed lookup on the
   * primary key.
   */
  getArchive(id: string): ArchiveMeta | null {
    const row = this.#db
      .prepare(
        `SELECT a.id, a.seed_url, a.created_at, a.status, a.pages, a.error,
                COUNT(r.url) AS resources,
                COALESCE(SUM(r.size), 0) AS bytes
           FROM archives a
           LEFT JOIN resources r ON r.archive_id = a.id
          WHERE a.id = ?
          GROUP BY a.id`,
      )
      .get(id) as Record<string, unknown> | undefined;
    return row === undefined ? null : toMeta(row);
  }

  /**
   * Every archive, newest first, each with its resource count and total size.
   *
   * Aggregated in the same statement as the archive rows rather than by a query
   * per archive: the list is what a client polls while a crawl runs, and an N+1
   * here would make the cost of listing grow with the number of archives at
   * exactly the moment there are most of them.
   */
  listArchives(): ArchiveMeta[] {
    const rows = this.#db
      .prepare(
        `SELECT a.id, a.seed_url, a.created_at, a.status, a.pages, a.error,
                COUNT(r.url) AS resources,
                COALESCE(SUM(r.size), 0) AS bytes
           FROM archives a
           LEFT JOIN resources r ON r.archive_id = a.id
          GROUP BY a.id
          ORDER BY a.created_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(toMeta);
  }

  /** Store a response body and record its index entry. */
  async put(
    archiveId: string,
    url: string,
    status: number,
    headers: Record<string, string>,
    contentType: string | null,
    body: Uint8Array,
  ): Promise<ArchiveRecord> {
    const hash = createHash('sha256').update(body).digest('hex');
    const compression = this.#config.compression;

    if (!this.#pending.has(hash) && !(await this.#blobExists(hash))) {
      const compressed = compress(Buffer.from(body), compression);
      // Stage it first; a shared asset will be written by whichever capture
      // finishes first and the rest will find it already present.
      this.#pending.set(hash, compressed);
    }

    const record: ArchiveRecord = {
      archiveId,
      url,
      status,
      headers,
      contentType,
      blobHash: hash,
      compression,
      size: body.byteLength,
      capturedAt: new Date().toISOString(),
    };

    this.#db
      .prepare(
        `INSERT INTO resources (archive_id, url, status, headers, content_type, blob_hash, compression, size, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(archive_id, url) DO UPDATE SET
           status = excluded.status, headers = excluded.headers, content_type = excluded.content_type,
           blob_hash = excluded.blob_hash, compression = excluded.compression, size = excluded.size,
           captured_at = excluded.captured_at`,
      )
      .run(
        record.archiveId,
        record.url,
        record.status,
        JSON.stringify(record.headers),
        record.contentType,
        record.blobHash,
        record.compression,
        record.size,
        record.capturedAt,
      );

    return record;
  }

  /** Flush staged blobs to disk. Call once at the end of a crawl. */
  async flush(): Promise<number> {
    let written = 0;
    for (const [hash, bytes] of this.#pending) {
      const path = this.#blobPath(hash);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
      written += 1;
    }
    this.#pending.clear();
    return written;
  }

  /** Look up a captured resource by archive and URL. */
  async get(archiveId: string, url: string): Promise<{ record: ArchiveRecord; body: Uint8Array } | null> {
    const row = this.#db
      .prepare('SELECT * FROM resources WHERE archive_id = ? AND url = ?')
      .get(archiveId, url) as Record<string, unknown> | undefined;
    if (row === undefined) return null;

    const record: ArchiveRecord = {
      archiveId: String(row['archive_id']),
      url: String(row['url']),
      status: Number(row['status']),
      headers: JSON.parse(String(row['headers'])) as Record<string, string>,
      contentType: row['content_type'] === null ? null : String(row['content_type']),
      blobHash: String(row['blob_hash']),
      compression: String(row['compression']) as ArchiveRecord['compression'],
      size: Number(row['size']),
      capturedAt: String(row['captured_at']),
    };

    const body = await this.#readBlob(record.blobHash, record.compression);
    return body === null ? null : { record, body };
  }

  /** Every URL captured in an archive, for coverage reporting. */
  urls(archiveId: string): string[] {
    return this.resources(archiveId).map((resource) => resource.url);
  }

  /**
   * Every resource in an archive, with its size and the rest of the stored facts.
   *
   * Named `resources` rather than `urls` because that is what it returns: `urls`
   * is kept as the thin projection callers actually want when they only need the
   * addresses, and it is derived from this so the two cannot disagree about
   * which resources exist.
   *
   * Ordered by URL so the listing is stable across calls. The index has no
   * insertion order to offer — the primary key is `(archive_id, url)` and the
   * rows come back in whatever order the query planner picks — so sorting here
   * is what makes the output diffable between two calls.
   */
  resources(archiveId: string): ResourceMeta[] {
    const rows = this.#db
      .prepare(
        `SELECT url, status, content_type, size, captured_at
           FROM resources
          WHERE archive_id = ?
          ORDER BY url`,
      )
      .all(archiveId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      url: String(row['url']),
      status: Number(row['status']),
      contentType: row['content_type'] === null ? null : String(row['content_type']),
      size: Number(row['size']),
      capturedAt: String(row['captured_at']),
    }));
  }

  /**
   * Every stored URL whose query differs from `url`'s only at the end.
   *
   * The relation is: split both queries into parameters; one list must be a
   * parameter-for-parameter prefix of the other. `q=x&udm=50` and
   * `q=x&udm=50&sei=abc` qualify; `q=x&udm=50` and `q=x&tbm=nws` do not, because
   * the lists diverge at the second parameter and everything after a divergence
   * reads differently.
   *
   * **This is a guess, and both directions of it are.** An earlier version of this
   * function claimed the superset direction was sound — that a stored URL with
   * *more* parameters proves the extras were ignored, so the page still answers
   * the reader's question. That claim was wrong, and backwards: a stored URL
   * carrying `&tbm=nws` that the reader never asked for serves *news results* for
   * a general search, which is precisely the failure the claim was meant to rule
   * out. Neither direction is guaranteed, because whether a trailing parameter
   * selects content is a fact about the origin that nothing here can verify.
   *
   * What makes it usable anyway is that the substitution is never automatic and
   * never silent. It is offered with both URLs shown and the difference counted,
   * the reader decides, and every substituted response is labelled
   * `x-archive-compat: substitute`. The honest version of this feature is a
   * question, not an inference.
   *
   * `mayDrop` names parameters removed from both sides first, for an origin that
   * demonstrably ignores a cache-buster or tracking id. It is empty by default,
   * because listing one is that same unverifiable claim.
   *
   * Candidates come back closest-first: fewest differing parameters, then the
   * smallest change in length.
   */
  candidates(
    archiveId: string,
    url: string,
    options: { mayDrop?: readonly string[]; maxExtra?: number } = {},
  ): string[] {
    const at = url.indexOf('?');
    // A query-less request cannot be a variant of a queried one, so a miss on a
    // bare path is a real miss.
    if (at === -1) return [];
    if (url.slice(at + 1) === '') return [];

    const base = url.slice(0, at);
    const mayDrop = options.mayDrop ?? [];
    const maxExtra = options.maxExtra ?? 8;
    const rows = this.#db
      .prepare("SELECT url FROM resources WHERE archive_id = ? AND url LIKE ? ESCAPE '\\'")
      .all(archiveId, `${escapeLike(base)}?%`) as Array<Record<string, unknown>>;

    const matched: Array<{ url: string; extra: number }> = [];
    for (const row of rows) {
      const stored = String(row['url']);
      const distance = queryVariantDistance(url, stored, mayDrop);
      if (distance === null || distance > maxExtra) continue;
      matched.push({ url: stored, extra: distance });
    }

    return matched
      .sort((a, b) => a.extra - b.extra || a.url.length - b.url.length)
      .map((entry) => entry.url);
  }

  /**
   * Read one of `candidates`' records.
   *
   * A thin alias for `get`, separated so the intent is legible at the call site:
   * the record's `url` is deliberately *not* the URL that was asked for, and
   * anything presenting it to a reader has to say so. Naming it `get` there would
   * make a substitute look like a hit.
   */
  getRecord(archiveId: string, url: string): Promise<{ record: ArchiveRecord; body: Uint8Array } | null> {
    return this.get(archiveId, url);
  }

  close(): void {
    this.#db.close();
  }

  async #blobExists(hash: string): Promise<boolean> {
    try {
      await stat(this.#blobPath(hash));
      return true;
    } catch {
      return false;
    }
  }

  async #readBlob(hash: string, compression: ArchiveRecord['compression']): Promise<Uint8Array | null> {
    const staged = this.#pending.get(hash);
    const raw = staged ?? (await readFile(this.#blobPath(hash)).catch(() => null));
    if (raw === null) return null;
    return decompress(raw, compression);
  }

  /** Two-level fan-out keeps any one directory from growing unbounded. */
  #blobPath(hash: string): string {
    return join(this.#blobDir, hash.slice(0, 2), hash);
  }
}

/**
 * How many parameters one query differs from the other by, or null if they are
 * not a parameter-for-parameter prefix of each other.
 *
 * Splitting on `&` and comparing element-wise is what makes the relation
 * meaningful: `q=x&udm=50` and `q=x&udm=50&sei=abc` agree on their first two
 * parameters, so the reader's filters survive the substitution. `q=x&udm=50` and
 * `q=x&tbm=nws` diverge at the second, and everything after a divergence reads
 * differently, so they are refused.
 *
 * This says nothing about whether the page an origin returns for one is the page
 * it returns for the other. Whether a trailing parameter selects content is a
 * fact about the origin, and no comparison of two URLs can establish it — which
 * is why the caller asks before serving anything.
 */
export function queryVariantDistance(
  requested: string,
  stored: string,
  mayDrop: readonly string[] = [],
): number | null {
  if (requested === stored) return 0;

  const left = parametersOf(requested, mayDrop);
  const right = parametersOf(stored, mayDrop);
  const shared = Math.min(left.length, right.length);

  // At least one parameter has to be shared for this to mean anything. Without
  // it the prefix test is vacuous: an empty list is a prefix of every list, so
  // `_=9` and `x=1` would look like variants purely because the first one's only
  // parameter was dropped as ignorable. That is not a near miss, it is a
  // different query.
  if (shared === 0) return null;

  for (let i = 0; i < shared; i += 1) {
    if (left[i] !== right[i]) return null;
  }
  if (left.length === right.length) return 0;
  return Math.max(left.length, right.length) - shared;
}

/**
 * A query's parameters, in order, with ignorable ones removed.
 */
function parametersOf(query: string, mayDrop: readonly string[]): string[] {
  const drop = new Set(mayDrop);
  return query.split('&').filter((pair) => {
    if (pair === '') return false;
    const equals = pair.indexOf('=');
    return !drop.has(equals === -1 ? pair : pair.slice(0, equals));
  });
}

/**
 * Is `request` the page at `page` asking for itself, with something appended?
 *
 * The relation behind a page that navigates to its own URL. Google's interstitial
 * rebuilds `location.href` and appends its retry marker — `&sei=<eid>` — and live
 * that is harmless, because the origin answers the URL it just built. Under a
 * replay the browser's URL is the archive's, so the marker lands outside the
 * encoded payload and the request arrives as "the page I am already on, plus one
 * parameter", which the capture does not hold.
 *
 * Compared parameter-by-parameter rather than as raw strings, so `a=1` is not
 * read as a prefix of `a=10`, and resolved to `origin + path + query` first so
 * that a fragment or a default port is not read as a difference.
 *
 * The direction is fixed: the request must be *at least* the page, so a page
 * navigating to a shorter URL — an ordinary "back" navigation, or a link to its
 * own parent path — is not a self-navigation.
 */
export function isSelfNavigation(
  page: string,
  request: string,
  mayDrop: readonly string[] = [],
): boolean {
  const here = comparableUrl(page);
  const there = comparableUrl(request);
  if (here === null || there === null) return false;

  const own = parametersOf(here, mayDrop);
  const asked = parametersOf(there, mayDrop);
  if (asked.length <= own.length) return false;
  for (let i = 0; i < own.length; i += 1) {
    if (own[i] !== asked[i]) return false;
  }
  return true;
}

/** `origin + pathname + search`, so a fragment or a default port cannot differ. */
function comparableUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

/** Escape a literal for a SQL `LIKE`, so a URL's own `%` is not a wildcard. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function compress(input: Buffer, compression: ArchiveConfig['compression']): Buffer {
  switch (compression) {
    case 'gzip':
      return gzipSync(input);
    case 'brotli':
      return brotliCompressSync(input);
    case 'none':
      return input;
  }
}

function decompress(input: Buffer, compression: ArchiveRecord['compression']): Uint8Array {
  switch (compression) {
    case 'gzip':
      return gunzipSync(input);
    case 'brotli':
      return brotliDecompressSync(input);
    case 'none':
      return input;
  }
}
