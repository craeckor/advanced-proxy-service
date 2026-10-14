import type { Config } from '../config.ts';
import type { Logger } from '../util/logger.ts';
import type { ArchiveStore } from './store.ts';
import { ArchiveBuilder } from './builder.ts';
import { boundaryOf, dispositionOf, parseMultipart, sanitizeFilename, type MultipartPart } from './multipart.ts';

/**
 * Ingest for a page saved by the SingleFile browser extension.
 *
 * SingleFile's "REST Form API" destination posts one `multipart/form-data`
 * request: the saved page as a file part, and the URL it was saved from as a
 * second part. That is genuinely all it sends — no title, no date, no tags, no
 * custom headers — so this module's job is to turn those two fields into an
 * archive and to be honest about what it had to infer.
 *
 * Three things about the payload drive everything here, and each was measured
 * from the client rather than assumed:
 *
 *   - **The file part is identified by having a `filename`, not by its field
 *     name.** The name is a user option on the client and blank is a legal
 *     value; a blank `filename` field name would silently drop the payload
 *     entirely, leaving a body of just a closing boundary. A part with a
 *     filename is the page; a part without one is the URL.
 *   - **A ZIP upload is labelled `application/octet-stream`, not
 *     `application/zip`.** The extension's compression step tags the blob with
 *     the former, so the media type cannot be used to tell an archive from an
 *     untyped part. The bytes are checked instead.
 *   - **A "self-extracting" archive is a valid HTML document that contains a
 *     ZIP**, labelled `text/html` with a `.zip.html` name. It is stored as
 *     `text/html` and replays as itself, which is correct — the browser unpacks
 *     it on load — so nothing here tries to look inside it.
 *
 * Continuity with the rest of the service is deliberate: an incoming upload
 * becomes an ordinary archive with an ordinary replay URL, and it is stored by
 * the same store, keyed by the same URL, as a crawl or a browser-assisted
 * capture.
 *
 * One thing this ingest deliberately does **not** do is fetch anything. A
 * SingleFile page is self-contained by construction — stylesheets, images,
 * fonts and frames are already inlined as data URIs, and the extension has
 * already resolved every URL itself from the user's own session. There is
 * nothing left to retrieve, so an upload costs one request and no outbound
 * traffic, which is also why it cannot be used to make this server fetch
 * arbitrary internal addresses.
 */

/** The outcome of accepting one upload. */
export interface RestFormResult {
  archiveId: string;
  /** The URL the page was saved from, which becomes the archive's seed. */
  sourceUrl: string;
  /** The filename the client reported, sanitised, for display only. */
  filename: string;
  /** Media type of the stored document, as recorded in the archive. */
  contentType: string;
  /** Bytes of the file part, before any resource the server fetched itself. */
  size: number;
}

/**
 * Why an upload was refused, in the wording the extension will show verbatim.
 *
 * The client surfaces a non-2xx body as the error text and appends
 * `(RestFormApi)`, so these are short, lower-case and free of JSON — a reader
 * sees them in a popup next to a Save button, not in a log.
 */
export class RestFormError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'RestFormError';
    this.status = status;
  }
}

export class RestFormIngest {
  readonly #config: Config;
  readonly #logger: Logger;
  readonly #store: ArchiveStore;

  constructor(config: Config, logger: Logger, store: ArchiveStore) {
    this.#config = config;
    this.#logger = logger;
    this.#store = store;
  }

  /**
   * Turn one uploaded multipart body into an archive.
   *
   * Throws `RestFormError` for anything the client should be told about; the
   * caller maps its `status` and `message` straight onto the response, which is
   * what makes the failure legible in the SingleFile popup.
   */
  async ingest(
    body: Buffer,
    contentType: string | string[] | undefined,
  ): Promise<RestFormResult> {
    if (body.byteLength > this.#config.archive.restFormMaxBytes) {
      throw new RestFormError(413, 'archive too large');
    }

    const boundary = boundaryOf(contentType);
    if (boundary === null) {
      throw new RestFormError(400, 'expected multipart/form-data');
    }

    const parts = parseMultipart(body, boundary);
    if (parts.length === 0) {
      throw new RestFormError(400, 'empty or malformed upload');
    }

    const described = parts.map((part) => ({ part, disposition: dispositionOf(part) }));
    const fileIndex = described.findIndex((entry) => entry.disposition.filename !== undefined);
    const file = described[fileIndex];
    if (file === undefined) {
      // The shape the client produces when the "archive data field name" option
      // is left blank: a body of one closing boundary and nothing else.
      throw new RestFormError(422, 'missing archive part');
    }

    const sourceUrl = this.#readSourceUrl(described, fileIndex);
    const filename = sanitizeFilename(file.disposition.filename);
    const partType = (file.part.headers['content-type'] ?? '').trim().toLowerCase();

    const { stored, contentType: storedType } = this.#decodePayload(file.part.body, filename, partType);

    const seed = sourceUrl === '' ? `singlefile:${filename || 'upload'}` : sourceUrl;
    const builder = await ArchiveBuilder.open(this.#store, this.#logger, {
      seedUrl: seed,
      producer: 'singlefile-rest-form',
    });

