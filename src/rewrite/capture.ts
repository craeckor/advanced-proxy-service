/**
 * The page-side capture agent, as a source string.
 *
 * Unlike `src/shim/runtime.ts`, which is seamless but ships to every page the
 * proxy serves, this file may use ES2020 syntax (optional chaining, `??`,
 * `async`/`await`) because it only ever runs where it is deliberately placed:
 * inside a `/proxy/archive/` document, or pasted into a console. It is still a
 * classic script — no `import`/`export`, no top-level `await` — because a
 * console paste and an injected `<script>` both require that.
 *
 * A backtick anywhere inside this string terminates the template literal that
 * holds it, so the agent is written without backticks and without template
 * literals of its own. `test/shim.test.ts` enforces that for the shim; the same
 * constraint applies here for the same reason.
 *
 * ## What the agent can and cannot do
 *
 * It cannot read most of what the page loaded. A cross-origin `<img>`, a CDN
 * script and a web font are all *opaque* fetches: the bytes exist in the
 * browser's cache, and script is not allowed to see them. Only the server can
 * fetch those, so the agent does not pretend otherwise.
 *
 * What it *can* do is worth more than the bytes it cannot read:
 *
 *   - it has the live DOM, so it can serialise the document exactly as the
 *     browser built it, *after* script has run. A static crawler only ever sees
 *     the server's HTML, which for a client-rendered page is an empty shell;
 *   - it can read same-origin stylesheets through the CSSOM, which includes
 *     rules that arrived in a cross-origin sheet fetched with CORS — the parsed
 *     form is readable even when the original response was not;
 *   - it can read inline `<script>` bodies and `document.cookie`;
 *   - and it can enumerate every URL the page actually requested, because the
 *     proxy's shim already wraps `fetch`, `XMLHttpRequest` and `URL`. That list
 *     is the part no rewriter can compute: it contains URLs assembled at
 *     runtime from fragments, which is exactly the class of request that a
 *     URL-rewriting proxy cannot see.
 *
 * The server takes that list and fetches each URL itself, so the archive ends up
 * with real bytes for the resources the browser refused to hand over.
 */

/** Marker the proxy's shim installs when it is running in capture mode. */
export const CAPTURE_HOOK = '__PROXY_CAPTURE__';

/**
 * The agent.
 *
 * Deliberately an IIFE rather than module scope, so that pasting it into a
 * console cannot collide with page variables and so the same text works as an
 * injected classic script.
 */
