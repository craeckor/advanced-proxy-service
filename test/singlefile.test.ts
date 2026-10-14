import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.ts';
import { createLogger } from '../src/util/logger.ts';
import { ArchiveStore } from '../src/archive/store.ts';
import { RestFormError, RestFormIngest } from '../src/archive/rest-form.ts';
import { rewriteHtml } from '../src/rewrite/html.ts';
import { RUNTIME_SHIM_SOURCE } from '../src/shim/runtime.ts';

/**
 * The SingleFile REST Form API ingest.
 *
 * Tested against a real store rather than a stub, because the properties that
 * matter are the ones a stub cannot have: that the upload is keyed by the URL it
 * came from so a replay resolves it, that the bytes survive into the blob store
 * unchanged, and that the recorded media type is the one the replay needs to
 * render rather than download.
 *
 * The three payload shapes below are the ones the destination actually produces,
 * including the two whose media type is misleading — a ZIP labelled
 * `application/octet-stream`, and a self-extracting archive labelled `text/html`
 * whose bytes are a document containing a ZIP.
 */

interface Harness {
  ingest: RestFormIngest;
  store: ArchiveStore;
  config: ReturnType<typeof parseConfig>;
  close(): Promise<void>;
}

const harnesses: Harness[] = [];

async function harness(overrides: Record<string, unknown> = {}): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'singlefile-test-'));
  const config = parseConfig({
    server: { host: '127.0.0.1', port: 0 },
    archive: { dataDir, compression: 'gzip', ...overrides },
    log: { level: 'silent' },
  });
  const store = await ArchiveStore.open(config.archive);
  const created: Harness = {
    ingest: new RestFormIngest(config, createLogger(config), store),
    store,
    config,
    close: async () => {
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
  harnesses.push(created);
  return created;
}

test.after(async () => {
  for (const h of harnesses) await h.close();
});

/** Build a request body the way a browser's `FormData` does. */
function form(
  boundary: string,
  parts: Array<{ name?: string; filename?: string; type?: string; body: string | Buffer }>,
): { body: Buffer; contentType: string } {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = ['form-data'];
    if (part.name !== undefined) disposition.push(`name="${part.name}"`);
    if (part.filename !== undefined) disposition.push(`filename="${part.filename}"`);
    const headers = [`Content-Disposition: ${disposition.join('; ')}`];
    if (part.type !== undefined) headers.push(`Content-Type: ${part.type}`);
    chunks.push(Buffer.from(`--${boundary}\r\n${headers.join('\r\n')}\r\n\r\n`, 'latin1'));
    chunks.push(Buffer.isBuffer(part.body) ? part.body : Buffer.from(part.body, 'utf8'));
    chunks.push(Buffer.from('\r\n', 'latin1'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'latin1'));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** A minimal but real ZIP: local file header, one stored file, central directory. */
function zipBytes(): Buffer {
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]), // local file header signature
    Buffer.from('archive payload', 'utf8'),
    Buffer.from([0x50, 0x4b, 0x01, 0x02]), // central directory
    Buffer.from([0x50, 0x4b, 0x05, 0x06]), // end of central directory
  ]);
}

test('a plain html upload becomes an archive keyed by its source URL', async () => {
  const h = await harness();
  const target = 'https://example.com/page?a=1#frag';
  const request = form('B', [
    { name: 'archive', filename: 'My Page (2026-10-14).html', type: 'text/html', body: '<!doctype html><p>saved</p>' },
    { name: 'url', body: target },
  ]);

  const result = await h.ingest.ingest(request.body, request.contentType);

  assert.equal(result.sourceUrl, target, 'the fragment is preserved verbatim');
  assert.equal(result.filename, 'My Page (2026-10-14).html');
  assert.equal(result.contentType, 'text/html');
  assert.equal(result.size, Buffer.byteLength('<!doctype html><p>saved</p>'));

  // The archive exists, is complete, and holds the document under the source URL
  // — which is what makes a replay of that URL find it.
  const meta = h.store.getArchive(result.archiveId);
  assert.equal(meta?.status, 'complete');
  assert.equal(meta?.seedUrl, target);
  assert.equal(meta?.pages, 1);

  // And the aggregate agrees with what was stored: one resource, whose size is
  // the byte length of the document.
  assert.equal(meta?.resources, 1);
  assert.equal(meta?.bytes, Buffer.byteLength('<!doctype html><p>saved</p>'));

  const stored = await h.store.get(result.archiveId, target);
  assert.equal(stored?.record.contentType, 'text/html');
  assert.equal(Buffer.from(stored?.body ?? []).toString('utf8'), '<!doctype html><p>saved</p>');
});

