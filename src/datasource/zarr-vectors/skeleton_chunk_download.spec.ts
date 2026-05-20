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
} from "#src/datasource/zarr-vectors/fragment_index.js";
import {
  downloadSkeletonChunk,
  type LinkDtype,
} from "#src/datasource/zarr-vectors/skeleton_chunk_download.js";

/** Build a single-range-fragment ZVFG blob covering all `numVertices` rows. */
function singleRangeFragmentBlob(numVertices: number): Uint8Array {
  // Layout: 16-byte header, 8-byte bitmap (1 bit set), 16-byte range entry,
  // 4-byte CSR offsets section (one uint32 zero — E+1 with E=0).
  const buf = new ArrayBuffer(16 + 8 + 16 + 4);
  const view = new DataView(buf);
  view.setUint32(0, FRAGMENT_INDEX_MAGIC, true);
  view.setUint16(4, FRAGMENT_INDEX_VERSION, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, 1, true); // F = 1
  view.setUint32(12, 1, true); // R = 1
  new Uint8Array(buf)[16] = 0x01; // bitmap bit 0 set
  view.setBigInt64(24, 0n, true); // start
  view.setBigInt64(32, BigInt(numVertices), true); // count
  view.setUint32(40, 0, true); // csr_offsets[0] = 0 (E=0)
  return new Uint8Array(buf);
}

