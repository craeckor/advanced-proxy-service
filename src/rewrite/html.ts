import { parse, parseFragment, serialize } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { proxyUrlFor, resolveTarget, type CodecName } from './codec.ts';
import { rewriteCss } from './css.ts';
import { rewriteJs } from './js.ts';
import { rewriteImportMap, rewriteSpeculationRules } from './json.ts';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];

/**
 * Attributes whose value is a single URL.
 *
 * Grouped into one list rather than handled per-tag because the same attribute
 * name means the same thing wherever it appears, and a tag-by-tag table always
 * ends up missing one.
 */
const URL_ATTRIBUTES: readonly string[] = [
  'href',
  'src',
  'action',
  'formaction',
  'poster',
  'data',
  'cite',
  'background',
  'usemap',
  'codebase',
  'manifest',
  // SVG's namespaced hyperlink attribute; parse5 keeps the qualified name.
  'xlink:href',
];

const SRCSET_ATTRIBUTES: readonly string[] = ['srcset', 'imagesrcset', 'data-srcset'];

const EVENT_ATTRIBUTE_RE = /^on[a-z]+$/i;

/**
 * Attributes that must be renamed rather than deleted.
 *
 * They are enforced by the browser only under their exact literal names, so
 * renaming neutralises enforcement while preserving the original value for
 * anyone inspecting the page. Deleting them would lose information.
 */
const RENAMED_ATTRIBUTES: readonly string[] = ['integrity', 'nonce', 'sandbox', 'crossorigin'];

const RENAME_PREFIX = 'data-proxy-orig-';

/** Elements whose text content is a stylesheet. */
const CSS_TEXT_ELEMENTS = new Set(['style']);

/** Elements whose text content is JavaScript. */
const JS_TEXT_ELEMENTS = new Set(['script']);

/** Script types that are data blocks, not executable JavaScript. */
const NON_JS_SCRIPT_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/manifest+json',
  'importmap',
  'speculationrules',
]);

/**
 * Script types that name resources the browser fetches without asking the page.
 *
 * These are the same class of leak as a web app manifest, and they are worse in
 * one way: the browser does not merely read them, it acts on them for the whole
 * document. An importmap's absolute `imports` values are fetched directly, and a
 * speculationrules `urls` entry is prefetched — from the real origin, in a page
 * that is supposed to be inside the proxy, for every visitor.
 *
 * Their contents are JSON rather than executable JavaScript, so the JavaScript
 * rewriter must not see them: it would parse the object as a block statement and
 * either throw or corrupt it. They get a JSON walk instead.
 */
const URL_BLOCK_SCRIPT_TYPES = new Set(['importmap', 'speculationrules']);

export interface HtmlRewriteOptions {
  codec: CodecName;
  /** The real URL of this document, used to resolve relative references. */
  baseUrl: string;
  /** Path prefix rewritten URLs are generated under; see `CssRewriteOptions`. */
  prefix?: string;
  /** Whether the injected runtime shim script should be added. */
  injectShim?: boolean;
  /** Inline source of the runtime shim. */
  shimSource?: string;
  /**
   * Extra keys merged into the shim's `window.__PROXY_CONFIG__` object.
   *
   * The shim reads its settings off that object, and a mode such as capture
   * needs to add a key without the rewriter knowing what the key means — the
   * alternative is a `captureLedger` option threaded through this interface,
   * which would put one feature's vocabulary into the shared rewriter.
   */
  shimConfig?: Record<string, unknown>;
  /**
   * Source of a further script injected after the shim.
   *
   * Used by capture. Injected separately rather than appended to the shim so
   * the shim keeps shipping to every page unchanged, and so a syntax error in
   * this script cannot take the shim's patches down with it — the shim failing
   * to execute silently disables every runtime patch, which this project has
   * already been bitten by once.
   */
  captureAgent?: string;
  /** Path prefix proxied cookies are scoped under. */
  cookiePathPrefix?: string;
  /** Origin of the proxied site, exposed to the shim. */
  targetOrigin?: string;
}

export interface HtmlRewriteResult {
  html: string;
  /**
   * Absolute URLs discovered in the document. The archiver uses this to know
   * what to crawl next.
   */
  discovered: Set<string>;
}