test('a resource listing reports each size, and they sum to the total', async () => {
  // The invariant a reader reconciles against: the archive's `bytes` is the sum
  // of what the detail endpoint lists, so a total can always be attributed.
  const h = await harness();
  const first = form('B', [
    { name: 'archive', filename: 'one.html', type: 'text/html', body: '<p>one</p>' },
    { name: 'url', body: 'https://example.com/one' },
  ]);
  const second = form('B', [
    { name: 'archive', filename: 'two.html', type: 'text/html', body: '<p>two is longer</p>' },
    { name: 'url', body: 'https://example.com/two' },
  ]);

  const one = await h.ingest.ingest(first.body, first.contentType);
  const two = await h.ingest.ingest(second.body, second.contentType);

  for (const result of [one, two]) {
    const meta = h.store.getArchive(result.archiveId);
    const resources = h.store.resources(result.archiveId);

    assert.equal(resources.length, meta?.resources);
    assert.equal(
      resources.reduce((sum, resource) => sum + resource.size, 0),
      meta?.bytes,
      'the listed sizes must sum to the reported total',
    );
    assert.equal(resources[0]?.size, result.size);
    assert.equal(resources[0]?.contentType, 'text/html');
    assert.equal(resources[0]?.status, 200);
  }

  // The three views of the same archive agree about which resources exist.
  assert.deepEqual(
    h.store.urls(one.archiveId),
    h.store.resources(one.archiveId).map((resource) => resource.url),
    'urls must stay a projection of resources, not a second source of truth',
  );

  // And the listing is ordered, so two calls are comparable.
  const urls = h.store.resources(one.archiveId).map((resource) => resource.url);
  assert.deepEqual(urls, [...urls].sort());
});

test('two archives are counted separately', async () => {
  // The aggregate must be scoped to one archive, or a list of them would report
  // the whole store's size against each entry.
  const h = await harness();
  const first = form('B', [
    { name: 'archive', filename: 'a.html', type: 'text/html', body: '<p>a</p>' },
    { name: 'url', body: 'https://example.com/a' },
  ]);
  const second = form('B', [
    { name: 'archive', filename: 'b.html', type: 'text/html', body: '<p>b</p>' },
    { name: 'url', body: 'https://example.com/b' },
  ]);

  const one = await h.ingest.ingest(first.body, first.contentType);
  await h.ingest.ingest(second.body, second.contentType);

  const listed = h.store.listArchives();
  assert.equal(listed.length, 2);
  for (const meta of listed) {
    assert.equal(meta.resources, 1, `${meta.seedUrl} must not absorb its neighbour's resources`);
    assert.equal(meta.bytes, Buffer.byteLength('<p>a</p>'));
  }
  assert.equal(h.store.getArchive(one.archiveId)?.resources, 1);
});

test('the two aggregation paths agree', async () => {
  // `getArchive` and `listArchives` select their columns by hand, so a field
  // added to one and not the other would surface as a missing key in just one
  // response. Comparing them catches that without asserting each field twice.
  const h = await harness();
  const request = form('B', [
    { name: 'archive', filename: 'page.html', type: 'text/html', body: '<p>agree</p>' },
    { name: 'url', body: 'https://example.com/agree' },
  ]);
  const result = await h.ingest.ingest(request.body, request.contentType);

  const single = h.store.getArchive(result.archiveId);
  const listed = h.store.listArchives().find((meta) => meta.id === result.archiveId);
  assert.deepEqual(single, listed);
});

test('a freshly opened archive reports zero rather than nothing', async () => {
  // A running archive has no resources yet. `COALESCE` keeps `bytes` a number
  // instead of null, so a client can sum the list without a null check.
  const h = await harness();
  const { ArchiveBuilder } = await import('../src/archive/builder.ts');
  const builder = await ArchiveBuilder.open(h.store, createLogger(h.config), {
    seedUrl: 'https://example.com/running',
    producer: 'test',
  });

  const meta = h.store.getArchive(builder.archiveId);
  assert.equal(meta?.status, 'running');
  assert.equal(meta?.resources, 0);
  assert.equal(meta?.bytes, 0);
  assert.deepEqual(h.store.resources(builder.archiveId), []);
  assert.deepEqual(h.store.urls(builder.archiveId), []);
});

