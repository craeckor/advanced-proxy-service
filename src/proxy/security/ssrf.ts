import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import type { SecurityConfig } from '../../config.ts';

/**
 * SSRF and DNS-rebinding defences.
 *
 * These are config-gated and **off by default** by project decision. The code
 * lives here fully implemented rather than being retrofitted later, so enabling
 * protection is a one-line config change rather than a new feature.
 *
 * The threat model being defended against: this proxy fetches arbitrary
 * user-supplied URLs on the server's behalf, which is the textbook SSRF shape.
 * Without a check, a caller can reach cloud metadata endpoints, internal admin
 * panels, and anything else routable from the server.
 */

/** IPv4 ranges that must never be reachable through an open proxy. */
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, includes 169.254.169.254 metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
];

/** IPv6 prefixes that must never be reachable through an open proxy. */
const BLOCKED_V6_PREFIXES: readonly string[] = [
  '::', // unspecified
  '::1', // loopback
  'fc', // unique local fc00::/7
  'fd', // unique local fc00::/7
  'fe8', // link-local fe80::/10
  'fe9',
  'fea',
  'feb',
  'ff', // multicast
  '2001:db8', // documentation
];

export class BlockedDestinationError extends Error {
  override readonly name = 'BlockedDestinationError';
  readonly hostname: string;

  constructor(message: string, hostname: string) {
    super(message);
    this.hostname = hostname;
  }
}

export interface ResolvedDestination {
  /** The address the connection must be pinned to. */
  address: string;
  family: number;
}

/**
 * Validate a target URL and resolve it to a pinned address.
 *
 * The resolution happens **once** and the resulting address is returned for the
 * caller to connect to. Re-resolving later would reopen the TOCTOU gap that DNS
 * rebinding depends on: an attacker's record can return a harmless address
 * during validation and an internal one microseconds later at connect time.
 */
export async function resolveAndValidate(
  target: URL,
  config: SecurityConfig,
): Promise<ResolvedDestination | null> {
  if (!config.enabled) return null;

  const hostname = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (config.blockedHosts.includes(hostname)) {
    throw new BlockedDestinationError(`Host "${hostname}" is blocked by configuration`, hostname);
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new BlockedDestinationError(`Host "${hostname}" is a local address`, hostname);
  }

  // A literal IP needs no lookup and must be checked directly.
  if (isIP(hostname) !== 0) {
    if (config.blockPrivateRanges && isBlockedAddress(hostname, config)) {
      throw new BlockedDestinationError(`Address ${hostname} is in a blocked range`, hostname);
    }
    return { address: hostname, family: isIP(hostname) };
  }

  let results: Array<{ address: string; family: number }>;
  try {
    results = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new BlockedDestinationError(`Could not resolve "${hostname}"`, hostname);
  }
  if (results.length === 0) {
    throw new BlockedDestinationError(`Could not resolve "${hostname}"`, hostname);
  }

  // Every returned address must be acceptable; if any one resolves into a
  // blocked range the whole destination is refused, so a DNS record that mixes
  // one public and one private answer cannot be used to slip past.
  for (const entry of results) {
    if (config.blockPrivateRanges && isBlockedAddress(entry.address, config)) {
      throw new BlockedDestinationError(
        `"${hostname}" resolves to ${entry.address}, which is in a blocked range`,
        hostname,
      );
    }
  }

  const chosen = results[0];
  if (chosen === undefined) {
    throw new BlockedDestinationError(`Could not resolve "${hostname}"`, hostname);
  }
  return { address: chosen.address, family: chosen.family };
}

/** True when an IP literal falls inside any blocked range. */
export function isBlockedAddress(address: string, config: SecurityConfig): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedV4(address) || matchesExtraCidrs(address, config);
  if (family === 6) return isBlockedV6(address) || matchesExtraCidrs(address, config);
  return true; // unparseable: refuse rather than guess
}

function isBlockedV4(address: string): boolean {
  const value = ipv4ToInt(address);
  if (value === null) return true;
  return BLOCKED_V4.some(([base, bits]) => {
    const baseValue = ipv4ToInt(base);
    if (baseValue === null) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((value & mask) >>> 0) === ((baseValue & mask) >>> 0);
  });
}

function isBlockedV6(address: string): boolean {
  const normalized = address.toLowerCase();
  // IPv4-mapped addresses must be judged on the embedded IPv4 address, or
  // ::ffff:127.0.0.1 would sail straight through.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped?.[1]) return isBlockedV4(mapped[1]);
  return BLOCKED_V6_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function matchesExtraCidrs(address: string, config: SecurityConfig): boolean {
  for (const cidr of config.blockedCidrs) {
    const [base, bitsRaw] = cidr.split('/');
    if (base === undefined) continue;
    const bits = Number.parseInt(bitsRaw ?? '128', 10);
    if (Number.isNaN(bits)) continue;

    if (isIP(base) === 4 && isIP(address) === 4) {
      const value = ipv4ToInt(address);
      const baseValue = ipv4ToInt(base);
      if (value === null || baseValue === null) continue;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if (((value & mask) >>> 0) === ((baseValue & mask) >>> 0)) return true;
    }
  }
  return false;
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number.parseInt(part, 10);
    if (Number.isNaN(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}
