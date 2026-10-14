import { parse } from 'acorn';
import type { AnyNode, CallExpression, ImportExpression, NewExpression, Node } from 'acorn';
import { proxyUrlFor, proxyPathWithTargetPath, resolveTarget, type CodecName } from './codec.ts';

export interface JsRewriteOptions {
  codec: CodecName;
  baseUrl: string;
  /** Path prefix rewritten URLs are generated under; see `CssRewriteOptions`. */
  prefix?: string;
  /**
   * Emit proxy URLs whose path carries the target's directory.
   *
   * See `proxyPathInDirectoryFor`. It matters for a module in a subdirectory,
   * because its siblings resolve relative to the module and a flat proxied URL
   * has no directory to resolve them against; see `codec.ts` for the full
   * reasoning. It is off by default so that every existing caller — the CSS and
   * HTML rewriters, whose references resolve against a document that carries
   * its own directory in the browser — keeps the shorter form.
   */
  directoryForm?: boolean;
  /**
   * Rewrite `import.meta.url` into the proxied URL of this module.
   *
   * Only meaningful for JavaScript that actually is a module, and it is worth
   * being explicit about because the token is a module-only construct. See
   * `importMetaUrlRange` for why the rewrite is necessary at all.
   */
  rewriteImportMetaUrl?: boolean;
}

/** A string literal that denotes a location, tagged with how to interpret it. */
type UrlTarget = Node & {
  start: number;
  end: number;
  /**
   * True for module specifiers (`import`/`export` sources), which follow
   * specifier resolution rather than URL resolution.
   *
   * This has to be per-literal rather than per-file: one module routinely
   * contains both `import 'react'` (a bare name that must be left alone) and
   * `fetch('data.json')` (a relative location that must be routed).
   */
  specifier: boolean;
};

/**
 * Rewrite URLs in JavaScript source.
 *
 * This walks a real AST rather than doing text replacement. The naive approach —
 * swapping every occurrence of a URL literal — is unsafe specifically because it
 * destroys **write context**: `window.location.href = '/x'` contains the same
 * token sequence as a read, and blindly rewriting the left-hand side produces
 * `"/proxy/..." = '/x'`, which is a syntax error that takes the whole page down.
 *
 * Only string literals in argument position of known URL-taking APIs are
 * rewritten. Everything else is left untouched; the runtime shim catches the
 * dynamically constructed cases this cannot see.
 */
export function rewriteJs(input: string, options: JsRewriteOptions): string {
  // Cheap bail-out: most inline scripts contain no absolute URL at all.
  if (!looksLikeItMayContainUrl(input)) return input;

  let ast: Node;
  try {
    ast = parse(input, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowHashBang: true,
      // Do not enable ranges: edits are applied as (offset, length, text) tuples
      // collected during the walk and applied back-to-front afterwards.
    });
  } catch {
    // An inline script may be a fragment rather than a whole program. Shipping
    // it unrewritten is far better than rewriting it wrongly.
    try {
      ast = parse(input, {
        ecmaVersion: 'latest',
        sourceType: 'script',
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: true,
        allowHashBang: true,
      });
    } catch {
      return input;
    }
  }

  const edits: Array<{ start: number; end: number; text: string }> = [];

  walkAst(ast, (node) => {
    // `import.meta.url` is not a literal, so it is handled before the literal
    // path and never reaches it.
    const metaUrl = importMetaUrlRange(node);
    if (metaUrl !== null && options.rewriteImportMetaUrl === true) {
      const rewritten = options.directoryForm === true
        ? proxyPathWithTargetPath(options.codec, options.baseUrl, options.prefix)
        : proxyUrlFor(options.codec, null, options.baseUrl, options.prefix);
      if (rewritten !== null) {
        edits.push({
          start: metaUrl.start,
          end: metaUrl.end,
          // A string literal rather than a bare token: `import.meta.url` is a
          // URL and its readers expect one, so the replacement has to be too.
          text: `"${rewritten}"`,
        });
      }
    }

    const targets = urlArgumentLiterals(node);
    if (targets === null) return;

    for (const literal of targets) {
      if (!('start' in literal) || !('end' in literal)) continue;
      const start = literal.start as number;
      const end = literal.end as number;
      const raw = input.slice(start, end);      const { quote, value } = unquote(raw);
      if (value === null) continue;

      const isTemplate = quote === '`';
      if (isTemplate && raw.includes('${')) continue; // dynamic: leave to the shim

      if (literal.specifier && !isRewritableSpecifier(value)) continue;

      const rewritten = options.directoryForm === true
        ? proxyPathWithTargetPath(options.codec, resolveTarget(options.baseUrl, value) ?? value, options.prefix)
        : proxyUrlFor(options.codec, options.baseUrl, value, options.prefix);
      if (rewritten === null) continue;

      edits.push({
        start,
        end,
        text: `${quote}${escapeFor(rewritten, quote)}${quote}`,
      });
    }
  });

  if (edits.length === 0) return input;

  // Apply back-to-front so earlier offsets stay valid.
  edits.sort((a, b) => b.start - a.start);
  let out = input;
  for (const edit of edits) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

