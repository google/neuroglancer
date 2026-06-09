/**
 * @license
 * Copyright 2026 Allen Institute for Brain Science
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

/**
 * Decoder for the zarr v3 `vlen-bytes` codec chunk format.  Each
 * variable-length-bytes chunk encodes an array of byte blobs as:
 *
 * ```
 *   uint32 num_elements N
 *   for each i in [0, N):
 *     uint32 byte_length L_i
 *     byte[L_i] data
 * ```
 *
 * All integers little-endian.  An empty chunk is `[0x00, 0x00, 0x00,
 * 0x00]` (4 bytes, N=0).
 *
 * The layout was confirmed empirically against
 * `numcodecs.vlen.VLenBytes` (the implementation zarr-python's
 * `zarr.codecs.VLenBytesCodec` delegates to).  See the slice-4b notes
 * in the implementation plan.
 *
 * This decoder is needed because zarr-vectors stores write
 * `object_index/manifests` as a 1-D vlen-bytes zarr array; resolving an
 * object's manifest requires fetching the array chunk that owns
 * element ``oid``, decoding it with this codec, and indexing into the
 * resulting blob list.
 */

const HEADER_BYTES = 4;
const PER_ELEMENT_HEADER_BYTES = 4;

/**
 * Decode one zarr v3 vlen-bytes chunk into a list of byte blobs.
 *
 * Each returned `Uint8Array` is a **view** onto the input buffer
 * (zero-copy).  Callers that need to retain the returned blobs beyond
 * the lifetime of the input buffer must copy them.
 *
 * Throws on malformed input: truncation, or a declared element length
 * that would run past the end of the chunk.
 */
export function decodeVlenBytesChunk(
  raw: ArrayBufferView | ArrayBuffer,
): Uint8Array[] {
  const u8 =
    raw instanceof ArrayBuffer
      ? new Uint8Array(raw)
      : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  if (view.byteLength < HEADER_BYTES) {
    throw new Error(
      `vlen-bytes chunk too short: ${view.byteLength} < ${HEADER_BYTES} (header)`,
    );
  }
  const n = view.getUint32(0, /* littleEndian */ true);
  const out: Uint8Array[] = new Array(n);
  let offset = HEADER_BYTES;
  for (let i = 0; i < n; ++i) {
    if (view.byteLength < offset + PER_ELEMENT_HEADER_BYTES) {
      throw new Error(
        `vlen-bytes chunk truncated at element ${i} header ` +
          `(need ${PER_ELEMENT_HEADER_BYTES} bytes, have ${
            view.byteLength - offset
          })`,
      );
    }
    const length = view.getUint32(offset, true);
    offset += PER_ELEMENT_HEADER_BYTES;
    if (view.byteLength < offset + length) {
      throw new Error(
        `vlen-bytes chunk truncated in element ${i} payload ` +
          `(declared length ${length}, have ${view.byteLength - offset})`,
      );
    }
    out[i] = u8.subarray(offset, offset + length);
    offset += length;
  }
  if (offset !== view.byteLength) {
    throw new Error(
      `vlen-bytes chunk has ${view.byteLength - offset} trailing bytes ` +
        `after ${n} elements`,
    );
  }
  return out;
}

/**
 * Helper: decode one specific element by index from a vlen-bytes chunk.
 * Useful when only one element is needed and the caller wants to avoid
 * materialising the full array.  Still does a single linear scan over
 * the element headers, but only allocates one `Uint8Array` view.
 *
 * Throws `RangeError` if `elementIndex` >= chunk's `num_elements`.
 */
export function readVlenBytesElement(
  raw: ArrayBufferView | ArrayBuffer,
  elementIndex: number,
): Uint8Array {
  if (elementIndex < 0 || !Number.isInteger(elementIndex)) {
    throw new RangeError(
      `readVlenBytesElement: elementIndex must be a non-negative integer, got ${elementIndex}`,
    );
  }
  const u8 =
    raw instanceof ArrayBuffer
      ? new Uint8Array(raw)
      : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (view.byteLength < HEADER_BYTES) {
    throw new Error(
      `vlen-bytes chunk too short: ${view.byteLength} < ${HEADER_BYTES} (header)`,
    );
  }
  const n = view.getUint32(0, true);
  if (elementIndex >= n) {
    throw new RangeError(
      `readVlenBytesElement: elementIndex ${elementIndex} out of range [0, ${n})`,
    );
  }
  let offset = HEADER_BYTES;
  for (let i = 0; i < n; ++i) {
    if (view.byteLength < offset + PER_ELEMENT_HEADER_BYTES) {
      throw new Error(`vlen-bytes chunk truncated at element ${i} header`);
    }
    const length = view.getUint32(offset, true);
    offset += PER_ELEMENT_HEADER_BYTES;
    if (view.byteLength < offset + length) {
      throw new Error(`vlen-bytes chunk truncated in element ${i} payload`);
    }
    if (i === elementIndex) {
      return u8.subarray(offset, offset + length);
    }
    offset += length;
  }
  /* unreachable — bounds check above guarantees we hit the target index */
  throw new Error("vlen-bytes element loop fell through unexpectedly");
}
