# advanced-proxy-service

A proxy that fetches a site server-side, **rewrites every URL in the response** so
all subsequent requests also route through the proxy, and returns it — so you can
browse a site fully through the proxy.

Includes:

- **Header mimicry** — your real `User-Agent` and client headers are forwarded
  upstream, so the origin sees a normal browser.
- **Header rewriting** — `Content-Security-Policy`, `X-Frame-Options`,
  `Set-Cookie`, `Location` and friends are rewritten so the site works from the
  proxy's origin instead of the original site's.
- **Offline archiving** — save a site fully, server-side, and reopen it later with
  no network access.

## Quick start

```bash
npm install
npm start
```

Then browse:

```
http://localhost:8080/proxy/https%3A%2F%2Fexample.com%2F
```

The human-readable form is just the target URL, percent-encoded. The simpler
`/proxy/https://example.com/` also works when the URL needs no escaping.

`GET /` itself returns a route catalogue as JSON — machine-readable, and
asserted against the router in the test suite, so an endpoint the service claims
is always one the index documents. The table below is the human-readable form of
the same thing.

## HTTP API

Every route the service answers. Anything not listed here is a 404, and nothing
else is claimed, so this table doubles as the security surface.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Route catalogue, codecs and active posture, as JSON. |
| `GET` | `/health` | Liveness probe: `{status, uptime}`. |
| `GET` | `/proxy/[codec/]<encoded-url>` | Browse a site through the proxy. |
| `GET` | `/archive/<id>/[codec/]<encoded-url>` | Replay a resource from an archive. With compatibility mode on, an uncaptured query-variant answers with a chooser instead of a 404. A page that navigated to itself is answered with the page it was already on. |
| `GET` | `/proxy/archive/<codec>/<encoded-url>` | Open a page with the capture agent injected, to archive what the browser *rendered*. |
| `GET` | `/api/capture.js?url=<encoded-url>` | The capture as a console snippet, generated for this origin and that target. |
| `GET` | `/api/capture-relay.html` | Relay page for a capture whose upload the originating site's policy blocked. |
| `POST` | `/api/captures` | Accept an uploaded capture (rendered HTML + URL ledger). |
| `OPTIONS` | `/api/captures` | CORS preflight for the above. |
| `POST` | `/api/archives` | Start a server-side crawl. Returns `202` immediately. |
| `GET` | `/api/archives` | List archives, newest first, with status, page count, resource count and total size. |
| `GET` | `/api/archives/<id>` | One archive's detail: the same fields plus every resource it holds, each with its own size. |
| `POST` | `/api/singlefile` | Accept a page saved by the SingleFile extension's REST Form API destination. |
| `OPTIONS` | `/api/singlefile` | CORS preflight for the above. Always taken — see below. |

### The two URL grammars

The codec segment is optional and defaults to `plain`, so `/proxy/<encoded-url>`
works without knowing about codecs. `b64` encodes the target as unpadded
base64url, which keeps a proxied URL inside a query string or a filename without
the `%` escaping `plain` needs.

| Form | Shape | Why it exists |
|---|---|---|
| Flat | `/proxy/plain/<encoded-url>` | Unambiguous: the payload is the whole target. |
| Directory | `/proxy/plain/<encoded-url><target-path>` | A module whose own source contains `./chunk.js` resolves against its URL's directory. Appending the target's pathname makes that directory the target's own, so the relative reference lands where the origin meant it to. |

