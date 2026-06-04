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
} from "#src/datasource/zarr-vectors/fragment_index.js";
import { MANIFEST_MODE_SINGLE } from "#src/datasource/zarr-vectors/object_manifest.js";
import {
  buildSkeletonChunk,
} from "#src/datasource/zarr-vectors/skeleton_chunk.js";
import {
  collectOwnedCrossChunkEdges,
  deriveImplicitSequentialCrossChunkEdges,
  downloadSegmentSkeleton,
  filterChunkByFragments,
  type OrderedManifestBlock,
} from "#src/datasource/zarr-vectors/skeleton_segment_download.js";
import type { CrossChunkLinksTable } from "#src/datasource/zarr-vectors/cross_chunk_links.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Build a FragmentIndex from a list of range / explicit fragments. */
function buildFragmentIndex(
  fragments: Array<
    | { range: { start: number; count: number } }
    | { explicit: number[] }
  >,
): FragmentIndex {
  const f = fragments.length;
  const bitmap = new Uint8Array(Math.max(1, (f + 7) >> 3));
  const rangeRows: bigint[] = [];
  const csrOffsets: number[] = [0];
  const csrIndices: bigint[] = [];
  for (let i = 0; i < f; ++i) {
    const frag = fragments[i];
    if ("range" in frag) {
      bitmap[i >> 3] |= 1 << (i & 7);
      rangeRows.push(BigInt(frag.range.start), BigInt(frag.range.count));
    } else {
      for (const idx of frag.explicit) csrIndices.push(BigInt(idx));
      csrOffsets.push(csrIndices.length);
    }
  }
  return new FragmentIndex(
    f,
    bitmap,
    new BigInt64Array(rangeRows),
    new Uint32Array(csrOffsets),
    new BigInt64Array(csrIndices),
  );
}

/**
 * Pack a FragmentIndex back into the ZVFG byte layout.  Used to build
 * `vertex_fragments/<chunk>` fixtures for the downloadSegmentSkeleton
 * integration tests below.
 */
function packFragmentIndexBlob(
  fragments: Array<
    | { range: { start: number; count: number } }
    | { explicit: number[] }
  >,
): Uint8Array {
  const f = fragments.length;
  let r = 0;
  for (const frag of fragments) if ("range" in frag) r++;
  const e = f - r;

  const bitmapRaw = (f + 7) >> 3;
  const bitmapPadded = (bitmapRaw + 7) & ~7;
  let csrIndexCount = 0;
  for (const frag of fragments) if ("explicit" in frag) csrIndexCount += frag.explicit.length;

  const total = 16 + bitmapPadded + r * 16 + (e + 1) * 4 + csrIndexCount * 8;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  view.setUint32(0, FRAGMENT_INDEX_MAGIC, true);
  view.setUint16(4, FRAGMENT_INDEX_VERSION, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, f, true);
  view.setUint32(12, r, true);

  let off = 16;
  for (let i = 0; i < f; ++i) {
    if ("range" in fragments[i]) u8[off + (i >> 3)] |= 1 << (i & 7);
  }
  off += bitmapPadded;

  for (let i = 0; i < f; ++i) {
    const frag = fragments[i];
    if ("range" in frag) {
      view.setBigInt64(off, BigInt(frag.range.start), true);
      view.setBigInt64(off + 8, BigInt(frag.range.count), true);
      off += 16;
    }
  }

  let csrCursor = 0;
  view.setUint32(off, 0, true);
  off += 4;
  for (let i = 0; i < f; ++i) {
    const frag = fragments[i];
    if ("explicit" in frag) {
      csrCursor += frag.explicit.length;
      view.setUint32(off, csrCursor, true);
      off += 4;
    }
  }
  for (const frag of fragments) {
    if ("explicit" in frag) {
      for (const idx of frag.explicit) {
        view.setBigInt64(off, BigInt(idx), true);
        off += 8;
      }
    }
  }
  return u8;
}

