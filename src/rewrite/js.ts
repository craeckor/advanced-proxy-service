import { parse } from 'acorn';
import type { AnyNode, CallExpression, ImportExpression, NewExpression, Node } from 'acorn';
import { isAbsoluteHttpUrl, proxyUrlFor, proxyPathWithTargetPath, resolveTarget, type CodecName } from './codec.ts';

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
  /**
   * Rewrite absolute `http(s)` URL literals wherever they appear, not only in
   * the argument position of a known URL-taking API.
   *
   * This is the "hidden URL builder" case. A page that does
   * `var API = "https://api.example.com/v1"; fetch(API + "/users")` names a
   * location in a position no API signature can predict, and the concatenation
   * means the value that reaches `fetch` is not a literal at all. Left alone,
   * the request goes to the real origin from a page that is supposed to be
   * inside the proxy.
   *
   * Only *absolute* URLs are eligible, and that restriction is what makes a
   * whole-file pass safe. A relative literal is a location only in a URL
   * position — `"users"` is a path in `fetch("users")` and a key in
   * `{ users: 1 }` — so rewriting those everywhere would corrupt ordinary data.
   * An absolute `http(s)` URL is a location in every position it can legally
   * appear, which is why it can be rewritten without knowing the context.
   *
   * See `isRewritableUrlLiteral` for the positions that are still refused.
   */
  rewriteUrlLiterals?: boolean;
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
  // Only the whole-file pass needs to know a literal's position, and linking
  // parents is a second full traversal — so it is paid for only when asked.
  if (options.rewriteUrlLiterals === true) linkParents(ast);
  /**
   * Ranges already claimed by the API-position pass.
   *
   * A literal in `fetch("https://x/")` is both a URL argument *and* an absolute
   * URL literal, so without this it would be rewritten twice — the second pass
   * would see the proxy path the first one produced and wrap it again. The
   * ranges are recorded rather than the edits being deduplicated afterwards
   * because the two passes compute different replacements.
   */
  const claimed: Array<{ start: number; end: number }> = [];

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

      claimed.push({ start, end });
      edits.push({
        start,
        end,
        text: `${quote}${escapeFor(rewritten, quote)}${quote}`,
      });
    }
  });

  if (options.rewriteUrlLiterals === true) {
    walkAst(ast, (node) => {
      const literal = node as AnyNode & { start?: number; end?: number };
      const isPlainLiteral = literal.type === 'Literal';
      const isTemplate = literal.type === 'TemplateLiteral';
      if (!isPlainLiteral && !isTemplate) return;
      if (typeof literal.start !== 'number' || typeof literal.end !== 'number') return;
      if (claimed.some((range) => range.start === literal.start && range.end === literal.end)) return;

      const raw = input.slice(literal.start, literal.end);
      const { quote, value } = unquote(raw);
      if (value === null) return;
      // A template with a substitution is not a literal URL; the shim owns it.
      if (isTemplate && raw.includes('${')) return;
      if (!isRewritableUrlLiteral(node, value)) return;

      const rewritten = proxyUrlFor(options.codec, options.baseUrl, value, options.prefix);
      if (rewritten === null) return;

      // The directory form, always — and this is not cosmetic. A literal in an
      // arbitrary position is most often a *base* that the page concatenates
      // onto, and the flat form loses the last path segment when it is:
      // `…/v1` + `/users` routes to `https://host/users`, not `…/v1/users`.
      // The directory form appends the target's own pathname, so the
      // concatenation lands where the origin would have put it.
      const withPath = proxyPathWithTargetPath(options.codec, value, options.prefix);

      edits.push({
        start: literal.start,
        end: literal.end,
        text: `${quote}${escapeFor(withPath, quote)}${quote}`,
      });
    });
  }

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
 * True when an absolute URL literal may be rewritten wherever it appears.
 *
 * The whole-file pass exists for URLs in positions no API signature predicts, so
 * it cannot use position as its filter. It uses the *value* instead: only an
 * absolute `http(s)` URL is a location in every position it can legally appear,
 * which is what makes rewriting it context-free.
 *
 * Three positions are still refused, and each is a case where the literal is
 * read as text rather than as a location:
 *
 *   - **A regular expression.** `new RegExp("https://x")` and `/https:\/\/x/`
 *     match text; a proxy path in either matches nothing. The `RegExp`
 *     constructor is caught by the parent check, a literal regex by its own
 *     node type.
 *   - **A property key.** `{ "https://x": 1 }` and `obj["https://x"]` use the
 *     string as a name. Rewriting it renames the property, so the lookup that
 *     follows silently misses.
 *   - **A comparison operand.** `if (url === "https://x")` compares against a
 *     value the page obtained elsewhere — often from `location.href`, which the
 *     shim already presents in the origin's own URL space. Rewriting one side
 *     makes a comparison that used to succeed fail.
 *
 * A `switch` case is deliberately *not* refused: a case label is compared
 * against a value the page computed, and if that value came from a rewritten
 * literal the label has to be rewritten too or the branch stops matching. That
 * is the opposite of the comparison case, and the difference is that a `case`
 * label and its subject are both produced by the same code.
 */
