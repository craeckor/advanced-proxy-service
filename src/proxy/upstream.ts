import type { Readable } from 'node:stream';
import { Pool, type Dispatcher } from 'undici';
import type { Config } from '../config.ts';
import { resolveAndValidate, BlockedDestinationError } from './security/ssrf.ts';

/**
 * A request body for an upstream call.
 *
 * A Node `Readable` rather than a web `ReadableStream`: undici accepts the
 * former natively, and `Readable.fromWeb` is a cheap adapter, whereas a web
 * stream relies on undici's own experimental web-stream support.
 */
export type UpstreamBody = Readable;

export interface UpstreamResponse {
  status: number;
  headers: Headers;
  /**
   * undici hands back a Node `Readable`, not a web `ReadableStream`, so the
   * plumbing here stays on Node streams throughout rather than converting at
   * every boundary.
   */
  body: Readable | null;
}

export interface UpstreamRequestOptions {
  method: string;
  headers: Headers;
  body?: UpstreamBody | null;
  signal?: AbortSignal;
}

/**
 * Pooled HTTP client for upstream requests.
 *
 * Pools are keyed per origin so that connection reuse and socket limits are
 * scoped to each target host rather than shared globally, which is what keeps
 * one slow origin from starving the others.
 *
 * Note what this deliberately does *not* use: the `http-proxy` family. That
 * package carries an unpatched CL.TE request-smuggling vulnerability in its
 * `deleteLength` pass (unfixed upstream as of 1.18.1) and is effectively
 * abandoned. undici is the Node project's own client and is actively maintained.
 */
export class UpstreamClient {
  readonly #pools = new Map<string, Pool>();
  readonly #config: Config;

  constructor(config: Config) {
    this.#config = config;
  }

  /** Send a request to an absolute target URL. */
  async fetch(target: URL, options: UpstreamRequestOptions): Promise<UpstreamResponse> {
    const pinned = await resolveAndValidate(target, this.#config.security);
    const pool = this.#poolFor(target, pinned?.address);

    // Redirects are deliberately not followed: a proxy must hand the caller the
    // origin's actual 3xx so the Location header can be rewritten and the client
    // stays on the proxy. Following internally would hide the hop and strand the
    // browser on the real origin.
    const response = await pool.request({
      method: options.method as Dispatcher.HttpMethod,
      path: `${target.pathname}${target.search}`,
      headers: Object.fromEntries(options.headers.entries()),
      ...(options.body ? { body: options.body } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    return {
      status: response.statusCode,
      headers: headersFromUndici(response.headers),
      body: response.body as unknown as Readable,
    };
  }

  /** A low-level request used by the archiver, which needs the raw stream. */
  async rawRequest(
    target: URL,
    options: UpstreamRequestOptions,
  ): Promise<{ status: number; headers: Headers; body: Dispatcher.ResponseData['body'] }> {
    const pinned = await resolveAndValidate(target, this.#config.security);
    const response = await this.#poolFor(target, pinned?.address).request({
      method: options.method as Dispatcher.HttpMethod,
      path: `${target.pathname}${target.search}`,
      headers: Object.fromEntries(options.headers.entries()),
      ...(options.body ? { body: options.body } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    return {
      status: response.statusCode,
      headers: headersFromUndici(response.headers),
      body: response.body,
    };
  }

  /** Close every pooled connection. Called during graceful shutdown. */
  async close(): Promise<void> {
    const pools = [...this.#pools.values()];
    this.#pools.clear();
    await Promise.allSettled(pools.map((pool) => pool.close()));
  }

  #poolFor(target: URL, pinnedAddress?: string): Pool {
    const key = `${target.protocol}//${pinnedAddress ?? target.hostname}:${target.port || defaultPort(target.protocol)}`;
    let pool = this.#pools.get(key);
    if (pool === undefined) {
      pool = new Pool(key, {
        connections: this.#config.proxy.maxSocketsPerOrigin,
        headersTimeout: this.#config.proxy.timeoutMs,
        bodyTimeout: this.#config.proxy.timeoutMs,
        // TLS still validates against the real hostname even when the TCP
        // connection is pinned to an address, so pinning does not weaken it.
        ...(pinnedAddress !== undefined && target.protocol === 'https:'
          ? { connect: { servername: target.hostname } }
          : {}),
      });
      this.#pools.set(key, pool);
    }
    return pool;
  }
}

function defaultPort(protocol: string): string {
  return protocol === 'https:' ? '443' : '80';
}

/**
 * Convert undici's flat response headers into a `Headers` instance, preserving
 * repeated `set-cookie` values which a plain object would collapse.
 */
function headersFromUndici(raw: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const entry of values) {
      try {
        headers.append(name, entry);
      } catch {
        // Skip malformed headers rather than failing the whole response.
      }
    }
  }
  return headers;
}

export { BlockedDestinationError };
export type { Dispatcher };
