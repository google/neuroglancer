/**
 * @license
 * Copyright 2026 Allen Institute for Brain Science
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { describe, expect, it } from "vitest";
import {
  MANIFEST_MODE_EXPLICIT,
  MANIFEST_MODE_RANGE,
  MANIFEST_MODE_SINGLE,
  decodeObjectManifest,
  resolveFragmentRef,
} from "#src/datasource/zarr-vectors/object_manifest.js";

/**
 * Helpers to build a manifest blob by hand, mirroring the
 * `encode_object_manifest_blocks` encoder in the zarr-vectors-py repo
 * (no dependency on the encoder itself — keeps tests self-contained).
 */
function buildBlob(
  blocks: Array<{
    chunkCoords: number[];
    ref:
      | { mode: "single"; fragmentIndex: number }
      | { mode: "range"; start: number; count: number }
      | { mode: "explicit"; indices: number[] };
  }>,
  sidNdim: number,
): Uint8Array {
  // First pass: compute total size.
  let total = 4; // num_blocks header
  for (const b of blocks) {
    total += sidNdim * 8 + 1; // chunk_coords + mode tag
    switch (b.ref.mode) {
      case "single":
        total += 8;
        break;
      case "range":
        total += 16;
        break;
      case "explicit":
        total += 4 + b.ref.indices.length * 8;
        break;
    }
  }
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  view.setUint32(0, blocks.length, true);
  let offset = 4;
  for (const b of blocks) {
    if (b.chunkCoords.length !== sidNdim) {
      throw new Error("test fixture: chunkCoords length mismatch");
    }
    for (const c of b.chunkCoords) {
      view.setBigInt64(offset, BigInt(c), true);
      offset += 8;
    }
    switch (b.ref.mode) {
      case "single":
        view.setUint8(offset, MANIFEST_MODE_SINGLE);
        offset += 1;
        view.setBigInt64(offset, BigInt(b.ref.fragmentIndex), true);
        offset += 8;
        break;
      case "range":
        view.setUint8(offset, MANIFEST_MODE_RANGE);
        offset += 1;
        view.setBigInt64(offset, BigInt(b.ref.start), true);
        view.setBigInt64(offset + 8, BigInt(b.ref.count), true);
        offset += 16;
        break;
      case "explicit":
        view.setUint8(offset, MANIFEST_MODE_EXPLICIT);
        offset += 1;
        view.setUint32(offset, b.ref.indices.length, true);
        offset += 4;
        for (const idx of b.ref.indices) {
          view.setBigInt64(offset, BigInt(idx), true);
          offset += 8;
        }
        break;
    }
  }
  return new Uint8Array(buf);
}

