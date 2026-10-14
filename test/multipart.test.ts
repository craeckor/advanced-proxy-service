import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundaryOf, dispositionOf, parseMultipart, sanitizeFilename } from '../src/archive/multipart.ts';

/**
 * The multipart parser, unit-tested because every input it sees is chosen by the
 * client that sent it: the boundary, the part names, and the `filename` are all
 * attacker-controlled strings, and the payload is opaque bytes that may contain
 * the boundary sequence by coincidence.
 *
 * The shapes below are all taken from what the SingleFile REST Form API
 * destination actually sends, including the degenerate ones — a body with no
 * parts at all is a documented outcome of leaving a field-name option blank.
 */

/** Build a body the way a browser's `FormData` does, CRLF and all. */
function form(boundary: string, parts: Array<{ headers: string[]; body: string | Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n${part.headers.join('\r\n')}\r\n\r\n`, 'latin1'));
    chunks.push(Buffer.isBuffer(part.body) ? part.body : Buffer.from(part.body, 'utf8'));
    chunks.push(Buffer.from('\r\n', 'latin1'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'latin1'));
  return Buffer.concat(chunks);
}

const FILE_HEADERS = [
  'Content-Disposition: form-data; name="archive"; filename="page.html"',
  'Content-Type: text/html',
];
const URL_HEADERS = ['Content-Disposition: form-data; name="url"'];

test('a boundary is read from the media type, quoted or bare', () => {
  assert.equal(boundaryOf('multipart/form-data; boundary=abc'), 'abc');
  assert.equal(boundaryOf('multipart/form-data; boundary="a;b"'), 'a;b');
  assert.equal(boundaryOf('multipart/form-data; boundary=----formdata-undici-0'), '----formdata-undici-0');
  // Case and surrounding whitespace are the media type's business, not the value's.
  assert.equal(boundaryOf('Multipart/Form-Data; BOUNDARY=xyz'), 'xyz');
});

test('a body that is not multipart has no boundary', () => {
  // The caller refuses on null rather than attempting a parse that would find no
  // parts and report the same problem, less legibly, one step later.
  assert.equal(boundaryOf(undefined), null);
  assert.equal(boundaryOf('application/json'), null);
  assert.equal(boundaryOf('application/x-www-form-urlencoded'), null);
  // A `boundary` parameter on a non-multipart type is not a multipart body.
  assert.equal(boundaryOf('text/plain; boundary=abc'), null);
});

test('a boundary that is present but empty is refused', () => {
  // `boundary=` with no value would make the delimiter `--`, which matches the
  // dashes every part starts with and would split the body into nonsense.
  assert.equal(boundaryOf('multipart/form-data; boundary='), null);
  assert.equal(boundaryOf('multipart/form-data; boundary=""'), null);
  assert.equal(boundaryOf('multipart/form-data'), null);
});

test('a file part and a url part are separated', () => {
  const boundary = '----formdata-undici-055479952025';
  const body = form(boundary, [
    { headers: FILE_HEADERS, body: '<!doctype html><p>hi</p>' },
    { headers: URL_HEADERS, body: 'https://example.com/page?a=1#frag' },
  ]);

  const parts = parseMultipart(body, boundary);
  assert.equal(parts.length, 2);

  const file = dispositionOf(parts[0] as never);
  assert.equal(file.name, 'archive');
  assert.equal(file.filename, 'page.html');
  assert.equal((parts[0] as { body: Buffer }).body.toString('utf8'), '<!doctype html><p>hi</p>');

  const url = dispositionOf(parts[1] as never);
  assert.equal(url.name, 'url');
  assert.equal(url.filename, undefined, 'the url part carries no filename');
  assert.equal((parts[1] as { body: Buffer }).body.toString('utf8'), 'https://example.com/page?a=1#frag');
});

test('the part body excludes the CRLF that precedes the delimiter', () => {
  // Off by two here and every uploaded page gains a trailing blank line, which
  // changes the stored hash and therefore the archive's dedupe.
  const boundary = 'B';
  const body = form(boundary, [{ headers: FILE_HEADERS, body: 'exact' }]);
  const parts = parseMultipart(body, boundary);
  assert.equal((parts[0] as { body: Buffer }).body.toString('utf8'), 'exact');
  assert.equal((parts[0] as { body: Buffer }).body.byteLength, 5);
});

test('an empty part body is parsed as empty, not dropped', () => {
  const boundary = 'B';
  const body = form(boundary, [
    { headers: FILE_HEADERS, body: '' },
    { headers: URL_HEADERS, body: '' },
  ]);
  const parts = parseMultipart(body, boundary);
  assert.equal(parts.length, 2);
  assert.equal((parts[0] as { body: Buffer }).body.byteLength, 0);
  // The file part is still identifiable by its filename even with no content,
  // which is what makes an empty upload a 201 rather than a confusing 422.
  assert.equal(dispositionOf(parts[0] as never).filename, 'page.html');
});

test('a body with no parts yields no parts', () => {
  // The measured shape of "archive data field name" and "archive URL field name"
  // both left blank: 38 bytes of closing boundary and nothing else.
  const bare = Buffer.from('------formdata-undici-055479952025--\r\n', 'latin1');
  assert.deepEqual(parseMultipart(bare, '----formdata-undici-055479952025'), []);
});

test('binary content is preserved byte for byte', () => {
  // A ZIP upload: every byte above 0x7f would be destroyed by a text decode, and
  // the CRLF sequences inside the archive must not be treated as framing.
  const boundary = 'B';
  const binary = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x0d, 0x0a, 0xff, 0x00, 0x1a, 0x0d, 0x0a]);
  const body = form(boundary, [{ headers: FILE_HEADERS, body: binary }]);
  const parts = parseMultipart(body, boundary);
  assert.deepEqual(Buffer.from((parts[0] as { body: Buffer }).body), binary);
});

test('a boundary appearing inside a part does not truncate it', () => {
  // The delimiter is only a delimiter at a start of line. A payload that happens
  // to contain the boundary string mid-line — which a saved page can, since the
  // page's own bytes are arbitrary — must not be split there.
  const boundary = '----boundary';
  const payload = `before ----boundary after`;
  const body = form(boundary, [{ headers: FILE_HEADERS, body: payload }]);
  const parts = parseMultipart(body, boundary);
  assert.equal(parts.length, 1);
  assert.equal((parts[0] as { body: Buffer }).body.toString('utf8'), payload);
});

test('a truncated upload yields only the parts that were complete', () => {
  // The client was cancelled or the connection dropped. A part whose terminating
  // delimiter never arrived is not a part — its bytes are returned as nothing
  // rather than as a half-page that would be stored as if it were whole.
  const boundary = 'B';
  const full = form(boundary, [
    { headers: FILE_HEADERS, body: 'complete' },
    { headers: URL_HEADERS, body: 'https://example.com/' },
  ]);

  // Cut inside the final part, so the first part is intact and the second is not.
  const cut = full.subarray(0, full.length - 12);
  const parts = parseMultipart(cut, boundary);
  assert.equal(parts.length, 1, 'the complete part survives and the partial one does not');
  assert.equal((parts[0] as { body: Buffer }).body.toString('utf8'), 'complete');
  assert.equal(dispositionOf(parts[0] as never).filename, 'page.html');

  // Cut inside the only part: nothing is claimed at all.
  const nothing = parseMultipart(full.subarray(0, 20), boundary);
  assert.deepEqual(nothing, []);
});

test('a part header with no colon is ignored rather than stored', () => {
  const boundary = 'B';
  const body = form(boundary, [
    { headers: ['garbage line', ...FILE_HEADERS], body: 'x' },
  ]);
  const parts = parseMultipart(body, boundary);
  assert.equal(parts.length, 1);
  assert.equal(parts[0]?.headers['garbage line'], undefined);
  assert.equal(dispositionOf(parts[0] as never).filename, 'page.html');
});

test('repeated part headers are joined rather than overwritten', () => {
  // Two `content-disposition` headers is a smuggling attempt: a parser that
  // keeps the last one reads a different filename than one that keeps the first.
  // Joining makes both visible to whoever inspects the map.
  const boundary = 'B';
  const body = form(boundary, [
    {
      headers: ['Content-Disposition: form-data; name="a"', 'Content-Disposition: form-data; name="b"'],
      body: 'x',
    },
  ]);
  const parts = parseMultipart(body, boundary);
  assert.match(parts[0]?.headers['content-disposition'] ?? '', /name="a"/);
  assert.match(parts[0]?.headers['content-disposition'] ?? '', /name="b"/);
});

test('quoted-string escapes in a disposition are undone', () => {
  const boundary = 'B';
  const body = form(boundary, [
    { headers: ['Content-Disposition: form-data; name="archive"; filename="a\\"b.html"'], body: 'x' },
  ]);
  const parts = parseMultipart(body, boundary);
  assert.equal(dispositionOf(parts[0] as never).filename, 'a"b.html');
});

// --- filename sanitisation --------------------------------------------------

test('a path-traversal filename is reduced to its last segment', () => {
  // The extension sanitises for its own disk, not for this server, so this
  // arrives verbatim in Content-Disposition.
  assert.equal(sanitizeFilename('../../etc/passwd.html'), 'passwd.html');
  assert.equal(sanitizeFilename('..\\..\\windows\\system32\\evil.html'), 'evil.html');
  assert.equal(sanitizeFilename('/absolute/path/page.html'), 'page.html');
  // A mixed-separator name is the case `path.basename` alone gets wrong on
  // POSIX, where a backslash is an ordinary character.
  assert.equal(sanitizeFilename('a/b\\c.html'), 'c.html');
});

test('a percent-encoded traversal is decoded before being reduced', () => {
  assert.equal(sanitizeFilename('..%2F..%2Fetc%2Fpasswd.html'), 'passwd.html');
  // A name that is not valid percent-encoding is used as-is rather than lost.
  assert.equal(sanitizeFilename('100%25.html'), '100%.html');
  assert.equal(sanitizeFilename('50% off.html'), '50% off.html');
});

test('control characters are removed from a filename', () => {
  // A newline in a filename would break a header or forge a log line.
  assert.equal(sanitizeFilename('a\r\nb.html'), 'ab.html');
  assert.equal(sanitizeFilename('a\u0000b.html'), 'ab.html');
  assert.equal(sanitizeFilename('a\u007fb.html'), 'ab.html');
});

test('an absent or empty filename is reported as such', () => {
  assert.equal(sanitizeFilename(undefined), '');
  assert.equal(sanitizeFilename(''), '');
  // A name that is only a directory reduces to nothing rather than to a dot.
  assert.equal(sanitizeFilename('../../'), '');
});

test('an over-long filename is bounded', () => {
  const long = `${'a'.repeat(5000)}.html`;
  assert.equal(sanitizeFilename(long).length, 255);
});