/** Rewrite every URL in an HTML document so it routes back through the proxy. */
export function rewriteHtml(input: string, options: HtmlRewriteOptions): HtmlRewriteResult {
  const document = parse(input);
  const discovered = new Set<string>();

  // An explicit <base href> changes how every relative URL in the document is
  // resolved, so it has to be read before anything else is rewritten. It may
  // itself be relative (`<base href="/">` is the common case for single-page
  // apps), so it is resolved against the document's real URL first.
  const effectiveBase = resolveDocumentBase(document, options.baseUrl);

  walk(document, (node) => {
    if (node.nodeName === undefined) return;
    const element = node as Element;
    if (!Array.isArray(element.attrs) || !Array.isArray(element.childNodes)) return;

    rewriteElementAttributes(element, effectiveBase, options, discovered);
    rewriteElementText(element, effectiveBase, options, discovered);
    rewriteNoscriptContent(element, effectiveBase, options, discovered);
    rewriteTemplateContent(element, effectiveBase, options, discovered);
    removeBaseElementHref(element);
  });

  if (options.injectShim && options.shimSource) {
    injectShimScript(document, options.shimSource, options.baseUrl, effectiveBase, options);
    if (options.captureAgent) {
      injectScriptAfterShim(document, options.captureAgent);
    }
  }

  return { html: serialize(document), discovered };
}

/**
 * Work out the base URL relative references in a document resolve against.
 *
 * The order matters and mirrors what a browser does: the document's own URL is
 * always a usable base, and a `<base href>` replaces it only when that href is
 * itself resolvable. Using an unresolvable href — a relative one, most often —
 * as the base is what makes every relative URL in the page look unrewritable.
 */
function resolveDocumentBase(document: ParentNode, documentUrl: string): string {
  const declaration = findBaseHref(document);
  if (declaration === null) return documentUrl;

  const resolved = resolveTarget(documentUrl, declaration);
  return resolved ?? documentUrl;
}

/**
 * Remove `<base href>` so it cannot change how the browser resolves the
 * already-rewritten links.
 *
 * Every URL the rewriter emits is *root-relative* (`/proxy/plain/...`), exactly
 * like a root-relative link the page itself might contain — and a `<base href>`
 * applies to those too. Leaving the element pointing at the target origin made
 * the browser turn `/proxy/plain/<target>` into
 * `https://<target-origin>/proxy/plain/<target>`, which leaves the proxy and
 * hits the real site. Pointing it at the proxy origin is no better: the page's
 * own unrewritten root-relative references would then resolve to the proxy.
 *
 * Removing it is the only value that keeps both cases correct, and it is safe
 * because the rewriter has already applied the base it declared to every URL it
 * resolved. The declared value is preserved under the rename prefix, which the
 * injected shim reports as `document.baseURI`.
 */
function removeBaseElementHref(element: Element): void {
  if (element.tagName?.toLowerCase() !== 'base') return;
  const href = findAttr(element, 'href');
  if (href === undefined) return;

  removeAttr(element, 'href');
  setAttr(element, `${RENAME_PREFIX}base-href`, href);
}

/**
 * Rewrite the markup inside `<noscript>`.
 *
 * With scripting enabled the HTML parser treats `<noscript>` content as raw
 * text, so parse5 hands back a text node holding HTML that would never be
 * visited as elements. Browsers do exactly the same, but the *serializer* then
 * emits that text raw — so a relative `href` inside it survives into the
 * response and resolves against the proxy origin.
 */
function rewriteNoscriptContent(
  element: Element,
  base: string,
  options: HtmlRewriteOptions,
  discovered: Set<string>,
): void {
  if (element.tagName?.toLowerCase() !== 'noscript') return;

  for (const child of element.childNodes) {
    const text = child as { nodeName?: string; value?: string };
    if (text.nodeName !== '#text' || typeof text.value !== 'string') continue;
    if (!looksLikeMarkup(text.value)) continue;

    const fragment = parseFragment(text.value);
    rewriteTree(fragment, base, options, discovered);

    // parse5's serializer emits a `<noscript>` text node as raw markup, so the
    // rewritten fragment is put back the same way it arrived.
    text.value = serialize(fragment);
  }
}

/**
 * Rewrite the markup inside `<template>`.
 *
 * parse5 keeps template children in a separate `content` document fragment, so
 * a plain child-node walk never reaches them.
 */
function rewriteTemplateContent(
  element: Element,
  base: string,
  options: HtmlRewriteOptions,
  discovered: Set<string>,
): void {
  if (element.tagName?.toLowerCase() !== 'template') return;
  const content = (element as Element & { content?: ParentNode }).content;
  if (content === undefined) return;
  rewriteTree(content, base, options, discovered);
}