/**
 * Decide which arguments of a call are URL positions.
 *
 * `fetch(url)` and `fetch(url, init)` take the URL first, but
 * `XMLHttpRequest.open(method, url)` takes it **second** — getting that index
 * wrong silently rewrites the HTTP method into a URL, which is exactly the kind
 * of bug that only shows up as a broken request at runtime.
 */
function urlArgumentLiterals(node: AnyNode): UrlTarget[] | null {
  switch (node.type) {
    case 'CallExpression': {
      const call = node as CallExpression;
      const name = calleeName(call.callee as AnyNode);
      if (name === null) return null;

      switch (name) {
        case 'fetch':
        case 'importScripts':
        case 'sendBeacon':
          return literalAt(call, 0);
        case 'open':
          // XMLHttpRequest.prototype.open(method, url[, async, user, password])
          return literalAt(call, 1);
        default:
          return null;
      }
    }
    case 'NewExpression': {
      const created = node as NewExpression;
      const name = calleeName(created.callee as AnyNode);
      // WebSocket is deliberately absent: it is not an HTTP resource and the
      // runtime shim owns its routing.
      if (name === 'Worker' || name === 'SharedWorker' || name === 'EventSource') {
        return literalAt(created, 0);
      }
      return null;
    }
    case 'ImportExpression': {
      const expression = (node as ImportExpression).source as AnyNode;
      return literalAsTarget(expression, true);
    }
    // Static module declarations. Browsers resolve these against the *module's
    // own URL*, not the document, so an unrewritten `./chunk-X.js` in a module
    // served from /proxy/plain/<encoded> resolves to /proxy/plain/chunk-X.js
    // and 404s. Code-split bundles are almost entirely static imports, so
    // missing these breaks every modern build output.
    case 'ImportDeclaration':
    case 'ExportNamedDeclaration':
    case 'ExportAllDeclaration': {
      const source = (node as { source?: AnyNode | null }).source;
      if (source === undefined || source === null) return null;
      return literalAsTarget(source, true);
    }
    default:
      return null;
  }
}

/**
 * The text range an `import.meta.url` member expression occupies, if this node
 * is one.
 *
 * `import.meta.url` is the module's own URL, and a build runtime reads it to
 * discover where its chunks live. Left unrewritten it reports the *proxied*
 * URL, whose directory is the payload's — so a runtime that strips the last
 * segment to form a public path gets `<prefix>/<codec>/` and asks for bare chunk
 * names that exist nowhere in the source and so cannot be rewritten as
 * specifiers. Its value is not a literal, so `urlArgumentLiterals` cannot see it.
 *
 * `.url` on `import.meta` is a read and never a write — `import.meta.url = x` is
 * a syntax error — so replacing the whole expression with a literal target is
 * safe in every position it can legally appear.
 */
