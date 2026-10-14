/**
 * Constant-time-ish helpers for the URL codecs used to embed a target URL in a
 * proxy path, plus the shared body reader.
 */

import type { Readable } from 'node:stream';

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export function toBase64Url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

export function fromBase64Url(input: string): string | null {
  if (!BASE64URL_RE.test(input)) return null;
  try {
    const decoded = Buffer.from(input, 'base64url').toString('utf8');
    // Buffer.from is lenient and silently drops invalid trailing bytes, so
    // round-tripping is the only reliable validity check.
    return toBase64Url(decoded) === input ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Read a response body into memory, stopping at `limit`.
 *
 * Returns what arrived rather than throwing when the limit is hit. Both callers
 * — the static crawler and the browser-assisted capture — are recording a
 * snapshot, and a partial resource is more useful than a failed archive; the
 * truncation is visible in the recorded size.
 *
 * This lives here rather than in either caller because it had drifted into two
 * copies, and the two copies disagreed about the limit they used.
 */
export async function readAll(stream: Readable | null, limit: number): Promise<Uint8Array> {
  if (stream === null) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const value = chunk as Uint8Array;
      total += value.byteLength;
      if (total > limit) {
        stream.destroy();
        break;
      }
      chunks.push(value);
    }
  } catch {
    // Return what arrived rather than losing the partial capture.
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
