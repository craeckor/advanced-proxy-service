import { parse, generate, walk } from 'css-tree';
import { proxyUrlFor, type CodecName } from './codec.ts';

export interface CssRewriteOptions {
  codec: CodecName;
  baseUrl: string;
  /**
   * Path prefix rewritten URLs are generated under.
   *
   * Archive replay sets this so rewritten links stay inside the archive instead
   * of pointing at the live proxy route, which would silently reach the network
   * during an offline replay.
   */
  prefix?: string;
  /**
   * Parse as a declaration list rather than a full stylesheet.
   *
   * This matters for inline `style=""` attributes, whose content is
   * `background:url(x)` with no selector or braces — parsing that as a
   * stylesheet throws, which would silently leave every inline style unrewritten.
   */
  declarations?: boolean;
}

/**
 * Rewrite URLs inside a stylesheet or an inline style attribute.
 *
 * Uses a real CSS parser rather than a `url\(...\)` regex. Regexes on CSS
 * reliably break on quoting variants, escapes, comments and `data:` payloads,
 * and a failed rewrite here shows up as a page with no images or fonts.
 *
 * A parse failure returns the input unchanged: shipping a stylesheet that is
 * merely unrewritten is far better than shipping a corrupted one.
 */
export function rewriteCss(input: string, options: CssRewriteOptions): string {
  if (!input.includes('url(') && !input.includes('@import')) return input;

  const declarationMode = options.declarations === true;

  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(input, {
      context: declarationMode ? 'declarationList' : 'stylesheet',
      positions: false,
      // Custom properties must be parsed as real values, not kept as raw text.
      // With this off, a `--menu-tab-icon: url(/static/client/a.svg)` declaration
      // is an opaque `Raw` node, the `Url` visitor never sees the URL inside it,
      // and the reference is left relative. It then resolves against the serving
      // origin rather than the target — during a replay that is the proxy's own
      // root, so a page requests `/static/client/a.svg` and 404s, and on the live
      // proxy it reaches the real origin, which is the leak this exists to close.
      //
      // This is not an edge case: custom properties are the standard way to hold
      // an icon or background URL for reuse, and MDN's own stylesheet stores its
      // menu icons this way. Parsing them is also what makes the *rewritten*
      // value usable, because a `var()` reference then resolves to the already
      // proxied URL rather than to a bare path.
      parseCustomProperty: true,
      onParseError: () => {
        throw new Error('css parse error');
      },
    });
  } catch {
    return input;
  }

  try {
    walk(ast, {
      visit: 'Url',
      enter(node) {
        const value = node.value;
        if (typeof value !== 'string') return;
        const rewritten = rewriteOne(value, options);
        if (rewritten !== null) node.value = rewritten;
      },
    });

    walk(ast, {
      visit: 'Atrule',
      enter(node) {
        if (node.name.toLowerCase() !== 'import') return;
        // The prelude of `@import` is an AtrulePrelude whose children hold the
        // target as a `String` (bareword form) or `Url` (already handled above),
        // optionally followed by a media query list.
        const prelude = node.prelude;
        if (!prelude || prelude.type !== 'AtrulePrelude') return;

        for (const child of prelude.children) {
          if (child.type !== 'String' || typeof child.value !== 'string') continue;
          const rewritten = rewriteOne(child.value, options);
          if (rewritten !== null) child.value = rewritten;
          break;
        }
      },
    });

    return generate(ast);
  } catch {
    return input;
  }
}

/** Rewrite one URL reference, or null when it should be left alone. */
function rewriteOne(value: string, options: CssRewriteOptions): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  // Fragments, data URIs and other opaque schemes are not proxied resources.
  if (trimmed.startsWith('#') || trimmed.startsWith('data:')) return null;
  return proxyUrlFor(options.codec, options.baseUrl, trimmed, options.prefix);
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export { stripQuotes };