/** Build a single-block per-object manifest (ZVOM mode-0). */
function buildManifestBlob(
  chunkCoords: number[],
  fragmentIndex: number,
): Uint8Array {
  const sidNdim = chunkCoords.length;
  const blob = new Uint8Array(4 + 8 * sidNdim + 1 + 8);
  const view = new DataView(blob.buffer);
  view.setUint32(0, 1, true);
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

/** Build a vlen-bytes chunk holding one element. */
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

/** Pack a float-flat (numVertices * rank) position buffer as bytes. */
function verticesBlob(positions: number[]): Uint8Array {
  const arr = new Float32Array(positions);
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

function makeKvStore(map: Record<string, Uint8Array | undefined>) {
  return async (path: string) => map[path];
}

// ---------------------------------------------------------------------------
// filterChunkByFragments — unit tests over an in-memory SkeletonChunk
// ---------------------------------------------------------------------------

describe("filterChunkByFragments", () => {
  it("keeps just the named fragment's vertices and sequential edges", () => {
    // Two fragments [0..3) and [3..6).  Filter to fragment 0 only.
    const positions = new Float32Array([
      0, 0, 0, 1, 0, 0, 2, 0, 0,
      10, 0, 0, 11, 0, 0, 12, 0, 0,
    ]);
    const fi = buildFragmentIndex([
      { range: { start: 0, count: 3 } },
      { range: { start: 3, count: 3 } },
    ]);
    const chunk = buildSkeletonChunk({
      rank: 3,
      positions,
      fragmentIndex: fi,
      linksConvention: "implicit_sequential",
      geometryKind: "streamline",
      vertexAttributes: [],
    });

    const filtered = filterChunkByFragments(chunk, new Uint32Array([0]));
    expect(filtered.positions.length).toBe(9); // 3 vertices × rank 3
    expect(Array.from(filtered.positions.slice(0, 3))).toEqual([0, 0, 0]);
    expect(Array.from(filtered.positions.slice(6, 9))).toEqual([2, 0, 0]);
    // Edges within fragment 0 only: (0,1), (1,2) — remapped to local
    // indices [0..3), so identity remap.  No (2,3) bridge across the
    // fragment boundary because that edge was never emitted.
    expect(Array.from(filtered.edges)).toEqual([0, 1, 1, 2]);
  });

  it("keeps both fragments and their edges when filter selects both", () => {
    const positions = new Float32Array([
      0, 0, 0, 1, 0, 0, 2, 0, 0,
      10, 0, 0, 11, 0, 0, 12, 0, 0,
    ]);
    const fi = buildFragmentIndex([
      { range: { start: 0, count: 3 } },
      { range: { start: 3, count: 3 } },
    ]);
    const chunk = buildSkeletonChunk({
      rank: 3,
      positions,
      fragmentIndex: fi,
      linksConvention: "implicit_sequential",
      geometryKind: "streamline",
      vertexAttributes: [],
    });
    const filtered = filterChunkByFragments(chunk, new Uint32Array([0, 1]));
    expect(filtered.positions.length).toBe(18);
    // Sequential edges of both fragments, remapped to local indices.
    // Fragment 0: (0,1), (1,2); fragment 1: (3,4), (4,5) — which after
    // remap are (0,1)(1,2) and (3,4)(4,5) (identity since we kept all
    // vertices in walk order).
    expect(Array.from(filtered.edges)).toEqual([0, 1, 1, 2, 3, 4, 4, 5]);
  });

  it("keeps explicit branch edges where both endpoints are in the owned set", () => {
    // 5 vertices, single fragment.  Sequential edges (0,1)..(3,4) plus
    // an explicit branch (1, 4).  Filter to the fragment — all edges
    // survive.
    const positions = new Float32Array(15);
    for (let i = 0; i < 5; ++i) positions[i * 3] = i;
    const fi = buildFragmentIndex([{ range: { start: 0, count: 5 } }]);
    const chunk = buildSkeletonChunk({
      rank: 3,
      positions,
      fragmentIndex: fi,
      explicitEdges: new Uint32Array([1, 4]),
      linksConvention: "implicit_sequential_with_branches",
      geometryKind: "skeleton",
      vertexAttributes: [],
    });
    const filtered = filterChunkByFragments(chunk, new Uint32Array([0]));
    expect(Array.from(filtered.edges)).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 1, 4]);
  });

  it("drops branch edges that would cross a fragment boundary", () => {
    // Two fragments [0..3) and [3..6) with an explicit branch (2, 5)
    // bridging them.  Filter to fragment 0 only: the bridge edge has
    // one endpoint (5) outside the owned set → dropped.
    const positions = new Float32Array([
      0, 0, 0, 1, 0, 0, 2, 0, 0,
      10, 0, 0, 11, 0, 0, 12, 0, 0,
    ]);
    const fi = buildFragmentIndex([
      { range: { start: 0, count: 3 } },
      { range: { start: 3, count: 3 } },
    ]);
    const chunk = buildSkeletonChunk({
      rank: 3,
      positions,
      fragmentIndex: fi,
      explicitEdges: new Uint32Array([2, 5]),
      linksConvention: "implicit_sequential_with_branches",
      geometryKind: "skeleton",
      vertexAttributes: [],
    });
    const filtered = filterChunkByFragments(chunk, new Uint32Array([0]));
    expect(Array.from(filtered.edges)).toEqual([0, 1, 1, 2]);
  });

  it("emits filtered tangents for streamline / polyline kinds", () => {
    // 3 vertices marching +X.  Tangents = (1,0,0) for all.
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    const fi = buildFragmentIndex([{ range: { start: 0, count: 3 } }]);
    const chunk = buildSkeletonChunk({
      rank: 3,
      positions,
      fragmentIndex: fi,
      linksConvention: "implicit_sequential",
      geometryKind: "streamline",
      vertexAttributes: [],
    });
    const filtered = filterChunkByFragments(chunk, new Uint32Array([0]));
    expect(filtered.attributes.length).toBe(1); // just tangent
    const tangent = filtered.attributes[0] as Float32Array;
    expect(tangent.length).toBe(9);
    for (let i = 0; i < 3; ++i) {
      expect(tangent[i * 3]).toBeCloseTo(1, 6);
      expect(tangent[i * 3 + 1]).toBeCloseTo(0, 6);
      expect(tangent[i * 3 + 2]).toBeCloseTo(0, 6);
    }
  });

  it("filters user-declared vertex attributes alongside positions", () => {
    const positions = new Float32Array(9);
    const fi = buildFragmentIndex([{ range: { start: 0, count: 3 } }]);
    const radius = new Float32Array([0.1, 0.2, 0.3]);
    const swcType = new Int32Array([1, 2, 3]);
    const chunk = buildSkeletonChunk({
      rank: 3,
      positions,
      fragmentIndex: fi,
      linksConvention: "implicit_sequential",
      geometryKind: "polyline",
      vertexAttributes: [radius, swcType],
    });
    const filtered = filterChunkByFragments(chunk, new Uint32Array([0]));
    // tangent + radius + swcType
    expect(filtered.attributes.length).toBe(3);
    // index 0 = tangent, 1 = radius, 2 = swcType
    const radiusOut = filtered.attributes[1] as Float32Array;
    expect(radiusOut.length).toBe(3);
    expect(radiusOut[0]).toBeCloseTo(0.1, 5);
    expect(radiusOut[1]).toBeCloseTo(0.2, 5);
    expect(radiusOut[2]).toBeCloseTo(0.3, 5);
    expect(Array.from(filtered.attributes[2] as Int32Array)).toEqual([1, 2, 3]);
  });

  it("dedupes vertices when two fragments share rows", () => {
    // Two explicit fragments sharing vertex 2.  Filter to both — vertex
    // 2 should appear once in the output, with edges from both
    // fragments referring to it.
    const positions = new Float32Array([
      0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0,
    ]);
    const fi = buildFragmentIndex([
      { explicit: [0, 1, 2] },
      { explicit: [2, 3] },
    ]);
    const chunk = buildSkeletonChunk({
      rank: 3,
      positions,
      fragmentIndex: fi,
      linksConvention: "implicit_sequential",
      geometryKind: "streamline",
      vertexAttributes: [],
    });
    const filtered = filterChunkByFragments(
      chunk,
      new Uint32Array([0, 1]),
    );
    // Output has 4 unique vertices, walked in first-occurrence order.
    expect(filtered.positions.length / 3).toBe(4);
    // Edges from frag 0 ((0,1),(1,2)) + frag 1 ((2,3)) — all remapped.
    expect(Array.from(filtered.edges)).toEqual([0, 1, 1, 2, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// downloadSegmentSkeleton — orchestrator across a multi-chunk manifest
// ---------------------------------------------------------------------------

describe("downloadSegmentSkeleton", () => {
  const rank = 3;
  const attributeNames: string[] = [];
  const attributeDtypes: ("float32" | "uint8")[] = [];

  it("aggregates a single-chunk manifest into one merged skeleton", async () => {
    // Manifest: object 0 owns fragment 0 of chunk [1,2,3].
    // Chunk has 3 vertices forming one fragment.
    const manifestBlob = buildManifestBlob([1, 2, 3], 0);
    const manifestChunk = buildVlenBytesChunk([manifestBlob]);
    const fragmentBlob = packFragmentIndexBlob([
      { range: { start: 0, count: 3 } },
    ]);
    const verticesBytes = verticesBlob([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    const kvStoreRead = makeKvStore({
      "object_index/manifests/c/0": manifestChunk,
      "vertices/1.2.3/c/0": verticesBytes,
      "vertex_fragments/1.2.3/c/0": fragmentBlob,
    });

    const result = await downloadSegmentSkeleton(
      0,
      {
        manifestReader: {
          numObjects: 1,
          chunkSize: 16384,
          sidNdim: rank,
          kvStoreRead,
        },
        rank,
        linkDtype: "int64",
        attributeNames,
        attributeDtypes,
        linksConvention: "implicit_sequential",
        geometryKind: "streamline",
      },
      new AbortController().signal,
    );

    expect(result).toBeDefined();
    expect(result!.vertexPositions.length).toBe(9);
    expect(Array.from(result!.indices)).toEqual([0, 1, 1, 2]);
    // tangent attribute is present for streamline
    expect(result!.vertexAttributes.length).toBe(1);
    const tangents = result!.vertexAttributes[0] as Float32Array;
    expect(tangents.length).toBe(9);
    expect(tangents[0]).toBeCloseTo(1, 6);
  });

  it("aggregates a multi-chunk manifest with re-offset edge indices", async () => {
    // Object 0 spans two chunks: [0,0,0] frag 0 (2 verts) and
    // [1,0,0] frag 0 (3 verts).  Output should have 5 vertices and 3
    // total edges, with chunk-2's edges offset by 2.
    const manifestBytes = new Uint8Array(
      4 + (8 * 3 + 1 + 8) * 2,
    );
    const manifestView = new DataView(manifestBytes.buffer);
    manifestView.setUint32(0, 2, true); // num_blocks
    let off = 4;
    // Block 0
    for (const c of [0, 0, 0]) {
      manifestView.setBigInt64(off, BigInt(c), true);
      off += 8;
    }
    manifestView.setUint8(off, MANIFEST_MODE_SINGLE);
    off += 1;
    manifestView.setBigInt64(off, 0n, true);
    off += 8;
    // Block 1
    for (const c of [1, 0, 0]) {
      manifestView.setBigInt64(off, BigInt(c), true);
      off += 8;
    }
    manifestView.setUint8(off, MANIFEST_MODE_SINGLE);
    off += 1;
    manifestView.setBigInt64(off, 0n, true);

    const manifestChunk = buildVlenBytesChunk([manifestBytes]);
    const fragBlob = packFragmentIndexBlob([
      { range: { start: 0, count: 2 } },
    ]);
    const fragBlob3 = packFragmentIndexBlob([
      { range: { start: 0, count: 3 } },
    ]);
    const kvStoreRead = makeKvStore({
      "object_index/manifests/c/0": manifestChunk,
      "vertices/0.0.0/c/0": verticesBlob([0, 0, 0, 1, 0, 0]),
      "vertex_fragments/0.0.0/c/0": fragBlob,
      "vertices/1.0.0/c/0": verticesBlob([10, 0, 0, 11, 0, 0, 12, 0, 0]),
      "vertex_fragments/1.0.0/c/0": fragBlob3,
    });

    const result = await downloadSegmentSkeleton(
      0,
      {
        manifestReader: {
          numObjects: 1,
          chunkSize: 16384,
          sidNdim: rank,
          kvStoreRead,
        },
        rank,
        linkDtype: "int64",
        attributeNames,
        attributeDtypes,
        linksConvention: "implicit_sequential",
        geometryKind: "streamline",
      },
      new AbortController().signal,
    );

    expect(result).toBeDefined();
    expect(result!.vertexPositions.length).toBe(15); // 5 verts × 3
    // Intra-chunk edges: chunk-1 contributes (0,1); chunk-2 contributes
    // (2,3),(3,4).  Cross-chunk bridge (implicit_sequential): last
    // vertex of chunk-1's fragment (merged 1) → first vertex of
    // chunk-2's fragment (merged 2).  Appended after intra-chunk edges.
    expect(Array.from(result!.indices)).toEqual([0, 1, 2, 3, 3, 4, 1, 2]);
  });

  it("returns undefined when the OID has no manifest", async () => {
    const manifestChunk = buildVlenBytesChunk([
      new Uint8Array(4), // B = 0, empty manifest
    ]);
    const kvStoreRead = makeKvStore({
      "object_index/manifests/c/0": manifestChunk,
    });
    const result = await downloadSegmentSkeleton(
      0,
      {
        manifestReader: {
          numObjects: 1,
          chunkSize: 16384,
          sidNdim: rank,
          kvStoreRead,
        },
        rank,
        linkDtype: "int64",
        attributeNames,
        attributeDtypes,
        linksConvention: "implicit_sequential",
        geometryKind: "streamline",
      },
      new AbortController().signal,
    );
    expect(result).toBeUndefined();
  });

  it("skips chunks whose vertex blob is absent (sparse chunk presence)", async () => {
    // Manifest names two chunks; only one of them has a vertex blob.
    const manifestBytes = new Uint8Array(
      4 + (8 * 3 + 1 + 8) * 2,
    );
    const manifestView = new DataView(manifestBytes.buffer);
    manifestView.setUint32(0, 2, true);
    let off = 4;
    for (const c of [0, 0, 0]) {
      manifestView.setBigInt64(off, BigInt(c), true);
      off += 8;
    }
    manifestView.setUint8(off, MANIFEST_MODE_SINGLE);
    off += 1;
    manifestView.setBigInt64(off, 0n, true);
    off += 8;
    for (const c of [9, 9, 9]) {
      manifestView.setBigInt64(off, BigInt(c), true);
      off += 8;
    }
    manifestView.setUint8(off, MANIFEST_MODE_SINGLE);
    off += 1;
    manifestView.setBigInt64(off, 0n, true);

    const fragBlob = packFragmentIndexBlob([
      { range: { start: 0, count: 2 } },
    ]);
    const kvStoreRead = makeKvStore({
      "object_index/manifests/c/0": buildVlenBytesChunk([manifestBytes]),
      "vertices/0.0.0/c/0": verticesBlob([0, 0, 0, 1, 0, 0]),
      "vertex_fragments/0.0.0/c/0": fragBlob,
      // intentionally missing vertices/9.9.9 — sparse chunk
    });

    const result = await downloadSegmentSkeleton(
      0,
      {
        manifestReader: {
          numObjects: 1,
          chunkSize: 16384,
          sidNdim: rank,
          kvStoreRead,
        },
        rank,
        linkDtype: "int64",
        attributeNames,
        attributeDtypes,
        linksConvention: "implicit_sequential",
        geometryKind: "streamline",
      },
      new AbortController().signal,
    );
    // Only the first chunk's contribution survives.
    expect(result).toBeDefined();
    expect(result!.vertexPositions.length / rank).toBe(2);
    expect(Array.from(result!.indices)).toEqual([0, 1]);
  });

  it("returns undefined when the OID's manifest chunk file is missing", async () => {
    const kvStoreRead = makeKvStore({}); // no manifest chunk anywhere
    const result = await downloadSegmentSkeleton(
      0,
      {
        manifestReader: {
          numObjects: 1,
          chunkSize: 16384,
          sidNdim: rank,
          kvStoreRead,
        },
        rank,
        linkDtype: "int64",
        attributeNames,
        attributeDtypes,
        linksConvention: "implicit_sequential",
        geometryKind: "streamline",
      },
      new AbortController().signal,
    );
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// collectOwnedCrossChunkEdges
// ---------------------------------------------------------------------------

describe("collectOwnedCrossChunkEdges", () => {
  function table(
    linkWidth: number,
    records: Array<
      Array<{ chunkCoords: number[]; vertexIndex: number }>
    >,
    sidNdim = 3,
  ): CrossChunkLinksTable {
    return {
      linkWidth,
      sidNdim,
      records: records.map((eps) => ({ endpoints: eps })),
    };
  }

  function chunk(
    remap: number[],
    offset: number,
  ): { vertexRemap: Int32Array; vertexOffset: number } {
    return { vertexRemap: Int32Array.from(remap), vertexOffset: offset };
  }

  it("emits one edge per fully-owned record", () => {
    const t = table(2, [
      // record 0: A=(chunk 0.0.0, vert 2), B=(1.0.0, vert 0)
      [
        { chunkCoords: [0, 0, 0], vertexIndex: 2 },
        { chunkCoords: [1, 0, 0], vertexIndex: 0 },
      ],
    ]);
    const owned = new Map([
      // Chunk 0.0.0 has 3 vertices; vert 2 → merged index 2; offset 0.
      ["0.0.0", chunk([0, 1, 2], 0)],
      // Chunk 1.0.0 has 4 vertices; vert 0 → merged index 0; offset 3.
      ["1.0.0", chunk([0, 1, 2, 3], 3)],
    ]);
    const edges = collectOwnedCrossChunkEdges(t, owned);
    expect(Array.from(edges)).toEqual([2, 3]); // (0+2, 3+0)
  });

  it("drops records where one endpoint chunk is not owned", () => {
    const t = table(2, [
      [
        { chunkCoords: [0, 0, 0], vertexIndex: 0 },
        { chunkCoords: [99, 0, 0], vertexIndex: 0 },
      ],
    ]);
    const owned = new Map([["0.0.0", chunk([0], 0)]]);
    expect(Array.from(collectOwnedCrossChunkEdges(t, owned))).toEqual([]);
  });

  it("drops records where either endpoint vertex is filtered out (remap < 0)", () => {
    const t = table(2, [
      [
        { chunkCoords: [0, 0, 0], vertexIndex: 1 },
        { chunkCoords: [1, 0, 0], vertexIndex: 1 },
      ],
    ]);
    const owned = new Map([
      ["0.0.0", chunk([0, -1, 1], 0)], // vert 1 was filtered out
      ["1.0.0", chunk([0, 1, 2], 2)],
    ]);
    expect(Array.from(collectOwnedCrossChunkEdges(t, owned))).toEqual([]);
  });

  it("translates merged indices using each chunk's stored vertex offset", () => {
    const t = table(2, [
      [
        { chunkCoords: [0, 0, 0], vertexIndex: 0 },
        { chunkCoords: [1, 0, 0], vertexIndex: 2 },
      ],
    ]);
    const owned = new Map([
      ["0.0.0", chunk([5], 100)], // remap[0] = 5; offset 100 → merged 105
      ["1.0.0", chunk([0, 1, 7], 200)], // remap[2] = 7; offset 200 → merged 207
    ]);
    expect(Array.from(collectOwnedCrossChunkEdges(t, owned))).toEqual([
      105, 207,
    ]);
  });

  it("returns empty for linkWidth !== 2 (mesh / metanode records skipped)", () => {
    const t = table(3, [
      [
        { chunkCoords: [0, 0, 0], vertexIndex: 0 },
        { chunkCoords: [0, 0, 0], vertexIndex: 1 },
        { chunkCoords: [0, 0, 0], vertexIndex: 2 },
      ],
    ]);
    const owned = new Map([["0.0.0", chunk([0, 1, 2], 0)]]);
    expect(collectOwnedCrossChunkEdges(t, owned).length).toBe(0);
  });

  it("handles negative chunk-grid coordinates", () => {
    const t = table(2, [
      [
        { chunkCoords: [-1, -1, 0], vertexIndex: 0 },
        { chunkCoords: [0, -1, 0], vertexIndex: 0 },
      ],
    ]);
    const owned = new Map([
      ["-1.-1.0", chunk([0], 0)],
      ["0.-1.0", chunk([0], 1)],
    ]);
    expect(Array.from(collectOwnedCrossChunkEdges(t, owned))).toEqual([0, 1]);
  });

  it("drops records whose endpoint vertex index is out of range", () => {
    const t = table(2, [
      [
        { chunkCoords: [0, 0, 0], vertexIndex: 99 },
        { chunkCoords: [1, 0, 0], vertexIndex: 0 },
      ],
    ]);
    const owned = new Map([
      ["0.0.0", chunk([0], 0)],
      ["1.0.0", chunk([0], 1)],
    ]);
    expect(Array.from(collectOwnedCrossChunkEdges(t, owned))).toEqual([]);
  });

  it("emits multiple records when both endpoints survive each time", () => {
    const t = table(2, [
      [
        { chunkCoords: [0, 0, 0], vertexIndex: 0 },
        { chunkCoords: [1, 0, 0], vertexIndex: 0 },
      ],
      [
        { chunkCoords: [1, 0, 0], vertexIndex: 1 },
        { chunkCoords: [2, 0, 0], vertexIndex: 0 },
      ],
    ]);
    const owned = new Map([
      ["0.0.0", chunk([0], 0)],
      ["1.0.0", chunk([0, 1], 1)],
      ["2.0.0", chunk([0], 3)],
    ]);
    expect(Array.from(collectOwnedCrossChunkEdges(t, owned))).toEqual([
      0, 1, // record 0 → merged (0, 1)
      2, 3, // record 1 → merged (2, 3)
    ]);
  });
});

// ---------------------------------------------------------------------------
// deriveImplicitSequentialCrossChunkEdges
// ---------------------------------------------------------------------------

describe("deriveImplicitSequentialCrossChunkEdges", () => {
  function block(
    chunkKey: string,
    remap: number[],
    offset: number,
    firstLocal: number,
    lastLocal: number,
  ): OrderedManifestBlock {
    return {
      chunkKey,
      vertexRemap: Int32Array.from(remap),
      vertexOffset: offset,
      firstFragmentLocalVert: firstLocal,
      lastFragmentLocalVert: lastLocal,
    };
  }

  it("emits one bridge edge per chunk-to-chunk transition", () => {
    // Streamline visits A (verts 0..1, merged 0..1) then B (verts 0..2, merged 2..4).
    // Cross-chunk edge: A's last vert (chunk-local 1, merged 1) → B's first
    // (chunk-local 0, merged 2).
    const blocks = [
      block("0.0.0", [0, 1], 0, 0, 1),
      block("1.0.0", [0, 1, 2], 2, 0, 2),
    ];
    expect(Array.from(deriveImplicitSequentialCrossChunkEdges(blocks))).toEqual([
      1, 2,
    ]);
  });

  it("emits N-1 bridge edges for an N-chunk streamline", () => {
    const blocks = [
      block("0.0.0", [0, 1], 0, 0, 1), // merged 0..1
      block("1.0.0", [0, 1, 2], 2, 0, 2), // merged 2..4
      block("2.0.0", [0, 1], 5, 0, 1), // merged 5..6
    ];
    expect(Array.from(deriveImplicitSequentialCrossChunkEdges(blocks))).toEqual([
      1, 2, // bridge A→B
      4, 5, // bridge B→C
    ]);
  });

  it("bridges consecutive fragments even within the same chunk", () => {
    // zarr-vectors partitions streamlines by bin_shape, not just chunk
    // boundaries, so two fragments of the same streamline can live in
    // one chunk.  Each fragment is its own implicit-sequential edge
    // run, so we still need a bridge between them.
    const blocks = [
      block("0.0.0", [0, 1], 0, 0, 1), // merged 0..1
      block("0.0.0", [0, 1, 2], 2, 0, 2), // merged 2..4 (different filtered output)
    ];
    expect(Array.from(deriveImplicitSequentialCrossChunkEdges(blocks))).toEqual([
      1, 2,
    ]);
  });

  it("skips bridges where either side is a multi-fragment block (firstLocal/lastLocal = -1)", () => {
    const blocks = [
      block("0.0.0", [0, 1], 0, 0, 1),
      // Multi-fragment block: ambiguous cross-chunk endpoint, skip.
      block("1.0.0", [0, 1, 2], 2, -1, -1),
      block("2.0.0", [0, 1], 5, 0, 1),
    ];
    // Only the C-side bridge would be candidate, but B's lastLocal is
    // -1 so no bridge can be formed off B.  Result: 0 edges.
    expect(deriveImplicitSequentialCrossChunkEdges(blocks).length).toBe(0);
  });

  it("drops bridges where the endpoint vertex was filtered out (remap < 0)", () => {
    const blocks = [
      block("0.0.0", [0, -1], 0, 0, 1), // last-local 1, remap[1] = -1
      block("1.0.0", [0, 1, 2], 2, 0, 2),
    ];
    expect(deriveImplicitSequentialCrossChunkEdges(blocks).length).toBe(0);
  });

  it("handles single-block manifests (no bridges)", () => {
    const blocks = [block("0.0.0", [0, 1, 2], 0, 0, 2)];
    expect(deriveImplicitSequentialCrossChunkEdges(blocks).length).toBe(0);
  });

  it("handles empty input", () => {
    expect(deriveImplicitSequentialCrossChunkEdges([]).length).toBe(0);
  });

  it("respects each block's vertexOffset when emitting merged indices", () => {
    const blocks = [
      block("0.0.0", [42], 100, 0, 0), // last vert: local 0, remap[0]=42, offset 100 → merged 142
      block("1.0.0", [7], 200, 0, 0), // first vert: remap[0]=7, offset 200 → merged 207
    ];
    expect(Array.from(deriveImplicitSequentialCrossChunkEdges(blocks))).toEqual([
      142, 207,
    ]);
  });
});