function isRewritableUrlLiteral(node: AnyNode, value: string): boolean {
  if (!isAbsoluteHttpUrl(value)) return false;

  const parent = (node as { parent?: AnyNode }).parent;
  if (parent === undefined) return false;

  switch (parent.type) {
    case 'Property':
    case 'MethodDefinition':
    case 'PropertyDefinition': {
      // Only the *key* is a name; a value is a location.
      const key = (parent as { key?: AnyNode }).key;
      if (key === node) return false;
      break;
    }
    case 'MemberExpression': {
      // `obj["https://x"]` is a computed name, not a location.
      const property = (parent as { property?: AnyNode }).property;
      if (property === node) return false;
      break;
    }
    case 'BinaryExpression': {
      const operator = (parent as { operator?: string }).operator;
      if (operator === '===' || operator === '!==' || operator === '==' || operator === '!=') return false;
      break;
    }
    case 'NewExpression':
    case 'CallExpression': {
      // `new RegExp("https://x")` and `RegExp("https://x")` compile a pattern.
      const callee = (parent as { callee?: AnyNode }).callee;
      const name = callee === undefined ? null : calleeName(callee);
      if (name === 'RegExp') return false;

      // `new URL(x)` and `new Request(x)` with a *single* argument require an
      // absolute URL — the native constructor throws `Invalid URL` on a relative
      // one. Rewriting the argument to a proxy path therefore breaks the call
      // outright, and it is the one position where a proxy path is not a
      // substitute for the URL it stands for.
      //
      // With a second argument the base is supplied, so a relative path is
      // legal and the rewrite is safe. The shim's `URL` patch exists for the
      // same reason and cannot help here: it is the *argument* that changed.
      if (name === 'URL' || name === 'Request') {
        const args = (parent as { arguments?: readonly Node[] }).arguments;
        if (args !== undefined && args.length < 2) return false;
      }
      // `URL.parse(x)` is the same constructor contract as `new URL(x)`: one
      // argument, and it must be absolute.
      if (name === 'parse') {
        const callee = (parent as { callee?: AnyNode }).callee;
        const owner = (callee as { object?: AnyNode } | undefined)?.object;
        if (owner !== undefined && (owner as { name?: string }).name === 'URL') return false;
      }
      break;
    }
    default:
      break;
  }

  return true;
}

/**
 * Attach each node's parent, so a literal can be judged by its position.
 *
 * acorn does not record parents, and the alternative — a second traversal that
 * carries the parent down — would have to duplicate the walk. Done in place
 * before the passes run, and skipped for keys that are already structural.
 */
function linkParents(root: Node): void {
  const stack: AnyNode[] = [root as AnyNode];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || node === undefined || typeof node !== 'object') continue;

    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'parent') continue;
      const value = (node as unknown as Record<string, unknown>)[key];
      const children = Array.isArray(value) ? value : [value];
      for (const child of children) {
        if (child === null || typeof child !== 'object' || !('type' in child)) continue;
        (child as { parent?: AnyNode }).parent = node;
        stack.push(child as AnyNode);
      }
    }
  }
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
      // `parent` is a back-reference added by `linkParents`; following it would
      // walk the tree upwards and never terminate.
      if (key === 'type' || key === 'start' || key === 'end' || key === 'parent') continue;
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
