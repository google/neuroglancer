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
  fetchGhostVertices,
  type GhostVertexRequest,
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

/**
 * Build a ZVFG blob with two contiguous range fragments:
 * fragment 0 = `[0, count0)`, fragment 1 = `[count0, count0 + count1)`.
 */
function twoRangeFragmentsBlob(count0: number, count1: number): Uint8Array {
  // 16 header + 8 bitmap + 2*16 range table + 4 CSR offsets (E=0).
  const buf = new ArrayBuffer(16 + 8 + 32 + 4);
  const view = new DataView(buf);
  view.setUint32(0, FRAGMENT_INDEX_MAGIC, true);
  view.setUint16(4, FRAGMENT_INDEX_VERSION, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, 2, true); // F = 2
  view.setUint32(12, 2, true); // R = 2
  new Uint8Array(buf)[16] = 0x03; // bitmap bits 0 and 1 set
  view.setBigInt64(24, 0n, true); // frag 0 start
  view.setBigInt64(32, BigInt(count0), true); // frag 0 count
  view.setBigInt64(40, BigInt(count0), true); // frag 1 start
  view.setBigInt64(48, BigInt(count1), true); // frag 1 count
  view.setUint32(56, 0, true); // csr_offsets[0] = 0 (E=0)
  return new Uint8Array(buf);
}