describe("decodeObjectManifest — v0.6 manifest-block layout", () => {
  it("decodes an empty manifest (B=0) as zero blocks", () => {
    const blob = buildBlob([], 3);
    expect(blob.byteLength).toBe(4);
    expect(decodeObjectManifest(blob, 3)).toEqual([]);
  });

  it("decodes a single mode-0 (single) block", () => {
    const blob = buildBlob(
      [{ chunkCoords: [1, 2, 3], ref: { mode: "single", fragmentIndex: 7 } }],
      3,
    );
    const decoded = decodeObjectManifest(blob, 3);
    expect(decoded).toEqual([
      {
        chunkCoords: [1, 2, 3],
        fragmentRef: { mode: "single", fragmentIndex: 7 },
      },
    ]);
  });

  it("decodes a single mode-1 (range) block", () => {
    const blob = buildBlob(
      [{ chunkCoords: [0, 0, 0], ref: { mode: "range", start: 5, count: 12 } }],
      3,
    );
    const decoded = decodeObjectManifest(blob, 3);
    expect(decoded).toEqual([
      {
        chunkCoords: [0, 0, 0],
        fragmentRef: { mode: "range", start: 5, count: 12 },
      },
    ]);
  });

  it("decodes a single mode-2 (explicit) block", () => {
    const blob = buildBlob(
      [
        {
          chunkCoords: [9, 9, 9],
          ref: { mode: "explicit", indices: [100, 7, 42, 200] },
        },
      ],
      3,
    );
    const decoded = decodeObjectManifest(blob, 3);
    expect(decoded.length).toBe(1);
    expect(decoded[0].chunkCoords).toEqual([9, 9, 9]);
    expect(decoded[0].fragmentRef.mode).toBe("explicit");
    if (decoded[0].fragmentRef.mode === "explicit") {
      expect(Array.from(decoded[0].fragmentRef.indices)).toEqual([
        100, 7, 42, 200,
      ]);
    }
  });

  it("decodes a mixed manifest (single + range + explicit) across multiple chunks", () => {
    // Models a real coarsened skeleton spanning 3 chunks with mixed
    // fragment-ref kinds.
    const blob = buildBlob(
      [
        { chunkCoords: [0, 0, 0], ref: { mode: "single", fragmentIndex: 2 } },
        { chunkCoords: [1, 0, 0], ref: { mode: "range", start: 0, count: 4 } },
        {
          chunkCoords: [1, 1, 0],
          ref: { mode: "explicit", indices: [5, 9, 0] },
        },
      ],
      3,
    );
    const decoded = decodeObjectManifest(blob, 3);
    expect(decoded.length).toBe(3);
    expect(decoded[0].chunkCoords).toEqual([0, 0, 0]);
    expect(decoded[0].fragmentRef).toEqual({
      mode: "single",
      fragmentIndex: 2,
    });
    expect(decoded[1].chunkCoords).toEqual([1, 0, 0]);
    expect(decoded[1].fragmentRef).toEqual({
      mode: "range",
      start: 0,
      count: 4,
    });
    expect(decoded[2].chunkCoords).toEqual([1, 1, 0]);
    expect(decoded[2].fragmentRef.mode).toBe("explicit");
    if (decoded[2].fragmentRef.mode === "explicit") {
      expect(Array.from(decoded[2].fragmentRef.indices)).toEqual([5, 9, 0]);
    }
  });

  it("handles rank-2 chunk coords", () => {
    const blob = buildBlob(
      [{ chunkCoords: [3, 4], ref: { mode: "single", fragmentIndex: 1 } }],
      2,
    );
    const decoded = decodeObjectManifest(blob, 2);
    expect(decoded[0].chunkCoords).toEqual([3, 4]);
  });

  it("rejects negative single-mode fragment indices", () => {
    // Hand-build a blob with negative idx to trip the validation.
    const buf = new ArrayBuffer(4 + 8 * 3 + 1 + 8);
    const view = new DataView(buf);
    view.setUint32(0, 1, true);
    let off = 4;
    for (let i = 0; i < 3; ++i) {
      view.setBigInt64(off, 0n, true);
      off += 8;
    }
    view.setUint8(off, MANIFEST_MODE_SINGLE);
    off += 1;
    view.setBigInt64(off, -1n, true);
    expect(() => decodeObjectManifest(buf, 3)).toThrow(/>= 0/);
  });

  it("rejects negative range count", () => {
    const buf = new ArrayBuffer(4 + 8 * 3 + 1 + 16);
    const view = new DataView(buf);
    view.setUint32(0, 1, true);
    let off = 4;
    for (let i = 0; i < 3; ++i) {
      view.setBigInt64(off, 0n, true);
      off += 8;
    }
    view.setUint8(off, MANIFEST_MODE_RANGE);
    off += 1;
    view.setBigInt64(off, 0n, true); // start
    view.setBigInt64(off + 8, -5n, true); // count
    expect(() => decodeObjectManifest(buf, 3)).toThrow(/count must be >= 0/);
  });

  it("rejects an unknown mode tag", () => {
    const buf = new ArrayBuffer(4 + 8 * 3 + 1);
    const view = new DataView(buf);
    view.setUint32(0, 1, true);
    let off = 4;
    for (let i = 0; i < 3; ++i) {
      view.setBigInt64(off, 0n, true);
      off += 8;
    }
    view.setUint8(off, 99); // unknown mode
    expect(() => decodeObjectManifest(buf, 3)).toThrow(/mode 99/);
  });

  it("rejects truncated blobs", () => {
    const blob = buildBlob(
      [{ chunkCoords: [0, 0, 0], ref: { mode: "range", start: 0, count: 4 } }],
      3,
    );
    expect(() =>
      decodeObjectManifest(blob.slice(0, blob.byteLength - 4), 3),
    ).toThrow(/truncated/i);
    expect(() => decodeObjectManifest(blob.slice(0, 2), 3)).toThrow(
      /too short/i,
    );
  });

  it("rejects trailing bytes after the declared number of blocks", () => {
    const blob = buildBlob(
      [{ chunkCoords: [0, 0, 0], ref: { mode: "single", fragmentIndex: 0 } }],
      3,
    );
    const padded = new Uint8Array(blob.byteLength + 7);
    padded.set(blob);
    expect(() => decodeObjectManifest(padded, 3)).toThrow(/trailing/i);
  });
});

describe("resolveFragmentRef", () => {
  it("flattens a single-mode ref to a 1-element index array", () => {
    expect(
      Array.from(resolveFragmentRef({ mode: "single", fragmentIndex: 7 })),
    ).toEqual([7]);
  });

  it("expands a range-mode ref to [start, start+count)", () => {
    expect(
      Array.from(resolveFragmentRef({ mode: "range", start: 10, count: 4 })),
    ).toEqual([10, 11, 12, 13]);
  });

  it("returns the explicit indices unchanged", () => {
    const indices = new Uint32Array([5, 12, 1, 9]);
    const out = resolveFragmentRef({ mode: "explicit", indices });
    expect(out).toBe(indices);
  });
});
