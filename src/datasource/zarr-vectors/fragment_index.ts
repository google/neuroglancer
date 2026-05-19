/**
 * @license
 * Copyright 2026 Allen Institute for Brain Science
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

/**
 * Decoder for the v1 fragment-index byte layout used by zarr-vectors stores
 * for `vertex_fragments/<chunk>` and `link_fragments/<chunk>` arrays.
 *
 * On-disk layout (all little-endian):
 *
 *   HEADER (16 bytes, 8-byte aligned)
 *     uint32 magic               = 0x5A56_4647  ('ZVFG')
 *     uint16 version             = 1
 *     uint16 flags               = 0
 *     uint32 num_fragments       F
 *     uint32 num_range_fragments R   (popcount of bitmap; redundant)
 *
 *   RANGE BITMAP
 *     ceil(F/8) bytes, padded to the next 8-byte boundary
 *     bit f (LSB-first within byte f >> 3) = 1 iff fragment f is a range
 *
 *   RANGE TABLE                    (R entries x 16 bytes)
 *     int64 start, int64 count    per range fragment, in fragment order
 *
 *   EXPLICIT CSR                   (E = F - R)
 *     uint32 explicit_offsets[E+1]    running offsets into explicit_indices
 *     int64  explicit_indices[T]      concatenated row indices, T = explicit_offsets[E]
 *
 * Each fragment is either a contiguous **range** `[start, start+count)` of
 * row indices into the chunk's `vertices/<chunk>` (or `links/0/<chunk>`)
 * array, or an explicit **list** of row indices.
 *
 * See the zarr_vectors spec §7.3 for the canonical specification.
 */

export const FRAGMENT_INDEX_MAGIC = 0x5a564647; // 'ZVFG' little-endian
export const FRAGMENT_INDEX_VERSION = 1;
const HEADER_BYTES = 16;

/** Compute the padded length of the range bitmap (multiple of 8). */
function bitmapPaddedLength(numFragments: number): number {
  const raw = (numFragments + 7) >> 3;
  return (raw + 7) & ~7;
}

/**
 * Decoded view of one chunk's fragment-index blob.  Holds typed-array
 * views onto the source bytes (where alignment allows) plus a lazily-built
 * prefix-popcount cache for O(1) random access.
 */
export class FragmentIndex {
  /** Number of fragments F. */
  readonly numFragments: number;

  /** Bitmap, length `ceil(F/8)`; bit `f` is set iff fragment `f` is a range. */
  private readonly bitmap: Uint8Array;

  /** Range table flattened as `[start0, count0, start1, count1, ...]` (BigInt64). */
  private readonly rangeTable: BigInt64Array;

  /** CSR offsets array, length `E + 1`. */
  private readonly csrOffsets: Uint32Array;

  /** Concatenated CSR indices, length `T = csrOffsets[E]` (BigInt64). */
  private readonly csrIndices: BigInt64Array;

  /**
   * Prefix-popcount cache of the bitmap.  `popcountPrefix[i]` == count of
   * set bits in `bitmap[0..i)` (i.e. how many fragments in `[0, i)` are
   * ranges).  Built lazily on first access; subsequent queries are O(1).
   */
  private popcountPrefix: Int32Array | undefined;

  constructor(
    numFragments: number,
    bitmap: Uint8Array,
    rangeTable: BigInt64Array,
    csrOffsets: Uint32Array,
    csrIndices: BigInt64Array,
  ) {
    this.numFragments = numFragments;
    this.bitmap = bitmap;
    this.rangeTable = rangeTable;
    this.csrOffsets = csrOffsets;
    this.csrIndices = csrIndices;
  }

  get numRangeFragments(): number {
    return this.rangeTable.length >> 1;
  }

  get numExplicitFragments(): number {
    return this.numFragments - this.numRangeFragments;
  }

  /** O(1) — a single bit lookup; does not warm the popcount cache. */
  isRange(f: number): boolean {
    if (f < 0 || f >= this.numFragments) {
      throw new Error(
        `Fragment index ${f} out of range [0, ${this.numFragments})`,
      );
    }
    return ((this.bitmap[f >> 3] >> (f & 7)) & 1) === 1;
  }