/** Rewrite every URL under an arbitrary tree, used for nested document data. */
function rewriteTree(
  root: ParentNode,
  base: string,
  options: HtmlRewriteOptions,
  discovered: Set<string>,
): void {
  walk(root, (node) => {
    if (node.nodeName === undefined) return;
    const element = node as Element;
    if (!Array.isArray(element.attrs) || !Array.isArray(element.childNodes)) return;

    rewriteElementAttributes(element, base, options, discovered);
    rewriteElementText(element, base, options, discovered);
    rewriteNoscriptContent(element, base, options, discovered);
    rewriteTemplateContent(element, base, options, discovered);
    removeBaseElementHref(element);
  });
}

/** True when a text node is likely to contain markup worth reparsing. */
function looksLikeMarkup(value: string): boolean {
  return value.includes('<') && /<[a-z!/]/i.test(value);
}

function rewriteElementAttributes(
  element: Element,
  base: string,
  options: HtmlRewriteOptions,
  discovered: Set<string>,
): void {
  const tagName = element.tagName.toLowerCase();
  const additions: Array<{ name: string; value: string }> = [];
  const removals: string[] = [];

  for (const attr of element.attrs) {
    const name = attr.name.toLowerCase();
    const value = attr.value;

    if (RENAMED_ATTRIBUTES.includes(name)) {
      removals.push(attr.name);
      additions.push({ name: `${RENAME_PREFIX}${name}`, value });
      continue;
    }

    if (URL_ATTRIBUTES.includes(name)) {
      // `<base href>` is not a resource to fetch but the resolution root for
      // every other URL, so it is normalized separately rather than proxied.
      if (tagName === 'base' && name === 'href') continue;

      const rewritten = rewriteAttributeUrl(value, base, options, discovered);
      if (rewritten !== null) attr.value = rewritten;
      continue;
    }

    if (SRCSET_ATTRIBUTES.includes(name)) {
      attr.value = rewriteSrcset(value, base, options, discovered);
      continue;
    }

    if (name === 'style') {
      // An inline style attribute is a declaration list, not a stylesheet.
      attr.value = rewriteCss(value, {
        codec: options.codec,
        baseUrl: base,
        prefix: options.prefix,
        declarations: true,
      });
      continue;
    }

    if (EVENT_ATTRIBUTE_RE.test(name)) {
      attr.value = rewriteJs(value, { codec: options.codec, baseUrl: base, prefix: options.prefix });
      continue;
    }

    if (name === 'srcdoc') {
      // Recursive by nature: the embedded document has its own relative URLs.
      const nested = rewriteHtml(value, { ...options, injectShim: false });
      attr.value = nested.html;
      for (const url of nested.discovered) discovered.add(url);
      continue;
    }

    if (name === 'http-equiv') {
      // `<meta http-equiv>` is how CSP, refresh and friends are declared in the
      // document rather than in headers; renaming defeats enforcement the same
      // way the header strip does.
      removals.push(attr.name);
      additions.push({ name: `${RENAME_PREFIX}http-equiv`, value });
      continue;
    }

    if (name === 'content' && tagName === 'meta') {
      const httpEquiv = findAttr(element, 'http-equiv')?.toLowerCase();
      if (httpEquiv === 'refresh') {
        attr.value = rewriteMetaRefresh(value, base, options, discovered);
      } else if (httpEquiv === 'content-security-policy') {
        removals.push(attr.name);
      }
      continue;
    }

    if (name === 'target' && tagName === 'a') {
      // Navigating a named browsing context out of the proxy would strand the
      // user; forcing `_top` keeps them on the proxied document.
      continue;
    }
  }

  for (const name of removals) {
    const index = element.attrs.findIndex((a) => a.name === name);
    if (index !== -1) element.attrs.splice(index, 1);
  }
  element.attrs.push(...additions);
}

