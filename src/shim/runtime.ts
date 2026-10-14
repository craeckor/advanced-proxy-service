/**
 * The client-side runtime shim, injected as an inline script before any page
 * script runs.
 *
 * Server-side rewriting cannot see URLs that JavaScript builds at runtime — a
 * URL assembled from string concatenation, a config object, or a redirect
 * response never appears as a literal in the source. The shim closes that gap by
 * patching the browser APIs that actually perform navigation and I/O, so the
 * rewrite happens at the point of use instead of at the point of parse.
 *
 * It is written as a plain script string rather than a module because it has to
 * run synchronously, before the page's own scripts, with no import machinery.
 *
 * Deliberate limitation: `window.location` is a non-configurable own property of
 * the global object in every modern browser, so it cannot be replaced outright.
 * The shim patches what is genuinely patchable and leaves `location` alone rather
 * than installing a fake that would lie to the page in confusing ways.
 */
export const RUNTIME_SHIM_SOURCE = String.raw`
(function () {
  'use strict';

  var cfg = window.__PROXY_CONFIG__ || {};
  var CODEC = cfg.codec || 'plain';
  // Archive replay generates /archive/<id>/... links; the live proxy uses
  // /proxy/... . Everything the shim builds has to match the document it runs in.
  var PREFIX = cfg.prefix || '/proxy';

  // The rewriter removed the document's <base href> (see removeBaseElementHref)
  // because it would otherwise re-point the root-relative proxy links the
  // rewriter emits. The base the page declared is carried in the config instead,
  // so page script that reads the document base still sees what it declared.
  var TARGET_ORIGIN = cfg.targetOrigin || '';
  var TARGET_URL = cfg.targetUrl || '';
  var DECLARED_BASE = cfg.declaredBase || '';
  var DOCUMENT_BASE = DECLARED_BASE || TARGET_URL || (TARGET_ORIGIN ? TARGET_ORIGIN + '/' : document.baseURI);

  // Present the origin's base rather than the proxy's, so a page that resolves
  // URLs itself works against the site it thinks it is on.
  try {
    Object.defineProperty(document, 'baseURI', {
      configurable: true,
      get: function () { return DOCUMENT_BASE; }
    });
  } catch (e) { /* not overridable in this browser */ }

  function encodeTarget(url) {
    if (CODEC === 'b64') {
      var bytes = new TextEncoder().encode(url);
      var binary = '';
      for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary).replace(/[+/]/g, function (c) { return c === '+' ? '-' : '_'; }).replace(/=+$/, '');
    }
    return encodeURIComponent(url);
  }

  // A URL that already routes through the proxy must be returned untouched.
  //
  // This is the entire defence against re-proxying, and it has to run *before*
  // the input is resolved against DOCUMENT_BASE. The rewriter emits proxy links
  // in the origin's own path space, as /proxy/plain/<encoded>, so resolving one
  // of them against DOCUMENT_BASE yields https://<origin>/proxy/plain/<encoded>
  // — a URL that belongs to the origin, and so is indistinguishable from one
  // that legitimately still needs proxying. Anchored matching then fails, the
  // link is wrapped a second time, and because the MutationObserver visits every
  // insertion it wraps again on each pass, nesting the encoding one generation
  // deeper each time until the browser refuses the URL.
  function isProxied(value) {
    if (value instanceof URL) return isProxied(value.href);
    if (typeof value !== 'string') return false;
    // As written: root-relative, which is what the rewriter emits.
    if (value.indexOf(PREFIX + '/' + CODEC + '/') === 0) return true;
    // Absolute, on the proxy's own origin.
    if (location.origin && value.indexOf(location.origin + PREFIX + '/' + CODEC + '/') === 0) {
      return true;
    }
    return false;
  }

  // --- the capture ledger --------------------------------------------------
  // Every URL the page asks for passes through toProxyUrl, whichever patched
  // API produced it, so recording here sees all of them at once. That matters
  // for capture: a request assembled at runtime from fragments appears in no
  // document, so the DOM walk cannot find it, and it is precisely the request a
  // server-side crawler could never have discovered on its own.
  //
  // Recording is off unless this document was served for capture, because the
  // ledger is otherwise pure overhead on a hot path.
  var RECORD = cfg.captureLedger === true;
  var recorded = [];
  var recordedSeen = {};
  var RECORD_LIMIT = 5000;

  function record(url) {
    if (!RECORD) return;
    if (typeof url !== 'string' || url === '') return;
    // A request the page already addressed through the proxy was recorded when
    // it was first built, in its unproxied form, which is what the archive
    // wants. Recording the proxied form would store a URL no origin serves.
    if (url.indexOf(PREFIX + '/') === 0) return;
    if (recordedSeen[url] || recorded.length >= RECORD_LIMIT) return;
    recordedSeen[url] = true;
    recorded.push(url);
  }

  function toProxyUrl(input) {
    // Before any resolution, so an already-proxied link keeps the form it has.
    if (isProxied(input)) return input;

    var absolute = null;
    try {
      if (input instanceof URL) absolute = input.href;
      else if (typeof input === 'string') absolute = new URL(input, DOCUMENT_BASE).href;
    } catch (e) {
      return input;
    }
    if (absolute === null) return input;
    if (absolute.indexOf('data:') === 0 || absolute.indexOf('blob:') === 0 ||
        absolute.indexOf('javascript:') === 0 || absolute.indexOf('about:') === 0) {
      return input;
    }
    // A safety net for an input that only becomes recognisable once absolute.
    if (isProxied(absolute)) return input;

    // A URL on the proxy's own origin is the proxy's, never the target's. The
    // two cannot be confused: this page is served from the proxy, so a
    // same-origin absolute URL can only name something on the proxy — its API,
    // its archive, or another proxied page — and encoding it would ask the
    // target site to serve the proxy's own endpoints, which is how the capture
    // upload ended up as a 404 from the origin. Deliberately not recorded
    // either: the ledger lists what the *page* loaded, and an endpoint of this
    // service is not part of the captured site.
    if (absolute === location.origin || absolute.indexOf(location.origin + '/') === 0) return input;

    record(absolute);
    var proxied = PREFIX + '/' + CODEC + '/' + encodeTarget(absolute);
    if (input instanceof URL) return new URL(proxied, location.origin);
    return proxied;
  }

  function define(target, name, value) {
    try {
      Object.defineProperty(target, name, {
        value: value, writable: true, configurable: true, enumerable: false
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  // Publish the ledger for the capture agent. The global object is shared with
  // the page, so this is namespaced under one well-known name rather than
  // scattered, and it is installed even when recording is off: the agent calls
  // requests() unconditionally, and a missing hook would be a TypeError.
  try {
    var hook = window.__PROXY_CAPTURE__ || {};
    hook.requests = function () { return recorded.slice(); };
    window.__PROXY_CAPTURE__ = hook;
  } catch (e) { /* ignore */ }

  // --- fetch ---------------------------------------------------------------
  if (typeof window.fetch === 'function') {
    var nativeFetch = window.fetch;
    define(window, 'fetch', function (input, init) {
      if (typeof input === 'string' || input instanceof URL) return nativeFetch(toProxyUrl(input), init);
      if (typeof Request !== 'undefined' && input instanceof Request) {
        try {
          var copy = new Request(toProxyUrl(input.url), input);
          return nativeFetch(copy, init);
        } catch (e) {
          return nativeFetch(input, init);
        }
      }
      return nativeFetch(input, init);
    });
  }

  // --- XMLHttpRequest ------------------------------------------------------
  if (typeof XMLHttpRequest !== 'undefined') {
    var nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      var rest = Array.prototype.slice.call(arguments, 2);
      return nativeOpen.apply(this, [method, toProxyUrl(url)].concat(rest));
    };
  }

  // --- Worker / SharedWorker ----------------------------------------------
  ['Worker', 'SharedWorker'].forEach(function (name) {
    var Native = window[name];
    if (typeof Native !== 'function') return;
    define(window, name, function (url, options) {
      return new Native(toProxyUrl(url), options);
    });
  });

  // --- EventSource ---------------------------------------------------------
  if (typeof EventSource === 'function') {
    var NativeEventSource = EventSource;
    define(window, 'EventSource', function (url, config) {
      return new NativeEventSource(toProxyUrl(url), config);
    });
  }

  // --- WebSocket -----------------------------------------------------------
  // A transport-level tunnel is not attempted here; the constructor is only
  // patched so that a same-origin socket request is routed through the proxy
  // rather than silently hitting the wrong host.
  if (typeof WebSocket === 'function') {
    var NativeWebSocket = WebSocket;
    define(window, 'WebSocket', function (url, protocols) {
      var target = url;
      try {
        var parsed = new URL(url, location.href);
        target = parsed.protocol + '//' + location.host + PREFIX + '/' + CODEC + '/' +
                 encodeTarget(parsed.protocol + '//' + parsed.host + parsed.pathname + parsed.search);
      } catch (e) { /* leave as-is */ }
      return protocols === undefined ? new NativeWebSocket(target) : new NativeWebSocket(target, protocols);
    });
    window.WebSocket.prototype = NativeWebSocket.prototype;
    window.WebSocket.CONNECTING = 0;
    window.WebSocket.OPEN = 1;
    window.WebSocket.CLOSING = 2;
    window.WebSocket.CLOSED = 3;
  }

  // --- history -------------------------------------------------------------
  ['pushState', 'replaceState'].forEach(function (name) {
    if (!window.history || typeof history[name] !== 'function') return;
    var native = history[name];
    define(history, name, function (state, title, url) {
      return native.call(history, state, title, url === undefined ? url : toProxyUrl(url));
    });
  });

  // --- document.cookie -----------------------------------------------------
  // The real cookie store holds namespaced names for this origin; page script
  // must see the names the origin actually set.
  var NAMESPACE = cfg.cookieNamespace || '';
  if (NAMESPACE && Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')) {
    var cookieDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    try {
      Object.defineProperty(document, 'cookie', {
        configurable: true,
        get: function () {
          return String(cookieDescriptor.get.call(document))
            .split('; ')
            .map(function (pair) {
              var eq = pair.indexOf('=');
              if (eq === -1) return pair;
              var name = pair.slice(0, eq);
              return name.indexOf(NAMESPACE) === 0 ? name.slice(NAMESPACE.length) + pair.slice(eq) : pair;
            })
            .join('; ');
        },
        set: function (value) {
          var eq = String(value).indexOf('=');
          if (eq <= 0) return cookieDescriptor.set.call(document, value);
          var name = String(value).slice(0, eq).trim();
          var restOfCookie = String(value).slice(eq);
          if (name.charAt(0) === '_' || name.indexOf(NAMESPACE) === 0) {
            return cookieDescriptor.set.call(document, value);
          }
          return cookieDescriptor.set.call(document, NAMESPACE + name + restOfCookie);
        }
      });
    } catch (e) { /* not overridable in this browser */ }
  }

  // --- storage namespacing -------------------------------------------------
  // Two different proxied sites share one real storage partition, so keys must
  // not collide.
  ['localStorage', 'sessionStorage'].forEach(function (storageName) {
    var storage;
    try { storage = window[storageName]; } catch (e) { return; }
    if (!storage) return;
    var prefix = (cfg.targetOrigin || '') + '::';
    var nativeGet = storage.getItem.bind(storage);
    var nativeSet = storage.setItem.bind(storage);
    var nativeRemove = storage.removeItem.bind(storage);
    var shimmed = {
      getItem: function (k) { return nativeGet(prefix + k); },
      setItem: function (k, v) { return nativeSet(prefix + k, v); },
      removeItem: function (k) { return nativeRemove(prefix + k); },
      clear: function () {
        Object.keys(storage)
          .filter(function (k) { return k.indexOf(prefix) === 0; })
          .forEach(function (k) { nativeRemove(k); });
      },
      key: function (i) {
        var keys = Object.keys(storage).filter(function (k) { return k.indexOf(prefix) === 0; });
        var found = keys[i];
        return found === undefined ? null : found.slice(prefix.length);
      }
    };
    Object.defineProperty(shimmed, 'length', {
      get: function () {
        return Object.keys(storage).filter(function (k) { return k.indexOf(prefix) === 0; }).length;
      }
    });
    try { define(window, storageName, shimmed); } catch (e) { /* ignore */ }
  });

  // --- service workers -----------------------------------------------------
  // A proxied site registering its own service worker would take control of
  // fetch for this origin and bypass the proxy entirely.
  if (navigator.serviceWorker) {
    try {
      define(navigator.serviceWorker, 'register', function () {
        return Promise.reject(new Error('service workers are disabled by the proxy'));
      });
    } catch (e) { /* ignore */ }
  }

  // --- dynamically created elements ---------------------------------------
  // Applies the same URL attributes the server rewriter handles, but for nodes
  // the page creates after load.
  var URL_ATTRS = ['href', 'src', 'action', 'formaction', 'poster', 'data', 'cite', 'background'];
  var SRCSET_ATTRS = ['srcset', 'imagesrcset'];

  function rewriteSrcsetValue(value) {
    return value.split(',').map(function (candidate) {
      var match = /^(\s*)(\S+)([\s\S]*)$/.exec(candidate);
      if (!match) return candidate;
      var rewritten = toProxyUrl(match[2]);
      return match[1] + (rewritten === match[2] ? match[2] : rewritten) + match[3];
    }).join(',');
  }

  function rewriteElement(el) {
    if (!el || el.nodeType !== 1 || !el.getAttribute) return;
    for (var i = 0; i < URL_ATTRS.length; i++) {
      var attr = URL_ATTRS[i];
      var value = el.getAttribute(attr);
      if (value && !isProxied(value) && value.indexOf('#') !== 0) {
        var rewritten = toProxyUrl(value);
        if (rewritten !== value) el.setAttribute(attr, rewritten);
      }
    }
    for (var s = 0; s < SRCSET_ATTRS.length; s++) {
      var srcsetValue = el.getAttribute(SRCSET_ATTRS[s]);
      if (!srcsetValue) continue;
      var rewrittenSrcset = rewriteSrcsetValue(srcsetValue);
      if (rewrittenSrcset !== srcsetValue) el.setAttribute(SRCSET_ATTRS[s], rewrittenSrcset);
    }
    var style = el.getAttribute && el.getAttribute('style');
    if (style) {
      el.setAttribute('style', style.replace(
        /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
        function (m, q, u) {
          var r = toProxyUrl(u);
          return r === u ? m : 'url(' + q + r + q + ')';
        }
      ));
    }
  }

  if (typeof MutationObserver === 'function') {
    try {
      new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          var added = records[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var node = added[j];
            rewriteElement(node);
            if (node.querySelectorAll) {
              var selector = '[href],[src],[action],[poster],[style],[srcset],[imagesrcset]';
              var descendants = node.querySelectorAll(selector);
              for (var k = 0; k < descendants.length; k++) rewriteElement(descendants[k]);
            }
          }
        }
      }).observe(document.documentElement || document, { childList: true, subtree: true });
    } catch (e) { /* ignore */ }
  }

  // --- URL resolution against the origin's base -----------------------------
  // This is what makes the rewriter's removal of <base href> complete rather
  // than a half-measure. The rewriter cannot see URLs a page builds at runtime,
  // and URL resolution via document.baseURI would otherwise land on the proxy
  // origin — which is the whole class of bug the base element created in the
  // the first place. Patching here means both paths agree: a page resolving its
  // own URLs and a resource the browser fetches end up at the same target.
  //
  // This is applied after every other module has captured its natives, so no
  // other patch is affected by the constructor being wrapped.
  // A base has to be absolute for the native constructor, but the rewriter emits
  // root-relative proxy URLs — they work without knowing the deployment's host,
  // which is what lets one capture replay from anywhere. A page that treats such
  // a URL as a base would otherwise throw, and the throw is invisible: it
  // surfaces as a generic "Invalid base URL" from deep inside whatever library
  // happened to do it. Resolving the base against the document turns it into the
  // absolute URL the native constructor needs, and the result is the same
  // absolute proxy URL the page would have got from document.baseURI.
  if (typeof URL === 'function') {
    var NativeURL = URL;
    var absoluteBase = function (base) {
      var value = (base === undefined || base === null) ? DOCUMENT_BASE : base;
      try {
        return new NativeURL(value).href;
      } catch (e) {
        return new NativeURL(String(value), location.href).href;
      }
    };
    var PatchedURL = function (input, base) {
      if (arguments.length < 2) return new NativeURL(input);
      return new NativeURL(input, absoluteBase(base));
    };
    PatchedURL.prototype = NativeURL.prototype;
    ['createObjectURL', 'revokeObjectURL', 'canParse', 'parse'].forEach(function (name) {
      if (typeof NativeURL[name] === 'function') PatchedURL[name] = NativeURL[name];
    });
    try {
      Object.defineProperty(PatchedURL, 'name', { value: 'URL', configurable: true });
      define(window, 'URL', PatchedURL);
    } catch (e) { /* not overridable in this browser */ }
  }

  // --- document.write ------------------------------------------------------
  if (typeof document.write === 'function') {
    var nativeWrite = document.write.bind(document);
    var nativeWriteln = document.writeln ? document.writeln.bind(document) : null;
    define(document, 'write', function () {
      var args = Array.prototype.slice.call(arguments).map(function (chunk) {
        return typeof chunk === 'string'
          ? chunk.replace(/(href|src|action)\s*=\s*(["'])([^"']+)\2/gi, function (m, attr, q, u) {
              var r = toProxyUrl(u);
              return r === u ? m : attr + '=' + q + r + q;
            })
          : chunk;
      });
      return nativeWrite.apply(document, args);
    });
    if (nativeWriteln) define(document, 'writeln', function () {
      var args = Array.prototype.slice.call(arguments);
      return nativeWriteln.apply(document, args);
    });
  }
})();
`;