  /**
   * Return `[start, count]` for a range fragment.  Throws if `f` is
   * explicit.  Builds the popcount cache on first call.
   */
  range(f: number): { start: number; count: number } {
    if (!this.isRange(f)) {
      throw new Error(
        `Fragment ${f} is explicit, not a range; use indices(f) instead`,
      );
    }
    const row = this.getPopcountPrefix()[f];
    const start = Number(this.rangeTable[row * 2]);
    const count = Number(this.rangeTable[row * 2 + 1]);
    return { start, count };
  }

  /**
   * Return the row indices of fragment `f`.  Range fragments materialise
   * as `[start, start+count)`; explicit fragments return a copy of the
   * CSR slice.  Output is `number[]` for ergonomic downstream use; if
   * you need int64 width, see `indicesView(f)` for an explicit-fragment
   * zero-copy `BigInt64Array` view.
   */
  indices(f: number): Uint32Array {
    if (this.isRange(f)) {
      const { start, count } = this.range(f);
      const out = new Uint32Array(count);
      for (let i = 0; i < count; ++i) out[i] = start + i;
      return out;
    }
    const prefix = this.getPopcountPrefix();
    const eIdx = f - prefix[f];
    const a = this.csrOffsets[eIdx];
    const b = this.csrOffsets[eIdx + 1];
    const out = new Uint32Array(b - a);
    for (let i = a; i < b; ++i) out[i - a] = Number(this.csrIndices[i]);
    return out;
  }

  /**
   * Return a zero-copy `BigInt64Array` view onto an explicit fragment's
   * indices.  Throws if `f` is a range (no backing array to view).
   */
  indicesView(f: number): BigInt64Array {
    if (this.isRange(f)) {
      throw new Error(
        `Fragment ${f} is a range; indicesView requires an explicit fragment`,
      );
    }
    const prefix = this.getPopcountPrefix();
    const eIdx = f - prefix[f];
    const a = this.csrOffsets[eIdx];
    const b = this.csrOffsets[eIdx + 1];
    return this.csrIndices.subarray(a, b);
  }

  private getPopcountPrefix(): Int32Array {
    if (this.popcountPrefix !== undefined) return this.popcountPrefix;
    const f = this.numFragments;
    const prefix = new Int32Array(f + 1);
    let running = 0;
    for (let i = 0; i < f; ++i) {
      prefix[i] = running;
      if (((this.bitmap[i >> 3] >> (i & 7)) & 1) === 1) running++;
    }
    prefix[f] = running;
    this.popcountPrefix = prefix;
    return prefix;
  }
}

/**
 * Parse a v1 fragment-index blob.  Throws on malformed input (bad magic,
 * unsupported version/flags, truncated payload, popcount mismatch).
 */