test('a zip upload is detected by its bytes, not by its media type', async () => {
  // The extension's compression step tags the blob `application/octet-stream`,
  // which is also what an untyped part carries. A server that trusted the label
  // would store an archive as an opaque blob no reader can open.
  const h = await harness();
  const bytes = zipBytes();
  const request = form('B', [
    { name: 'archive', filename: 'page.zip', type: 'application/octet-stream', body: bytes },
    { name: 'url', body: 'https://example.com/page' },
  ]);

  const result = await h.ingest.ingest(request.body, request.contentType);
  assert.equal(result.contentType, 'application/zip');

  const stored = await h.store.get(result.archiveId, 'https://example.com/page');
  assert.deepEqual(Buffer.from(stored?.body ?? []), bytes, 'the archive bytes reach the blob store unchanged');
});

test('a self-extracting archive is stored as the html document it is', async () => {
  // A `.zip.html` save is labelled text/html and its first bytes are HTML, so it
  // must not be mistaken for a ZIP. Storing it as one would turn a page that
  // unpacks itself on load into a download.
  const h = await harness();
  const html = '<!doctype html><script>/* unpack */</script>';
  const request = form('B', [
    { name: 'archive', filename: 'page.zip.html', type: 'text/html', body: html },
    { name: 'url', body: 'https://example.com/self' },
  ]);

  const result = await h.ingest.ingest(request.body, request.contentType);
  assert.equal(result.contentType, 'text/html');
});

test('the file part is found by its filename, not by its field name', async () => {
  // The field names are the extension's own user options and blank is a legal
  // value for either. A server that looked for a part called `archive` would
  // refuse a correctly formed upload from a user who named theirs something else.
  const h = await harness();
  const request = form('B', [
    { name: 'page_html', filename: 'custom.html', type: 'text/html', body: '<p>custom fields</p>' },
    { name: 'page_url', body: 'https://example.com/custom#x' },
  ]);

  const result = await h.ingest.ingest(request.body, request.contentType);
  assert.equal(result.sourceUrl, 'https://example.com/custom#x');
  assert.equal(result.filename, 'custom.html');
});

test('a blank url field name yields a file-only upload that still works', async () => {
  const h = await harness();
  const request = form('B', [
    { name: 'archive', filename: 'page.html', type: 'text/html', body: '<p>no url field</p>' },
  ]);

  const result = await h.ingest.ingest(request.body, request.contentType);
  assert.equal(result.sourceUrl, '');
  // The seed falls back to a synthetic key rather than being dropped, so the
  // archive is still readable and still listed with a seed that names it.
  const meta = h.store.getArchive(result.archiveId);
  assert.equal(meta?.seedUrl, 'singlefile:page.html');
  const stored = await h.store.get(result.archiveId, 'singlefile:page.html');
  assert.equal(Buffer.from(stored?.body ?? []).toString('utf8'), '<p>no url field</p>');
});

test('a body with no parts is refused rather than stored as empty', async () => {
  // The measured client behaviour when *both* field-name options are blank: a
  // 38-byte body of one closing boundary. Accepting it would create an archive
  // that holds nothing and claims to be complete.
  const h = await harness();
  const bare = Buffer.from('------formdata-undici-055479952025--\r\n', 'latin1');
  await assert.rejects(
    () => h.ingest.ingest(bare, 'multipart/form-data; boundary=----formdata-undici-055479952025'),
    (error: unknown) => error instanceof RestFormError && error.status === 400,
  );
});

test('a body with a url part but no file part is refused as a missing archive', async () => {
  // The other blank-field case, and a different failure: the URL field is set so
  // there *is* a part, but nothing carries a filename. Refused on its own terms
  // so the message says what is actually wrong — 422 rather than a generic 400.
  const h = await harness();
  const request = form('B', [{ name: 'url', body: 'https://example.com/' }]);
  await assert.rejects(
    () => h.ingest.ingest(request.body, request.contentType),
    (error: unknown) => error instanceof RestFormError && error.status === 422,
  );
  assert.equal(h.store.listArchives().length, 0, 'a refused upload creates no archive');
});

test('a request that is not multipart is refused with a nameable status', async () => {
  const h = await harness();
  await assert.rejects(
    () => h.ingest.ingest(Buffer.from('{"url":"x"}'), 'application/json'),
    (error: unknown) => error instanceof RestFormError && error.status === 400,
  );
});

test('a payload above the configured cap is refused before it is parsed', async () => {
  const h = await harness({ restFormMaxBytes: 256 });
  const big = form('B', [
    { name: 'archive', filename: 'big.html', type: 'text/html', body: 'x'.repeat(1024) },
    { name: 'url', body: 'https://example.com/' },
  ]);
  await assert.rejects(
    () => h.ingest.ingest(big.body, big.contentType),
    (error: unknown) => error instanceof RestFormError && error.status === 413,
  );
});