function importMetaUrlRange(node: AnyNode): { start: number; end: number } | null {
  if (node.type !== 'MemberExpression') return null;

  const member = node as { object?: AnyNode; property?: AnyNode; computed?: boolean; start?: number; end?: number };
  if (member.computed === true) return null;
  if (member.start === undefined || member.end === undefined) return null;
  if ((member.property as { name?: string } | undefined)?.name !== 'url') return null;

  const object = member.object;
  if (object === undefined || object.type !== 'MetaProperty') return null;
  const meta = object as unknown as { meta?: { name?: string }; property?: { name?: string } };
  if (meta.meta?.name !== 'import' || meta.property?.name !== 'meta') return null;

  return { start: member.start, end: member.end };
}

/**
 * True when a module specifier should be routed through the proxy.
 *
 * Module specifiers are not documents: they are resolved against the importing
 * module, and bare ones are *names*, not locations. `import 'react'` must be left
 * alone — rewriting it makes the browser load a URL named "react" relative to the
 * module, which can never resolve. A specifier only denotes a location when it is
 * explicitly relative (`./`, `../`), explicitly rooted (`/`), or already absolute.
 */
export function isRewritableSpecifier(specifier: string): boolean {
  const trimmed = specifier.trim();
  if (trimmed === '') return false;

  if (/^[./]/.test(trimmed)) return true;
  return /^https?:\/\//i.test(trimmed) || trimmed.startsWith('//');
}

function literalAt(call: { arguments?: readonly Node[] }, index: number): UrlTarget[] | null {
  const argument = call.arguments?.[index];
  if (argument === undefined) return null;
  return literalAsTarget(argument as AnyNode, false);
}

function literalAsTarget(node: AnyNode, specifier: boolean): UrlTarget[] | null {
  if (!isLiteral(node)) return null;
  return [{ ...(node as Node & { start: number; end: number }), specifier }];
}

function isLiteral(node: AnyNode): boolean {
  return node.type === 'Literal' || node.type === 'TemplateLiteral';
}

function calleeName(node: AnyNode): string | null {
  if (node.type === 'Identifier') return (node as { name: string }).name;
  if (node.type === 'MemberExpression') {
    const property = (node as { property?: AnyNode; computed?: boolean }).property;
    if (property?.type === 'Identifier') return (property as { name: string }).name;
  }
  return null;
}

/** Split surrounding quotes off a literal, returning null if it is not simple. */
function unquote(raw: string): { quote: string; value: string | null } {
  const first = raw[0];
  if (first !== '"' && first !== "'" && first !== '`') return { quote: '"', value: null };
  if (raw.length < 2 || raw[raw.length - 1] !== first) return { quote: first, value: null };
  if (raw.includes('\\') || raw.includes('\n')) return { quote: first, value: null };
  return { quote: first, value: raw.slice(1, -1) };
}

function escapeFor(value: string, quote: string): string {
  if (quote === '"' || quote === "'") {
    return value.replaceAll(quote, `\\${quote}`).replaceAll('\\', '\\\\');
  }
  return value.replaceAll('`', '\\`').replaceAll('$', '\\$');
}

function looksLikeItMayContainUrl(input: string): boolean {
  return (
    input.includes('/') ||
    input.includes('http') ||
    input.includes('fetch') ||
    input.includes('Worker') ||
    input.includes('import')
  );
}

/**
 * Iterative AST walk. Recursion depth on adversarial input is not worth the
 * risk, and acorn trees are plain objects so a stack works fine.
 */
function walkAst(root: Node, visit: (node: AnyNode) => void): void {
  const stack: AnyNode[] = [root as AnyNode];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || node === undefined || typeof node !== 'object') continue;
    visit(node);

    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      const value = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (entry !== null && typeof entry === 'object' && 'type' in entry) {
            stack.push(entry as AnyNode);
          }
        }
      } else if (value !== null && typeof value === 'object' && 'type' in value) {
        stack.push(value as AnyNode);
      }
    }
  }
}