/** Pack uint64 per-fragment segment ids into a fragment-attribute blob. */
function uint64SegmentIdBlob(ids: bigint[]): Uint8Array {
  const arr = new BigUint64Array(ids);
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
    // Skeletons synthesise edge-adjacency tangents (prop_tangent()).
    expect(chunk!.tangents).toBeDefined();
    expect(chunk!.tangents!.length).toBe(5 * 3);
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

  /** Reconstruct the per-vertex uint64 ids from the interleaved [lo,hi] column. */
  function segmentIdsAsBigint(segmentIds: Uint32Array): bigint[] {
    const out: bigint[] = [];
    for (let v = 0; v * 2 + 1 < segmentIds.length; ++v) {
      out.push(
        BigInt(segmentIds[v * 2] >>> 0) | (BigInt(segmentIds[v * 2 + 1] >>> 0) << 32n),
      );
    }
    return out;
  }

  it("synthesises a per-vertex FULL uint64 segment column from fragment_attributes/segment_id", async () => {
    // Two fragments: frag 0 owns vertices 0..1, frag 1 owns vertices 2..4.
    // Flywire-scale ids (> 2^32) must survive intact — the high 32 bits are
    // what made the old uint32-truncated colour differ from the flat
    // segmentation.
    const id0 = 720575940612786691n;
    const id1 = 720575940606327461n;
    expect(id0 > 0xffffffffn && id1 > 0xffffffffn).toBe(true); // genuinely uint64
    const kvStoreRead = makeKvStore({
      "vertices/0.0.0/c/0": verticesBlob([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0]),
      "vertex_fragments/0.0.0/c/0": twoRangeFragmentsBlob(2, 3),
      "fragment_attributes/segment_id/0.0.0/c/0": uint64SegmentIdBlob([id0, id1]),
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
    expect(chunk!.segmentIds).toBeDefined();
    expect(chunk!.segmentIds!.length).toBe(5 * 2); // interleaved [lo, hi]
    expect(segmentIdsAsBigint(chunk!.segmentIds!)).toEqual([id0, id0, id1, id1, id1]);
  });

  it("falls back to the fragment's chunk-local index when segment_id is absent", async () => {
    const kvStoreRead = makeKvStore({
      "vertices/0.0.0/c/0": verticesBlob([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0]),
      "vertex_fragments/0.0.0/c/0": twoRangeFragmentsBlob(2, 3),
      // no fragment_attributes/segment_id blob
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
    // Fragment 0 → id 0 for its 2 vertices; fragment 1 → id 1 for its 3.
    expect(segmentIdsAsBigint(chunk!.segmentIds!)).toEqual([0n, 0n, 1n, 1n, 1n]);
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

// ---------------------------------------------------------------------------
// fetchGhostVertices
// ---------------------------------------------------------------------------

function uint16AttrBlob(values: number[]): Uint8Array {
  const arr = new Uint16Array(values);
  return new Uint8Array(arr.buffer);
}

describe("fetchGhostVertices", () => {
  it("returns [] for an empty request list (and does not fetch anything)", async () => {
    let fetchCount = 0;
    const kvStoreRead = async (_path: string) => {
      fetchCount++;
      return undefined;
    };
    const result = await fetchGhostVertices(
      [],
      {
        rank: 3,
        attributeNames: ["fa"],
        attributeDtypes: ["float32"],
        kvStoreRead,
      },
      new AbortController().signal,
    );
    expect(result).toEqual([]);
    expect(fetchCount).toBe(0);
  });

  it("slices one neighbor vertex + attribute into a ghost record", async () => {
    // Neighbor chunk has 3 vertices.  Request vertex index 1.
    const kvStoreRead = makeKvStore({
      "vertices/1.0.0/c/0": verticesBlob([
        10, 20, 30,
        11, 21, 31,
        12, 22, 32,
      ]),
      "vertex_attributes/fa/1.0.0/c/0": new Uint8Array(
        new Float32Array([0.1, 0.5, 0.9]).buffer,
      ),
    });
    const requests: GhostVertexRequest[] = [
      {
        hostLocalVertex: 4,
        neighborChunkKey: "1.0.0",
        neighborLocalVertex: 1,
      },
    ];
    const ghosts = await fetchGhostVertices(
      requests,
      {
        rank: 3,
        attributeNames: ["fa"],
        attributeDtypes: ["float32"],
        kvStoreRead,
      },
      new AbortController().signal,
    );
    expect(ghosts).toHaveLength(1);
    expect(Array.from(ghosts[0].position)).toEqual([11, 21, 31]);
    expect(ghosts[0].attributes).toHaveLength(1);
    expect((ghosts[0].attributes[0] as Float32Array)[0]).toBeCloseTo(0.5);
    expect(ghosts[0].bridgeFromLocalVertex).toBe(4);
  });

  it("groups multiple requests on the same neighbor into one fetch per file", async () => {
    const fetched: string[] = [];
    const kvStoreRead = async (path: string, _s: AbortSignal) => {
      fetched.push(path);
      if (path === "vertices/1.0.0/c/0") {
        return verticesBlob([10, 20, 30, 11, 21, 31, 12, 22, 32]);
      }
      if (path === "vertex_attributes/fa/1.0.0/c/0") {
        return new Uint8Array(new Float32Array([0.1, 0.5, 0.9]).buffer);
      }
      return undefined;
    };
    const requests: GhostVertexRequest[] = [
      { hostLocalVertex: 0, neighborChunkKey: "1.0.0", neighborLocalVertex: 0 },
      { hostLocalVertex: 1, neighborChunkKey: "1.0.0", neighborLocalVertex: 1 },
      { hostLocalVertex: 2, neighborChunkKey: "1.0.0", neighborLocalVertex: 2 },
    ];
    const ghosts = await fetchGhostVertices(
      requests,
      {
        rank: 3,
        attributeNames: ["fa"],
        attributeDtypes: ["float32"],
        kvStoreRead,
      },
      new AbortController().signal,
    );
    expect(ghosts).toHaveLength(3);
    // Exactly one fetch per file (positions + 1 attribute = 2 unique paths).
    expect(fetched.filter((p) => p === "vertices/1.0.0/c/0")).toHaveLength(1);
    expect(
      fetched.filter((p) => p === "vertex_attributes/fa/1.0.0/c/0"),
    ).toHaveLength(1);
    expect(Array.from(ghosts[0].position)).toEqual([10, 20, 30]);
    expect(Array.from(ghosts[2].position)).toEqual([12, 22, 32]);
  });

  it("drops requests whose neighbor chunk file is absent (sparse / missing)", async () => {
    const kvStoreRead = makeKvStore({});
    const requests: GhostVertexRequest[] = [
      { hostLocalVertex: 0, neighborChunkKey: "1.0.0", neighborLocalVertex: 0 },
    ];
    const ghosts = await fetchGhostVertices(
      requests,
      {
        rank: 3,
        attributeNames: ["fa"],
        attributeDtypes: ["float32"],
        kvStoreRead,
      },
      new AbortController().signal,
    );
    expect(ghosts).toEqual([]);
  });

  it("drops requests whose neighbor vertex index is out of range", async () => {
    const kvStoreRead = makeKvStore({
      // Only 2 vertices' worth of bytes — index 5 is out of range.
      "vertices/1.0.0/c/0": verticesBlob([0, 0, 0, 1, 1, 1]),
    });
    const requests: GhostVertexRequest[] = [
      { hostLocalVertex: 0, neighborChunkKey: "1.0.0", neighborLocalVertex: 5 },
    ];
    const ghosts = await fetchGhostVertices(
      requests,
      {
        rank: 3,
        attributeNames: [],
        attributeDtypes: [],
        kvStoreRead,
      },
      new AbortController().signal,
    );
    expect(ghosts).toEqual([]);
  });

  it("zero-fills missing neighbor attributes (pyramid-level case)", async () => {
    const kvStoreRead = makeKvStore({
      "vertices/1.0.0/c/0": verticesBlob([5, 6, 7]),
      // Intentionally NO vertex_attributes/fa/...
    });
    const requests: GhostVertexRequest[] = [
      { hostLocalVertex: 0, neighborChunkKey: "1.0.0", neighborLocalVertex: 0 },
    ];
    const ghosts = await fetchGhostVertices(
      requests,
      {
        rank: 3,
        attributeNames: ["fa"],
        attributeDtypes: ["float32"],
        kvStoreRead,
      },
      new AbortController().signal,
    );
    expect(ghosts).toHaveLength(1);
    expect((ghosts[0].attributes[0] as Float32Array)[0]).toBe(0);
  });

  it("handles uint16-dtype attributes (mixed dtype slicing)", async () => {
    const kvStoreRead = makeKvStore({
      "vertices/1.0.0/c/0": verticesBlob([0, 0, 0, 1, 1, 1]),
      "vertex_attributes/swc_type/1.0.0/c/0": uint16AttrBlob([3, 7]),
    });
    const requests: GhostVertexRequest[] = [
      { hostLocalVertex: 0, neighborChunkKey: "1.0.0", neighborLocalVertex: 1 },
    ];
    const ghosts = await fetchGhostVertices(
      requests,
      {
        rank: 3,
        attributeNames: ["swc_type"],
        attributeDtypes: ["uint16"],
        kvStoreRead,
      },
      new AbortController().signal,
    );
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].attributes[0]).toBeInstanceOf(Uint16Array);
    expect((ghosts[0].attributes[0] as Uint16Array)[0]).toBe(7);
  });

  it("handles multiple neighbors (parallel fetches, results ordered by request)", async () => {
    const kvStoreRead = makeKvStore({
      "vertices/0.0.0/c/0": verticesBlob([1, 2, 3]),
      "vertices/1.0.0/c/0": verticesBlob([4, 5, 6]),
    });
    const requests: GhostVertexRequest[] = [
      { hostLocalVertex: 10, neighborChunkKey: "1.0.0", neighborLocalVertex: 0 },
      { hostLocalVertex: 20, neighborChunkKey: "0.0.0", neighborLocalVertex: 0 },
    ];
    const ghosts = await fetchGhostVertices(
      requests,
      {
        rank: 3,
        attributeNames: [],
        attributeDtypes: [],
        kvStoreRead,
      },
      new AbortController().signal,
    );
    expect(ghosts).toHaveLength(2);
    // Output order matches request order.
    expect(Array.from(ghosts[0].position)).toEqual([4, 5, 6]);
    expect(ghosts[0].bridgeFromLocalVertex).toBe(10);
    expect(Array.from(ghosts[1].position)).toEqual([1, 2, 3]);
    expect(ghosts[1].bridgeFromLocalVertex).toBe(20);
  });
});