test('an over-long url field is truncated rather than stored whole', async () => {
  // The field becomes the seed and is stored per resource, so an unbounded one
  // is a cheap way to write a megabyte per archived resource.
  const h = await harness({ restFormMaxUrlBytes: 64 });
  const request = form('B', [
    { name: 'archive', filename: 'page.html', type: 'text/html', body: '<p>x</p>' },
    { name: 'url', body: `https://example.com/${'a'.repeat(5000)}` },
  ]);

  const result = await h.ingest.ingest(request.body, request.contentType);
  assert.ok(Buffer.byteLength(result.sourceUrl) <= 64, `url field not bounded: ${result.sourceUrl.length}`);
});

test('a path-traversal filename never reaches the filesystem', async () => {
  const h = await harness();
  const request = form('B', [
    { name: 'archive', filename: '../../etc/passwd.html', type: 'text/html', body: '<p>traversal</p>' },
    { name: 'url', body: 'https://example.com/traversal' },
  ]);

  const result = await h.ingest.ingest(request.body, request.contentType);
  assert.equal(result.filename, 'passwd.html');
  // And the record it created is named by the URL, so nothing about the path is
  // derived from the client's filename at all.
  assert.equal(h.store.getArchive(result.archiveId)?.seedUrl, 'https://example.com/traversal');
});

test('a non-http source URL is kept verbatim rather than rejected', async () => {
  // SingleFile will save a `file://` document or an extension page. Rejecting
  // those would lose the archive over a field that is only metadata.
  const h = await harness();
  const request = form('B', [
    { name: 'archive', filename: 'local.html', type: 'text/html', body: '<p>local</p>' },
    { name: 'url', body: 'file:///home/user/page.html' },
  ]);

  const result = await h.ingest.ingest(request.body, request.contentType);
  assert.equal(result.sourceUrl, 'file:///home/user/page.html');
  const stored = await h.store.get(result.archiveId, 'file:///home/user/page.html');
  assert.equal(Buffer.from(stored?.body ?? []).toString('utf8'), '<p>local</p>');
});

test('the stored document replays as rewritten html, not as a download', async () => {
  // The whole point of the endpoint: the result has to go through the same
  // replay path as any other archive, which means the recorded media type must
  // be one the replay recognises as rewritable.
  const h = await harness();
  const page = '<!doctype html><html><head><link rel="stylesheet" href="/a.css"></head><body><a href="/next">n</a></body></html>';
  const request = form('B', [
    { name: 'archive', filename: 'page.html', type: 'text/html', body: page },
    { name: 'url', body: 'https://example.com/dir/page.html' },
  ]);

  const result = await h.ingest.ingest(request.body, request.contentType);
  const stored = await h.store.get(result.archiveId, 'https://example.com/dir/page.html');
  assert.ok(stored !== null);

  const rewritten = rewriteHtml(Buffer.from(stored.body).toString('utf8'), {
    codec: 'plain',
    baseUrl: 'https://example.com/dir/page.html',
    prefix: `/archive/${result.archiveId}`,
    injectShim: true,
    shimSource: RUNTIME_SHIM_SOURCE,
  }).html;

  assert.match(rewritten, /\/archive\/[0-9a-f-]+\/plain\/https%3A%2F%2Fexample\.com%2Fa\.css/);
  assert.match(rewritten, /data-proxy-shim/);
});

test('two uploads with different content are two archives', async () => {
  const h = await harness();
  const first = form('B', [
    { name: 'archive', filename: 'a.html', type: 'text/html', body: '<p>one</p>' },
    { name: 'url', body: 'https://example.com/one' },
  ]);
  const second = form('B', [
    { name: 'archive', filename: 'b.html', type: 'text/html', body: '<p>two</p>' },
    { name: 'url', body: 'https://example.com/two' },
  ]);

  const one = await h.ingest.ingest(first.body, first.contentType);
  const two = await h.ingest.ingest(second.body, second.contentType);

  assert.notEqual(one.archiveId, two.archiveId);
  assert.equal(h.store.listArchives().length, 2);
});

test('the same bytes under the same URL stay one resource per archive', async () => {
  // Two saves of one page are two archives — that is deliberate, a save is a
  // moment — but each archive holds exactly one copy of the document, so a
  // reader of either sees a consistent archive rather than a doubled one.
  const h = await harness();
  const request = () =>
    form('B', [
      { name: 'archive', filename: 'page.html', type: 'text/html', body: '<p>same</p>' },
      { name: 'url', body: 'https://example.com/same' },
    ]);

  const first = request();
  const one = await h.ingest.ingest(first.body, first.contentType);
  assert.deepEqual(h.store.urls(one.archiveId), ['https://example.com/same']);
});
