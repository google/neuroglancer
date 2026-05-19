/**
 * @license
 * Copyright 2026 Allen Institute for Brain Science
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { describe, expect, it } from "vitest";
import {
  FRAGMENT_INDEX_MAGIC,
  FRAGMENT_INDEX_VERSION,
  FragmentIndex,
  decodeFragments,
} from "#src/datasource/zarr-vectors/fragment_index.js";

/**
 * Build a v1 fragment-index blob by hand.  Mirrors the encoder in the
 * zarr-vectors-py repo but stays inside this file so tests don't depend
 * on any other module.
 */
function buildBlob(
  numFragments: number,
  isRangeBits: boolean[],
  rangeTable: Array<{ start: number; count: number }>,
  csrOffsets: number[],
  csrIndices: number[],
): Uint8Array {
  const f = numFragments;
  const r = rangeTable.length;
  const e = f - r;
  const bitmapRawBytes = (f + 7) >> 3;
  const bitmapPadded = (bitmapRawBytes + 7) & ~7;
  const total =
    16 + // header
    bitmapPadded +
    r * 16 +
    (e + 1) * 4 +
    csrIndices.length * 8;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  // Header (16 bytes, little-endian).
  view.setUint32(0, FRAGMENT_INDEX_MAGIC, true);
  view.setUint16(4, FRAGMENT_INDEX_VERSION, true);
  view.setUint16(6, 0, true); // flags
  view.setUint32(8, f, true);
  view.setUint32(12, r, true);

  // Bitmap (LSB-first within each byte; padded to 8-byte boundary, zeros for padding).
  let off = 16;
  for (let i = 0; i < isRangeBits.length; ++i) {
    if (isRangeBits[i]) u8[off + (i >> 3)] |= 1 << (i & 7);
  }
  off += bitmapPadded;

  // Range table (R x int64 pairs).
  for (let i = 0; i < r; ++i) {
    view.setBigInt64(off, BigInt(rangeTable[i].start), true);
    view.setBigInt64(off + 8, BigInt(rangeTable[i].count), true);
    off += 16;
  }

  // CSR offsets (E+1 uint32).
  for (let i = 0; i < csrOffsets.length; ++i) {
    view.setUint32(off, csrOffsets[i], true);
    off += 4;
  }

  // CSR indices (T int64).
  for (let i = 0; i < csrIndices.length; ++i) {
    view.setBigInt64(off, BigInt(csrIndices[i]), true);
    off += 8;
  }
  return u8;
}

