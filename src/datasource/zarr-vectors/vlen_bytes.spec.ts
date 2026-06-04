/**
 * @license
 * Copyright 2026 Allen Institute for Brain Science
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { describe, expect, it } from "vitest";
import {
  decodeVlenBytesChunk,
  readVlenBytesElement,
} from "#src/datasource/zarr-vectors/vlen_bytes.js";

/** Build a vlen-bytes chunk from a list of byte blobs (test helper). */
function buildBlob(elements: ReadonlyArray<Uint8Array>): Uint8Array {
  let total = 4;
  for (const e of elements) total += 4 + e.byteLength;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);
  view.setUint32(0, elements.length, /* littleEndian */ true);
  let offset = 4;
  for (const e of elements) {
    view.setUint32(offset, e.byteLength, true);
    offset += 4;
    u8.set(e, offset);
    offset += e.byteLength;
  }
  return u8;
}

describe("decodeVlenBytesChunk — zarr v3 vlen-bytes codec", () => {
  it("decodes an empty chunk (N=0)", () => {
    const blob = buildBlob([]);
    expect(blob.byteLength).toBe(4);
    expect(decodeVlenBytesChunk(blob)).toEqual([]);
  });

  it("decodes one element of 3 bytes (matches numcodecs.VLenBytes empirically)", () => {
    // Reference bytes from a numcodecs.vlen.VLenBytes round-trip of
    // np.array([b"abc"], dtype=object):
    //   01 00 00 00  (N=1)
    //   03 00 00 00  (L=3)
    //   61 62 63     ("abc")
    const expected = new Uint8Array([
      0x01, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x61, 0x62, 0x63,
    ]);
    const built = buildBlob([new Uint8Array([0x61, 0x62, 0x63])]);
    expect(built).toEqual(expected);

    const decoded = decodeVlenBytesChunk(built);
    expect(decoded.length).toBe(1);
    expect(Array.from(decoded[0])).toEqual([0x61, 0x62, 0x63]);
  });

  it("decodes 3 mixed-length elements (matches the empirical reference fixture)", () => {
    // From the numcodecs probe: np.array([b"ab", b"", b"XYZ"]) →
    // 03 00 00 00  (N=3)
    // 02 00 00 00  61 62                ("ab")
    // 00 00 00 00                       (empty)
    // 03 00 00 00  58 59 5a             ("XYZ")
    const expected = new Uint8Array([
      0x03, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x61, 0x62, 0x00, 0x00,
      0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x58, 0x59, 0x5a,
    ]);
    const built = buildBlob([
      new Uint8Array([0x61, 0x62]),
      new Uint8Array(0),
      new Uint8Array([0x58, 0x59, 0x5a]),
    ]);
    expect(built).toEqual(expected);

    const decoded = decodeVlenBytesChunk(built);
    expect(decoded.length).toBe(3);
    expect(Array.from(decoded[0])).toEqual([0x61, 0x62]);
    expect(Array.from(decoded[1])).toEqual([]);
    expect(Array.from(decoded[2])).toEqual([0x58, 0x59, 0x5a]);
  });

  it("rejects a blob too short for the header", () => {
    expect(() => decodeVlenBytesChunk(new Uint8Array([1, 2]))).toThrow(
      /too short/i,
    );
  });

  it("rejects truncation at an element header", () => {
    // N=2 in header, but only one full element is present.
    const blob = new Uint8Array([
      0x02, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x61, 0x62, 0x63,
    ]);
    expect(() => decodeVlenBytesChunk(blob)).toThrow(
      /truncated.*element 1 header/,
    );
  });

  it("rejects truncation in an element payload", () => {
    // N=1, L=10, but only 3 bytes follow.
    const blob = new Uint8Array([
      0x01, 0x00, 0x00, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x61, 0x62, 0x63,
    ]);
    expect(() => decodeVlenBytesChunk(blob)).toThrow(
      /truncated.*element 0 payload/,
    );
  });

  it("rejects trailing bytes after the declared element count", () => {
    const blob = new Uint8Array([
      0x01, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x61, 0x62, 0x63, 0xff,
    ]);
    expect(() => decodeVlenBytesChunk(blob)).toThrow(/trailing/i);
  });

  it("returns zero-copy views into the input buffer", () => {
    const blob = buildBlob([new Uint8Array([0x10, 0x20, 0x30])]);
    const decoded = decodeVlenBytesChunk(blob);
    // The returned view shares the underlying buffer with the input.
    expect(decoded[0].buffer).toBe(blob.buffer);
  });
});

describe("readVlenBytesElement — direct indexing", () => {
  const blob = buildBlob([
    new Uint8Array([0x41]),       // 'A'
    new Uint8Array([0x42, 0x43]), // 'BC'
    new Uint8Array(0),
    new Uint8Array([0x44, 0x45, 0x46, 0x47]), // 'DEFG'
  ]);

  it("reads element 0", () => {
    expect(Array.from(readVlenBytesElement(blob, 0))).toEqual([0x41]);
  });

  it("reads element 1", () => {
    expect(Array.from(readVlenBytesElement(blob, 1))).toEqual([0x42, 0x43]);
  });

  it("reads an empty element", () => {
    expect(Array.from(readVlenBytesElement(blob, 2))).toEqual([]);
  });

  it("reads the last element", () => {
    expect(Array.from(readVlenBytesElement(blob, 3))).toEqual([
      0x44, 0x45, 0x46, 0x47,
    ]);
  });

  it("throws RangeError when elementIndex is out of bounds", () => {
    expect(() => readVlenBytesElement(blob, 4)).toThrow(RangeError);
    expect(() => readVlenBytesElement(blob, -1)).toThrow(RangeError);
    expect(() => readVlenBytesElement(blob, 1.5)).toThrow(RangeError);
  });

  it("throws on a header-only too-short input", () => {
    expect(() => readVlenBytesElement(new Uint8Array([0, 0]), 0)).toThrow(
      /too short/i,
    );
  });
});