function rewriteElementText(
  element: Element,
  base: string,
  options: HtmlRewriteOptions,
  discovered: Set<string>,
): void {
  const tagName = element.tagName.toLowerCase();

  const isCss = CSS_TEXT_ELEMENTS.has(tagName);
  const scriptType = JS_TEXT_ELEMENTS.has(tagName) ? scriptTypeOf(element) : '';
  const isJs = JS_TEXT_ELEMENTS.has(tagName) && !NON_JS_SCRIPT_TYPES.has(scriptType);
  const block = URL_BLOCK_SCRIPT_TYPES.has(scriptType) ? scriptType : null;

  if (!isCss && !isJs && block === null) return;

  for (const child of element.childNodes) {
    const text = child as { nodeName?: string; value?: string };
    if (text.nodeName !== '#text' || typeof text.value !== 'string') continue;

    if (isCss) {
      text.value = rewriteCss(text.value, {
        codec: options.codec,
        baseUrl: base,
        prefix: options.prefix,
      });
    } else if (block !== null) {
      const jsonOptions = {
        codec: options.codec,
        baseUrl: base,
        prefix: options.prefix,
        discovered,
      };
      text.value =
        block === 'importmap'
          ? rewriteImportMap(text.value, jsonOptions)
          : rewriteSpeculationRules(text.value, jsonOptions);
    } else {
      text.value = rewriteJs(text.value, {
        codec: options.codec,
        baseUrl: base,
        prefix: options.prefix,
        // An inline script is where a hidden URL builder usually lives: a
        // config object or a base constant that no API signature predicts.
        rewriteUrlLiterals: true,
      });
    }
  }
}

/** Rewrite a single URL-valued attribute, returning null to leave it alone. */
function rewriteAttributeUrl(
  value: string,
  base: string,
  options: HtmlRewriteOptions,
  discovered: Set<string>,
): string | null {
  const rewritten = proxyUrlFor(options.codec, base, value, options.prefix);
  if (rewritten === null) return null;

  // Record the real target so the crawler can follow it later. Resolution here
  // is only for discovery, so a value the rewriter accepted but that cannot be
  // re-resolved must not be allowed to abort the whole document rewrite.
  const absolute = resolveTarget(base, value);
  if (absolute !== null) discovered.add(absolute);
  return rewritten;
}

/**
 * Rewrite a `srcset` value.
 *
 * The grammar is a comma-separated list of `URL [descriptor]` candidates. Only
 * the URL is rewritten; descriptors such as `2x` are preserved verbatim.
 */
function rewriteSrcset(
  value: string,
  base: string,
  options: HtmlRewriteOptions,
  discovered: Set<string>,
): string {
  return value
    .split(',')
    .map((candidate) => {
      const trimmed = candidate.trim();
      if (trimmed === '') return null;

      const match = /^(\S+)(\s+[\s\S]*)?$/.exec(trimmed);
      if (!match) return trimmed;

      const url = match[1] ?? '';
      const descriptor = match[2] ?? '';
      const rewritten = rewriteAttributeUrl(url, base, options, discovered);
      return `${rewritten ?? url}${descriptor}`;
    })
    .filter((candidate): candidate is string => candidate !== null)
    .join(', ');
}