export const CAPTURE_AGENT_SOURCE = String.raw`
(function () {
  'use strict';

  var cfg = window.__PROXY_CONFIG__ || {};
  // Long enough for a large payload to be re-sent by the relay on a slow link,
  // short enough that a user is not left looking at a popup that will never
  // report. The relay itself has no deadline; this side gives up waiting, which
  // is also how a Cross-Origin-Opener-Policy that severed the opener surfaces.
  var RELAY_DEADLINE = 60000;

  // Resolved against this document's own origin before anything else sees it. A
  // relative upload path would otherwise resolve against the page's declared base
  // — the *target* site — and the shim, which rewrites every URL the page fetches,
  // would encode it into a proxy path and ask the target for an endpoint that
  // belongs to this service.
  function uploadUrl() {
    var raw = cfg.captureUpload || '/api/captures';
    try {
      return new URL(raw, location.origin).href;
    } catch (e) {
      return raw;
    }
  }

  var dest = uploadUrl();
  var targetUrl = cfg.captureTarget || location.href;

  // What the origin actually served, as opposed to what the browser asked for.
  //
  // On a proxied page those differ, and reading only location.href gets it wrong
  // twice over. The proxy re-encodes the target after a redirect, so the address
  // bar holds whatever the *proxy* was asked for — the document's own URL is only
  // known if it is asked. And the value is used as the archive's seed and display
  // name, so a proxied value leaks this service's address into the archive
  // listing, where it means nothing and outlives the deployment.
  //
  // Reversing the proxy wrapper is best-effort and deliberately wraps everything
  // in a try: an unexpected prefix must degrade to the raw string, never throw.
  function originUrl() {
    var href = location.href;
    if (href.indexOf('/proxy/') === -1 && href.indexOf('/archive/') === -1) return href;
    try {
      var tail = href.replace(/^[a-z]+:\/\/[^/]+/, '').replace(/[?#][\s\S]*$/, '');
      var parts = tail.split('/');
      var payload = parts[parts.length - 1];
      if (payload === undefined || payload === '') return href;
      var decoded = decodeURIComponent(payload);
      if (decoded.indexOf('http://') !== 0 && decoded.indexOf('https://') !== 0) return href;
      // A trailing target path is appended after decoding, so it is not part of
      // the decoded payload and must not be treated as one. Parsed rather than
      // concatenated so the result is the URL's canonical form: a page posted at
      // /de redirects to /de/, and the seed must equal what the ledger recorded
      // for the document, or the capture stores it twice under two spellings.
      return new URL(decoded).href;
    } catch (e) {
      return href;
    }
  }

  // The page's own idea of what it requested, installed by the shim. Absent
  // when this agent is pasted into a page that is not proxied, which is the
  // normal case for the console snippet.
  var hook = window.${CAPTURE_HOOK};

  // Where a relative URL in the page's markup actually belongs.
  //
  // The document was served by the proxy, so resolving against the document base
  // names a path *on the proxy* where the markup means a path on the target. The
  // shim rewrites most attributes and so hides this, but anything it misses — a
  // node inserted after its last pass, say — resolved to /wp-content/... on
  // this service, so the capture stored a 404 from the proxy in place of the
  // image. Present only for a proxied page; a pasted snippet has no declared base
  // and correctly falls back to the document's.
  var TARGET_BASE = null;
  if (typeof cfg.declaredBase === 'string' && cfg.declaredBase !== '') {
    try { TARGET_BASE = new URL(cfg.declaredBase).href; } catch (e) { TARGET_BASE = null; }
  }

  function absolute(raw) {
    if (typeof raw !== 'string' || raw === '') return null;
    try {
      var u = new URL(raw, document.baseURI);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

      // A URL the shim already rewrote names a resource through the proxy, and
      // every consumer of this function wants the target URL: the ledger feeds a
      // server-side fetch, and an inline resource is keyed by the URL a replay
      // will look it up by. Decoding here keeps one spelling of a URL throughout
      // rather than relying on the server to unwrap each one.
      var proxied = /^\/proxy\/[^/]+\/(.+)$/.exec(u.pathname);
      if (proxied !== null) {
        var decoded = decodeURIComponent(proxied[1]);
        if (decoded.indexOf('http://') === 0 || decoded.indexOf('https://') === 0) {
          return new URL(decoded).href;
        }
        return u.href;
      }

      // Otherwise a relative URL resolved against the document base names a path
      // on the proxy where the markup means a path on the target. The shim
      // rewrites most attributes and so hides this, but anything it missed — a
      // node inserted after its last pass, say — pointed at /wp-content/... on
      // this service, so the capture stored a 404 from the proxy in place of the
      // image. TARGET_BASE is absent for a pasted snippet, which is not proxied
      // and so resolves correctly on its own.
      if (TARGET_BASE !== null && u.origin === location.origin &&
          u.pathname.indexOf('/archive/') !== 0) {
        return new URL(u.pathname + u.search, TARGET_BASE).href;
      }

      return u.href;
    } catch (e) { return null; }
  }

  function push(list, seen, raw) {
    var abs = absolute(raw);
    if (abs === null || seen[abs]) return;
    seen[abs] = true;
    list.push(abs);
  }

  // --- the document -------------------------------------------------------
  // Serialised live, so anything script has built is included. The doctype is
  // re-attached because outerHTML does not carry it.
  function documentText() {
    var dt = document.doctype;
    var prefix = '';
    if (dt) {
      prefix = '<!DOCTYPE ' + dt.name +
        (dt.publicId ? ' PUBLIC "' + dt.publicId + '"' : '') +
        (dt.systemId ? ' "' + dt.systemId + '"' : '') + '>';
    }
    return prefix + (document.documentElement ? document.documentElement.outerHTML : '');
  }

  // --- same-origin stylesheets -------------------------------------------
  // Read through the CSSOM rather than re-fetching, because the parsed form of
  // a cross-origin sheet that was fetched with CORS is readable here even though
  // the response itself is not.
  function harvestStylesheets(inline, seen) {
    var links = document.querySelectorAll('link[rel~="stylesheet"][href]');
    for (var i = 0; i < links.length; i++) {
      var el = links[i];
      var sheet = el.sheet;
      var text = null;
      try {
        if (sheet && sheet.cssRules) {
          var out = '';
          for (var r = 0; r < sheet.cssRules.length; r++) out += sheet.cssRules[r].cssText + '\n';
          text = out;
        }
      } catch (e) { text = null; }
      if (text === null) continue;
      var href = absolute(el.getAttribute('href'));
      if (href === null) continue;
      seen[href] = true;
      // Keyed by the resolved URL because that is the identity the replay needs
      // to find it by; the tag says it arrived as a link, not inline.
      inline[href] = { type: 'text/css', text: text, tag: 'link' };
    }

    var styles = document.querySelectorAll('style');
    for (var s = 0; s < styles.length; s++) {
      var body = styles[s].textContent;
      if (typeof body !== 'string' || body === '') continue;
      inline['inline:style:' + s] = { type: 'text/css', text: body, tag: 'style' };
    }
  }

  // --- inline scripts -----------------------------------------------------
  function harvestScripts(inline, seen) {
    var scripts = document.querySelectorAll('script');
    for (var i = 0; i < scripts.length; i++) {
      var el = scripts[i];
      var src = el.getAttribute('src');
      if (src) continue;
      var text = el.textContent;
      if (typeof text !== 'string' || text === '') continue;
      var type = el.getAttribute('type') || 'text/javascript';
      inline['inline:script:' + i] = { type: type, text: text, tag: 'script' };
    }
  }

  // --- the URL ledger -----------------------------------------------------
  // Two sources, and both are needed. The DOM gives the URLs the markup names;
  // the shim hook gives the ones script asked for, which includes everything
  // built at runtime and therefore everything the server could not have found
  // by reading the document.
  function harvestUrls(urls, seen) {
    var nodes = document.querySelectorAll('[href],[src],[srcset],[poster],[data]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      push(urls, seen, el.getAttribute('href'));
      push(urls, seen, el.getAttribute('src'));
      push(urls, seen, el.getAttribute('poster'));
      push(urls, seen, el.getAttribute('data'));

      var srcset = el.getAttribute('srcset');
      if (srcset) {
        var parts = srcset.split(',');
        for (var p = 0; p < parts.length; p++) {
          var candidate = parts[p].trim().split(/\s+/)[0];
          push(urls, seen, candidate);
        }
      }
    }

    // Performance entries include every subresource the browser actually
    // requested, which covers a stylesheet or image that script inserted after
    // load and that the DOM walk above would still miss if it were removed.
    try {
      var entries = performance.getEntriesByType('resource');
      for (var e = 0; e < entries.length; e++) push(urls, seen, entries[e].name);
    } catch (err) { /* not available */ }

    if (hook && hook.requests) {
      var recorded = hook.requests();
      for (var k = 0; k < recorded.length; k++) push(urls, seen, recorded[k]);
    }
  }

  // --- storage ------------------------------------------------------------
  function harvestStorage() {
    var out = {};
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k !== null) out[k] = localStorage.getItem(k);
      }
    } catch (e) { /* blocked by policy */ }
    var session = {};
    try {
      for (var s = 0; s < sessionStorage.length; s++) {
        var sk = sessionStorage.key(s);
        if (sk !== null) session[sk] = sessionStorage.getItem(sk);
      }
    } catch (e2) { /* blocked by policy */ }
    return { local: out, session: session };
  }

  // --- upload -------------------------------------------------------------
  function encode(bytes) {
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function buildPayload() {
    var inline = {};
    var seen = {};
    var urls = [];

    harvestStylesheets(inline, seen);
    harvestScripts(inline, seen);
    harvestUrls(urls, seen);

    return {
      targetUrl: targetUrl,
      // The final URL matters when the page redirected: the archive is keyed by
      // what actually served the document, not by what was asked for.
      finalUrl: originUrl(),
      document: { type: 'text/html', text: documentText() },
      inline: inline,
      urls: urls,
      cookies: document.cookie || '',
      title: document.title || '',
      storage: harvestStorage(),
    };
  }

  function send(payload) {
    var body = JSON.stringify(payload);
    // Sent as text/plain on purpose. Binary has to be base64'd either way, and
    // text/plain is a CORS-safelisted content type: a request with only
    // safelisted headers needs no preflight and no CORS response headers, so
    // this works from an arbitrary origin and from a console paste.
    var blob = new Blob([body], { type: 'text/plain;charset=UTF-8' });

    // sendBeacon is deliberately not used, though it looks like the obvious
    // transport for a capture. Its failure modes are all silent, and each one was
    // observed rather than theorised:
    //
    //   - it caps at about 64KB, so a page with a real DOM is refused outright,
    //     while a modest one succeeds — the wrong way round for this feature;
    //   - it reports success for a request the server later rejects, so a 404
    //     from the origin looked like a completed capture;
    //   - it reports success when Content-Security-Policy connect-src has
    //     blocked the request entirely, which is exactly the case that needs to
    //     be *detected* so the relay can take over.
    //
    // fetch reports all three honestly, and the relay below covers the one
    // thing a beacon would have added, which is surviving a page that navigates
    // away mid-upload.
    return fetch(dest, { method: 'POST', body: blob, mode: 'cors', credentials: 'omit' })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (json) {
          // A rejected upload must say so. The caller has no other way to tell:
          // the console line below would otherwise report success for a capture
          // the server refused, and swallowing the parse error would hide it.
          if (!res.ok) {
            throw new Error('[capture] upload rejected with ' + res.status +
              (json && json.error ? ': ' + json.error : ''));
          }
          return json;
        });
      })
      .then(report);
  }

  // --- upload when the page's own policy forbids one ----------------------
  //
  // A site's Content-Security-Policy governs every request its own document
  // makes, so connect-src decides whether fetch, XHR and sendBeacon may reach
  // this service at all — and on a site that sets it the answer can be a flat no.
  // Nothing script can do changes that *from that document*.
  //
  // A popup is a different matter. connect-src does not restrict a navigation,
  // and a script-opened window is a separate document with its own policy. So the
  // agent opens a window on this service and lets *that* document upload: from the
  // service's own origin the request is same-origin, and no policy objects.
  //
  // The channel is postMessage, and it has to be. The popup is same-origin with
  // the service but the opener is not, so the opener cannot touch its properties
  // at all — the same-origin policy forbids exactly that. postMessage is the one
  // thing that crosses. Both directions are checked anyway: the relay is chosen
  // by this code, so its origin is known, and the reply is only honoured from the
  // window that was opened and from the service's own origin.
  //
  // A site can still defeat this with Cross-Origin-Opener-Policy: same-origin,
  // which severs window.opener. That is detected as a timeout and reported,
  // rather than failing as a mute "nothing happened".
  function sendViaRelay(payload) {
    var relay = cfg.captureRelay;
    if (typeof relay !== 'string' || relay === '') return Promise.resolve(null);

    var serviceOrigin;
    try { serviceOrigin = new URL(relay).origin; } catch (e) { return Promise.resolve(null); }

    // Opened synchronously, on the click that ran this script: a window may only
    // be opened while a user activation is live, and the upload cannot finish
    // inside it.
    var win = null;
    try { win = window.open(relay, 'proxyCaptureRelay', 'width=440,height=340'); } catch (e) { win = null; }
    if (!win) return Promise.resolve(null);

    return new Promise(function (resolve) {
      var settled = false;
      var deadline = null;

      function finish(value) {
        if (settled) return;
        settled = true;
        if (deadline !== null) clearTimeout(deadline);
        window.removeEventListener('message', onMessage, false);
        resolve(value);
      }

      function onMessage(event) {
        // Only the window this call opened may answer, and only from the origin
        // that window was opened at. Without both checks any page that can get a
        // reference to this window could forge an archive id.
        if (event.source !== win) return;
        if (event.origin !== serviceOrigin) return;

        var data = event.data || {};
        if (data.type === 'proxy-capture-ready') {
          send();
          return;
        }
        if (data.type === 'proxy-capture-result') finish(data);
      }

      function send() {
        try {
          win.postMessage({ type: 'proxy-capture', payload: payload }, serviceOrigin);
        } catch (e) {
          // The popup was closed between the two calls; the deadline is the
          // backstop, so nothing to do here.
        }
      }

      window.addEventListener('message', onMessage, false);

      // Sent immediately as well as on the relay's own announcement, because the
      // relay may still be loading — in which case this first message is dropped
      // and the announcement triggers the second. Guessing at the timing instead
      // would make the feature depend on network speed.
      send();
      deadline = setTimeout(function () { finish(null); }, RELAY_DEADLINE);
    });
  }

  function report(json) {
    if (json && json.archiveId) {
      var line = '/archive/' + json.archiveId + '/plain/' + encodeURIComponent(targetUrl);
      if (window.console) {
        console.log('[capture] archived ' + (json.stored || 0) + ' resources -> ' + line);
      }
    }
    return json;
  }

  function run() {
    var payload = buildPayload();
    if (window.console) {
      console.log('[capture] collected ' + payload.urls.length + ' urls, catching up...');
    }

    // The URL list is only what the page has requested *so far*. Injected
    // resources keep arriving, so the hook is asked again just before sending
    // and the payload carries the union — otherwise an asset that finished
    // loading during serialisation would be missed.
    if (hook && hook.requests) {
      var seen = {};
      for (var i = 0; i < payload.urls.length; i++) seen[payload.urls[i]] = true;
      var extra = hook.requests();
      for (var k = 0; k < extra.length; k++) {
        var abs = absolute(extra[k]);
        if (abs !== null && !seen[abs]) { seen[abs] = true; payload.urls.push(abs); }
      }
    }

    // An upload the page's policy refuses is not a dead end: the payload goes to
    // a window on the service instead, whose own policy is its own. Only reached
    // when a relay is configured *and* the direct attempt failed, so a page that
    // can upload normally never opens a window.
    return send(payload).catch(function (error) {
      return sendViaRelay(payload).then(function (relayed) {
        if (relayed !== null) return report(relayed);

        // Nothing worked. The one instruction worth giving is the relay page,
        // opened by hand: a console paste runs in *this* document's context and
        // inherits its policy, so repeating it here cannot help. Running it on a
        // page served by the service can, and does not depend on a popup or on
        // window.opener surviving.
        if (window.console) {
          console.warn('[capture] the upload was blocked, most likely by this page\'s ' +
            'Content-Security-Policy (connect-src), and no relay window could be opened. ' +
            'Open ' + cfg.captureRelay + ' , paste the same snippet there, and run it again.');
        }
        throw error;
      });
    });
  }

  // Collected automatically only when the proxy injected this agent. A pasted
  // console snippet collects when its last expression is evaluated, which the
  // pasted text arranges by ending in a call.
  window.${CAPTURE_HOOK} = window.${CAPTURE_HOOK} || {};
  window.${CAPTURE_HOOK}.capture = run;
  window.${CAPTURE_HOOK}.payload = buildPayload;

  if (cfg.captureAuto === true) {
    var settled = false;
    var fire = function () {
      if (settled) return;
      settled = true;
      run().catch(function (e) {
        if (window.console) console.warn('[capture] upload failed', e);
      });
    };
    if (document.readyState === 'complete') {
      setTimeout(fire, 800);
    } else {
      window.addEventListener('load', function () { setTimeout(fire, 800); });
    }
    // A page with a long-polling request or a stream never fires 'load', so a
    // deadline guarantees the capture is still taken.
    setTimeout(fire, 20000);
  }

  // Returned so the console snippet can invoke it: the snippet evaluates this
  // IIFE and keeps the function. An injected <script> discards the value, which
  // is harmless.
  return run;
})();
`;

