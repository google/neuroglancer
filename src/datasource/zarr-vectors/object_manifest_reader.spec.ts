/**
 * @license
 * Copyright 2026 Allen Institute for Brain Science
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { describe, expect, it } from "vitest";
import { MANIFEST_MODE_SINGLE } from "#src/datasource/zarr-vectors/object_manifest.js";
import { readObjectManifest } from "#src/datasource/zarr-vectors/object_manifest_reader.js";

/**
 * Build one per-object manifest blob holding a single mode-0 block.
 * Mirrors the encoder layout from /Users/forrestc/ConnectomeStack/
 * zarr-vectors-py/zarr_vectors/encoding/fragments.py.
 */
function buildSingleBlockBlob(
  chunkCoords: number[],
  fragmentIndex: number,
): Uint8Array {
  const sidNdim = chunkCoords.length;
  const blob = new Uint8Array(4 + 8 * sidNdim + 1 + 8);
  const view = new DataView(blob.buffer);
  view.setUint32(0, 1, /* littleEndian */ true);
  let off = 4;
  for (const c of chunkCoords) {
    view.setBigInt64(off, BigInt(c), true);
    off += 8;
  }
  view.setUint8(off, MANIFEST_MODE_SINGLE);
  off += 1;
  view.setBigInt64(off, BigInt(fragmentIndex), true);
  return blob;
}

/**
 * Build a vlen-bytes chunk holding the supplied element blobs.
 * Format: `uint32 N + (uint32 len + bytes) per element`.
 */
function buildVlenBytesChunk(elements: ReadonlyArray<Uint8Array>): Uint8Array {
  let total = 4;
  for (const e of elements) total += 4 + e.byteLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, elements.length, true);
  let off = 4;
  for (const e of elements) {
    view.setUint32(off, e.byteLength, true);
    off += 4;
    out.set(e, off);
    off += e.byteLength;
  }
  return out;
}

/** kvStore stub that returns bytes from a path → bytes map. */
function makeKvStore(
  map: Record<string, Uint8Array | undefined>,
): (path: string, signal: AbortSignal) => Promise<Uint8Array | undefined> {
  return async (path: string) => map[path];
}

describe("readObjectManifest", () => {
  const sidNdim = 3;

  it("reads OID 0 from chunk 0", async () => {
    // OID 0 → chunk 0, element index 0.
    const blob = buildSingleBlockBlob([1, 2, 3], 7);
    const chunk = buildVlenBytesChunk([blob]);
    const kvStoreRead = makeKvStore({
      "object_index/manifests/c/0": chunk,
    });
    const manifest = await readObjectManifest(
      0,
      { numObjects: 10, chunkSize: 16384, sidNdim, kvStoreRead },
      new AbortController().signal,
    );
    expect(manifest).toBeDefined();
    expect(manifest!.length).toBe(1);
    expect(manifest![0].chunkCoords).toEqual([1, 2, 3]);
    expect(manifest![0].fragmentRef).toEqual({
      mode: "single",
      fragmentIndex: 7,
    });
  });

  it("crosses array chunk boundaries — OID = chunkSize + 5 lives in chunk 1", async () => {
    // chunkSize=4: OID 9 → chunk 2, within-chunk index 1.
    const blob = buildSingleBlockBlob([7, 8, 9], 3);
    // Chunk 2 holds elements [oid 8, oid 9, oid 10, oid 11]; element 1 is oid 9.
    const chunk2 = buildVlenBytesChunk([
      new Uint8Array(4), // oid 8 — empty manifest (B=0, 4 bytes of zeros)
      blob, // oid 9
      new Uint8Array(4), // oid 10 — empty
      new Uint8Array(4), // oid 11 — empty
    ]);
    const kvStoreRead = makeKvStore({
      "object_index/manifests/c/2": chunk2,
    });
    const manifest = await readObjectManifest(
      9,
      { numObjects: 12, chunkSize: 4, sidNdim, kvStoreRead },
      new AbortController().signal,
    );
    expect(manifest).toBeDefined();
    expect(manifest!.length).toBe(1);
    expect(manifest![0].chunkCoords).toEqual([7, 8, 9]);
  });

  it("returns undefined when OID is out of bounds (oid >= numObjects)", async () => {
    const kvStoreRead = makeKvStore({});
    const result = await readObjectManifest(
      100,
      { numObjects: 10, chunkSize: 16384, sidNdim, kvStoreRead },
      new AbortController().signal,
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined when the array chunk file is missing (sparse chunk)", async () => {
    const kvStoreRead = makeKvStore({}); // chunk 0 not materialised
    const result = await readObjectManifest(
      0,
      { numObjects: 10, chunkSize: 16384, sidNdim, kvStoreRead },
      new AbortController().signal,
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined when OID points past the last element of a partial last chunk", async () => {
    // numObjects=5, chunkSize=4 — chunk 1 only holds element 4 (oid 4).
    // Asking for oid 5..7 should produce undefined (RangeError caught
    // and converted to "absent").
    const blob = buildSingleBlockBlob([0, 0, 0], 0);
    const chunk1 = buildVlenBytesChunk([blob]); // only 1 element
    const kvStoreRead = makeKvStore({
      "object_index/manifests/c/1": chunk1,
    });
    // oid 5 → chunk 1, within-chunk index 1 — but chunk only has element 0.
    const result = await readObjectManifest(
      5,
      { numObjects: 8, chunkSize: 4, sidNdim, kvStoreRead },
      new AbortController().signal,
    );
    expect(result).toBeUndefined();
  });

  it("accepts bigint OIDs (segment-IDs are uint64 in neuroglancer)", async () => {
    const blob = buildSingleBlockBlob([0, 0, 0], 0);
    const chunk = buildVlenBytesChunk([blob]);
    const kvStoreRead = makeKvStore({
      "object_index/manifests/c/0": chunk,
    });
    const manifest = await readObjectManifest(
      0n,
      { numObjects: 1, chunkSize: 16384, sidNdim, kvStoreRead },
      new AbortController().signal,
    );
    expect(manifest).toBeDefined();
  });

  it("rejects negative OIDs and non-integers", async () => {
    const kvStoreRead = makeKvStore({});
    await expect(
      readObjectManifest(
        -1,
        { numObjects: 10, chunkSize: 16384, sidNdim, kvStoreRead },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    await expect(
      readObjectManifest(
        1.5,
        { numObjects: 10, chunkSize: 16384, sidNdim, kvStoreRead },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });

  it("rejects chunkSize <= 0", async () => {
    const kvStoreRead = makeKvStore({});
    await expect(
      readObjectManifest(
        0,
        { numObjects: 10, chunkSize: 0, sidNdim, kvStoreRead },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/chunkSize/);
  });
});