/** Rewrite `<meta http-equiv="refresh" content="0; url=...">`. */
function rewriteMetaRefresh(
  value: string,
  base: string,
  options: HtmlRewriteOptions,
  discovered: Set<string>,
): string {
  const match = /^(\s*[\d.]+\s*;\s*url\s*=\s*)(.*)$/i.exec(value);
  if (!match) return value;

  const prefix = match[1] ?? '';
  const target = (match[2] ?? '').trim().replace(/^['"]|['"]$/g, '');
  const rewritten = rewriteAttributeUrl(target, base, options, discovered);
  return rewritten === null ? value : `${prefix}${rewritten}`;
}

/**
 * Find the document's `<base href>` value, if any.
 */

function findAttr(element: Element, name: string): string | undefined {
  return element.attrs?.find((attr) => attr.name.toLowerCase() === name)?.value;
}

function removeAttr(element: Element, name: string): void {
  const index = element.attrs.findIndex((attr) => attr.name.toLowerCase() === name);
  if (index !== -1) element.attrs.splice(index, 1);
}

function setAttr(element: Element, name: string, value: string): void {
  const existing = element.attrs.find((attr) => attr.name.toLowerCase() === name);
  if (existing !== undefined) {
    existing.value = value;
    return;
  }
  element.attrs.push({ name, value });
}

/**
 * Find the raw `<base href>` declaration.
 *
 * Returns the *unresolved* value; resolving it is the caller's job, because a
 * relative href must be resolved against the document URL rather than used
 * directly.
 */
/** True when a document declares an explicit `<base href>`. */
export function declaresBaseHref(input: string): boolean {
  return findBaseHref(parse(input)) !== null;
}

function findBaseHref(document: ParentNode): string | null {
  let found: string | null = null;
  walk(document, (node) => {
    if (found !== null) return;
    const element = node as Element;
    if (element.tagName?.toLowerCase() !== 'base') return;
    const href = findAttr(element, 'href');
    if (href !== undefined && href.trim() !== '') found = href;
  });
  return found;
}

function scriptTypeOf(element: Element): string {
  const type = findAttr(element, 'type');
  return type === undefined ? '' : type.trim().toLowerCase();
}

/**
 * Insert the runtime shim as the first child of `<head>`.
 *
 * It must run before any page script so the page never observes an unpatched
 * `fetch` or `location`, which is the whole point of the shim.
 *
 * Two distinct bases are handed over, because they answer different questions:
 * `declaredBase` is what relative URL resolution must use (the page's `<base
 * href>`, since removed, or the document URL), while `targetUrl` is the actual
 * document URL that cookie namespacing keys off.
 */
function injectShimScript(
  document: ParentNode,
  source: string,
  documentUrl: string,
  declaredBase: string,
  options: HtmlRewriteOptions,
): void {
  const head = findElement(document, 'head');
  const owner = head ?? findElement(document, 'html');
  if (!owner) return;

  const config = JSON.stringify({
    targetOrigin: options.targetOrigin ?? safeOrigin(documentUrl),
    targetUrl: documentUrl,
    declaredBase,
    codec: options.codec,
    prefix: options.prefix ?? '/proxy',
    // Merged rather than nested: the shim reads these as top-level keys, and a
    // mode that adds one must not change how the existing ones are read.
    ...(options.shimConfig ?? {}),
  });

  const text = {
    nodeName: '#text',
    value: `window.__PROXY_CONFIG__=${config};\n${source}`,
  };

  const script = {
    nodeName: 'script',
    tagName: 'script',
    attrs: [{ name: 'data-proxy-shim', value: '' }],
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    childNodes: [text],
    parentNode: owner,
  };

  // The back-reference is load-bearing, not decoration: parse5's serializer
  // inspects a text node's *parent* to decide whether its content is raw text.
  // Without it the serializer cannot tell this is `<script>` content and
  // HTML-escapes it, turning `i < n` into `i &lt; n` — which in a script is not
  // merely wrong but a syntax error, because entities are never decoded there.
  (text as { parentNode?: unknown }).parentNode = script;

  (owner.childNodes as unknown as Node[]).unshift(script as unknown as Node);
}

/**
 * Insert a second script immediately after the shim.
 *
 * "After" is the requirement, not a detail: the capture agent reads the ledger
 * the shim installs, so it must not run first. Inserting at index 1 is what
 * makes the order stable, since `injectShimScript` puts the shim at index 0.
 *
 * The same parent back-reference is set for the same reason as above.
 */
function injectScriptAfterShim(document: ParentNode, source: string): void {
  const owner = findElement(document, 'head') ?? findElement(document, 'html');
  if (!owner || !Array.isArray(owner.childNodes)) return;

  const text = { nodeName: '#text', value: source };
  const script = {
    nodeName: 'script',
    tagName: 'script',
    attrs: [{ name: 'data-proxy-capture', value: '' }],
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    childNodes: [text],
    parentNode: owner,
  };
  (text as { parentNode?: unknown }).parentNode = script;

  const nodes = owner.childNodes as unknown as Node[];
  nodes.splice(1, 0, script as unknown as Node);
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function findElement(root: ParentNode, tagName: string): Element | null {
  let found: Element | null = null;
  walk(root, (node) => {
    if (found !== null) return;
    const element = node as Element;
    if (element.tagName?.toLowerCase() === tagName) found = element;
  });
  return found;
}

/**
 * Depth-first walk over a parse5 tree.
 *
 * Iterative rather than recursive: pages can nest deeply, and a recursive walk
 * risks a stack overflow on hostile input.
 */
function walk(root: ParentNode, visit: (node: Node) => void): void {
  const stack: Node[] = [...(root.childNodes ?? [])].reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) continue;
    visit(node);
    const children = (node as ParentNode).childNodes;
    if (Array.isArray(children)) {
      for (let i = children.length - 1; i >= 0; i -= 1) {
        const child = children[i];
        if (child !== undefined) stack.push(child);
      }
    }
  }
}
