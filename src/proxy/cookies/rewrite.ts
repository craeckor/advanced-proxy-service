/**
 * Set-Cookie parsing and rewriting.
 *
 * The browser partitions cookies by the origin it is actually talking to — the
 * proxy — but the proxied site expects its own scoping. So `Domain` and `Path`
 * must be rewritten to the proxy's own, and a per-origin namespace has to be
 * applied to the cookie *name* so two different proxied sites sharing one
 * physical cookie jar cannot cross-contaminate.
 */

export interface ParsedCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  maxAge?: string;
  expires?: string;
  /** Attributes we do not interpret but must preserve verbatim. */
  rest: string[];
}

/**
 * Parse a single `Set-Cookie` value. Deliberately permissive: a malformed cookie
 * is rewritten on a best-effort basis rather than dropped, because dropping
 * `Set-Cookie` silently breaks logins in ways that are very hard to debug.
 */
export function parseSetCookie(input: string): ParsedCookie | null {
  const parts = splitCookieAttributes(input);
  const first = parts.shift();
  if (first === undefined) return null;

  const eq = first.indexOf('=');
  if (eq <= 0) return null;

  const cookie: ParsedCookie = {
    name: first.slice(0, eq).trim(),
    value: first.slice(eq + 1).trim(),
    secure: false,
    httpOnly: false,
    rest: [],
  };

  for (const part of parts) {
    const attrEq = part.indexOf('=');
    const key = (attrEq === -1 ? part : part.slice(0, attrEq)).trim().toLowerCase();
    const val = attrEq === -1 ? '' : part.slice(attrEq + 1).trim();

    switch (key) {
      case 'domain':
        cookie.domain = val;
        break;
      case 'path':
        cookie.path = val;
        break;
      case 'secure':
        cookie.secure = true;
        break;
      case 'httponly':
        cookie.httpOnly = true;
        break;
      case 'samesite':
        cookie.sameSite = val;
        break;
      case 'max-age':
        cookie.maxAge = val;
        break;
      case 'expires':
        cookie.expires = val;
        break;
      default:
        cookie.rest.push(part.trim());
    }
  }
  return cookie;
}

/** Split on `;` while respecting quoted values that may contain semicolons. */
function splitCookieAttributes(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of input) {
    if (char === '"') inQuotes = !inQuotes;
    if (char === ';' && !inQuotes) {
      out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter((s) => s !== '');
}

export interface CookieRewriteOptions {
  /** Path prefix every proxied cookie must be scoped under. */
  pathPrefix: string;
  /** Namespace applied to the cookie name, unique per proxied origin. */
  namespace: string;
  /** Whether the proxy itself is served over HTTPS. */
  proxyIsSecure: boolean;
}

/**
 * Rewrite one `Set-Cookie` value so the browser will accept and re-send it to
 * the proxy.
 *
 * `__Host-` and `__Secure-` prefixed cookies are a known limitation: the browser
 * enforces hard invariants on those names (exactly `Path=/`, no `Domain`) that
 * directly conflict with the scoping the proxy needs. We strip the prefix rather
 * than emit a cookie the browser will silently reject, which at least keeps the
 * value reachable — at the cost of the extra guarantees the prefix provided.
 */
export function rewriteSetCookie(input: string, options: CookieRewriteOptions): string | null {
  const cookie = parseSetCookie(input);
  if (cookie === null) return null;

  const hadHostPrefix = cookie.name.startsWith('__Host-');
  const hadSecurePrefix = cookie.name.startsWith('__Secure-');
  let name = cookie.name;
  if (hadHostPrefix || hadSecurePrefix) {
    name = name.replace(/^__(?:Host|Secure)-/, '');
  }

  const out: string[] = [`${options.namespace}${name}=${cookie.value}`];

  // Dropping Domain entirely makes the cookie host-only for the proxy, which is
  // exactly the isolation we want; an unmodified Domain would be rejected by the
  // browser as host-mismatched anyway.
  out.push(`Path=${options.pathPrefix}`);

  // Path=/ is required by the __Host- prefix, but we have already stripped that
  // prefix, so no special case is needed here.

  if (cookie.maxAge !== undefined) out.push(`Max-Age=${cookie.maxAge}`);
  if (cookie.expires !== undefined) out.push(`Expires=${cookie.expires}`);
  if (cookie.httpOnly) out.push('HttpOnly');

  const secure = cookie.secure || options.proxyIsSecure;
  if (secure) out.push('Secure');

  // The navigation context now looks cross-site relative to what the origin
  // author assumed, so a strict SameSite would stop the cookie being sent.
  // SameSite=None requires Secure, which is why the two are coupled here.
  if (secure) {
    out.push('SameSite=None');
  } else if (cookie.sameSite) {
    out.push(`SameSite=${cookie.sameSite}`);
  }

  for (const extra of cookie.rest) out.push(extra);

  return out.join('; ');
}

/**
 * Rewrite a `Cookie` request header, stripping the namespace the browser sent
 * back so the origin receives the names it originally set.
 */
export function rewriteCookieRequestHeader(
  headerValue: string,
  namespace: string,
): string {
  return headerValue
    .split(';')
    .map((pair) => {
      const trimmed = pair.trim();
      if (trimmed === '') return null;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) return trimmed;
      const name = trimmed.slice(0, eq);
      const value = trimmed.slice(eq + 1);
      return name.startsWith(namespace) ? `${name.slice(namespace.length)}=${value}` : `${name}=${value}`;
    })
    .filter((pair): pair is string => pair !== null)
    .join('; ');
}

/** Build the per-origin namespacing applied to cookie names. */
export function cookieNamespaceFor(origin: string): string {
  return `p_${Buffer.from(origin, 'utf8').toString('base64url')}_`;
}