describe("decodeFragments — v1 fragment-index layout", () => {
  it("decodes an empty blob (F=0) as zero fragments", () => {
    const blob = buildBlob(0, [], [], [0], []);
    const fi = decodeFragments(blob);
    expect(fi.numFragments).toBe(0);
    expect(fi.numRangeFragments).toBe(0);
    expect(fi.numExplicitFragments).toBe(0);
  });

  it("decodes a single range fragment", () => {
    const blob = buildBlob(1, [true], [{ start: 7, count: 4 }], [0], []);
    const fi = decodeFragments(blob);
    expect(fi.numFragments).toBe(1);
    expect(fi.numRangeFragments).toBe(1);
    expect(fi.isRange(0)).toBe(true);
    expect(fi.range(0)).toEqual({ start: 7, count: 4 });
    expect(Array.from(fi.indices(0))).toEqual([7, 8, 9, 10]);
  });

  it("decodes a single explicit fragment", () => {
    const blob = buildBlob(1, [false], [], [0, 3], [5, 12, 1]);
    const fi = decodeFragments(blob);
    expect(fi.numFragments).toBe(1);
    expect(fi.numRangeFragments).toBe(0);
    expect(fi.isRange(0)).toBe(false);
    expect(Array.from(fi.indices(0))).toEqual([5, 12, 1]);
  });

  it("decodes the spec's worked example — three fragments (range, explicit, range)", () => {
    // From /Users/forrestc/ConnectomeStack/zarr-vectors-py/docs/spec/layout/vg_index_arrays.md§"Worked example":
    //  Fragment 0 — range [0, 4)
    //  Fragment 1 — explicit [12, 7, 19]
    //  Fragment 2 — range [20, 28)
    // bitmap: bits 0 and 2 set (= 0b00000101 = 0x05)
    const blob = buildBlob(
      3,
      [true, false, true],
      [
        { start: 0, count: 4 },
        { start: 20, count: 8 },
      ],
      [0, 3],
      [12, 7, 19],
    );
    expect(blob.byteLength).toBe(88);

    const fi = decodeFragments(blob);
    expect(fi.numFragments).toBe(3);
    expect(fi.numRangeFragments).toBe(2);
    expect(fi.numExplicitFragments).toBe(1);

    // is_range bit lookups — these should not depend on the popcount cache.
    expect(fi.isRange(0)).toBe(true);
    expect(fi.isRange(1)).toBe(false);
    expect(fi.isRange(2)).toBe(true);

    // Range payloads — note: fragment 2 maps to row 1 of the range table
    // via prefix-popcount (bitmap bits 0 + 1 set before f=2 = 1, so row=1).
    expect(fi.range(0)).toEqual({ start: 0, count: 4 });
    expect(fi.range(2)).toEqual({ start: 20, count: 8 });

    // Indices materialised:
    expect(Array.from(fi.indices(0))).toEqual([0, 1, 2, 3]);
    expect(Array.from(fi.indices(1))).toEqual([12, 7, 19]);
    expect(Array.from(fi.indices(2))).toEqual([
      20, 21, 22, 23, 24, 25, 26, 27,
    ]);

    // .indicesView on an explicit fragment is zero-copy BigInt64Array.
    const view = fi.indicesView(1);
    expect(view).toBeInstanceOf(BigInt64Array);
    expect(Array.from(view).map(Number)).toEqual([12, 7, 19]);

    // .range on an explicit fragment throws.
    expect(() => fi.range(1)).toThrow();
    // .indicesView on a range throws.
    expect(() => fi.indicesView(0)).toThrow();

    // Out-of-bounds fragment index throws.
    expect(() => fi.isRange(-1)).toThrow();
    expect(() => fi.isRange(3)).toThrow();
  });

  it("rejects a bad magic", () => {
    const blob = buildBlob(0, [], [], [0], []);
    blob[0] = 0xff;
    expect(() => decodeFragments(blob)).toThrow(/magic/i);
  });

  it("rejects an unsupported version", () => {
    const blob = buildBlob(1, [true], [{ start: 0, count: 1 }], [0], []);
    new DataView(
      blob.buffer,
      blob.byteOffset,
      blob.byteLength,
    ).setUint16(4, 99, true);
    expect(() => decodeFragments(blob)).toThrow(/version/i);
  });

  it("rejects flags != 0", () => {
    const blob = buildBlob(1, [true], [{ start: 0, count: 1 }], [0], []);
    new DataView(
      blob.buffer,
      blob.byteOffset,
      blob.byteLength,
    ).setUint16(6, 0x0001, true);
    expect(() => decodeFragments(blob)).toThrow(/flags/i);
  });

  it("rejects a header/bitmap popcount mismatch", () => {
    // F=2, claim R=2 in the header but only set 1 bit in the bitmap.
    const blob = buildBlob(2, [true, false], [{ start: 0, count: 1 }], [0, 0], []);
    // Manually corrupt the header so R disagrees with the bitmap.
    new DataView(
      blob.buffer,
      blob.byteOffset,
      blob.byteLength,
    ).setUint32(12, 2, true);
    expect(() => decodeFragments(blob)).toThrow(/mismatch/i);
  });

  it("rejects truncated blobs", () => {
    const blob = buildBlob(
      3,
      [true, false, true],
      [
        { start: 0, count: 4 },
        { start: 20, count: 8 },
      ],
      [0, 3],
      [12, 7, 19],
    );
    // Truncate just before CSR indices end.
    expect(() => decodeFragments(blob.slice(0, blob.length - 8))).toThrow(
      /truncated/i,
    );
    // Truncate to less than header.
    expect(() => decodeFragments(blob.slice(0, 8))).toThrow(/too short/i);
  });

  it("ignores spurious high bits in the last bitmap byte (F not divisible by 8)", () => {
    // F=3, only bit 0 set legally; set bit 7 too (which would invalidate
    // the popcount if we naively counted it).
    const blob = buildBlob(3, [true, false, false], [{ start: 0, count: 1 }], [0, 0, 0], []);
    blob[16] |= 0b10000000; // bit 7 in the bitmap byte
    // Header says R=1, bitmap legal bits sum to 1 even though byte popcount=2.
    expect(() => decodeFragments(blob)).not.toThrow();
    const fi = decodeFragments(blob);
    expect(fi.isRange(0)).toBe(true);
    expect(fi.isRange(1)).toBe(false);
    expect(fi.isRange(2)).toBe(false);
  });

  it("popcount cache: many lookups are O(1) after first call", () => {
    // Smoke test that repeated lookups don't crash and return stable
    // results (correctness check; no perf assertion).
    const blob = buildBlob(
      5,
      [true, false, true, false, true],
      [
        { start: 0, count: 2 },
        { start: 10, count: 2 },
        { start: 20, count: 2 },
      ],
      [0, 2, 4],
      [100, 101, 200, 201],
    );
    const fi = decodeFragments(blob);
    expect(fi.range(0)).toEqual({ start: 0, count: 2 });
    expect(Array.from(fi.indices(1))).toEqual([100, 101]);
    expect(fi.range(2)).toEqual({ start: 10, count: 2 });
    expect(Array.from(fi.indices(3))).toEqual([200, 201]);
    expect(fi.range(4)).toEqual({ start: 20, count: 2 });
    // Re-querying:
    expect(fi.isRange(2)).toBe(true);
    expect(fi.range(2)).toEqual({ start: 10, count: 2 });
  });
});

describe("FragmentIndex direct construction", () => {
  it("is constructible with the published shape", () => {
    // Sanity that the class accepts hand-built data; useful for callers
    // that synthesize fragments from impl-internal sources.
    const fi = new FragmentIndex(
      2,
      new Uint8Array([0b11]),
      new BigInt64Array([0n, 3n, 5n, 2n]),
      new Uint32Array([0]),
      new BigInt64Array(0),
    );
    expect(fi.numFragments).toBe(2);
    expect(fi.numRangeFragments).toBe(2);
    expect(fi.range(0)).toEqual({ start: 0, count: 3 });
    expect(fi.range(1)).toEqual({ start: 5, count: 2 });
  });
});