    try {
      // The document is stored under the URL it was saved from, so a replay of
      // that URL finds it — the archive is keyed the same way for every
      // producer, and a seed that is not a URL still gets a stable key rather
      // than being dropped.
      await builder.add(seed, 200, { 'content-type': storedType }, storedType, stored, {
        size: stored.byteLength,
        isDocument: true,
      });

      const result = await builder.finish();
      this.#logger.info(
        {
          archiveId: result.archiveId,
          sourceUrl,
          filename,
          contentType: storedType,
          size: stored.byteLength,
        },
        'singlefile upload archived',
      );

      return {
        archiveId: result.archiveId,
        sourceUrl,
        filename,
        contentType: storedType,
        size: stored.byteLength,
      };
    } catch (error) {
      await builder.fail(error);
      throw error;
    }
  }

  /**
   * The URL the page was saved from, taken from the one part that is not the file.
   *
   * Matched by *absence* of a filename rather than by field name, for the reason
   * in the module doc: the field name is a client-side option whose blank value
   * is legal, and a server that looked for `url` would refuse a correctly formed
   * upload from a user who named their fields something else.
   *
   * The value is bounded and trimmed of the trailing newline some clients add,
   * then accepted as opaque. It is *not* required to be a URL: SingleFile will
   * happily save a `file://` document or an extension page, and rejecting those
   * would lose the archive over a field that is only metadata. It is stored
   * verbatim so a replay of it is an exact replay.
   */
  #readSourceUrl(
    described: readonly { part: MultipartPart; disposition: { name?: string; filename?: string } }[],
    fileIndex: number,
  ): string {
    const limit = this.#config.archive.restFormMaxUrlBytes;
    const urlPart = described.find(
      (entry, index) => index !== fileIndex && entry.disposition.filename === undefined,
    );
    if (urlPart === undefined) return '';

    const raw = urlPart.part.body;
    const trimmed = raw.subarray(0, Math.min(raw.byteLength, limit)).toString('utf8').trim();
    if (raw.byteLength > limit) {
      this.#logger.warn({ bytes: raw.byteLength, limit }, 'singlefile upload: url field truncated');
    }
    return trimmed;
  }

  /**
   * Decide what the file part actually is, from its bytes rather than its label.
   *
   * A ZIP is recognised by its local file header signature, because the client
   * labels ZIP uploads `application/octet-stream` — the same label an untyped
   * part would carry, and a label that says nothing at all about the content.
   * Trusting the label would mean storing an archive as an opaque blob that no
   * reader can open.
   *
   * The stored media type is what the *replay* will need: `text/html` for
   * anything that is not a ZIP, so the page renders inline. A ZIP is stored as
   * `application/zip` rather than as `application/octet-stream` so that a
   * download of it is named and opened as the archive it is.
   */
  #decodePayload(body: Buffer, filename: string, declared: string): { stored: Buffer; contentType: string } {
    if (isZip(body)) {
      return { stored: body, contentType: 'application/zip' };
    }

    // A part with no media type at all is the case the extension produces for a
    // blob whose type was never set; the filename is the only remaining hint,
    // and an unknown one is treated as a document because that is what the
    // destination exists to carry.
    if (declared !== '' && declared !== 'application/octet-stream') {
      return { stored: body, contentType: declared };
    }
    if (/\.zip$/i.test(filename)) {
      return { stored: body, contentType: 'application/zip' };
    }
    return { stored: body, contentType: 'text/html; charset=utf-8' };
  }
}

/**
 * True when the bytes begin with a ZIP local file header.
 *
 * All four signature families are accepted, not only `PK\x03\x04`: an empty
 * archive is a bare end-of-central-directory record, and a spanned archive
 * starts with `PK\x07\x08`. A saved page is never empty, so the extra forms
 * cost nothing and avoid a class of "it stored my archive as a web page".
 *
 * A self-extracting archive is deliberately *not* matched. Those are valid HTML
 * documents whose first bytes are HTML, and storing one as a ZIP would turn a
 * page that renders into a download.
 */
function isZip(body: Buffer): boolean {
  if (body.byteLength < 4) return false;
  if (body[0] !== 0x50 || body[1] !== 0x4b) return false;
  const third = body[2];
  const fourth = body[3];
  return (
    (third === 0x03 && fourth === 0x04) ||
    (third === 0x05 && fourth === 0x06) ||
    (third === 0x07 && fourth === 0x08)
  );
}