/** Pack float32 positions into a vertices blob (rank-3). */
function verticesBlob(positions: number[]): Uint8Array {
  const arr = new Float32Array(positions);
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

/** Pack uint16 edges into a links blob. */
function uint16LinksBlob(edges: number[]): Uint8Array {
  const arr = new Uint16Array(edges);
  return new Uint8Array(arr.buffer);
}

/** Build a kvStore stub from a path → bytes map (any missing path → undefined). */
function makeKvStore(
  map: Record<string, Uint8Array | undefined>,
): (path: string, signal: AbortSignal) => Promise<Uint8Array | undefined> {
  return async (path: string) => map[path];
}

describe("downloadSkeletonChunk — orchestrator", () => {
  it("returns undefined when the vertices blob is absent", async () => {
    const kvStoreRead = makeKvStore({});
    const result = await downloadSkeletonChunk(
      {
        chunkKey: "0.0.0",
        rank: 3,
        linkDtype: "int64",
        attributeNames: [],
        attributeDtypes: [],
        linksConvention: "implicit_sequential",
        geometryKind: "streamline",
        kvStoreRead,
      },
      new AbortController().signal,
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined when the vertices blob is zero bytes", async () => {
    const kvStoreRead = makeKvStore({
      "vertices/0.0.0/c/0": new Uint8Array(0),
    });
    const result = await downloadSkeletonChunk(
      {
        chunkKey: "0.0.0",
        rank: 3,
        linkDtype: "int64",
        attributeNames: [],
        attributeDtypes: [],
        linksConvention: "implicit_sequential",
        geometryKind: "streamline",
        kvStoreRead,
      },
      new AbortController().signal,
    );
    expect(result).toBeUndefined();
  });

  it("downloads a streamline chunk and returns positions + edges + tangents", async () => {
    // 3 vertices marching +X by 1 each step → tangents all (1, 0, 0).
    const positions = [0, 0, 0, 1, 0, 0, 2, 0, 0];
    const kvStoreRead = makeKvStore({
      "vertices/1.2.3/c/0": verticesBlob(positions),
      "vertex_fragments/1.2.3/c/0": singleRangeFragmentBlob(3),
    });
    const chunk = await downloadSkeletonChunk(
      {
        chunkKey: "1.2.3",
        rank: 3,
        linkDtype: "int64",
        attributeNames: [],
        attributeDtypes: [],
        linksConvention: "implicit_sequential",
        geometryKind: "streamline",
        kvStoreRead,
      },
      new AbortController().signal,
    );
    expect(chunk).toBeDefined();
    expect(chunk!.numVertices).toBe(3);
    expect(chunk!.numEdges).toBe(2);
    expect(Array.from(chunk!.edges)).toEqual([0, 1, 1, 2]);
    // tangents all (1, 0, 0)
    expect(chunk!.tangents).toBeDefined();
    for (let i = 0; i < 3; ++i) {
      expect(chunk!.tangents![i * 3]).toBeCloseTo(1, 6);
      expect(chunk!.tangents![i * 3 + 1]).toBeCloseTo(0, 6);
      expect(chunk!.tangents![i * 3 + 2]).toBeCloseTo(0, 6);
    }
  });

  it("downloads a polyline chunk with per-vertex attributes", async () => {
    const kvStoreRead = makeKvStore({
      "vertices/0.0.0/c/0": verticesBlob([0, 0, 0, 1, 0, 0]),
      "vertex_fragments/0.0.0/c/0": singleRangeFragmentBlob(2),
      "vertex_attributes/radius/0.0.0/c/0": new Uint8Array(
        new Float32Array([0.5, 0.7]).buffer,
      ),
    });
    const chunk = await downloadSkeletonChunk(
      {
        chunkKey: "0.0.0",
        rank: 3,
        linkDtype: "int64",
        attributeNames: ["radius"],
        attributeDtypes: ["float32"],
        linksConvention: "implicit_sequential",
        geometryKind: "polyline",
        kvStoreRead,
      },
      new AbortController().signal,
    );
    expect(chunk!.vertexAttributes.length).toBe(1);
    const radius = chunk!.vertexAttributes[0] as Float32Array;
    expect(radius.length).toBe(2);
    expect(radius[0]).toBeCloseTo(0.5);
    expect(radius[1]).toBeCloseTo(0.7);
  });

  it("downloads a skeleton chunk with implicit_sequential_with_branches and uint16 link dtype", async () => {
    // 5 vertices, single fragment.  Sequential edges plus a branch (1,4)
    // stored in links/0 as uint16.
    const kvStoreRead = makeKvStore({
      "vertices/0.0.0/c/0": verticesBlob([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0]),
      "vertex_fragments/0.0.0/c/0": singleRangeFragmentBlob(5),
      "links/0/0.0.0/c/0": uint16LinksBlob([1, 4]),
    });
    const chunk = await downloadSkeletonChunk(
      {
        chunkKey: "0.0.0",
        rank: 3,
        linkDtype: "uint16",
        attributeNames: [],
        attributeDtypes: [],
        linksConvention: "implicit_sequential_with_branches",
        geometryKind: "skeleton",
        kvStoreRead,
      },
      new AbortController().signal,
    );
    expect(chunk!.numEdges).toBe(5); // 4 sequential + 1 branch
    expect(Array.from(chunk!.edges)).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 1, 4]);
    // Skeletons don't precompute tangents.
    expect(chunk!.tangents).toBeUndefined();
  });

  it("downloads an explicit-only graph chunk with int32 link dtype", async () => {
    const linksBlob = new Uint8Array(new Int32Array([0, 1, 2, 3]).buffer);
    const kvStoreRead = makeKvStore({
      "vertices/0.0.0/c/0": verticesBlob([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]),
      "vertex_fragments/0.0.0/c/0": singleRangeFragmentBlob(4),
      "links/0/0.0.0/c/0": linksBlob,
    });
    const chunk = await downloadSkeletonChunk(
      {
        chunkKey: "0.0.0",
        rank: 3,
        linkDtype: "int32",
        attributeNames: [],
        attributeDtypes: [],
        linksConvention: "explicit",
        geometryKind: "skeleton",
        kvStoreRead,
      },
      new AbortController().signal,
    );
    expect(chunk!.numEdges).toBe(2);
    expect(Array.from(chunk!.edges)).toEqual([0, 1, 2, 3]);
  });

  it("handles a skeleton chunk with no branches (empty links blob)", async () => {
    const kvStoreRead = makeKvStore({
      "vertices/0.0.0/c/0": verticesBlob([0, 0, 0, 1, 0, 0]),
      "vertex_fragments/0.0.0/c/0": singleRangeFragmentBlob(2),
      "links/0/0.0.0/c/0": new Uint8Array(0),
    });
    const chunk = await downloadSkeletonChunk(
      {
        chunkKey: "0.0.0",
        rank: 3,
        linkDtype: "uint16",
        attributeNames: [],
        attributeDtypes: [],
        linksConvention: "implicit_sequential_with_branches",
        geometryKind: "skeleton",
        kvStoreRead,
      },
      new AbortController().signal,
    );
    expect(chunk!.numEdges).toBe(1); // just the (0,1) sequential edge
    expect(Array.from(chunk!.edges)).toEqual([0, 1]);
  });

  it("rejects when vertex_fragments is missing", async () => {
    const kvStoreRead = makeKvStore({
      "vertices/0.0.0/c/0": verticesBlob([0, 0, 0]),
    });
    await expect(
      downloadSkeletonChunk(
        {
          chunkKey: "0.0.0",
          rank: 3,
          linkDtype: "int64",
          attributeNames: [],
          attributeDtypes: [],
          linksConvention: "implicit_sequential",
          geometryKind: "streamline",
          kvStoreRead,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/vertex_fragments is missing/);
  });

  it("zero-fills declared attributes when the per-chunk blob is missing", async () => {
    // Used by the pyramid case: coarser levels often have vertices but
    // no `vertex_attributes/<name>/` arrays at all (the writer's
    // metavertex aggregation skips attribute propagation).  Rather
    // than fail the whole chunk, the reader degrades each missing
    // attribute to zero-filled.
    const kvStoreRead = makeKvStore({
      "vertices/0.0.0/c/0": verticesBlob([0, 0, 0, 1, 0, 0]),
      "vertex_fragments/0.0.0/c/0": singleRangeFragmentBlob(2),
      // intentionally missing vertex_attributes/radius/...
    });
    const chunk = await downloadSkeletonChunk(
      {
        chunkKey: "0.0.0",
        rank: 3,
        linkDtype: "int64",
        attributeNames: ["radius"],
        attributeDtypes: ["float32"],
        linksConvention: "implicit_sequential",
        geometryKind: "polyline",
        kvStoreRead,
      },
      new AbortController().signal,
    );
    expect(chunk).toBeDefined();
    expect(chunk!.vertexAttributes).toHaveLength(1);
    expect(chunk!.vertexAttributes[0]).toBeInstanceOf(Float32Array);
    expect(chunk!.vertexAttributes[0].length).toBe(2); // numVertices
    expect(Array.from(chunk!.vertexAttributes[0] as Float32Array)).toEqual([
      0, 0,
    ]);
  });

  it("widens narrow-int link dtypes to chunk-local Uint32Array", async () => {
    // uint8 link dtype — the widening should preserve indices losslessly.
    const linksBlob = new Uint8Array([0, 1, 1, 2]); // edges (0,1) and (1,2)
    const kvStoreRead = makeKvStore({
      "vertices/0.0.0/c/0": verticesBlob([0, 0, 0, 1, 0, 0, 2, 0, 0]),
      "vertex_fragments/0.0.0/c/0": singleRangeFragmentBlob(3),
      "links/0/0.0.0/c/0": linksBlob,
    });
    const chunk = await downloadSkeletonChunk(
      {
        chunkKey: "0.0.0",
        rank: 3,
        linkDtype: "uint8",
        attributeNames: [],
        attributeDtypes: [],
        linksConvention: "explicit",
        geometryKind: "skeleton",
        kvStoreRead,
      },
      new AbortController().signal,
    );
    expect(chunk!.edges.constructor).toBe(Uint32Array);
    expect(Array.from(chunk!.edges)).toEqual([0, 1, 1, 2]);
  });

  it("rejects attributeNames / attributeDtypes length mismatch", async () => {
    await expect(
      downloadSkeletonChunk(
        {
          chunkKey: "0.0.0",
          rank: 3,
          linkDtype: "int64",
          attributeNames: ["radius", "swc_type"],
          attributeDtypes: ["float32"], // mismatched length
          linksConvention: "implicit_sequential",
          geometryKind: "polyline",
          kvStoreRead: makeKvStore({}),
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/length mismatch/i);
  });
});

describe("downloadSkeletonChunk — link dtype matrix", () => {
  // Round-trip parity check: edges (0,1) and (1,2) written in each dtype
  // should produce identical chunk-local Uint32Array output.
  const cases: Array<{ dtype: LinkDtype; blob: () => Uint8Array }> = [
    { dtype: "uint8", blob: () => new Uint8Array([0, 1, 1, 2]) },
    { dtype: "uint16", blob: () => new Uint8Array(new Uint16Array([0, 1, 1, 2]).buffer) },
    { dtype: "uint32", blob: () => new Uint8Array(new Uint32Array([0, 1, 1, 2]).buffer) },
    { dtype: "int8", blob: () => new Uint8Array(new Int8Array([0, 1, 1, 2]).buffer) },
    { dtype: "int16", blob: () => new Uint8Array(new Int16Array([0, 1, 1, 2]).buffer) },
    { dtype: "int32", blob: () => new Uint8Array(new Int32Array([0, 1, 1, 2]).buffer) },
    {
      dtype: "int64",
      blob: () =>
        new Uint8Array(new BigInt64Array([0n, 1n, 1n, 2n]).buffer),
    },
  ];
  for (const { dtype, blob } of cases) {
    it(`reads edges with linkDtype=${dtype}`, async () => {
      const kvStoreRead = makeKvStore({
        "vertices/0.0.0/c/0": verticesBlob([0, 0, 0, 1, 0, 0, 2, 0, 0]),
        "vertex_fragments/0.0.0/c/0": singleRangeFragmentBlob(3),
        "links/0/0.0.0/c/0": blob(),
      });
      const chunk = await downloadSkeletonChunk(
        {
          chunkKey: "0.0.0",
          rank: 3,
          linkDtype: dtype,
          attributeNames: [],
          attributeDtypes: [],
          linksConvention: "explicit",
          geometryKind: "skeleton",
          kvStoreRead,
        },
        new AbortController().signal,
      );
      expect(Array.from(chunk!.edges)).toEqual([0, 1, 1, 2]);
    });
  }
});