/**
 * The page a blocked upload is handed to.
 *
 * Served from the service's own origin and deliberately trivial. A site's
 * Content-Security-Policy governs every request its document makes, so a page
 * that forbids `connect-src` to this service cannot upload to it however the
 * payload is built — but a *popup* is a separate document with its own policy,
 * and a navigation is not what `connect-src` restricts. So the snippet opens
 * this page, hands it the finished payload as an ordinary same-origin property,
 * and lets it POST. From this origin the request is same-origin and no policy
 * can object.
 *
 * The window is same-origin with the service, which is what makes the handover
 * plain property access rather than a postMessage dance with origin checks to
 * get wrong. The payload is left on the window for the poller below to find
 * because the popup may still be loading when it is set, and the result is
 * written back the same way.
 *
 * No CSP of its own: this page exists to be allowed to talk to this service.
 */
export const CAPTURE_RELAY_SOURCE = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Uploading capture…</title>
</head>
<body>
<p id="status">Waiting for the page to hand over its capture…</p>
<pre id="detail"></pre>
<script>
(function () {
  'use strict';
  var status = document.getElementById('status');
  var detail = document.getElementById('detail');

  function say(message, extra) {
    status.textContent = message;
    if (extra) detail.textContent = extra;
  }

  // The opener is cross-origin to this page, so postMessage is the only channel
  // that crosses — it cannot read or write anything here directly. The reply goes
  // back to the opener's own origin, which is learned from the message itself:
  // this page does not know and does not need to know what site it was opened
  // from, and echoing back the origin a message actually arrived from is the one
  // safe way to answer it.
  var uploading = false;

  window.addEventListener('message', function (event) {
    var data = event.data || {};
    if (data.type !== 'proxy-capture') return;

    var payload = data.payload;
    if (!payload || typeof payload !== 'object') return;
    // A capture that has already been handed over is not uploaded twice; the
    // opener sends on both the ready announcement and immediately.
    if (uploading) return;
    uploading = true;

    var body = JSON.stringify(payload);
    say('Uploading ' + (payload.urls ? payload.urls.length : 0) + ' known URLs…');

    // text/plain for the same reason every other transport uses it: it is
    // CORS-safelisted, so this stays a simple request. Same-origin here, but the
    // endpoint is shared and behaves identically.
    fetch('/api/captures', {
      method: 'POST',
      body: new Blob([body], { type: 'text/plain;charset=UTF-8' })
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (json) {
          if (!res.ok) throw new Error(json && json.error ? json.error : ('HTTP ' + res.status));
          return json;
        });
      })
      .then(function (json) {
        say('Archived ' + (json.stored || 0) + ' resources.',
          '/archive/' + json.archiveId + '/plain/' + encodeURIComponent(payload.targetUrl || ''));
        try {
          event.source.postMessage(
            { type: 'proxy-capture-result', ok: true, archiveId: json.archiveId, stored: json.stored },
            event.origin
          );
        } catch (e) { /* opener gone */ }
        setTimeout(function () { window.close(); }, 1500);
      })
      .catch(function (error) {
        say('Upload failed: ' + error.message, '');
        try {
          event.source.postMessage(
            { type: 'proxy-capture-result', ok: false, error: String(error.message) },
            event.origin
          );
        } catch (e) { /* opener gone */ }
      });
  }, false);

  // Announced on load, because the opener may have sent its payload before this
  // document existed — a message to a window that is still loading is discarded,
  // not queued — and the opener re-sends when it hears this.
  function announce() {
    try {
      if (window.opener) {
        window.opener.postMessage({ type: 'proxy-capture-ready' }, '*');
      }
    } catch (e) { /* no opener: opened directly, nothing to relay for */ }
  }
  announce();
})();
</script>
</body>
</html>
`;

/**
 * A copy-paste snippet that captures whatever page the console is open on.
 *
 * The snippet has to work on a site that is *not* proxied, so it cannot rely on
 * the shim's URL ledger — the DOM walk and the resource-timing entries are what
 * remain, and `document.cookie` also cannot see `HttpOnly` cookies, so a
 * logged-in view will be captured as the logged-out one. That is a real
 * limitation of running in the page rather than through the proxy, and it is
 * stated here rather than discovered later.
 *
 * The document is posted to the configured proxy origin, which is why the
 * endpoint has to accept a cross-origin POST — see the CORS note in the README.
 */
export function captureSnippet(options: {
  /** Absolute URL of the proxy the snippet uploads to. */
  origin: string;
  /** The URL being captured, recorded as the archive's seed. */
  targetUrl: string;
  codec?: string;
}): string {
  const upload = `${options.origin.replace(/\/+$/, '')}/api/captures`;
  const codec = options.codec ?? 'plain';

  // The agent returns its capture function so the snippet can invoke it. The
  // snippet is an expression statement whose value the console prints, which
  // also means awaiting it is possible by wrapping in `await (...)`, but the
  // plain form is what a user actually pastes.
  return `// Capture this page into ${options.origin}
// 1. Open DevTools on the page you want to save.
// 2. Paste everything below into the Console and press Enter.
// 3. Watch for the "[capture] archived N resources" line it logs.
(() => {
  window.__PROXY_CONFIG__ = Object.assign({}, window.__PROXY_CONFIG__, {
    captureUpload: ${JSON.stringify(upload)},
    captureTarget: ${JSON.stringify(options.targetUrl)},
    // A page whose Content-Security-Policy forbids the upload can still be
    // captured: the payload is handed to a window on the service, whose own
    // policy is its own. Only used after a direct upload is refused.
    captureRelay: ${JSON.stringify(`${options.origin.replace(/\/+$/, '')}/api/capture-relay.html`)},
    captureAuto: false
  });
  const capture = ${CAPTURE_AGENT_SOURCE.trim()};
  return capture();
})();
`;
}
