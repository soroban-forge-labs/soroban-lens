/**
 * Compression for the raw-XDR columns (#35).
 *
 * `value_xdr` and `topics_xdr_json` store base64 — roughly a third larger than
 * the bytes it encodes — and are read rarely: mostly by the UI's "Raw XDR"
 * panel, never by a filter or an aggregate. gzip compresses them further,
 * since base64 and JSON both leave redundancy a general-purpose compressor
 * eats easily.
 *
 * Column type in SQLite is advisory (affinity, not enforcement), so a TEXT-
 * declared column happily stores a BLOB. Reads have to handle both: every row
 * written before this existed is still plain text, forever, and this module
 * is what makes that transparent rather than requiring a rewrite of every
 * existing row.
 */
import { gzipSync, gunzipSync } from 'node:zlib';

/** Always compresses. Exposed for the benchmark, which wants the raw ratio. */
export function compressXdrColumn(text: string): Buffer {
  return gzipSync(Buffer.from(text, 'utf8'));
}

/**
 * Compress for storage, but only when it actually wins.
 *
 * gzip carries roughly 18-20 bytes of fixed header/footer overhead. A short
 * ScVal — a bare symbol or a small integer, both common as a single topic —
 * is smaller than that overhead, so compressing unconditionally would grow
 * exactly the rows it should shrink. This measures both and keeps whichever
 * is smaller; decompressXdrColumn already handles plain text transparently
 * (that is what makes every pre-#35 row valid forever), so storing a small
 * value uncompressed costs nothing extra to read back.
 */
export function encodeXdrColumn(text: string): Buffer | string {
  const compressed = compressXdrColumn(text);
  return compressed.length < Buffer.byteLength(text, 'utf8') ? compressed : text;
}

/**
 * Read a raw-XDR column back to text, transparently handling both a
 * compressed BLOB (new rows) and plain TEXT (every row written before this
 * existed, and never rewritten).
 */
export function decompressXdrColumn(value: string | Uint8Array): string {
  if (typeof value === 'string') return value;
  return gunzipSync(Buffer.from(value.buffer, value.byteOffset, value.byteLength)).toString('utf8');
}