export function decodeFragments(raw: ArrayBufferView | ArrayBuffer): FragmentIndex {
  const view =
    raw instanceof ArrayBuffer
      ? new DataView(raw)
      : new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const u8 =
    raw instanceof ArrayBuffer
      ? new Uint8Array(raw)
      : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);

  if (view.byteLength < HEADER_BYTES) {
    throw new Error(
      `Fragment-index blob too short: ${view.byteLength} < ${HEADER_BYTES}`,
    );
  }
  const magic = view.getUint32(0, /* littleEndian */ true);
  const version = view.getUint16(4, true);
  const flags = view.getUint16(6, true);
  const f = view.getUint32(8, true);
  const r = view.getUint32(12, true);

  if (magic !== FRAGMENT_INDEX_MAGIC) {
    throw new Error(
      `Bad fragment-index magic: got 0x${magic.toString(16).padStart(8, "0")}, ` +
        `want 0x${FRAGMENT_INDEX_MAGIC.toString(16).padStart(8, "0")}`,
    );
  }
  if (version !== FRAGMENT_INDEX_VERSION) {
    throw new Error(
      `Unsupported fragment-index version ${version}; ` +
        `this reader supports version ${FRAGMENT_INDEX_VERSION}`,
    );
  }
  if (flags !== 0) {
    throw new Error(
      `Unsupported fragment-index flags 0x${flags.toString(16).padStart(4, "0")}; expected 0`,
    );
  }
  if (r > f) {
    throw new Error(`num_range_fragments (${r}) exceeds num_fragments (${f})`);
  }

  if (f === 0) {
    return new FragmentIndex(
      0,
      new Uint8Array(0),
      new BigInt64Array(0),
      new Uint32Array(1),
      new BigInt64Array(0),
    );
  }

  let offset = HEADER_BYTES;

  // Range bitmap: ceil(F/8) bytes, padded to 8-byte boundary.
  const bitmapRawBytes = (f + 7) >> 3;
  const bitmapPadded = bitmapPaddedLength(f);
  if (view.byteLength < offset + bitmapPadded) {
    throw new Error("Fragment-index blob truncated in bitmap region");
  }
  const bitmap = new Uint8Array(u8.subarray(offset, offset + bitmapRawBytes));
  offset += bitmapPadded;

  // Validate popcount(bitmap) === r.  Cheap O(F/8) sanity check; catches
  // header / bitmap-corruption that would otherwise silently mis-route
  // fragment lookups.
  let popcount = 0;
  for (let i = 0; i < bitmapRawBytes; ++i) {
    let byte = bitmap[i];
    while (byte) {
      popcount += byte & 1;
      byte >>= 1;
    }
  }
  // Last byte may have spurious high bits if F is not a multiple of 8;
  // re-mask those off and recount only the valid `f & 7` bits.
  const validTailBits = f & 7;
  if (validTailBits !== 0) {
    const tailMask = (1 << validTailBits) - 1;
    const lastByte = bitmap[bitmapRawBytes - 1];
    const invalid = lastByte & ~tailMask;
    let invalidPop = 0;
    let b = invalid;
    while (b) {
      invalidPop += b & 1;
      b >>= 1;
    }
    popcount -= invalidPop;
  }
  if (popcount !== r) {
    throw new Error(
      `Fragment-index header/bitmap mismatch: bitmap popcount=${popcount}, ` +
        `header num_range_fragments=${r}`,
    );
  }

  // Range table: R entries of 16 bytes each (int64 start, int64 count).
  // Construct as BigInt64Array via .slice() to get an aligned copy.
  const rangeTableBytes = r * 16;
  if (view.byteLength < offset + rangeTableBytes) {
    throw new Error("Fragment-index blob truncated in range table");
  }
  const rangeTable = new BigInt64Array(
    u8.buffer.slice(
      u8.byteOffset + offset,
      u8.byteOffset + offset + rangeTableBytes,
    ),
  );
  offset += rangeTableBytes;

  const e = f - r;
  const csrOffsetsBytes = (e + 1) * 4;
  if (view.byteLength < offset + csrOffsetsBytes) {
    throw new Error("Fragment-index blob truncated in CSR offsets");
  }
  const csrOffsets = new Uint32Array(
    u8.buffer.slice(
      u8.byteOffset + offset,
      u8.byteOffset + offset + csrOffsetsBytes,
    ),
  );
  offset += csrOffsetsBytes;

  // Validate CSR offsets monotonicity (catch corruption that would crash
  // indicesView() with nonsensical slices later).
  for (let i = 0; i < e; ++i) {
    if (csrOffsets[i + 1] < csrOffsets[i]) {
      throw new Error(
        `Fragment-index CSR offsets not monotonic at index ${i}: ` +
          `${csrOffsets[i]} -> ${csrOffsets[i + 1]}`,
      );
    }
  }

  const t = e > 0 ? csrOffsets[e] : 0;
  const csrIndicesBytes = t * 8;
  if (view.byteLength < offset + csrIndicesBytes) {
    throw new Error("Fragment-index blob truncated in CSR indices");
  }
  const csrIndices = new BigInt64Array(
    u8.buffer.slice(
      u8.byteOffset + offset,
      u8.byteOffset + offset + csrIndicesBytes,
    ),
  );

  return new FragmentIndex(f, bitmap, rangeTable, csrOffsets, csrIndices);
}
