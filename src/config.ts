import { z } from 'zod';

/**
 * Configuration schema. Every value has a default so the service can start with
 * no configuration file at all.
 */

const SecuritySchema = z.object({
  /**
   * SSRF and DNS-rebinding defences.
   *
   * Disabled by default by project decision. When enabled, destinations are
   * resolved once, validated against the blocked ranges, and the connection is
   * pinned to that validated IP so a rebinding attack cannot swap it afterwards.
   */
  enabled: z.boolean().default(false),
  /** Block loopback, private, link-local and cloud-metadata address ranges. */
  blockPrivateRanges: z.boolean().default(true),
  /** Extra CIDR ranges to refuse, on top of the built-in list. */
  blockedCidrs: z.array(z.string()).default([]),
  /** Hostnames that are always refused, matched case-insensitively. */
  blockedHosts: z.array(z.string()).default([]),
});

const ProxySchema = z.object({
  /** Codec used when a request does not name one. */
  defaultCodec: z.enum(['plain', 'b64']).default('plain'),
  /** Upstream request timeout, in milliseconds. */
  timeoutMs: z.number().int().positive().default(30_000),
  /** Largest response body buffered for rewriting, in bytes. */
  maxRewriteBytes: z.number().int().positive().default(10 * 1024 * 1024),
  /** Sockets kept per upstream origin. */
  maxSocketsPerOrigin: z.number().int().positive().default(64),
  /** Forward the client's own headers upstream (User-Agent and friends). */
  mimicClientHeaders: z.boolean().default(true),
  /**
   * Rebase prefixless requests onto the site behind their referer.
   *
   * Catches subresource requests that escape the rewriters because their path
   * is assembled at runtime, or because the shim never ran. It is a heuristic,
   * so it is switchable; see `src/proxy/rebasing.ts` for what qualifies.
   */
  resolveUnknownPaths: z.boolean().default(true),
});

const ArchiveSchema = z.object({
  /** Directory holding content-addressed blobs and the SQLite index. */
  dataDir: z.string().default('data'),
  /** Maximum crawl depth from the seed URL. */
  maxDepth: z.number().int().nonnegative().default(3),
  /** Maximum number of pages captured in one archive. */
  maxPages: z.number().int().positive().default(200),
  /** Maximum concurrent upstream requests during a crawl. */
  concurrency: z.number().int().positive().default(6),
  /** Delay between requests to the same host, in milliseconds. */
  politenessDelayMs: z.number().int().nonnegative().default(100),
  /** Honour robots.txt while crawling. */
  respectRobotsTxt: z.boolean().default(true),
  /** Capture cross-origin subresources as well as same-origin ones. */
  includeCrossOrigin: z.boolean().default(true),
  /** Compression applied to stored blobs. */
  compression: z.enum(['none', 'gzip', 'brotli']).default('gzip'),
  /**
   * Offer a query-variant page when the exact URL was not captured.
   *
   * Off by default. When on, a replay of an uncaptured URL whose query differs
   * from a captured one only at the end is *offered* that captured page: the
   * reader sees both URLs, the difference, and a choice. Accepting serves the
   * variant, labelled `x-archive-compat: substitute` and never presented as a hit.
   *
   * Nothing about this is an inference about the origin. Whether a trailing
   * parameter selects different content is a fact about the site, unverifiable
   * from two URLs, so the feature asks rather than decides — and never consults
   * the network. A deployment that promises an exact archive should leave it off.
   */
  compatMode: z.boolean().default(false),
  /** Maximum parameters a substitute's query may add or omit. */
  compatMaxExtra: z.number().int().nonnegative().default(8),
  /**
   * Query parameters whose presence is ignored on either side of the comparison.
   *
   * For identifiers the origin demonstrably ignores, where the reader's URL and
   * the captured one differ only by noise rather than by a value that selects
   * content. Listing one here is a claim about the origin, so it is empty by
   * default: the safe `&`-append rule needs no such claim and is what most
   * mismatches actually are.
   */
  compatIgnoreParams: z.array(z.string()).default([]),
  /**
   * Bearer token the SingleFile "REST Form API" destination must present.
   *
   * Empty — the default — accepts any token, which is only safe while the
   * endpoint is reachable by nobody but its operator. A deployment that exposes
   * this service must set it; see the README's "SingleFile REST Form API".
   */
  restFormToken: z.string().default(''),
  /**
   * Largest SingleFile upload accepted, in bytes.
   *
   * The destination buffers whole archives in one request and does not chunk, so
   * this is the only bound on it. A page with its images inlined is routinely
   * several megabytes and a large one can exceed a hundred.
   */
  restFormMaxBytes: z.number().int().positive().default(512 * 1024 * 1024),
  /**
   * Largest accepted length of the source-URL field, in bytes.
   *
   * Bounded separately from the payload because it becomes the archive's seed
   * and is stored per resource; an unbounded field is a cheap way to write a
   * megabyte per archived resource.
   */
  restFormMaxUrlBytes: z.number().int().positive().default(8192),
});

const ServerSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(0).max(65_535).default(8080),
  /** Milliseconds an idle keep-alive connection is held open. */
  keepAliveTimeoutMs: z.number().int().nonnegative().default(5_000),
  /** Milliseconds allowed for request headers to arrive. */
  headersTimeoutMs: z.number().int().nonnegative().default(60_000),
  /** Milliseconds to wait for in-flight requests during shutdown. */
  shutdownGraceMs: z.number().int().nonnegative().default(10_000),
});

const LogSchema = z.object({
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  /** Emit human-readable logs instead of JSON. */
  pretty: z.boolean().default(false),
});

/**
 * `prefault` rather than `default`: it supplies the value when the key is absent
 * from the input (which is what a partial config file looks like) instead of
 * requiring the caller to already have a fully-formed object.
 */
export const ConfigSchema = z.object({
  server: ServerSchema.prefault({}),
  proxy: ProxySchema.prefault({}),
  archive: ArchiveSchema.prefault({}),
  security: SecuritySchema.prefault({}),
  log: LogSchema.prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type SecurityConfig = z.infer<typeof SecuritySchema>;
export type ProxyConfig = z.infer<typeof ProxySchema>;
export type ArchiveConfig = z.infer<typeof ArchiveSchema>;
export type ServerConfig = z.infer<typeof ServerSchema>;

/** Parse and validate configuration, applying every default. */
export function parseConfig(input: unknown = {}): Config {
  const result = ConfigSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return result.data;
}

/** Load configuration from a JSON file, or return defaults when it is absent. */
export async function loadConfig(path?: string): Promise<Config> {
  if (!path) return parseConfig({});
  const { readFile } = await import('node:fs/promises');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return parseConfig({});
    throw error;
  }
  return parseConfig(JSON.parse(raw));
}
