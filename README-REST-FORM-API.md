# REST Form API upload

Complete documentation of how the SingleFile extension uploads a saved page to an HTTP endpoint
(the `RestFormApi` destination), and how to build a server that receives those uploads.

> **Implemented in this service.** The endpoint this document describes is available at
> [`POST /api/singlefile`](./README.md#api-singlefile-request-body), with the extension fields to use
> in [SingleFile REST Form API](./README.md#singlefile-rest-form-api). The reference server in
> [§11](#11-reference-implementation) is a standalone illustration; the in-tree implementation
> reuses this project's store and replay rather than writing files to `./uploads`.

Everything in this document is derived from the code in this repository and has been verified by
driving the real client implementation (`src/lib/rest-form-api/index.js`) against a local capture
server.

- Client implementation: [index.js](src/lib/rest-form-api/index.js)
- Server-side dispatch and error wrapping: [downloads.js](src/core/bg/downloads.js)
- Options, defaults and validation: [config.js](src/core/bg/config.js)
- Options UI markup: [options.html](src/ui/pages/options.html)
- User-facing help text: [help.html](src/ui/pages/help.html)

## Table of contents

1. [What it is](#1-what-it-is)
2. [The exact wire protocol](#2-the-exact-wire-protocol)
3. [The client in detail](#3-the-client-in-detail)
4. [Where the uploaded data comes from](#4-where-the-uploaded-data-comes-from)
5. [How a save is triggered and dispatched](#5-how-a-save-is-triggered-and-dispatched)
6. [The five options](#6-the-five-options)
7. [Response handling and error semantics](#7-response-handling-and-error-semantics)
8. [Cancellation, progress, bookmarks](#8-cancellation-progress-bookmarks)
9. [CORS, permissions and security model](#9-cors-permissions-and-security-model)
10. [Building the server](#10-building-the-server)
11. [Reference implementation](#11-reference-implementation)
12. [Feature matrix: what you can and cannot do](#12-feature-matrix-what-you-can-and-cannot-do)
13. [Talking to the browser add-on](#13-talking-to-the-browser-add-on)
14. [Gotchas and verification checklist](#14-gotchas-and-verification-checklist)

## 1. What it is

`RestFormApi` is one of nine "destination" code paths SingleFile can use instead of a browser
download. It is the simplest of them: a single `POST` of `multipart/form-data`, no negotiation, no
directory handling, no conflict resolution, no chunking.

Use it when you want a **custom HTTP backend** (your own archive service, a notes app, an internal
CMS) to receive the saved page. If you want the browser to write files on a local disk instead, use
the MCP destination ([tools/mcp-server/server.js](tools/mcp-server/server.js)); if you want plain
object storage, use S3; if you want a conventional file API, use WebDAV.

The whole client is 30 lines of logic:

```js
const blob = content instanceof Blob ? content : new Blob([content], { type: "text/html" });
const formData = new FormData();
if (this.fileFieldName) {
	formData.append(this.fileFieldName, blob, filename);
}
if (this.urlFieldName) {
	formData.append(this.urlFieldName, url);
}
const response = await fetch(this.restApiUrl, {
	method: "POST",
	body: formData,
	headers: this.headers,      // Map { Authorization: "Bearer <token>", Accept: "application/json" }
	signal: this.controller.signal
});
```

## 2. The exact wire protocol

### 2.1 Request

| Property | Value |
| --- | --- |
| Method | `POST` (always, never `PUT`/`PATCH`) |
| URL | the configured "URL" option, verbatim — no path is appended, no query is added |
| `Content-Type` | `multipart/form-data; boundary=...` (set by `FormData`, never set manually) |
| `Authorization` | `Bearer <token>` — always sent, even when the token is empty |
| `Accept` | `application/json` |
| Body | at most two parts, in this order: the file part, then the URL part |

Cache/preflight headers (`Origin`, `Referer`, `Sec-Fetch-*`, `User-Agent`) are added by the browser
and are not under the extension's control.

Capture of a real request issued by the verified client (file field `archive`, URL field `url`):

```http
POST /upload HTTP/1.1
Authorization: Bearer SECRET-TOKEN-123
Accept: application/json
Content-Type: multipart/form-data; boundary=----formdata-undici-055479952025

------formdata-undici-055479952025
Content-Disposition: form-data; name="archive"; filename="A & B (2026-10-14).html"
Content-Type: text/html

<!DOCTYPE html><html>...</html>
------formdata-undici-055479952025
Content-Disposition: form-data; name="url"

https://example.com/page?a=1#frag
------formdata-undici-055479952025--
```

### 2.2 The file part

- Part **name** is the configured `saveToRestFormApiFileFieldName`. It is not validated in any way —
  whatever string you type is used as the form field name.
- Part **filename** is the resolved save filename from the extension's filename template, e.g.
  `My Page (2026-10-14).html`. It is subject to all the extension's filename sanitization
  (`filenameTemplate`, `filenameMaxLength`, `filenameReplacedCharacters`, …), so it is a single path
  segment without directory separators in practice.
- Part **Content-Type** is the MIME type of the captured blob (see [§4](#4-where-the-uploaded-data-comes-from)):
  - `text/html` for a normal single-file HTML page,
  - `application/octet-stream` for a compressed archive (`<name>.zip`),
  - `text/html` for a self-extracting archive (`<name>.zip.html`) — the actual bytes are still a ZIP,
  - `application/octet-stream` when the caller passed a `Blob` whose type is not set.
- The bytes are sent **raw**; the extension never base64-encodes, gzips or otherwise transforms the
  payload. A compressed archive is a real ZIP byte stream inside the multipart part.
- If the extension receives a plain string rather than a `Blob`, it wraps it as
  `new Blob([content], { type: "text/html" })` — this is the path used by autosave/`App` captures.

### 2.3 The URL part

- Part **name** is the configured `saveToRestFormApiUrlFieldName`.
- Part **value** is the **original page URL**, not the archive filename. It is the same value passed
  as `originalUrl` throughout the download pipeline: the tab/URL being saved, e.g.
  `https://example.com/page?a=1#frag` (fragment included). For batch saves it is the URL that was
  submitted in the batch, for a frame/selection save it is the captured frame's/base URI.
- The part **has no filename**, so a correct parser will see it as a normal form field, giving you an
  unambiguous way to tell the two parts apart.

### 2.4 Optional parts

Both parts are **conditional on their option being non-empty**:

| `fileFieldName` | `urlFieldName` | Result |
| --- | --- | --- |
| `"archive"` | `"url"` | normal: file part + URL part |
| `"archive"` | `""` | file part only |
| `""` | `"url"` | URL part only — **the content is silently discarded** |
| `""` | `""` | `Content-Length: 38` — an empty multipart body, only `--boundary--`; your server must not treat this as a valid upload |

Verified: a POST with both options empty produced a 38-byte body containing only the closing
boundary. Configure at least the file field name.

**No other fields are ever sent.** There is no filename field, no title field, no metadata field, no
custom header field. If you need them, parse them from the payload ([§12](#12-feature-matrix-what-you-can-and-cannot-do)).

### 2.5 Success and failure responses

| Response | Client behaviour |
| --- | --- |
| `200`, `201`, `202` **with a JSON body** | resolves the upload; the parsed JSON becomes the response value |
| `200`, `201`, `202` **with a non-JSON body** | rejects with `SyntaxError` from `response.json()` |
| `204`, or any 2xx not in `{200, 201, 202}` | rejects (treated as failure, `await response.text()` is usually `""`) |
| `4xx` / `5xx` | rejects with `new Error(await response.text())` — the raw response body is the error message |
| network/CORS failure | rejects with the browser's `TypeError: Failed to fetch` |
| aborted locally | rejects with `AbortError` |

So: **always return one of `200`/`201`/`202` and always return JSON**, even on success of a no-op.
Return `204` and the extension reports a failure with an empty message.

The JSON body is not parsed for specific keys — it is only surfaced. Two keys are worth returning
anyway, because SingleFile uses them when they happen to be present:

- `url` — if the option "Misc > replace bookmark URL" is enabled and the save came from a bookmark,
  `response.url` is written into the bookmark ([downloads.js](src/core/bg/downloads.js)). Returning
  the permalink of the archived page therefore makes bookmark replacement work for your backend at
  no extra cost.
- Anything else is ignored by the extension but useful to you for debugging.

## 3. The client in detail

### 3.1 Class shape

```js
class RestFormApi {
	constructor(token, restApiUrl, fileFieldName, urlFieldName)
	async upload(filename, content, url)   // -> parsed JSON on 200/201/202, throws otherwise
	abort()                                // aborts the in-flight fetch
}
```

- `token` — hidden option `saveToRestFormApiToken`. Placed raw into `Bearer <token>`.
- `restApiUrl` — option `saveToRestFormApiUrl`.
- `fileFieldName` — option `saveToRestFormApiFileFieldName`.
- `urlFieldName` — option `saveToRestFormApiUrlFieldName`.
- `filename` — save filename produced by the extension, not user-editable at upload time.
- `content` — a `Blob` (HTML or ZIP bytes) or a `string`.
- `url` — the original page URL.

### 3.2 A fresh `AbortController` per upload

`upload()` assigns `this.controller = new AbortController()` on **every** call, so a single
`RestFormApi` instance is not safely reusable for concurrent uploads — the last call wins and
`abort()` only cancels that one. In practice SingleFile constructs a new instance per save
(`new RestFormApi(token, restApiUrl, fileFieldName, urlFieldName)` inside `saveToRestFormApi`), so
this is not observable through the UI.

`abort()` is a no-op if `upload()` was never called, and aborting is idempotent.

### 3.3 Header behaviour

`this.headers` is a `Map`, not a plain object — `fetch` accepts both, and a `Map` is converted to
`Headers` by the platform. Verified outcomes:

| Configured token | `Authorization` header sent |
| --- | --- |
| `"abc"` | `Bearer abc` |
| `""` | `Bearer` (trailing space trimmed by the header parser) |
| unset/`undefined` | `Bearer undefined` |

Consequences:

- You cannot send **no** `Authorization` header. A server that requires a token can therefore simply
  reject an empty/`undefined` bearer value.
- You cannot send a different scheme (Basic, an API key header, …). The scheme is hardcoded to
  `Bearer`.
- Empty token and unset token are indistinguishable from the server's point of view except that one
  sends `Bearer` and the other `Bearer undefined`. Treat both as "no token".
- `Accept: application/json` is always sent, and it is the only `Accept` value.

Because `Authorization` is not a CORS-safelisted request header, a cross-origin upload **always**
triggers an `OPTIONS` preflight (verified — see [§9](#9-cors-permissions-and-security-model)).

### 3.4 Not implemented

The client has no:

- retry logic (a 5xx is final),
- HTTP method or endpoint selection,
- progress reporting (see [§8](#8-cancellation-progress-bookmarks)),
- request timeouts,
- redirect handling you can rely on (a `302` to a same-origin URL is followed by `fetch`; the
  eventual response status is what gets checked),
- chunked/resumable upload,
- multipart field escaping or validation,
- response schema validation,
- conflict detection (`skip`/`uniquify`/`overwrite`/`prompt` are **ignored** — see
  [§12](#12-feature-matrix-what-you-can-and-cannot-do)).

## 4. Where the uploaded data comes from

Understanding this matters when you write your server-side parser, because the MIME type and the file
extension do **not** always agree.

`pageData.mimeType` is computed by single-file-core as:

```js
// single-file-core, core/util.js
getMimeType(options) {
	return !options.compressContent || options.selfExtractingArchive ? "text/html" : "application/zip";
}
```

| "File format" option | Flags | Bytes produced | `pageData.mimeType` | Filename extension | Part `Content-Type` |
| --- | --- | --- | --- | --- | --- |
| HTML | `compressContent: false` | HTML | `text/html` | `.html` | `text/html` |
| Self-extracting ZIP | `compressContent: true`, `selfExtractingArchive: true` | ZIP with an HTML wrapper | `text/html` | `.zip.html` | `text/html` |
| Self-extracting ZIP, universal | the above `+ extractDataFromPage: true` | ZIP with an HTML wrapper, extra data appended | `text/html` | `.zip.html` | `text/html` |
| ZIP | `compressContent: true` | ZIP | `application/zip` | `.zip` | `application/octet-stream` |

The two self-extracting rows are `text/html` end to end, because the result is a valid HTML document
that *contains* the ZIP bytes.

Two important details:

1. This is `pageData.mimeType`, which the REST destination **does not use**. The blob passed to
   `FormData` is tagged by the compression processor itself, and that tag becomes the part's
   `Content-Type`:

   ```js
   // single-file-core, processors/compression/compression.js
   return new Blob([pageContent], { type: "application/octet-stream" });
   ```

   So a ZIP upload always arrives as **`application/octet-stream`**, never `application/zip`. The
   `application/zip` value above only affects the plain browser-download path. **Detect ZIP by magic
   bytes (`PK\x03\x04`), not by `Content-Type`.**
2. **Self-extracting archives are labelled `text/html` and their filename ends in `.zip.html`.** A
   server that dispatches on `Content-Type` will happily store a self-extracting archive as an HTML
   page, and then serve it as `text/html` — which is in fact correct, because a self-extracting page
   *is* a valid HTML document that unpacks itself on load.

The "universal" variant (`extractDataFromPage: true`) appends the page's text content after the ZIP
end-of-central-directory record so that search engines can index it; it is the same `text/html`
wrapper, so nothing changes for the server.

### 4.1 What the payload contains (plain HTML case)

- Complete HTML document, resources (images, fonts, stylesheets) inlined as data URIs, frames inlined,
  shadow roots serialized, `<canvas>` snapshots embedded.
- A leading comment written by default (`insertSingleFileComment: true`):

  ```html
  <!--
   Page saved with SingleFile
   url: https://example.com/page?a=1#frag
   saved date: 2026-10-14T16:24:22.849Z
  -->
  ```

  This is the only place where the save **date** and the exact **save URL** are embedded in the
  payload. Parse it to get metadata the upload request does not carry. Note that it can be removed by
  user options (`insertSingleFileComment: false`, or `removeSavedDate: true`, or
  `removeFrames`-station variants).   The parser lives in single-file-core's `core/infobar.js` `extractInfobarData()` (source:
  https://github.com/gildas-lormeau/single-file-core), and it also tolerates a legacy header
  (`"Page saved with SingleFile"`). The header text is written by
  `Toolbar.prototype.getPageData()` (same repository, `core/index.js`).
- A `<link rel="canonical">` pointing at the original URL is inserted when
  `insertCanonicalLink` is on (default) and the saved URL is `http(s)`.
- If the "infobar" is enabled, a `<single-file-infobar>` element with save metadata is embedded.
  On the server side you would typically strip it; SingleFile's own editor does that after loading.

### 4.2 What a compressed payload contains

A ZIP archive of the page plus its resources (`index.html` + resource files), optionally with a root
directory named `<timestamp>_<tabId>/` when `createRootDirectory` is enabled, and optionally with a
password-protected payload (`password` option) using ZIP encryption. The upload itself is not
encrypted.

## 5. How a save is triggered and dispatched

### 5.1 Dispatch sites

`saveToRestFormApi` is called from exactly two places, both in the background page:

| Site | Function | Used for |
| --- | --- | --- |
| [downloads.js](src/core/bg/downloads.js) `downloadContent()` | normal saves | button, menu, shortcuts, batch-save, editor "save" button |
| [downloads.js](src/core/bg/downloads.js) `downloadCompressedContent()` | compressed saves | same, when `compressContent` is on and the page was serialized with `yabson` |
| [autosave.js](src/core/bg/autosave.js) `saveContent()` | auto-save | auto-save on load/unload/discard/remove, and `saveUrls()` batch jobs |

Signature:

```js
async function saveToRestFormApi(taskId, filename, content, url, token, restApiUrl, fileFieldName, urlFieldName)
```

It looks up the task, bails out silently if the task was cancelled, constructs the client, registers
`client.abort()` as the task's cancel callback, and awaits `client.upload(...)`:

```js
async function saveToRestFormApi(taskId, filename, content, url, token, restApiUrl, fileFieldName, urlFieldName) {
	try {
		const taskInfo = business.getTaskInfo(taskId);
		if (!taskInfo || !taskInfo.cancelled) {
			const client = new RestFormApi(token, restApiUrl, fileFieldName, urlFieldName);
			business.setCancelCallback(taskId, () => client.abort());
			return await client.upload(filename, content, url);
		}
	} catch (error) {
		throw new Error(error.message + " (RestFormApi)", { cause: error });
	}
}
```

Note the error wrapping: the UI shows `<your response body> (RestFormApi)`.

### 5.2 What is passed as `content`

The call sites differ and this affects the `Content-Type` you receive:

| Path | `content` argument | Part `Content-Type` |
| --- | --- | --- |
| `downloadContent()` (normal HTML) | `Blob` built from the received chunks with `message.mimeType` → `text/html` | `text/html` |
| `downloadCompressedContent()` | `Blob` returned by `singlefile.processors.compression.process(...)` → `application/octet-stream` | `application/octet-stream` |
| `autosave.js` (uncompressed) | `pageData.content` — a **string** → wrapped as `new Blob([content], { type: "text/html" })` | `text/html` |
| `autosave.js` (compressed) | `new Blob([new Uint8Array(content)], { type })` | `application/octet-stream` |

### 5.3 Which options are actually used

The options that gate and parameterize the REST destination, in evaluation order
([downloads.js](src/core/bg/downloads.js)):

```
saveToClipboard
  → saveWithWebDAV
  → saveWithMCP
  → saveToGDrive
  → saveToDropbox
  → saveToGitHub
  → saveWithCompanion
  → saveToRestFormApi      ← here
  → saveToS3
  → browser download (default)
```

So if more than one destination flag is set (only possible through an imported config), the first one
in that list wins, and REST form API loses to everything except S3 and the browser download.

## 6. The five options

Defined in [config.js](src/core/bg/config.js) `DEFAULT_CONFIG` and rendered in
[options.html](src/ui/pages/options.html) under Destination. All five are **per profile**, so a
rule can point different sites at different endpoints.

| Option key | Type | Default | UI control | Notes |
| --- | --- | --- | --- | --- |
| `saveToRestFormApi` | boolean | `false` | radio in the destination group | selects the destination |
| `saveToRestFormApiUrl` | string | `""` | text input | endpoint URL, used verbatim |
| `saveToRestFormApiToken` | string | `""` | password input | raw value after `Bearer ` |
| `saveToRestFormApiFileFieldName` | string | `""` | text input | part name of the file |
| `saveToRestFormApiUrlFieldName` | string | `""` | text input | part name of the page URL |

### 6.1 Validation

There is **no validation of any of these values**:

- No URL scheme check. `file://`, `ftp://`, relative paths, or garbage will be accepted by the
  options page and will simply fail at upload time.
- No requirement that the URL be non-empty. An empty URL makes `fetch("")` resolve to the
  extension's own background page URL, which then returns a non-2xx and surfaces as an error.
- No requirement that a field name be non-empty (see the empty-body case in [§2.4](#24-optional-parts)).
- The token is stored in plain text in `browser.storage.local` (or `.sync`, if "synchronize options"
  is enabled) and exported verbatim by the settings export. Treat it as a credential with a
  correspondingly narrow scope and a short lifetime.

### 6.2 Choosing a destination resets unrelated permissions

Clicking the REST form API radio calls
`disableDestinationPermissions(["clipboardWrite", "nativeMessaging"])`
([ui-options.js](src/ui/bg/ui-options.js)), which:

- revokes the Google Drive auth info and token,
- revokes the Dropbox auth info and token,
- removes the optional `clipboardWrite` and `nativeMessaging` permissions.

So switching to this destination is destructive to other destinations' state. The same happens for
every other destination radio, which is why "save to filesystem" is recomputed as
"none of the others are selected".

### 6.3 Interaction with the file format

- `compressContent: true` (ZIP / self-extracting ZIP) sends binary data — see [§4](#4-where-the-uploaded-data-comes-from).
- `confirmFilename: true` makes the extension prompt for the filename **before** uploading.
- Conflict handling options (`filenameConflictAction`, "filename conflict" prompt) are **ignored** by
  this destination, because the extension never learns whether the file already exists on your server.
- `openSavedPage` opens the viewer for the local copy after a successful upload.
- `replaceBookmarkURL` (+ `bookmarkId`) rewrites the bookmark using `response.url`.

## 7. Response handling and error semantics

```js
if ([200, 201, 202].includes(response.status)) {
	return response.json();
} else {
	throw new Error(await response.text());
}
```

Consequences for a server author:

- Return `200`, `201` or `202`. `204` fails.
- Return JSON on success. HTML or an empty body fails with a `SyntaxError`.
- On failure, the response body is shown in the SingleFile UI (and in the console) verbatim, so
  **return a short, human-readable error string**, e.g. `"archive too large"`, not an HTML page and
  not a huge JSON object. It is prefixed by the extension with `(RestFormApi)`.
- JSON error bodies are shown as raw JSON text, which is ugly in the popup. Plain text is better.
- Status `401`/`403` from your server has **no special handling** (unlike WebDAV, GDrive or Dropbox,
  which re-authenticate). It just becomes an error message; the user must fix the token manually.

## 8. Cancellation, progress, bookmarks

### 8.1 Cancellation

`business.setCancelCallback(taskId, () => client.abort())` connects the extension's cancel button,
the "x" in the pending-tasks page, tab closure and Escape-key cancellation to `AbortController.abort()`.

- Cancelling mid-upload rejects with `AbortError`.
- `downloadContent()` / `downloadCompressedContent()` swallow the error when
  `error.message == "upload_cancelled"`; an `AbortError` propagates to `ui.onError` and shows an
  error badge. In practice you should expect the user to see a transient error if they cancel during
  the upload rather than a clean cancellation.
- A cancelled task also skips the upload entirely, because `saveToRestFormApi` bails out before
  constructing the client.
- **Your server must tolerate a client disconnect mid-body.** Node's `req` will emit `aborted` and the
  request should be cleaned up; a half-written file should not be left behind or, if it is, it must
  not be published.

### 8.2 Progress

There is **no** progress reporting for this destination. `ui.onUploadProgress(tabId, offset, size)` is
only wired for Google Drive and Dropbox. The toolbar icon shows an indeterminate state until the
promise settles. If you need progress, you would have to modify the client to use
`XMLHttpRequest`/`ReadableStream` (a `fetch` upload body has no upload progress events in current
browsers).

### 8.3 Bookmarks

If the save originated from a bookmark (`saveCreatedBookmarks`) and `replaceBookmarkURL` is enabled,
`downloads.js` does:

```js
if (message.bookmarkId && message.replaceBookmarkURL && response && response.url) {
	await bookmarks.update(message.bookmarkId, { url: response.url });
}
```

Returning `{ "url": "https://your-backend/archives/1234" }` from your endpoint is therefore the
supported way to make archived pages reachable from the browser's bookmark bar.

## 9. CORS, permissions and security model

### 9.1 CORS is mandatory for cross-origin endpoints

The request is issued from the background page. `Origin` is the extension origin
(`moz-extension://…` / `chrome-extension://…`), and because the request carries a non-safelisted
`Authorization` header, a preflight is issued. Verified preflight/response pair:

```
OPTIONS /upload          → Access-Control-Request-Method: POST
                           Access-Control-Request-Headers: authorization
POST  /upload            → (actual request)
```

Your server must answer the preflight with a response that allows the `authorization` request header,
e.g.

```http
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: Authorization, Accept
Access-Control-Max-Age: 600
```

Notes:

- `Access-Control-Allow-Headers: *` does not cover `Authorization` in every browser; list it
  explicitly.
- `Access-Control-Allow-Origin: *` is fine because the request is not credentialed (no cookies are
  sent; `credentials` is not set, so it defaults to `same-origin`). If you ever need cookies, you
  would need `Access-Control-Allow-Credentials: true` and an explicit origin — but the client does
  not send credentials at all, so cookie-based auth is not usable with this destination.
- `form-data` itself is not the reason for the preflight; `Authorization` is. Removing the token does
  not remove the preflight, because the header is always sent (`Bearer` / `Bearer undefined`).
- If your endpoint is same-origin with… nothing, really — there is no case where a page-origin
  preflight is avoided, because the caller is always the extension.

### 9.2 Permissions

The extension already declares `<all_urls>` in `permissions`
([manifest.json](manifest.json)), so no extra runtime permission prompt is needed to upload to an
arbitrary HTTPS endpoint. There is no host allow-list and no per-endpoint consent step for this
destination, unlike the external capture API which has its own approval flow.

### 9.3 Security guidance for server authors

The extension sends the token to whatever URL is configured, on every save, without user confirmation.
The following are therefore the client's security properties, not yours to assume away:

- **Treat the token as a bearer credential** scoped to writing archives. If your endpoint returns
  archive permalinks, the token should not be required to read them, or reads should use a different
  credential.
- **Authenticate on the server.** The client makes no attempt to do so beyond the header.
- **Never trust the multipart `filename`.** Verified: `../../etc/passwd.html` is transmitted verbatim
  in `Content-Disposition`. Always `path.basename()` the filename, strip separators, and reject
  control characters before touching the filesystem. The extension's own filename sanitization
  protects the local download path, not your server.
- **Bound the request size.** The extension does not chunk, so the whole archive arrives in one
  request. Node's `http` server streams it, but if you buffer it you must cap the size yourself.
  Compressed archives of large pages are routinely tens of megabytes.
- **Bound the URL field length** before storing it.
- **Do not echo the token** in responses or logs.
- The uploaded HTML is **not necessarily trusted**: it can contain scripts that were present on the
  captured page (blocking scripts is a per-profile option, `blockScripts`, and it *is* on by default —
  but do not build a security control on it). If you serve archives back, serve them with
  `Content-Security-Policy` and from a separate origin or with `Content-Disposition: attachment`, and
  never from the same origin as anything that holds credentials.

## 10. Building the server

### 10.1 Minimum viable endpoint

1. Accept `POST` on your endpoint URL.
2. Answer `OPTIONS` for CORS.
3. Validate `Authorization: Bearer <token>`.
4. Parse `multipart/form-data`; take the part with a `filename` as the archive.
5. Read the other named part as the source URL.
6. Persist the bytes.
7. Reply `201` with `Content-Type: application/json` and a JSON object, ideally `{"url": "<permalink>"}`.

### 10.2 Choosing a framework

Any framework works, because the protocol is plain multipart. The characteristics you need:

| Requirement | Why |
| --- | --- |
| multipart body size limit raised above the default | a compressed archive of a big page is often > 10 MB; express defaults to 100 kB, Fastify to 1 MB |
| raw streaming or a raised limit | avoid buffering in memory if possible |
| CORS with `authorization` allowed | preflight |
| ability to return a non-2xx with a **plain text** body | error message surfacing |

Sketch (Express 5):

```js
import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();
app.use(cors({
	origin: "*",
	methods: ["POST", "OPTIONS"],
	allowedHeaders: ["Authorization", "Accept"]
}));
const upload = multer({ dest: "uploads/", limits: { fileSize: 256 * 1024 * 1024 } });

app.post("/api/archives", upload.single("archive"), async (req, res) => {
	const token = (req.headers.authorization || "").replace(/^Bearer\s+/, "");
	if (!token || token !== process.env.SINGLEFILE_TOKEN) {
		return res.status(401).type("text/plain").send("invalid token");
	}
	if (!req.file) {
		return res.status(422).type("text/plain").send("missing archive field");
	}
	const sourceUrl = req.body.url || "";
	const id = await store(req.file, sourceUrl);
	res.status(201).json({ url: `https://archives.example.com/${id}` });
});
```

Notes on this sketch:

- `multer` exposes the part name as the field name, so `saveToRestFormApiFileFieldName` must be
  `archive` here. If you want the field name to be configurable by users, accept any single file part
  instead of using `.single("archive")`.
- `multer` gives you `req.file.mimetype` from the part's `Content-Type` — remember it is
  `application/octet-stream` for ZIPs ([§4](#4-where-the-uploaded-data-comes-from)).
- The error replies use `.type("text/plain")` so the message reaches the SingleFile UI intact.

### 10.3 Sizing and limits

- A plain HTML page with inlined images is typically 0.5–20 MB.
- The same page as a ZIP is typically 20–70 % smaller.
- The fastest way to check the size the client will send is to configure the destination and watch the
  request; there is no client-side size check for this destination, unlike the MCP path.

## 11. Reference implementation

A complete, dependency-free Node server that implements the protocol and has been verified end-to-end
against the real `RestFormApi` client:

```js
/* SingleFile REST Form API receiver. Run: node server.mjs */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.SINGLEFILE_TOKEN || "";
const UPLOAD_DIR = process.env.UPLOAD_DIR || "./uploads";
const PATH_PREFIX = "/api/archives";
const MAX_FIELD_LENGTH = 8192;

function parseBoundary(contentType) {
	const match = /boundary="?([^";]+)"?/i.exec(contentType || "");
	return match && match[1];
}

function parsePartHeaders(rawHeaders) {
	const headers = {};
	for (const line of rawHeaders.split("\r\n")) {
		const separator = line.indexOf(":");
		if (separator > 0) {
			headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
		}
	}
	return headers;
}

function parseContentDisposition(value = "") {
	const name = /;\s*name="((?:[^"\\]|\\.)*)"/i.exec(value);
	const filename = /;\s*filename="((?:[^"\\]|\\.)*)"/i.exec(value);
	return { name: name && name[1], filename: filename && filename[1] };
}

function parseMultipart(body, boundary) {
	const delimiter = Buffer.from("--" + boundary);
	const parts = [];
	let cursor = body.indexOf(delimiter);
	if (cursor < 0) {
		return parts;
	}
	cursor += delimiter.length;
	while (cursor < body.length) {
		if (body.slice(cursor, cursor + 2).toString() === "--") {
			break;
		}
		if (body.slice(cursor, cursor + 2).toString() !== "\r\n") {
			break;
		}
		cursor += 2;
		const headerEnd = body.indexOf("\r\n\r\n", cursor);
		if (headerEnd < 0) {
			break;
		}
		const headers = parsePartHeaders(body.slice(cursor, headerEnd).toString("utf8"));
		const dataStart = headerEnd + 4;
		const dataEnd = body.indexOf(delimiter, dataStart);
		if (dataEnd < 0) {
			break;
		}
		// drop the CRLF that precedes the delimiter
		parts.push({ headers, data: body.slice(dataStart, Math.max(dataStart, dataEnd - 2)) });
		cursor = dataEnd + delimiter.length;
	}
	return parts;
}

function sendJson(res, status, payload) {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(payload));
}

// error bodies are shown verbatim in the SingleFile UI: keep them short and plain
function sendError(res, status, message) {
	res.writeHead(status, { "Content-Type": "text/plain" });
	res.end(message);
}

const server = createServer((req, res) => {
	const chunks = [];
	req.on("data", chunk => chunks.push(chunk));
	req.on("end", () => {
	handle(req, res, Buffer.concat(chunks)).catch(error => sendError(res, 500, error.message));
	});
});

async function handle(req, res, body) {
	if (req.method === "OPTIONS") {
		res.writeHead(204, {
			"Access-Control-Allow-Origin": req.headers.origin || "*",
			"Access-Control-Allow-Methods": "POST, OPTIONS",
			"Access-Control-Allow-Headers": "Authorization, Accept",
			"Access-Control-Max-Age": "600"
		});
		res.end();
		return;
	}
	if (req.method !== "POST" || !req.url.startsWith(PATH_PREFIX)) {
		sendError(res, 404, "not found");
		return;
	}
	const authorization = req.headers.authorization || "";
	if (!authorization.startsWith("Bearer ") || (TOKEN && authorization.slice(7) !== TOKEN)) {
		sendError(res, 401, "invalid or missing token");
		return;
	}
	const boundary = parseBoundary(req.headers["content-type"]);
	if (!boundary) {
		sendError(res, 400, "expected multipart/form-data");
		return;
	}
	const parts = parseMultipart(body, boundary);
	const dispositions = parts.map(part => parseContentDisposition(part.headers["content-disposition"] || ""));
	// the file part is the only one carrying a filename; any other part is the source URL,
	// whatever the user named it in the "archive URL field name" option
	const fileIndex = dispositions.findIndex(disposition => disposition.filename);
	if (fileIndex < 0) {
		sendError(res, 422, "missing archive part");
		return;
	}
	const filePart = parts[fileIndex];
	const urlIndex = dispositions.findIndex((disposition, index) => index !== fileIndex && !disposition.filename);
	const urlPart = urlIndex < 0 ? null : parts[urlIndex];
	const { name, filename } = dispositions[fileIndex];
	const pageUrl = urlPart && urlPart.data.length <= MAX_FIELD_LENGTH ? urlPart.data.toString("utf8") : "";
	const safeName = path.basename(decodeURIComponent(filename).replace(/\\/g, "/"));
	const storedName = `${Date.now()}-${safeName}`;
	await mkdir(UPLOAD_DIR, { recursive: true });
	await writeFile(path.join(UPLOAD_DIR, storedName), filePart.data);
	sendJson(res, 201, {
		url: `http://localhost:${PORT}${PATH_PREFIX}/${encodeURIComponent(storedName)}`,
		file: storedName,
		field: name,
		sourceUrl: pageUrl,
		size: filePart.data.length,
		contentType: filePart.headers["content-type"] || ""
	});
}

server.listen(PORT, () => console.log(`listening on http://localhost:${PORT}${PATH_PREFIX}`));
```

Important caveat about this reference code: it **buffers the whole request in memory** to keep the
multipart parser dependency-free. The buffer should be treated as untrusted input and must be sized
and validated; for production either add a size cap before buffering or use a streaming multipart
parser. The verified behaviour of this server:

```
POST html   → 201 {"url":"…/1791996042782-My%20Page%20(2026-10-14).html","field":"archive",
                   "sourceUrl":"https://example.com/page?a=1#frag","size":72,"contentType":"text/html"}
POST zip    → 201 {"contentType":"application/octet-stream", …}    (file part, ZIP bytes)
POST .zip.html → 201 {"contentType":"text/html", …}                (self-extracting archive)
POST with archive data field name "page_html" and URL field name "page_url"
            → 201 {"field":"page_html","sourceUrl":"https://example.com/custom#x", …}
POST with an empty URL field name → 201 {"sourceUrl":"", …}        (file only, correctly parsed)
wrong token → 401 "invalid or missing token"  → shown as: invalid or missing token (RestFormApi)
no file     → 422 "missing archive part"
"../../etc/passwd.html" → stored as "…-passwd.html"                (basename applied)
```

### 11.1 Configuration to paste into the extension

Destination → **upload to a REST Form API**:

| Field | Value |
| --- | --- |
| URL | `http://localhost:8080/api/archives` (or your HTTPS endpoint) |
| authorization token | the value of `SINGLEFILE_TOKEN` |
| archive data field name | `archive` |
| archive URL field name | `url` |

Then press the SingleFile button on any page. The page should appear under `./uploads`.

## 12. Feature matrix: what you can and cannot do

| Capability | Supported | Notes |
| --- | --- | --- |
| Custom endpoint URL | yes | used verbatim, per profile |
| Bearer token | yes | only auth scheme available; always sent |
| Arbitrary/custom HTTP headers | no | only `Authorization` and `Accept` |
| Custom form field names | yes | two fields, both optional |
| Additional form fields (title, date, tags, …) | no | derive from payload ([§4.1](#41-what-the-payload-contains-plain-html-case)) |
| Upload raw HTML | yes | `text/html`, filename `.html` |
| Upload ZIP archive | yes | `application/octet-stream`, filename `.zip`, magic bytes `PK\x03\x04` |
| Upload self-extracting archive | yes | `text/html`, filename `.zip.html`, contains ZIP |
| Upload MHTML/PDF/other formats | no | this destination always uploads the SingleFile HTML/ZIP output |
| Custom MIME type in the part | only indirectly | comes from the blob type |
| `PUT`/`PATCH`, directory creation, conflict detection | no | single `POST`; `filenameConflictAction` ignored |
| Resume / chunked / retry upload | no | one request, no retry |
| Upload progress reporting | no | only GDrive/Dropbox |
| Cancellation | yes | `AbortController`, mid-flight abort |
| Server-driven redirect to a viewer | only via response `url` | used for bookmark replacement, and `openSavedPage` opens the *local* copy |
| Cookie-based auth / client certificates | no | `fetch` runs with default `same-origin` credentials |
| Multiple destinations at once | no | one destination per save, priority list in [§5.3](#53-which-options-are-actually-used) |
| Auto-save to the endpoint | yes | per-profile `autoSave*` options |
| Batch/bulk save to the endpoint | yes | batch-save-urls page, tab/menu bulk actions |
| Per-site endpoints | yes | profiles + rules, including `regexp:` rules |
| Sync the token across devices | yes | "synchronize options" uses `browser.storage.sync` |
| Encrypt the upload | via HTTPS | the extension performs no payload encryption; ZIP password only protects the inner payload |

## 13. Talking to the browser add-on

If you are building a server *and* an integration, you have three separate integration surfaces. Only
the first one is used by this destination.

### 13.1 `onMessageExternal` — for other extensions

The extension exposes an external messaging API for other extensions
([external-messages.js](src/core/bg/external-messages.js), [index.js](src/core/bg/index.js)). Send to
SingleFile's fixed extension ID:

- Firefox: `{531906d3-e22f-4a6c-a102-8057b88a1a63}` ([manifest.json](manifest.json))
- Chromium: `mpiodijhokgodhhofbcjdecpffjipkle`
- Edge: `efnbkdcfmcmnhlkaijjjmhjjgladedno`

(The Chromium and Edge IDs are the store listing IDs from [README.MD](README.MD); confirm the installed
ID on `chrome://extensions` / `edge://extensions` before hardcoding it, especially for an unpacked or
self-hosted build, whose ID depends on the signing key.)

`manifest.json` does not declare `externally_connectable`, so — per the Chromium behaviour for a
missing key — any other extension or app may connect, while web pages may not. Invoking this API still
requires the caller to be an extension.

**Simple actions** — send a plain string, `sendMessage(singleFileId, "save-page")`:

| String | Effect |
| --- | --- |
| `"save-page"` | save the current page |
| `"edit-and-save-page"` | open the editor and save |
| `"save-selected-links"` | save links inside the selection |
| `"save-selected-content"` | save the selection |
| `"save-selected-tabs"` | save the highlighted tabs |
| `"save-unpinned-tabs"` | save unpinned tabs |
| `"save-all-tabs"` | save all tabs |

These run through the **user's configured destination**, so a server that registers an endpoint gets
these saves without any extra work.

**Capture** — `sendMessage(singleFileId, { method: "capture-page", tabId?, config?, displayName? })`
resolves with the captured `pageData` (including `content`) *without* saving anywhere. Two things to
know:

- `config` may only carry content-shaping options (`CAPTURE_OPTION_NAMES` in
  [external-messages.js](src/core/bg/external-messages.js)). Destinations, credentials, delays and
  filename confirmation are **always** taken from the user's settings and cannot be forced by the
  caller. There is no way for a third-party extension to push a page into your endpoint directly.
- The first request shows an approval prompt in the options page; decisions are stored per extension
  ID in `externalCaptureAllowedExtensionIds` / `externalCaptureDeniedExtensionIds`, with a
  5-minute timeout ([external-capture-permissions.js](src/core/bg/external-capture-permissions.js)).

Other accepted `method` values: `enableAutoSave`, `isAutoSaveEnabled` (both act on the active tab,
see `autosave.onMessageExternal`).

### 13.2 Internal `runtime.onMessage` protocol

Between the extension's own pages the protocol is `{ method: "<namespace>.<action>", ...payload }`
dispatched by prefix in [index.js](src/core/bg/index.js):

| Prefix | Module |
| --- | --- |
| `tabs.` | [tabs.js](src/core/bg/tabs.js) |
| `downloads.` | [downloads.js](src/core/bg/downloads.js) |
| `autosave.` | [autosave.js](src/core/bg/autosave.js) |
| `ui.` | [ui/bg/index.js](src/ui/bg/index.js) |
| `config.` | [config.js](src/core/bg/config.js) |
| `tabsData.` | [tabs-data.js](src/core/bg/tabs-data.js) |
| `editor.` | [editor.js](src/core/bg/editor.js) |
| `bookmarks.` | [bookmarks.js](src/core/bg/bookmarks.js) |
| `companion.` | [companion.js](src/core/bg/companion.js) |
| `requests.` | [requests.js](src/core/bg/requests.js) |
| `externalCapture.` | [external-capture-permissions.js](src/core/bg/external-capture-permissions.js) |
| `bootstrap.` | [bootstrap.js](src/core/bg/bootstrap.js) |

The two most relevant for configuring an endpoint programmatically:

- `config.get` → whole config incl. `profiles`
- `config.updateProfile` with `{ profileName, profile: { saveToRestFormApi: true, saveToRestFormApiUrl, … } }`
- `config.importConfig` with `{ profiles, rules, maxParallelWorkers, processInForeground }`
- `config.addRule` with `{ url, profileName, autoSaveProfileName }`
- `downloads.getInfo` / `downloads.cancel` with `{ taskId }`

These require `browser.runtime.id`-internal senders, so they are only usable from the extension's own
pages — not from your server.

### 13.3 Server-side integration points, in order of usefulness

1. **The REST Form API endpoint itself** — the only channel the server needs for receiving archives.
2. **The bookmark replacement URL** — return `{"url": …}` to make the browser bookmark point at your
   archive permalink.
3. **The exported settings JSON** — `config.exportConfig` produces a file you can hand to users;
   `config.importConfig` consumes it. For fleet/deployment scenarios this is the supported way to
   pre-configure an endpoint. Note that token fields are included verbatim, so do not ship a file with
   a shared secret in it; leave the token blank and instruct users to fill it in.
4. **`onMessageExternal`** — only relevant if you also ship a companion extension.
5. **A native companion** (`browser.runtime.sendNativeMessage("singlefile_companion", …)`,
   [companion.js](src/core/bg/companion.js)) — a separate, local-only integration that receives
   `pageData` over the native messaging channel. The MCP destination
   ([tools/mcp-server](tools/mcp-server)) is an HTTP variant of the same idea and is *not* compatible
   with the REST Form API protocol: it speaks JSON-RPC 2.0 with `tools/call`, not multipart.

## 14. Gotchas and verification checklist

Known traps, all of which cost time if you discover them while debugging:

1. `204 No Content` is **not** a success code. Return `200`, `201` or `202`.
2. A non-JSON success body fails with `SyntaxError`. Return JSON.
3. `Content-Type` of the file part is `application/octet-stream` for ZIP, not `application/zip`.
   Detect archives by magic bytes.
4. Self-extracting archives are `text/html` with a `.zip.html` name and contain a ZIP.
5. The `Authorization` header is always present. `Bearer` (empty token) and `Bearer undefined`
   (unset) are the two "no token" spellings.
6. A preflight `OPTIONS` is always required cross-origin; `Authorization` is not safelisted.
7. `filename` in the multipart part is attacker-controlled in the general case. Sanitize it.
8. Empty `fileFieldName` silently drops the payload, leaving a 38-byte body.
9. Error response bodies are shown verbatim in the SingleFile UI — return plain text.
10. Cancelling during upload surfaces as an error, because `AbortError` does not match the
    `"upload_cancelled"` string the download path swallows.
11. There is no retry. A transient 5xx loses the save (unless it was an auto-save that will re-run).
12. `filenameConflictAction` and the "prompt on conflict" behaviour do not apply to this destination.
13. Selecting this destination revokes Google Drive and Dropbox tokens and drops
    `clipboardWrite`/`nativeMessaging` permissions.
14. `saveToRestFormApiUrl` is used verbatim: no trailing-slash handling, no path joining, no
    normalization.
15. Options are per profile, so "it works on one site but not another" usually means a rule maps the
    site to a different profile.

### 14.1 Verification checklist for a new server

- [ ] `OPTIONS` returns `Access-Control-Allow-Headers: Authorization, Accept` (explicitly, not `*`).
- [ ] `POST` with a valid token returns `201` and a JSON body.
- [ ] `POST` with a wrong token returns `401` with a plain text body, and the text appears in the
      SingleFile popup.
- [ ] A plain HTML save lands as a readable `.html` file containing the expected page.
- [ ] Setting the format to ZIP lands binary bytes starting with `PK\x03\x04`.
- [ ] Setting the format to self-extracting ZIP lands a file ending in `.zip.html` that opens in a
      browser and unpacks itself.
- [ ] The URL field contains the original page URL including the fragment.
- [ ] A large page (say 30 MB of inlined images) uploads without hitting a body-size limit.
- [ ] Cancelling during the upload does not leave a corrupted file published.
- [ ] Reproducing the upload to a path-traversal filename does not write outside the upload directory.