Both are decoded by the same function, so the two-part shape — and the doubled
path a browser can produce from it — resolves to the resource that is actually
there rather than to a plausible-looking mistake. See
[JavaScript module specifiers](#javascript-module-specifiers).

### `/api/archives` request body

```jsonc
{
  "url": "https://example.com/",   // required, absolute http(s)
  "maxDepth": 3,                   // optional, overrides the configured default
  "maxPages": 200                  // optional, overrides the configured default
}
```

The response is `202` with a `hint` naming the replay URL shape; the crawl
continues in the background, so poll `GET /api/archives` for its status.

### `/api/archives` response, and archive sizes

Every response that describes an archive carries the same fields, so an archive
is described identically in the list and on its own:

```jsonc
{
  "archives": [
    {
      "id": "ab8dbab8-…",
      "seedUrl": "https://example.com/",
      "createdAt": "2026-10-14T19:03:14.361Z",
      "status": "complete",      // "running" | "complete" | "failed"
      "pages": 12,
      "resources": 178,          // resources stored
      "bytes": 4194304           // sum of every resource's size
    }
  ]
}
```

`bytes` is the sum of each resource's **uncompressed** size, which is what the
index records and what a replay hands back. It is deliberately not the size on
disk: that depends on `archive.compression`, so it would make two identical
captures incomparable, and it is not the number a caller saw when the archive
finished either. It is the same figure `ArchiveBuildResult.bytes` reports at the
end of a build.

Both fields are aggregated from the index rather than stored on the archive row,
so they cannot drift from the resources they describe. A `running` archive
reports `bytes: 0` rather than `null`, so a list can be summed without a null
check.

`GET /api/archives/<id>` adds the resources themselves, in the same order as
`urls`, so the two can be joined by index:

```jsonc
{
  "id": "ab8dbab8-…",
  "seedUrl": "https://example.com/",
  "status": "complete",
  "pages": 12,
  "resources": 178,
  "bytes": 4194304,
  "urls": [
    "https://example.com/",
    "https://example.com/app.css"
  ],
  "entries": [
    {
      "url": "https://example.com/",
      "status": 200,
      "contentType": "text/html",
      "size": 18422,
      "capturedAt": "2026-10-14T19:03:14.361Z"
    },
    {
      "url": "https://example.com/app.css",
      "status": 200,
      "contentType": "text/css",
      "size": 1204,
      "capturedAt": "2026-10-14T19:03:14.412Z"
    }
  ]
}
```

`resources` is a **count** wherever it appears; the per-resource rows are
`entries`. The sizes in `entries` sum to the archive's `bytes`, which is the
invariant to check a total against.

One caveat on `size`: it is the size of the stored bytes, not of the response you
get back from a replay. A replayed document is rewritten at replay time — the
shim is injected and URLs are re-pointed — so it is larger than the size reported
here.

### `/api/captures` request body

Sent as `text/plain` on purpose — see [Browser-assisted capture](#browser-assisted-capture)
— so it is read as text and parsed as JSON rather than trusted to arrive with a
JSON content type. A successful upload answers `201`:

```jsonc
{
  "archiveId": "ab8dbab8-…",
  "pages": 1,
  "stored": 42,        // resources this upload added
  "bytes": 915233,
  "failed": 0,         // URLs the server also could not fetch
  "replay": "/archive/ab8dbab8-…/plain/https%3A%2F%2Fexample.com%2F"
}
```

CORS headers are applied to this route and to the two snippet/relay routes, plus
the SingleFile upload below, and to nothing else. Those are the only endpoints
this service answers cross-origin, which is what lets a snippet pasted on an
unrelated page upload to it. Everything else is same-origin in effect: a `fetch`
from another page gets no CORS headers and the browser withholds the response.

### `/api/singlefile` request body

`multipart/form-data`, with at most two parts, in this order: the saved page as
a file part, then the URL it was saved from as a part with no filename. Both are
named by the client's own field-name options, so **the file part is identified by
having a `filename`, not by being called anything in particular** — a blank
file-field-name option is legal, and a server that looked for a part called
`archive` would refuse a correctly formed upload.

```http
POST /api/singlefile HTTP/1.1
Authorization: Bearer <token>
Accept: application/json
Content-Type: multipart/form-data; boundary=----formdata-undici-055479952025

------formdata-undici-055479952025
Content-Disposition: form-data; name="archive"; filename="My Page (2026-10-14).html"
Content-Type: text/html

<!DOCTYPE html><html>…</html>
------formdata-undici-055479952025
Content-Disposition: form-data; name="url"

https://example.com/page?a=1#frag
------formdata-undici-055479952025--
```

A success answers `201` with JSON:

```jsonc
{
  "url": "http://localhost:8080/archive/ab8dbab8-…/plain/https%3A%2F%2Fexample.com%2Fpage%3Fa%3D1%23frag",
  "archiveId": "ab8dbab8-…",
  "sourceUrl": "https://example.com/page?a=1#frag",
  "filename": "My Page (2026-10-14).html",
  "contentType": "text/html",
  "size": 915233
}
```

`url` is the replay permalink. The extension writes it into the browser bookmark
when its *replace bookmark URL* option is on, so returning it is what makes an
archived page reachable from the bookmark bar without any further integration.

A failure answers a non-2xx with a **plain-text** body, because the extension
shows that body verbatim in its popup (suffixed with `(RestFormApi)`) — so
`invalid or missing token` rather than a JSON error object:

| Status | Message | Cause |
|---|---|---|
| `401` | `invalid or missing token` | `archive.restFormToken` is set and the `Authorization` header does not match it. |
| `400` | `expected multipart/form-data` | The body is not multipart. |
| `400` | `empty or malformed upload` | No parts at all — what both blank field names produce. |
| `413` | `archive too large` | Above `archive.restFormMaxBytes`. |
| `422` | `missing archive part` | A part arrived but none carried a filename, so the page itself is absent. |

The preflight is not optional. The extension always sends an `Authorization`
header, which is not CORS-safelisted, so **every** cross-origin upload is
preflighted — and `Access-Control-Allow-Headers: *` does not cover
`Authorization` in any browser, so the answer names it explicitly.

**Set `archive.restFormToken` before exposing this service.** It is empty by
default, which accepts any upload from anyone who can reach the port — the same
exposure as the unauthenticated `POST /api/archives`, but with attacker-chosen
*content* rather than an attacker-chosen URL to fetch. See
[SingleFile REST Form API](#singlefile-rest-form-api) for the whole picture.

`/api/capture.js` accepts `?url=` either percent-encoded or as a plain URL, and
the value runs to the end of the query rather than to the next `&`, so a target
with several query parameters of its own stays intact. Percent-encoding it is
still the safer habit — an unencoded `&` in a shell is a command separator before
it is ever a URL, as
[Archiving with curl on Windows](#archiving-with-curl-on-windows) explains.

## How it works

A **server-side rewriting reverse proxy with an injected runtime shim**. That
combination was chosen over the service-worker model (used by Ultraviolet and
Scramjet) because it works on any browser, needs no HTTPS or localhost
requirement, has no bootstrap race, and shares its rewriting pipeline with the
offline archiver.

The shim is the second half of what Ultraviolet calls the "two-layer pattern":

| Layer | Where it runs | What it catches |
|---|---|---|
| 1. Static rewriting | Server | URLs present in the HTML, CSS and JS source |
| 2. Runtime shim | Browser | URLs JavaScript builds at runtime |

Layer 1 alone is not enough because a URL assembled from string concatenation,
read out of a config object, or delivered by a redirect never appears as a
literal in the source. Layer 2 patches `fetch`, `XMLHttpRequest`, `location`,
`WebSocket`, `document.cookie`, `localStorage` and the DOM-insertion APIs, so the
rewrite happens at the point of use instead of the point of parse.

### URL scheme

```
/proxy/<codec>/<encoded-target-url>                  live, flat
/proxy/<codec>/<encoded-target-url><target-path>     live, directory form
/archive/<id>/<codec>/<encoded-target-url>           offline replay
```

`<codec>` is `plain` (percent-encoded, readable) or `b64` (base64url). The codec
segment is optional and defaults to the configured one.

Both routes share one rewriting pipeline; the only difference is the path prefix
the rewriter emits. Replayed documents link to `/archive/<id>/…` rather than
`/proxy/…`, so an offline replay never reaches the network for an asset.

The encoded target is **self-contained**: a target's own query is percent-encoded
inside the payload, so a URL the proxy generated carries no query of its own.

A query that *is* present after the payload therefore belongs to whoever built
the URL by hand, and is re-attached to the target rather than ignored:

```
/proxy/plain/<encoded:/wa/getData>?publicationId=4076365
        →  https://host/wa/getData?publicationId=4076365
```

This matters because the obvious ways to build such a URL leave the query
outside. `encodeURI` does not escape `?` or `&`, and a `GET` form submitting to a
rewritten `action` appends its fields there. Reading the route as the payload
alone silently asked the origin for a *different* resource — and an application
whose route identity lives in its query then answered with the page it serves
when that parameter is missing, which looks exactly like the proxy mangling the
request.

#### The directory form

A flat proxy URL is one opaque segment, so its *directory* is always
`/proxy/<codec>/` no matter where the target lives. That is a lie about the
target, and anything that treats a proxied URL as a location rather than as an
envelope finds out:

- a relative reference resolves against the directory, so `./chunk-a.js` found in
  `https://cdn.example.net/assets/entry.js` arrives as
  `/proxy/plain/chunk-a.js` — the `/assets/` segment is simply gone;
- a code-split runtime that reads `import.meta.url` to discover its own base does
  the same arithmetic and asks for bare chunk names. Those names appear nowhere
  in the source, so no amount of specifier rewriting can see them.

The rewriters therefore append the target's pathname, unencoded, so the proxied
path mirrors the target's path:

```
/proxy/plain/https%3A%2F%2Fcdn.example.net%2Fassets%2Fentry.js/assets/entry.js
```

The appended path *must* not be encoded, and that is what makes it work: both
codecs escape `/` inside their segment, so an unencoded slash can only be the
boundary between the payload and the path. It also has to be structural rather
than one more opaque segment, or `..` could not climb out of it — a reference
that walks up one level has to remove one path segment, and there is no way to
remove part of an opaque one.

The router cannot tell a target's path from a payload without decoding, and does
not need to: `routeTarget` in `src/rewrite/codec.ts` splits at the first
unencoded slash and checks whether the head decodes to a URL. A hand-built
`encodeURI` URL — which leaves `/` alone — cannot be misread, because its first
segment is not an encoded target. When the trailing path names the *same*
resource as the payload, the payload wins, because a path cannot carry a query
and the payload can.

A target whose path is already `/` gains nothing from the extra segment, so it
keeps the flat form. Every URL the rewriters emit is fully percent-encoded inside
its payload, so every generated link uses the directory form.

### URL resolution

`<base href>` and relative references are handled the way a browser handles them:

- A `<base href>` is resolved against the document's real URL *first*. A relative
  value such as the near-universal `<base href="/">` is not usable as a
  resolution base on its own, and using it directly would leave every relative
  URL in the page unrewritten — after which the browser resolves it against the
  **proxy** origin and 404s.
- The element is then **stripped of its `href`**, with the declared value kept as
  `data-proxy-orig-base-href`. Every URL the rewriter emits is root-relative
  (`/proxy/plain/…`), and a `<base href>` applies to root-relative references
  too. A base pointing at the origin turns `/proxy/plain/<target>` into
  `https://<origin>/proxy/plain/<target>`, which leaves the proxy and hits the
  real site; a base pointing at the proxy breaks the page's own unrewritten
  root-relative references instead. Removing it is the only value that keeps both
  correct, and it is safe because the declared base has already been applied to
  every URL the rewriter resolved. The shim reports the declared value as
  `document.baseURI`.
- Runtime URL construction is redirected to the same base. The shim patches the
  `URL` constructor so `new URL(relative, document.baseURI)` resolves against the
  origin rather than the proxy, matching what the rewriter does statically.
- **Rewriting is idempotent, and it has to be.** The shim's element rewriter runs
  from a `MutationObserver`, so it sees every insertion — including markup the
  server already rewrote. A rewrite that could re-wrap an already-proxied URL
  would not merely double-encode: it would nest one generation deeper on *each*
  pass, producing `/proxy/plain/https%3A…%2Fproxy%2Fplain%2Fhttps%253A…` until the
  URL was too long for the browser to use. The guard therefore runs on the raw
  input, **before** any resolution, because resolving a root-relative
  `/proxy/plain/…` against the origin's base yields `https://<origin>/proxy/plain/…`
  — indistinguishable from a URL that genuinely still needs proxying.
- `<noscript>` content is reparsed and rewritten. With scripting enabled the HTML
  parser (and parse5) treats it as raw text, but the serializer emits that text
  unescaped — so a relative `href` inside it would otherwise reach the browser
  untouched.
- `<template>` content is rewritten too; parse5 keeps it in a separate document
  fragment that a plain child-node walk never reaches.

### JavaScript module specifiers

Static `import`/`export` sources are rewritten, which is not optional for any
code-split bundle:

```js
import "./chunk-BYXBJQAS.js";                    // rewritten
import { a } from "./chunk-YBSIOQUP.js";         // rewritten
export { x } from "./chunk-F.js";                // rewritten
```

A browser resolves these against the **module's own URL**, not the document. An
unrewritten `./chunk-X.js` in a module served from `/proxy/plain/<encoded>`
therefore resolves to `/proxy/plain/chunk-X.js` and 404s — which breaks every
Angular/Vite/webpack build output, since those are almost entirely static
imports.

Specifiers are classified **per literal**, not per file, because the two rules
differ and one module routinely contains both:

| Specifier | Treated as | Why |
|---|---|---|
| `./x.js`, `../x.js` | location → rewritten | relative to the importing module |
| `/x.js` | location → rewritten | rooted at the origin that served the module |
| `https://cdn/x.js` | location → rewritten | already absolute |
| `react`, `lodash/fp` | **name → left alone** | a bare specifier is not a location; rewriting it produces a URL called `react` that can never resolve |
| `node:fs`, `data:` | left alone | not an http(s) resource |

So `import "react"` and `fetch("data.json")` in the *same* module are handled
correctly, which a per-file flag could not do.

`import.meta.url` is rewritten too, and it is not optional. A code-split runtime
reads it to learn its own location, normalises that to a directory by stripping
the last path segment, and then asks for chunks by name:

```js
new URL("./", import.meta.url)   // the base, from which n.p is derived
n.p + "fq-66c2f56a07d39bd2.js"   // a name that appears nowhere in the source
```

Served unrewritten it is the proxy's own URL, so the derived directory is
`/proxy/<codec>/` and every chunk name lands at the proxy root. Served as the
directory form it yields the target's real directory. The replacement is a string
literal, which is safe in every legal position because `import.meta.url` is a
read — `import.meta.url = x` is a syntax error.

### Requests the rewriters cannot see

Three kinds of URL never appear in a form the rewriters can reach, so nothing
above can rewrite them:

- a path assembled from fragments at runtime, such as
  `base + '/assets/i18n/' + lang + '.json'`;
- a path assigned through a DOM property setter rather than an attribute;
- a URL the **browser itself** fetches after reading a data block — a web app
  manifest, an importmap, or a speculationrules list.

The first two resolve against the **proxy** origin and arrive at the proxy root
as `/assets/i18n/en.json`, carrying no target at all. The injected shim catches
most of them by patching `fetch`, `XMLHttpRequest`, `URL` and friends — but it
cannot catch anything that runs before it, and a shim that fails to execute
catches nothing at all while looking perfectly healthy. So there is a server-side
backstop.

The third needs no shim at all and no heuristic, because the body is right there:
a manifest and an importmap are JSON naming absolute URLs, so they are rewritten
as JSON (`src/rewrite/manifest.ts`, `src/rewrite/json.ts`). The shim never runs
for these — a manifest is not a document — and no element carries the URLs, so
nothing else sees them. Left alone, the browser obeys them literally and every
icon or module goes to the real origin, from a page that is supposed to be inside
the proxy. Only the URL-bearing members are touched: an importmap's *keys* are
specifier names, a scope key and a speculationrule's `source` are match patterns
and enums, and rewriting any of them changes what the page does rather than where
it fetches from.

Recognising a manifest is the hard part, and **the media type alone is not enough
to do it**. The spec's `application/manifest+json` is widely ignored — MDN serves
its own `/manifest.json` as `application/json` — so a body-only test silently
misses the majority of real manifests, and a missed manifest is relayed verbatim
with its root-relative icon URLs intact. On the live proxy those then reach the
real origin; under replay they resolve against the *proxy's* origin, so a page
requests `/favicon-192x192.png` and 404s even though the icon is sitting in the
archive. Both callers therefore take the browser's own `sec-fetch-dest: manifest`
as the authoritative signal, and `src/rewrite/kind.ts` holds that rule so the
live proxy, the crawler and the replay cannot drift apart. Replay — which cannot
rely on the header being present, since a replay may be read by `curl` — falls
back to the stored body's *shape*, naming only the members the rewriter actually
routes so that ordinary JSON is never mistaken for a manifest.

A `url()` inside a CSS **custom property** is rewritten too. It looks like a
corner of the grammar and is not: a custom property is the normal way to hold an
icon or background URL for reuse, and MDN's own `styles-menu.css` declares
`--menu-tab-icon: url(/static/client/<icon>.svg)`. Missed, those resolve against
the serving origin rather than the target — the proxy root under replay — which
is the same failure as a missed manifest, arriving by a different route.

A request with no target of its own is **rebased onto the site behind its
referer**. A proxy URL names a target, and the request path is a path *on that
target's origin*, because the proxy origin is standing in for it. This also
repairs the `/proxy/<name>` shape a removed `<base href>` can produce, where the
browser resolved a reference against `/proxy` and glued it there.

An **archive replay referer** is admitted too, and resolved the same way — with
one difference that matters: the resource is served *from that archive*, never
from the network. The target a replay referer names is derivable exactly as a
live one is, so the case was never about finding the target; it is about where
the bytes come from. Re-fetching would break the replay's no-live-fallback
guarantee, so a resource the archive does not hold stays a 404. What it repairs
is a real loss: an archived application that resolves icon URLs against
`document.baseURI` asks the proxy root for a path the archive holds under the
target's origin, and the manifest, stylesheet and module that name it all agree.

The rebase is a heuristic and is fenced like one:

| Guard | Effect |
|---|---|
| Safe methods only | a `POST` is never replayed against a guessed origin |
| File-shaped paths only, when prefixless | `/about` could be a mistyped route or a page on the site; guessing there means serving the wrong document |
| A referer that names a target | the index page and the API routes name none, so they stay 404 |
| An archive referer is served from the archive | it can never reach the live web, so a replay's no-fallback guarantee holds |
| Referer `Host` must match | a page elsewhere cannot aim this proxy by setting a `Referer` |
| `Sec-Fetch-Site: cross-site` is refused | the page said the request was for another origin, so the referer's site is not its target. Left alone it stays a 404; rebased it would be re-issued against that site as whatever the path happens to name |
| The response gets a veto | markup in reply to "this is a file" means the guess was wrong, so the request becomes the 404 it would have been |

The shape test is the only signal available when a request is replayed from a
saved file, and on its own it is too weak: real sites serve subresources from
extensionless paths. MDN's own image proxy is `/pimg/<base64>.<hmac>`, which no
initial guess about the path can recognise. A browser sends something much
better — by the time the document is being parsed, this service has injected a
shim that stamps `data-proxy-target` on every element it rewrites, so the request
for that image arrives carrying `Sec-Fetch-Dest: image`. The request is then not
guessed at all.

Only destinations that are *always* subresources are accepted. `document`,
`iframe`, `embed`, `object` and `empty` can each be a navigation, and a
navigation is what the response veto exists to protect: let a framed page be
mistaken for a stray subresource and the site's HTML ends up rejected as a
document rather than served as the page it is. Those are declined, so they stay
the 404 they already were.

A path that already carries `/proxy` is treated differently from a prefixless one,
because it is evidence of *how* the browser resolved it. The base it used was the
proxy's own URL, so the reference below the proxy origin is a path on the target —
the same shape a page with `<base href="/">` produces for its own unrewritten
`/api/data`, which is not file-shaped and must still work. Those paths are
therefore repaired without requiring a file-shaped tail, and are attributed the
same way.

Because every failure falls through to the original 404, the rebase can only turn
a 404 into a real response — it cannot make a working request start failing.
Disable it with `proxy.resolveUnknownPaths: false`.

## Offline archiving

Archive a site:

```bash
curl -X POST localhost:8080/api/archives \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","maxDepth":3,"maxPages":200}'
```

Crawling runs in the background; poll for completion:

```bash
curl localhost:8080/api/archives
curl localhost:8080/api/archives/<id>
```

Replay it offline:

```
http://localhost:8080/archive/<id>/plain/https%3A%2F%2Fexample.com%2F
```

Archives are stored as **content-addressed blobs** (`data/blobs/<aa>/<sha256>`)
plus a **SQLite index** (`data/index.sqlite`) via Node's built-in `node:sqlite`,
so there is no native build step. Blobs are named by the SHA-256 of their
uncompressed bytes, which deduplicates automatically — an asset shared across two
pages is stored once.

Two deliberate design choices:

- **No silent live fallback.** A resource that was not captured returns an
  explicit "Not in archive" page. Falling back to the live web would quietly mix
  archived and current content, making a partial capture look complete.
- **Rewriting happens at replay, not at capture.** Stored bytes are byte-exact
  what the origin served, so improving the rewriter improves every existing
  archive without re-crawling.

### Compatibility mode

A URL that differs from a captured one only at the end of its query is *usually*
the same page: a link with added tracking parameters, a share that appended
fingerprinting, a route with one more filter. The archive holds the page, and the
request is merely over-specified — so a bare 404 is unhelpful, and the reader has
no way to discover the close match sitting on disk.

Compatibility mode bridges that gap, **off by default**:

```json
{ "archive": { "compatMode": true } }
```

It is a question rather than an inference, because the inference is not sound.
Whether a trailing parameter selects content is a fact about the origin, and no
comparison of two URLs can establish it — `&tbm=nws` added to a search request
turns a general result set into news results. So a miss on a query-variant is
answered with a page that shows **both** URLs and the difference, and lets the
reader decide. Accepting serves the stored page, labelled on every response:

| Header | Meaning |
|---|---|
| `x-archive-compat: offer` | The chooser. Nothing was served from this URL. |
| `x-archive-compat: substitute` | The page came from a *different*, near-match URL. |
| `x-archive-requested` | The URL that was asked for, when a substitute was served. |

The answer is remembered in a cookie scoped to `/archive/<id>`, so it is asked
once per archive rather than on every click, and one archive's answer is not
another's. A decline is remembered too, and yields the ordinary miss from then on.

Two things are deliberately refused:

- **A divergence anywhere in the query but the end.** `a=1&b=2` says nothing
  about what `a=1&c=3` would return, because everything after a divergence reads
  differently. Only a parameter-for-parameter prefix counts, which is what stops
  this from offering news results for a general search.
- **Anything that is not a navigation.** A missing subresource is a real gap;
  answering it with an HTML page would break the page around it while hiding the
  gap. Only `Sec-Fetch-Dest: document` is offered a substitute, so `curl` and the
  crawler keep getting exact replays.

#### A page that navigates to itself

One shape of miss is not a gap in the capture and is not a substitution either.
Some pages rebuild their own URL and navigate to it, appending a marker — Google's
interstitial does this with `&sei=<id>`, to retry against the live origin. Live
that is harmless, because the origin answers the URL it just built.

Under a replay the browser's URL is the *archive's*, so the marker lands outside
the encoded payload and the request arrives as "the page I am already on, plus one
parameter". The capture does not hold that URL. Asked as a near miss, the archive
hands the same page back, the page appends its marker again, and the cycle has no
exit — the browser reports being redirected to itself and the server logs several
requests a second for as long as the tab is open.

The request is therefore resolved back to the page it came from, using the
referrer — a replay URL names its target, so the referrer says exactly which page
the request started from. Nothing is guessed and nothing is substituted: the
candidate is that page, and it is only used when the archive holds it, so a
genuine gap stays a gap. The relation is checked parameter by parameter, so `a=1`
is not read as a prefix of `a=10`, and only an *appended* tail counts, so an
ordinary "back" navigation is unaffected.

| Header | Meaning |
|---|---|
| `x-archive-self-navigation: 1` | The page asked for itself; this is that page, served as a hit. |

This is not part of compatibility mode and needs no consent from the reader, so it
answers the same way whether the mode is on or off — and it is deliberately not a
redirect, which would put the marker back in the address bar and let the page
append it again.

```jsonc
"archive": {
  "compatMode": true,
  "compatMaxExtra": 8,        // parameters a variant may differ by
  "compatIgnoreParams": []    // parameters ignored on both sides; see below
}
```
`compatIgnoreParams` is for an origin that demonstrably ignores a cache-buster or
a tracking id. Listing one is that same unverifiable claim about the origin, so it
is empty by default — the prefix rule needs no such claim. A parameter in common
is always required, so dropping noise can never make two unrelated queries look
like a match.

### Browser-assisted capture

A crawl can only find what a rewriter can read. A modern site assembles URLs at
runtime — a chunk name derived from a hash, an API path built from a fragment, an
image inserted after a click — and none of those appear in any document. There is
a second, browser-assisted method for exactly those pages.

```
http://localhost:8080/proxy/archive/plain/https%3A%2F%2Fexample.com%2F
```

This serves the page **through the proxy as normal** — it renders, runs its own
script, and behaves as it always does — with two additions: the shim keeps a
ledger of every URL the page requests, and an agent collects the result when the
document settles. Open it in a browser, wait, and read the archive id from the
`[capture] archived N resources` console line.

The design is hybrid because it has to be. A page cannot read a cross-origin
response — a stylesheet or a font fetched without CORS is an opaque response whose
bytes script may not touch — so "send all the HTML, CSS and JS to the server"
is not something any page can do. What the page *can* do is hand over what it
owns and the list of what it asked for:

| The page uploads | The server then does |
| --- | --- |
| its post-script DOM, so client-rendered content is included | fetches the document itself, preferring the origin's own bytes |
| stylesheet text read through the CSSOM | fetches every CSS file |
| inline `<script>` and inline `style` text | fetches every JS file |
| `localStorage`, `sessionStorage`, cookies | fetches every image, font, and chunk |
| the **ledger**: every URL it requested | reuses the client's own headers and cookies for each fetch |

The ledger is the part that matters. It contains URLs no rewriter could compute,
because the page computed them.

Captured through the proxy, every fetch is made with the *client's* `User-Agent`,
`Accept-Language`, `Referer` and `Sec-Fetch-*`, so the origin answers as it did to
that browser rather than as it answers a bot. The cookie jar is forwarded only to
the origin the capture belongs to — sending a session cookie to a third-party CDN
would leak it for no benefit.

The upload is sent as `text/plain`, which is a CORS-safelisted content type. That
means no preflight and no CORS response headers, so the same payload works from
any origin. The sentinel headers are still answered for clients that preflight
anyway.

#### The console snippet

The same agent is available for pages that are **not** proxied — the useful case,
where you are already looking at a login-gated page and want to keep it:

```bash
curl 'http://localhost:8080/api/capture.js?url=https%3A%2F%2Fexample.com%2F'          # *nix, macOS
curl "http://localhost:8080/api/capture.js?url=https%3A%2F%2Fexample.com%2F"           # cmd.exe
```

Paste the output into DevTools on the page. It uploads that page and returns the
archive id. Because the snippet is generated by this deployment, it carries the
deployment's own origin: fetch it from wherever the service actually runs.

A snippet captures what script can reach. `HttpOnly` cookies are invisible to it,
so a page that depends on one may not reproduce faithfully; the proxied form has
the same limitation, for the same reason.

#### When the site's own policy blocks the upload

A site's `Content-Security-Policy` governs every request its document makes, and
`connect-src` decides whether `fetch`, XHR and `sendBeacon` may reach this
service at all. A site that sets it can refuse outright:

```
Connecting to 'http://localhost:8080/api/captures' violates the following
Content Security Policy directive: "connect-src 'self' …". The action has been blocked.
```

Nothing script does changes that **from that document** — and that includes
pasting the snippet into its console, because a pasted script runs in the page's
own context. There is no header, flag or workaround that lifts another site's CSP.

Two ways out, both supported:

**1. Let the popup do it.** The snippet already does this by itself: when the
direct upload is refused it opens `/api/capture-relay.html` on this service and
hands the payload over with `postMessage`. `connect-src` does not restrict a
navigation, and the popup is a separate document with its own policy, so from the
service's own origin the upload is same-origin and nothing objects. Verified
against `developer.mozilla.org`, whose policy blocks this service completely: the
page was still archived, in full, with the page's own `fetch` visibly refused in
the console.

The popup needs a real user gesture to open, so click something first — a paste
straight into the console counts. A site that also sets
`Cross-Origin-Opener-Policy: same-origin` severs `window.opener`; that is detected
and reported rather than hanging.

**2. Run it on a page this service serves.** Open
`http://localhost:8080/api/capture-relay.html` and paste the snippet there. That
document belongs to the service, so no other site's policy applies to it and no
popup is needed. This is the fallback the warning message points at, and it works
whenever a popup cannot be opened.

```bash
curl "http://localhost:8080/api/capture.js?url=https%3A%2F%2Fexample.com%2F"
```

### SingleFile REST Form API

A third way in, and the only one where **another application does the saving**.
The [SingleFile](https://github.com/gildas-lormeau/SingleFile) browser extension
saves a page as one self-contained HTML file — every image, stylesheet and font
inlined as a data URI — and can send it anywhere instead of to disk. One of its
destinations is a plain multipart `POST`, which this service accepts at
`POST /api/singlefile`.

The trade against the two methods above is explicit:

| | Crawl | Browser-assisted capture | SingleFile upload |
|---|---|---|---|
| Who decides what to save | this service | the page, as it loads | **the user, per page** |
| What it can reach | public sites | anything the browser can | anything the user can see, **including logins** |
| What it costs | a crawl, N requests | one page load plus fetches | nothing — the page is already self-contained |
| What is stored | the origin's own bytes | the origin's bytes, fetched with the client's headers | **the extension's rendering**, which is not byte-identical to the origin |

Nothing is fetched by this endpoint. A SingleFile page is self-contained by
construction and the extension has already resolved every URL itself from the
user's own session, so an upload costs one request, no outbound traffic, and
cannot be used to make this server fetch anything.

#### Adding it in the extension

In the extension's **Options**, under **Destination**:

1. Select **upload to a REST Form API**.
2. Fill in four fields:

   | Field | Value |
   |---|---|
   | **URL** | `http://localhost:8080/api/singlefile` (or wherever this service runs) |
   | **authorization token** | the value of `archive.restFormToken`, or leave blank if you have not set one |
   | **archive data field name** | `archive` |
   | **archive URL field name** | `url` |

3. Save, then press the SingleFile button on any page.

The two field names are the extension's own labels for the multipart part names,
and they are only labels: this service identifies the page by *having a filename*
rather than by being called `archive`, so any non-empty name works. Leaving the
**archive data field name** blank is the one setting that cannot work — the
extension then sends no file part at all, and the service answers `422`.

Selecting this destination has two side effects the extension performs on its
own: it revokes any stored Google Drive and Dropbox tokens, and drops the
`clipboardWrite` and `nativeMessaging` permissions. That is the extension's
behaviour, not this service's.

Every upload carries an `Authorization` header — the scheme is hardcoded to
`Bearer`, so this service cannot be reached with Basic auth or an API-key header
— and an empty token is sent as `Bearer`, indistinguishable from no token. Set
`archive.restFormToken` and the two are treated the same way: refused.

```bash
# What the extension sends, by hand.
curl -X POST http://localhost:8080/api/singlefile \
  -H "authorization: Bearer $TOKEN" \
  -H "accept: application/json" \
  -F "archive=@page.html;type=text/html" \
  -F "url=https://example.com/page?a=1#frag"
```

The response's `url` is the replay permalink, and the extension writes it into
the browser bookmark when *Misc → replace bookmark URL* is on. That is the whole
integration: no companion extension, no native host, no polling.

#### What arrives, and what it is stored as

| The extension's "file format" | Bytes | Part `Content-Type` | Stored as |
|---|---|---|---|
| HTML | HTML | `text/html` | `text/html` |
| ZIP | ZIP | `application/octet-stream` | `application/zip` |
| Self-extracting ZIP | a ZIP *inside* an HTML document | `text/html` | `text/html` |

The middle row is the trap. The extension's compression step tags the blob
`application/octet-stream`, which is also what a part with no media type carries,
so the label says nothing about the content — a server that trusted it would
store an archive as an opaque blob that no reader can open. **The bytes are
checked instead**, by magic number, which is why the stored type is
`application/zip` even though `application/zip` was never sent.

The third row is the mirror image: a `.zip.html` save is labelled `text/html` and
its first bytes really are HTML. It is stored as the document it is, so it
replays as a page that unpacks itself on load rather than as a download.

The source URL is the second part, stored verbatim including its fragment. It
does not have to be an `http(s)` URL — the extension will save a `file://`
document or an extension page, and the archive is keyed by whatever it says, so a
replay of that exact string resolves.

## Configuration

All values have defaults; a config file is optional.
`node src/index.ts --config config.json`, or use CLI flags.

```jsonc
{
  "server": {
    "host": "127.0.0.1",
    "port": 8080,
    "keepAliveTimeoutMs": 5000,
    "headersTimeoutMs": 60000,
    "shutdownGraceMs": 10000
  },
  "proxy": {
    "defaultCodec": "plain",        // "plain" | "b64"
    "timeoutMs": 30000,
    "maxRewriteBytes": 10485760,    // bodies larger than this are relayed
    "maxSocketsPerOrigin": 64,
    "mimicClientHeaders": true,
    "resolveUnknownPaths": true     // rebase prefixless requests; see below
  },
  "archive": {
    "dataDir": "data",
    "maxDepth": 3,
    "maxPages": 200,
    "concurrency": 6,
    "politenessDelayMs": 100,
    "respectRobotsTxt": true,
    "includeCrossOrigin": true,
    "compression": "gzip",          // "none" | "gzip" | "brotli"
    "compatMode": false,            // offer a near-match URL; see "Compatibility mode"
    "compatMaxExtra": 8,            // parameters a variant may differ by
    "compatIgnoreParams": [],       // parameters ignored on both sides
    "restFormToken": "",            // required Bearer token for POST /api/singlefile
    "restFormMaxBytes": 536870912,  // largest SingleFile upload accepted
    "restFormMaxUrlBytes": 8192     // largest accepted source-URL field
  },
  "security": {
    "enabled": false,               // see Security below
    "blockPrivateRanges": true,
    "blockedCidrs": [],
    "blockedHosts": []
  },
  "log": { "level": "info", "pretty": false }
}
```

### CLI flags

```
-c, --config <file>       Path to a JSON configuration file
    --host <address>      Interface to bind (default 127.0.0.1)
-p, --port <number>       Port to listen on (default 8080)
    --data-dir <path>     Where archives are stored (default ./data)
    --enable-security     Turn on SSRF and DNS-rebinding defences
    --log-level <level>   trace|debug|info|warn|error|fatal|silent
-h, --help                Show usage
```

### Archiving with curl on Windows

`curl.exe` ships with Windows 10 and later, but **cmd.exe does not treat single
quotes as quotes** — they are passed through as literal characters, so the
familiar POSIX form `-d '{"url":"..."}'` sends a body of
`'{"url":"https://example.com"}'` and the server rejects it as invalid JSON.
The JSON body has to be written so cmd leaves the double quotes alone.

**Whatever form you use, there is one trap: `&`.** In cmd, an unescaped `&` ends
the command, and it ends it *before* `curl` sees anything — the text after it is
treated as a separate command. Almost every real URL has more than one query
parameter, so this is the normal case rather than an edge one, and the failure is
quiet: only the part before the first `&` reaches the server, so the crawl is
seeded with a **different URL** than you asked for.

The most reliable form — no `&` to escape, and no quoting rules to get right:

```
curl -sS -X POST "http://localhost:8080/api/archives" -H "content-type: application/json" -d @body.json
```

...where `body.json` contains the JSON on one line:

```json
{"url":"https://www.google.com/search?q=a+b&udm=50","maxDepth":3,"maxPages":200}
```

If you prefer it inline, the quotes can be backslash-escaped — but the `&` still
has to be escaped, with a caret:

```
curl -sS -X POST "http://localhost:8080/api/archives" -H "content-type: application/json" -d "{\"url\":\"https://www.google.com/search?q=a+b^&udm=50\",\"maxDepth\":3}"
```

The `^` is consumed by cmd and is not part of the URL, so the server receives
`…?q=a+b&udm=50` — one parameter, not two. Drop the caret and cmd runs the rest
of the URL as a second command, so the seed silently ends at `q=a+b`.

(There is a third spelling, escaping the quotes with `^` instead of `\`. It works
for a short body but breaks as soon as a second field is added, so it is not
recommended — the file form above has no such cliff.)

Add `-k` if you are terminating TLS in front of the proxy with a self-signed
certificate.

A crawl returns `202` immediately and finishes in the background. Only `url` is
required; `maxDepth` and `maxPages` override the configured defaults (3 and 200),
and anything else — `includeCrossOrigin`, `politenessDelayMs`, `respectRobotsTxt`
— comes from the config file.

This is worth checking on the **crawl response**, before the replay ever happens:
if its `seedUrl` is not the URL you meant to send, the problem is in your shell,
not in the service. Nothing else reveals it — the crawl succeeds and reports a
page count, having quietly captured a different page.

```
curl -sS -X POST "http://localhost:8080/api/archives" -H "content-type: application/json" -d @body.json
# → { "seedUrl": "https://www.google.com/search?q=a+b" }   ← missing &udm=50
```

The replay's miss page detects the same mistake after the fact: when the requested
URL differs from the archive's seed in **its query only**, it shows both URLs with
the shared prefix elided and the divergence marked, instead of the generic "not
captured" message. A miss on a *different path* still gets the generic message,
because there a re-crawl really is the answer.

```
curl -sS "http://localhost:8080/api/archives"
curl -sS "http://localhost:8080/api/archives/<id>"
```

The first lists every archive with its status, page count, resource count and
total size; the second returns one archive's detail, including every resource
that was captured with its own size.

To save yourself the encoding entirely, capture through the proxy in a browser
instead: `POST /api/archives` is for a URL you can type, and
[browser-assisted capture](#browser-assisted-capture) is for one you can only
reach by navigating.

Replay is a normal GET. The target is percent-encoded into the payload, and the
escapes go in **as written** — cmd passes `%` through untouched:

```
curl -sS -o NUL -w "status=%{http_code}\n" "http://localhost:8080/archive/<id>/plain/https%3A%2F%2Fexample.com%2F"
```

The one exception is a `.bat` or `.cmd` **script file**, where cmd expands `%`
before `curl` ever sees it and the escapes must be doubled
(`https%%3A%%2F%%2Fexample.com%%2F`). At the prompt, or after `cmd /c`, doubling
them is the mistake: the payload becomes a literal `%%3A` and the replay 404s.

To prove a capture really is offline, ask for something that was never stored —
it must answer `404` with `x-archive-miss: 1` rather than reaching the network:

```
curl -sS -D - -o NUL "http://localhost:8080/archive/<id>/plain/https%3A%2F%2Fexample.com%2Fnever-captured.html"
```

## Security

> **This service is an open proxy by default.** It will fetch any URL it is
> given, including internal addresses.

That is a deliberate configuration choice, but it is worth being explicit about
the consequences: an open proxy that fetches arbitrary URLs is a free relay for
abuse, and because the fetch happens server-side it can reach things the caller
cannot — internal admin panels, other services on the private network, and cloud
metadata endpoints such as `169.254.169.254`.

The defences are **fully implemented and config-gated**, so turning them on is one
line rather than a new feature:

```json
{ "security": { "enabled": true } }
```

or `npm start -- --enable-security`.

When enabled:

- Destinations are resolved **once**, validated, and the connection is **pinned to
  the validated IP**. Re-resolving at connect time would reopen the TOCTOU gap
  that DNS rebinding depends on.
- Loopback, private, link-local, carrier-grade-NAT, multicast and metadata ranges
  are refused for IPv4 **and** IPv6, including IPv4-mapped IPv6 addresses such as
  `::ffff:127.0.0.1`, which a naive prefix check misses.
- If a hostname resolves to *any* blocked address the whole destination is
  refused, so a DNS record mixing one public and one private answer cannot be
  used to slip past.
- `localhost`, `*.localhost` and `*.local` are refused by name, and
  `blockedCidrs` / `blockedHosts` add your own rules.

Bind to `127.0.0.1` (the default) unless you specifically intend to expose it.

The header-mimicry feature is worth stating plainly, because it sounds more
alarming than it is. Forwarding your `User-Agent`, `Accept-Language`, `Referer`
and `Sec-Fetch-*` upstream is what makes the origin answer a normal browser
instead of a bot, and the origin was going to receive those anyway if you had
visited it directly. What changes is the source address, not the identity: the
service does not forge credentials it was not given, and it sends your cookie jar
only to the origin the request belongs to — never to a third-party CDN, which
would leak a session cookie for no benefit.

### Cross-origin reach

Six endpoints are deliberately reachable from any origin. Four exist for the
console paste: `POST`/`OPTIONS /api/captures`, `GET /api/capture.js` and
`GET /api/capture-relay.html`. Two exist for the SingleFile extension:
`POST`/`OPTIONS /api/singlefile`. They are the only ones that send
`Access-Control-Allow-Origin`, so a page elsewhere in the browser can `fetch`
them and read the response; every other route is same-origin in effect.

The two groups are authenticated differently, and the difference is deliberate.

A **capture** upload is authenticated by nothing, because it cannot be: the
caller is a snippet pasted into a page on an origin this service has no prior
relationship with. The exposure is bounded rather than removed — the payload only
*names* URLs for the server to fetch, so it can create an archive of anything
`POST /api/archives` could already create.

A **SingleFile** upload is authenticated by `archive.restFormToken` whenever that
is set, because the caller is a browser extension and can carry a header. The
default is empty, which accepts any caller, so the two are equivalent until the
token is configured — and they are not equivalent in what they risk. A capture
upload contributes a URL the *server* then chooses how to fetch; a SingleFile
upload contributes bytes the server stores and later replays. Configure the token
on any deployment reachable by others.

## Known limitations

These are documented rather than worked around, because in each case the obstacle
is a guarantee enforced by the browser or by cryptography — satisfying it would
require not performing the very rewrite the proxy exists to perform.

| Limitation | Why |
|---|---|
| **SRI `integrity` hashes** on rewritten resources | The hash assumes exact bytes; rewriting changes them. `integrity` is renamed to `data-proxy-orig-integrity` so it is preserved for inspection but no longer enforced. |
| **`__Host-` / `__Secure-` cookie prefixes** | The browser hard-requires `Path=/` and no `Domain` for these, which is exactly what the proxy needs to change. The prefix is stripped so the value stays reachable, at the cost of the extra guarantees the prefix provided. |
| **Cross-origin isolation** (`SharedArrayBuffer`, etc.) | Requires genuine COOP/COEP, which the proxy must strip to function at all. The two requirements are mutually exclusive. |
| **WebRTC** | A peer-to-peer model that does not map onto an HTTP proxy. |
| **`window.location`** | In modern browsers this is a non-configurable own property of the global object and cannot be replaced. The shim patches what is genuinely patchable rather than installing a fake that would lie to the page. |
| **JavaScript-rendered content** during crawling | The static crawler has no headless browser, which is fast and dependency-free but captures a client-rendered SPA incompletely. Browser-assisted capture exists for those pages: open `/proxy/archive/<codec>/<url>` and the page uploads what it rendered plus every URL it requested. |
| **WebSockets** | Routed through the proxy rather than tunnelled at the transport level, so some fidelity is lost (for example `bufferedAmount`). |
| **Closed shadow roots** | The `MutationObserver` shim sees nodes added to the light DOM, but cannot reach into a closed shadow root, so markup a page builds there is left unrewritten. |
| **A `<base href>` target outside `http(s)`** | A base declaring a `data:` or `blob:` URL is not resolvable by the rewriter, so the document URL is used instead. |
| **Code holding a `URL` reference across the shim** | The shim replaces the global `URL` constructor. A module that captured `URL` before the shim ran keeps the native one, so its relative resolution falls back to the page's own base. |
| **Import maps** | An inline `<script type="importmap">` is walked as JSON, so the URLs in its `imports` and `scopes` values are proxied. Its *keys* are specifier names and a scope key is a match pattern, so neither is rewritten — a map whose specifiers depend on the origin's own resolution semantics is not fully translated. |
| **Speculation rules** | `<script type="speculationrules">` has its `urls` lists proxied. A `where` clause's match patterns are deliberately left alone, since rewriting one would change what the rule matches. A rule using a pattern rather than a URL list therefore still prefetches from the origin. |
| **Bare specifiers** | `import "react"` is deliberately left alone — it is a name, not a location, and rewriting it produces a URL that can never resolve. Sites that rely on a bundler-style resolver at runtime are out of scope. |
| **Web app manifests** | A manifest's icon, screenshot, shortcut and share-target URLs are proxied, whether it is served as `application/manifest+json` or — the common case — as plain `application/json`, which is identified by `sec-fetch-dest` on the live proxy and by the stored body's shape under replay (`src/rewrite/kind.ts`). `start_url`, `scope` and `id` are left alone: they are configuration rather than locations, and they resolve relative to the manifest's own proxied URL, which already lands on the target. |
| **Requests built from fragments** | A URL assembled at runtime (`base + name + '.json'`) appears in no document, so no rewriter can see it. The shim catches it, and the referring-page rebase catches what the shim misses — including during a replay, where the referer names both the target and the archive and the resource is served *from* that archive rather than the network. A path that is neither file-shaped nor marked by the browser as a subresource, nor attributable to a referer, is still a 404. |
| **Extensions with no initial asset guess** | The rebase uses `Sec-Fetch-Dest` to admit an extensionless subresource. A client that sends no browser metadata *and* a path with no recognisable shape is declined, which is correct but means such a request must already be rewritten by the shim. |
| **Cross-origin response bodies during capture** | A stylesheet or font fetched without CORS is an opaque response: script may not read its bytes. The browser-assisted capture uploads the URL list and lets the server fetch each one, so the archive still gets real bytes — but a resource only the client could reach (an origins-restricted CDN credential, say) cannot be fetched server-side. |
| **`HttpOnly` cookies during capture** | `document.cookie` cannot see them, so a capture from a console paste or an injected agent cannot reproduce a session that depends on one. The server-side crawl has the same limit for a different reason. |
| **A site's `connect-src` on a console paste** | The policy belongs to that document, so a pasted script inherits it and cannot upload from there. The snippet falls back to a popup on this service (`/api/capture-relay.html`), which the policy does not restrict; a site that also sets `Cross-Origin-Opener-Policy: same-origin` severs `window.opener` and defeats the popup, in which case the snippet must be run on the relay page instead. Nothing lifts another site's CSP, and nothing here tries to. |
| **Streamed and progressive media during capture** | A video or DASH/HLS stream is not a single URL to fetch, so the URL list carries the manifest rather than the segments. |
| **Compressed bodies already in an archive** | `accept-encoding: identity` is requested for every capture so bodies stay rewritable. An origin that compresses regardless is stored as-is, with its `content-encoding` recorded, and replayed byte-exact with the encoding passed through — so it renders, but without the shim and therefore without link rewriting. |
| **A URL captured with a different query** | Off by default; with `archive.compatMode` on, a query-variant is *offered* rather than served, and nothing verifies that the variant is the page the origin would return. Whether a trailing parameter selects content is a fact about the origin that two URLs cannot establish, which is why the reader decides. See [Compatibility mode](#compatibility-mode). |
| **A page that navigates to itself** | Resolved from the referrer, so the page it was already on is served rather than a substitute. This needs the referrer to be present and to name a replay URL in the same archive; a client that strips `Referer` gets the ordinary miss. |
| **A SingleFile upload with no token configured** | `POST /api/singlefile` accepts any caller when `archive.restFormToken` is empty, and the extension cannot send anything but `Bearer`. Set the token on any deployment that is reachable by others; unlike `POST /api/archives`, an accepted upload contributes content the server never chose. |
| **A SingleFile page's own fidelity** | The stored bytes are the extension's rendering, not the origin's response. Scripts are neutralised, resources are inlined, and the markup is the extension's serialisation — so a replay of it is a faithful copy of *a saved page*, not of the site. That is the point of the destination, but it is not interchangeable with a crawl. |

Also note that proxied content has its CSP, `X-Frame-Options` and related headers
stripped by design — that is what makes the site work at the proxy's origin, and
it means the proxied page runs without the origin's own protections.

## Development

```bash
npm run typecheck   # tsc --noEmit (strict)
npm test            # unit + end-to-end
npm run test:unit   # skips the integration suite
npm run build       # emit to dist/
npm run start:built # run the compiled output
```

The integration suite starts a real origin server and a real proxy instance and
exercises the whole pipeline end to end, including the archive round-trip.

`test/shim.test.ts` deserves a note: the shim is delivered as a template-literal
string, so `tsc` cannot parse its contents. That file parses it with acorn and
asserts it is a complete IIFE with balanced braces, no stray backtick (which
silently truncates the literal), no `</script` sequence, and a reference to every
config key the rewriter emits. Each of those is a real failure mode that would
otherwise ship clean through typecheck and only break in a browser.

### Layout

```
src/
  config.ts              zod-validated configuration
  index.ts               entry point and wiring
  server/                http server, router, referring-page rebase, graceful shutdown
  proxy/                 upstream client, header + cookie rewriting, SSRF defences
  rewrite/               URL codec, HTML (parse5), CSS (css-tree), JS + JSON (acorn)
  shim/                  injected client-side runtime shim
  archive/               crawler, capture ingest, SingleFile ingest, blob store, SQLite index, replay
```

## Design notes

**`http-proxy` is deliberately not used.** That package (node-http-proxy) carries
an unpatched CL.TE request-smuggling vulnerability in its `deleteLength` pass: it
sets `Content-Length: 0` and deletes `Transfer-Encoding` for `DELETE`/`OPTIONS`
requests **without checking whether `Transfer-Encoding` was present**, while still
piping the chunked body. Affects all versions since v0.9.0 including 1.18.1 (last
published 2020), and upstream is unmaintained. See
[node-http-proxy#1721](https://github.com/http-party/node-http-proxy/issues/1721).
This project uses `undici`, the Node project's own client, directly.

**Framing ambiguity is refused.** A request declaring both `Content-Length` and
`Transfer-Encoding` is rejected rather than forwarded, per RFC 9112 §6.1 — that
combination is the precondition for CL.TE and TE.CL smuggling.

**Hop-by-hop headers are stripped per RFC 9110 §7.6.1** (which obsoletes RFC
7230 §6.1). Any field named inside `Connection` is itself hop-by-hop and is
removed along with the canonical set.

**`Accept-Encoding: identity` is forced upstream** because a text rewriter cannot
operate on compressed bytes. Compression is preserved on the passthrough path,
where the body is relayed untouched.

**JS rewriting is AST-based and assignment-target aware.** Blind text replacement
turns `window.location.href = '/x'` into `"/proxy/..." = '/x'`, a syntax error
that takes the whole page down. Only string literals in argument position of
known URL-taking APIs are rewritten.

**Redirects are never followed internally.** The proxy hands back the origin's
actual 3xx so the `Location` header — including relative values resolved against
the request URL — can be rewritten and the client stays on the proxy.

## License

MIT
