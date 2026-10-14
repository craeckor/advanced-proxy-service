import type { Readable } from 'node:stream';
import type { UpstreamClient } from '../proxy/upstream.ts';
import { buildPassthroughRequestHeaders } from '../proxy/headers/request.ts';
import type { Config } from '../config.ts';

/**
 * Minimal robots.txt cache implementing the RFC 9309 matching rules.
 *
 * RFC 9309 standardises only `user-agent`, `allow` and `disallow`. Precedence is
 * longest-match-wins, and an `Allow` line wins a tie against an equal-length
 * `Disallow` — getting that backwards is the usual way a crawler accidentally
 * ignores a site's wishes.
 *
 * When `respect` is false every request is allowed and no fetch is made at all.
 */
export class RobotsCache {
  readonly #upstream: UpstreamClient;
  readonly #config: Config;
  readonly #respect: boolean;
  readonly #cache = new Map<string, { rules: RobotsRules; expiresAt: number }>();
  readonly #ttlMs = 10 * 60 * 1000;

  constructor(upstream: UpstreamClient, respect: boolean, config?: Config) {
    this.#upstream = upstream;
    this.#respect = respect;
    this.#config = config ?? ({ proxy: { timeoutMs: 10_000 } } as Config);
  }

  async allowed(target: URL): Promise<boolean> {
    if (!this.#respect) return true;

    const origin = target.origin;
    const cached = this.#cache.get(origin);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.rules.isAllowed(target.pathname + target.search);
    }

    const rules = await this.#load(origin);
    this.#cache.set(origin, { rules, expiresAt: Date.now() + this.#ttlMs });
    return rules.isAllowed(target.pathname + target.search);
  }

  async #load(origin: string): Promise<RobotsRules> {
    const robotsUrl = new URL('/robots.txt', origin);
    try {
      const headers = buildPassthroughRequestHeaders({}, robotsUrl, this.#config.proxy);
      const response = await this.#upstream.fetch(robotsUrl, { method: 'GET', headers });
      if (response.status !== 200 || response.body === null) return RobotsRules.allowAll();

      const text = await readText(response.body, 100 * 1024);
      return RobotsRules.parse(text);
    } catch {
      // An unreachable robots.txt is treated as permissive, matching what every
      // major crawler does: a 404 does not mean "do not crawl".
      return RobotsRules.allowAll();
    }
  }
}

interface RobotsRule {
  allow: boolean;
  path: string;
  /** Number of octets in the path, per RFC 9309's match-length rule. */
  length: number;
}

export class RobotsRules {
  readonly #rules: RobotsRule[];

  private constructor(rules: RobotsRule[]) {
    this.#rules = rules;
  }

  static allowAll(): RobotsRules {
    return new RobotsRules([]);
  }

  static parse(text: string, userAgent: string = '*'): RobotsRules {
    const rules: RobotsRule[] = [];
    let applies = false;
    let sawDirective = false;

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, '').trim();
      if (line === '') continue;

      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const field = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();

      if (field === 'user-agent') {
        // A new group starts; only its rules apply if the agent matches.
        applies = value === '*' || userAgent.toLowerCase().includes(value.toLowerCase());
        sawDirective = false;
        continue;
      }
      if (!applies) continue;

      if (field === 'allow' || field === 'disallow') {
        // An empty Disallow means "allow everything" and contributes no rule.
        if (field === 'disallow' && value === '') {
          sawDirective = true;
          continue;
        }
        if (value === '') continue;
        sawDirective = true;
        rules.push({ allow: field === 'allow', path: value, length: value.length });
      }
    }

    // A group with no allow/disallow at all is permissive.
    return sawDirective ? new RobotsRules(rules) : RobotsRules.allowAll();
  }

  isAllowed(path: string): boolean {
    let best: RobotsRule | null = null;
    for (const rule of this.#rules) {
      if (!matchesPath(rule.path, path)) continue;
      if (best === null || rule.length > best.length) {
        best = rule;
        continue;
      }
      // Tie on length: Allow wins, per RFC 9309.
      if (rule.length === best.length && rule.allow) best = rule;
    }
    return best === null ? true : best.allow;
  }
}

/** RFC 9309 path matching, including `*` wildcards and `$` end anchors. */
function matchesPath(pattern: string, path: string): boolean {
  if (pattern === '') return false;

  let regexSource = '^';
  for (const char of pattern) {
    if (char === '*') regexSource += '[\\s\\S]*';
    else if (char === '$') regexSource += '$';
    else regexSource += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }

  try {
    return new RegExp(regexSource).test(path);
  } catch {
    return false;
  }
}

async function readText(stream: Readable, limit: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const value = chunk as Uint8Array;
      total += value.byteLength;
      if (total > limit) {
        stream.destroy();
        break;
      }
      chunks.push(value);
    }
  } catch {
    // Use whatever was read before the failure.
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(merged);
}
