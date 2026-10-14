/**
 * A parser for the one shape of `multipart/form-data` this service receives.
 *
 * Hand-written rather than pulled from a dependency, for the same reason the
 * router is: what arrives here is attacker-shaped by definition — a file part
 * whose `filename` is client-controlled verbatim, and a boundary the client
 * chose — and the parts of multipart this service actually needs are small
 * enough to test exhaustively. A general parser would also bring framing
 * decisions (nested multipart, `Content-Transfer-Encoding`, per-part limits)
 * that nothing here uses and that would silently become behaviour this service
 * is responsible for.
 *
 * The two callers are the SingleFile REST Form API destination, which sends a
 * file part and a URL part, and nothing else at all.
 */

/** One part of a multipart body, with its headers already lower-cased. */
export interface MultipartPart {
  /** Part headers, names lower-cased, values trimmed. */
  headers: Record<string, string>;
  /** Part body, exactly as sent, without the CRLF that precedes the boundary. */
  body: Buffer;
}

/** The `name` and `filename` of a part, when it declares them. */
export interface PartDisposition {
  name?: string;
  filename?: string;
}

/**
 * Read the boundary out of a `Content-Type` header.
 *
 * Returns null for anything that is not a multipart media type, so a caller can
 * refuse the request rather than attempt a parse that would find no parts and
 * report the same failure a confusing step later.
 */
export function boundaryOf(contentType: string | string[] | undefined): string | null {
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  if (value === undefined) return null;

  const media = /^\s*multipart\/form-data\s*(?:;|$)/i;
  if (!media.test(value)) return null;

  // Quoted and unquoted are both legal and both occur in the wild; the quoted
  // form is the one that can contain a semicolon, so it is tried first.
  const match = /;\s*boundary="([^"]*)"|;\s*boundary=([^;\s]+)/i.exec(value);
  const boundary = match?.[1] ?? match?.[2];
  return boundary === undefined || boundary === '' ? null : boundary;
}

/**
 * Split a body into its parts.
 *
 * Deliberately tolerant of a malformed tail rather than strict: a truncated
 * upload — the client disconnected, the size cap was hit — should yield the
 * parts that did arrive, so the caller can report what was wrong instead of
 * being handed an exception that says only "bad request".
 *
 * The delimiter is matched at line starts only. A boundary string appearing
 * *inside* a part's bytes is otherwise indistinguishable from a real delimiter,
 * and would silently truncate the upload at a place the client never chose.
 */
export function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: MultipartPart[] = [];

  let cursor = body.indexOf(delimiter);
  if (cursor === -1) return parts;
  cursor += delimiter.length;

  while (cursor < body.length) {
    // `--` after the delimiter closes the body; anything else may be transport
    // padding (linear whitespace), which multipart permits.
    if (body[cursor] === 0x2d && body[cursor + 1] === 0x2d) break;
    while (body[cursor] === 0x20 || body[cursor] === 0x09) cursor += 1;

    if (body[cursor] !== 0x0d || body[cursor + 1] !== 0x0a) break;
    cursor += 2;

    const headerEnd = body.indexOf('\r\n\r\n', cursor);
    if (headerEnd === -1) break;

    const headers = parsePartHeaders(body.subarray(cursor, headerEnd).toString('latin1'));
    const bodyStart = headerEnd + 4;

    // The delimiter that ends this part must be preceded by CRLF, and that CRLF
    // belongs to the framing rather than to the part's content.
    const next = indexOfDelimiter(body, delimiter, bodyStart);
    if (next === -1) break;

    parts.push({ headers, body: body.subarray(bodyStart, next) });
    cursor = next + 2 + delimiter.length;
  }

  return parts;
}

/** The `name` and `filename` a part declares, with quoting and escapes undone. */
export function dispositionOf(part: MultipartPart): PartDisposition {
  const value = part.headers['content-disposition'];
  if (value === undefined) return {};

  const name = /\bname="((?:[^"\\]|\\.)*)"/i.exec(value)?.[1];
  const filename = /\bfilename="((?:[^"\\]|\\.)*)"/i.exec(value)?.[1];
  return {
    ...(name === undefined ? {} : { name: unescapeQuoted(name) }),
    ...(filename === undefined ? {} : { filename: unescapeQuoted(filename) }),
  };
}

/**
 * Reduce a client-supplied filename to a single safe path segment.
 *
 * The extension sanitises filenames for its *own* disk, not for this server, so
 * `../../etc/passwd.html` arrives verbatim. Every separator a filesystem might
 * honour is removed — including the Windows backslash, which `path.basename`
 * on a POSIX host does not treat as one — and control characters are dropped so
 * a name cannot smuggle a newline into a header or a log line.
 *
 * The name is also never used as a path here: it is recorded as metadata and
 * shown to the reader. This is a second line of defence, not the only one.
 */
export function sanitizeFilename(value: string | undefined): string {
  if (value === undefined) return '';
  const decoded = (() => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  })();

  const tail = decoded.replace(/\\/g, '/').split('/').pop() ?? '';
  return tail.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255);
}

/**
 * The header block of a part, as a lookup.
 *
 * Read as latin1 rather than utf8 because a part header is defined as ASCII with
 * arbitrary octets permitted in a filename; decoding as utf8 would replace those
 * with U+FFFD and lose the evidence of what was actually sent.
 */
function parsePartHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    // A repeated header is joined rather than overwritten, so a duplicated
    // `content-disposition` cannot hide the first one from a reader of the map.
    const value = line.slice(separator + 1).trim();
    headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
  }
  return headers;
}

/**
 * Find the delimiter that terminates a part, requiring a line boundary.
 *
 * `Buffer.indexOf` cannot express "preceded by CRLF" on its own, so the search
 * advances until a candidate sits at a start of line. Bounded by the body, so a
 * part whose delimiter never appears returns -1 and the caller stops rather than
 * scanning from the beginning again.
 */
function indexOfDelimiter(body: Buffer, delimiter: Buffer, from: number): number {
  let at = body.indexOf(delimiter, from);
  while (at !== -1) {
    if (at >= 2 && body[at - 2] === 0x0d && body[at - 1] === 0x0a) return at - 2;
    at = body.indexOf(delimiter, at + 1);
  }
  return -1;
}

/** Undo the backslash escapes a quoted-string header value may carry. */
function unescapeQuoted(value: string): string {
  return value.replace(/\\(.)/g, '$1');
}
