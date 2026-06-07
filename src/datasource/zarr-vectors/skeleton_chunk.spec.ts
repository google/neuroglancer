/**
 * @license
 * Copyright 2026 Allen Institute for Brain Science
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { describe, expect, it } from "vitest";
import { FragmentIndex } from "#src/datasource/zarr-vectors/fragment_index.js";
import {
  appendGhostVertices,
  appendIntraChunkEdges,
  buildSkeletonChunk,
  computeTangents,
  computeTangentsFromEdges,
  mergeEdges,
  recomputeTangentsForBridges,
  synthesizeSequentialEdges,
} from "#src/datasource/zarr-vectors/skeleton_chunk.js";

/**
 * Build a `FragmentIndex` directly from a list of fragments — used to
 * shape unit-test inputs without going through the byte-layout encoder.
 * Each entry is either `{range: {start, count}}` or
 * `{explicit: [indices...]}`.
 */
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

describe("synthesizeSequentialEdges", () => {
  it("returns no edges for an empty fragment index", () => {
    const fi = buildFragmentIndex([]);
    const edges = synthesizeSequentialEdges(fi);
    expect(edges.length).toBe(0);
  });

  it("returns no edges for singleton fragments", () => {
    const fi = buildFragmentIndex([
      { range: { start: 0, count: 1 } },
      { range: { start: 5, count: 1 } },
      { explicit: [9] },
    ]);
    expect(synthesizeSequentialEdges(fi).length).toBe(0);
  });

  it("emits N-1 sequential edges for a single range fragment", () => {
    // Range [3, 7) → edges (3,4), (4,5), (5,6)
    const fi = buildFragmentIndex([{ range: { start: 3, count: 4 } }]);
    const edges = Array.from(synthesizeSequentialEdges(fi));
    expect(edges).toEqual([3, 4, 4, 5, 5, 6]);
  });

  it("does not cross fragment boundaries", () => {
    // Two adjacent range fragments [0..3) and [3..6) — must NOT emit
    // an edge (2, 3) across the boundary.
    const fi = buildFragmentIndex([
      { range: { start: 0, count: 3 } },
      { range: { start: 3, count: 3 } },
    ]);
    const edges = Array.from(synthesizeSequentialEdges(fi));
    expect(edges).toEqual([
      0, 1, 1, 2, // first fragment
      3, 4, 4, 5, // second fragment, NO (2,3) bridge
    ]);
  });

  it("emits edges in walk order for explicit fragments", () => {
    // Explicit fragment [12, 7, 19] → edges (12,7) and (7,19).
    const fi = buildFragmentIndex([{ explicit: [12, 7, 19] }]);
    const edges = Array.from(synthesizeSequentialEdges(fi));
    expect(edges).toEqual([12, 7, 7, 19]);
  });

  it("handles mixed range + explicit fragments", () => {
    const fi = buildFragmentIndex([
      { range: { start: 0, count: 3 } }, // (0,1) (1,2)
      { explicit: [9, 8, 7] }, // (9,8) (8,7)
      { range: { start: 20, count: 2 } }, // (20,21)
    ]);
    const edges = Array.from(synthesizeSequentialEdges(fi));
    expect(edges).toEqual([0, 1, 1, 2, 9, 8, 8, 7, 20, 21]);
  });
});

describe("mergeEdges", () => {
  it("concatenates flat edge arrays in order", () => {
    const a = new Uint32Array([0, 1, 2, 3]);
    const b = new Uint32Array([10, 11]);
    expect(Array.from(mergeEdges(a, b))).toEqual([0, 1, 2, 3, 10, 11]);
  });
  it("returns an empty array when no inputs", () => {
    expect(mergeEdges().length).toBe(0);
  });
});

describe("computeTangents", () => {
  it("rejects unsupported rank", () => {
    const fi = buildFragmentIndex([{ range: { start: 0, count: 2 } }]);
    expect(() => computeTangents(new Float32Array(8), 4, fi)).toThrow(/rank/i);
  });

  it("rejects positions that aren't a multiple of rank", () => {
    const fi = buildFragmentIndex([{ range: { start: 0, count: 2 } }]);
    // 7 floats / rank 3 → not integer
    expect(() => computeTangents(new Float32Array(7), 3, fi)).toThrow(
      /multiple of rank/i,
    );
  });

  it("gives a zero tangent for a singleton fragment", () => {
    // Single vertex — no neighbour to point at.
    const fi = buildFragmentIndex([{ range: { start: 0, count: 1 } }]);
    const t = computeTangents(new Float32Array([5, 5, 5]), 3, fi);
    expect(Array.from(t)).toEqual([0, 0, 0]);
  });

  it("returns a constant tangent along a straight-line streamline", () => {
    // 5 vertices marching +X by 1 each step.  All tangents should be (1, 0, 0).
    const positions = new Float32Array([
      0, 0, 0,
      1, 0, 0,
      2, 0, 0,
      3, 0, 0,
      4, 0, 0,
    ]);
    const fi = buildFragmentIndex([{ range: { start: 0, count: 5 } }]);
    const t = computeTangents(positions, 3, fi);
    for (let i = 0; i < 5; ++i) {
      expect(t[i * 3]).toBeCloseTo(1, 6);
      expect(t[i * 3 + 1]).toBeCloseTo(0, 6);
      expect(t[i * 3 + 2]).toBeCloseTo(0, 6);
    }
  });

  it("returns axis-aligned tangents for three orthogonal streamlines", () => {
    // 6 vertices: a +X line, then a +Y line, then a +Z line — each a
    // separate fragment.  Tangents should be axis-aligned and never
    // cross fragment boundaries.
    const positions = new Float32Array([
      // +X fragment, vertices 0..1
      0, 0, 0,
      1, 0, 0,
      // +Y fragment, vertices 2..3
      0, 0, 0,
      0, 1, 0,
      // +Z fragment, vertices 4..5
      0, 0, 0,
      0, 0, 1,
    ]);
    const fi = buildFragmentIndex([
      { range: { start: 0, count: 2 } },
      { range: { start: 2, count: 2 } },
      { range: { start: 4, count: 2 } },
    ]);
    const t = computeTangents(positions, 3, fi);
    // Vertex 0 and 1 should be +X
    expect(t[0]).toBeCloseTo(1, 6);
    expect(t[3]).toBeCloseTo(1, 6);
    // Vertex 2 and 3 should be +Y
    expect(t[2 * 3 + 1]).toBeCloseTo(1, 6);
    expect(t[3 * 3 + 1]).toBeCloseTo(1, 6);
    // Vertex 4 and 5 should be +Z
    expect(t[4 * 3 + 2]).toBeCloseTo(1, 6);
    expect(t[5 * 3 + 2]).toBeCloseTo(1, 6);
    // None of the X tangents should leak into the Y fragment, etc.
    expect(t[2 * 3]).toBeCloseTo(0, 6);
    expect(t[4 * 3]).toBeCloseTo(0, 6);
    expect(t[4 * 3 + 1]).toBeCloseTo(0, 6);
  });

  it("uses central differences for interior vertices and forward/backward for endpoints", () => {
    // 3 vertices on a curve: (0,0,0), (1,1,0), (2,0,0).  The midpoint
    // tangent uses central difference = ((2,0,0) - (0,0,0))/|...| =
    // (1, 0, 0) normalised → (1, 0, 0).  Endpoint tangents use the
    // single-step direction.
    const positions = new Float32Array([0, 0, 0, 1, 1, 0, 2, 0, 0]);
    const fi = buildFragmentIndex([{ range: { start: 0, count: 3 } }]);
    const t = computeTangents(positions, 3, fi);
    // Endpoint at v0: direction (1,1,0) normalised = (1,1,0)/sqrt(2)
    const inv2 = 1 / Math.sqrt(2);
    expect(t[0]).toBeCloseTo(inv2, 6);
    expect(t[1]).toBeCloseTo(inv2, 6);
    expect(t[2]).toBeCloseTo(0, 6);
    // Midpoint v1: central diff = (2,0,0) - (0,0,0) → (1,0,0)
    expect(t[3]).toBeCloseTo(1, 6);
    expect(t[4]).toBeCloseTo(0, 6);
    expect(t[5]).toBeCloseTo(0, 6);
    // Endpoint v2: direction (1,-1,0) normalised
    expect(t[6]).toBeCloseTo(inv2, 6);
    expect(t[7]).toBeCloseTo(-inv2, 6);
    expect(t[8]).toBeCloseTo(0, 6);
  });

  it("handles rank-2 input by zero-padding the Z component", () => {
    // 2D streamline marching +X.
    const positions = new Float32Array([0, 0, 1, 0, 2, 0]);
    const fi = buildFragmentIndex([{ range: { start: 0, count: 3 } }]);
    const t = computeTangents(positions, 2, fi);
    expect(t.length).toBe(9); // numVertices * 3 even for rank-2
    expect(t[0]).toBeCloseTo(1, 6);
    expect(t[1]).toBeCloseTo(0, 6);
    expect(t[2]).toBe(0); // Z is always 0 for rank-2
  });

  it("respects fragment boundaries in an explicit fragment", () => {
    // 4 vertices laid out (0,0,0), (1,0,0), (10,0,0), (11,0,0).
    // Two range fragments [0..2) and [2..4) — adjacent vertices 1 and 2
    // are spatially distant but in different fragments, so the tangent
    // at vertex 1 must use vertex 0 as the back-neighbour, NOT vertex 2.
    const positions = new Float32Array([
      0, 0, 0,
      1, 0, 0,
      10, 0, 0,
      11, 0, 0,
    ]);
    const fi = buildFragmentIndex([
      { range: { start: 0, count: 2 } },
      { range: { start: 2, count: 2 } },
    ]);
    const t = computeTangents(positions, 3, fi);
    // All tangents should be (1, 0, 0) regardless of the 8-unit gap.
    for (let i = 0; i < 4; ++i) {
      expect(t[i * 3]).toBeCloseTo(1, 6);
      expect(t[i * 3 + 1]).toBeCloseTo(0, 6);
      expect(t[i * 3 + 2]).toBeCloseTo(0, 6);
    }
  });
});

describe("computeTangentsFromEdges", () => {
  it("gives +X tangent on a 5-vertex chain in +x", () => {
    // Chain 0—1—2—3—4 along x; edges in walk order.
    const positions = new Float32Array(15);
    for (let i = 0; i < 5; ++i) positions[i * 3] = i;
    const edges = new Uint32Array([0, 1, 1, 2, 2, 3, 3, 4]);
    const tangents = computeTangentsFromEdges(positions, 3, edges, 5);
    // Endpoints (degree-1): direction to lone neighbour — magnitude 1
    // along +x for vertex 0 (toward 1), and +x for vertex 4 (away from 3).
    for (let i = 0; i < 5; ++i) {
      expect(Math.abs(tangents[i * 3])).toBeCloseTo(1, 6);
      expect(tangents[i * 3 + 1]).toBeCloseTo(0, 6);
      expect(tangents[i * 3 + 2]).toBeCloseTo(0, 6);
    }
  });

  it("matches polyline computeTangents on a degree-2 chain (regression)", () => {
    // Bend in xy plane: (0,0,0) → (1,0,0) → (1,1,0).
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]);
    const edges = new Uint32Array([0, 1, 1, 2]);
    const edgeTangents = computeTangentsFromEdges(positions, 3, edges, 3);
    // Interior vertex (1): central-diff of (0,0,0) → (1,1,0) ≈ (.707, .707, 0).
    expect(edgeTangents[3]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(edgeTangents[4]).toBeCloseTo(Math.SQRT1_2, 6);
    // Endpoints: degree-1 → unit vector toward / from neighbour.
    expect(Math.abs(edgeTangents[0])).toBeCloseTo(1, 6);
    expect(Math.abs(edgeTangents[7])).toBeCloseTo(1, 6);
  });

  it("Y-junction picks central-diff of first two neighbours at the branch", () => {
    // Vertices: center=0 at origin, arms 1=+x, 2=+y, 3=+z.
    const positions = new Float32Array([
      0, 0, 0, // 0 (branch)
      1, 0, 0, // 1
      0, 1, 0, // 2
      0, 0, 1, // 3
    ]);
    // First two neighbours of vertex 0 are 1 (+x) and 2 (+y).
    const edges = new Uint32Array([0, 1, 0, 2, 0, 3]);
    const tangents = computeTangentsFromEdges(positions, 3, edges, 4);
    // Branch vertex: tangent = normalise((+y) - (+x)) = (-1/√2, 1/√2, 0).
    expect(tangents[0]).toBeCloseTo(-Math.SQRT1_2, 6);
    expect(tangents[1]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(tangents[2]).toBeCloseTo(0, 6);
  });

  it("isolated vertex (degree 0) gets zero tangent", () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    // Only an edge between 1 and 2 — vertex 0 is isolated.
    const edges = new Uint32Array([1, 2]);
    const tangents = computeTangentsFromEdges(positions, 3, edges, 3);
    expect(tangents[0]).toBe(0);
    expect(tangents[1]).toBe(0);
    expect(tangents[2]).toBe(0);
    // Vertex 1 and 2 (degree-1) point along +x.
    expect(Math.abs(tangents[3])).toBeCloseTo(1, 6);
    expect(Math.abs(tangents[6])).toBeCloseTo(1, 6);
  });

  it("self-loop edge is ignored", () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0]);
    const edges = new Uint32Array([0, 0, 0, 1]);
    const tangents = computeTangentsFromEdges(positions, 3, edges, 2);
    expect(Math.abs(tangents[0])).toBeCloseTo(1, 6);
    expect(Math.abs(tangents[3])).toBeCloseTo(1, 6);
  });

  it("rank 2 input yields zero z-component", () => {
    const positions = new Float32Array([0, 0, 1, 0, 2, 0]);
    const edges = new Uint32Array([0, 1, 1, 2]);
    const tangents = computeTangentsFromEdges(positions, 2, edges, 3);
    expect(tangents.length).toBe(9);
    for (let i = 0; i < 3; ++i) {
      expect(tangents[i * 3 + 2]).toBe(0);
    }
  });

  it("rejects odd-length edges array", () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0]);
    expect(() =>
      computeTangentsFromEdges(positions, 3, new Uint32Array([0, 1, 0]), 2),
    ).toThrow(/multiple of 2/);
  });
});

describe("buildSkeletonChunk", () => {
  it("produces a streamline chunk with tangents and sequential edges", () => {
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
    expect(chunk.numVertices).toBe(3);
    expect(chunk.numEdges).toBe(2);
    expect(Array.from(chunk.edges)).toEqual([0, 1, 1, 2]);
    expect(chunk.tangents).toBeDefined();
    // Every tangent should be +X for this straight line.
    for (let i = 0; i < 3; ++i) {
      expect(chunk.tangents![i * 3]).toBeCloseTo(1, 6);
    }
  });

  it("produces a skeleton chunk with both implicit + explicit edges and edge-adjacency tangents", () => {
    // 5 vertices, one fragment, three implicit edges (0,1),(1,2),(2,3),
    // (3,4), plus one explicit branch (1,4) — total 5 edges.
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
    expect(chunk.numEdges).toBe(5);
    expect(Array.from(chunk.edges)).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 1, 4]);
    // Skeletons now synthesise edge-adjacency tangents (prop_tangent()).
    expect(chunk.tangents).toBeDefined();
    expect(chunk.tangents!.length).toBe(5 * 3);
  });

  it("produces an explicit-only chunk with no implicit edges", () => {
    const positions = new Float32Array(9);
    const fi = buildFragmentIndex([{ range: { start: 0, count: 3 } }]);
    const chunk = buildSkeletonChunk({
      rank: 3,
      positions,
      fragmentIndex: fi,
      explicitEdges: new Uint32Array([0, 2, 1, 2]),
      linksConvention: "explicit",
      geometryKind: "skeleton",
      vertexAttributes: [],
    });
    expect(chunk.numEdges).toBe(2);
    expect(Array.from(chunk.edges)).toEqual([0, 2, 1, 2]);
  });

  it("produces a graph chunk with explicit edges and edge-adjacency tangents", () => {
    // 4 vertices on a Y junction: center=0 at origin, arms 1=+x, 2=+y, 3=+z.
    const positions = new Float32Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ]);
    const fi = buildFragmentIndex([{ range: { start: 0, count: 4 } }]);
    const chunk = buildSkeletonChunk({
      rank: 3,
      positions,
      fragmentIndex: fi,
      explicitEdges: new Uint32Array([0, 1, 0, 2, 0, 3]),
      linksConvention: "explicit",
      geometryKind: "graph",
      vertexAttributes: [],
    });
    expect(chunk.numEdges).toBe(3);
    expect(Array.from(chunk.edges)).toEqual([0, 1, 0, 2, 0, 3]);
    // Graphs DO get tangents now (edge-adjacency algorithm).
    expect(chunk.tangents).toBeDefined();
    // Branch vertex: central-diff of first two neighbours (1, 2) →
    // normalise((+y) - (+x)) = (-1/√2, 1/√2, 0).
    expect(chunk.tangents![0]).toBeCloseTo(-Math.SQRT1_2, 6);
    expect(chunk.tangents![1]).toBeCloseTo(Math.SQRT1_2, 6);
    // Endpoint (degree-1) toward / from lone neighbour — unit-length.
    const norm = Math.sqrt(
      chunk.tangents![3] ** 2 +
        chunk.tangents![4] ** 2 +
        chunk.tangents![5] ** 2,
    );
    expect(norm).toBeCloseTo(1, 6);
  });

  it("rejects implicit_sequential + explicit edges (writer bug)", () => {
    const positions = new Float32Array(9);
    const fi = buildFragmentIndex([{ range: { start: 0, count: 3 } }]);
    expect(() =>
      buildSkeletonChunk({
        rank: 3,
        positions,
        fragmentIndex: fi,
        explicitEdges: new Uint32Array([0, 2]),
        linksConvention: "implicit_sequential",
        geometryKind: "streamline",
        vertexAttributes: [],
      }),
    ).toThrow(/implicit_sequential.*explicit/i);
  });

  it("rejects explicit_links_convention without explicit edges", () => {
    const positions = new Float32Array(9);
    const fi = buildFragmentIndex([{ range: { start: 0, count: 3 } }]);
    expect(() =>
      buildSkeletonChunk({
        rank: 3,
        positions,
        fragmentIndex: fi,
        linksConvention: "explicit",
        geometryKind: "skeleton",
        vertexAttributes: [],
      }),
    ).toThrow(/explicit.*explicitEdges/i);
  });

  it("carries vertex attributes through verbatim", () => {
    const positions = new Float32Array(6);
    const fi = buildFragmentIndex([{ range: { start: 0, count: 2 } }]);
    const radius = new Float32Array([0.5, 0.7]);
    const swcType = new Int32Array([1, 3]);
    const chunk = buildSkeletonChunk({
      rank: 3,
      positions,
      fragmentIndex: fi,
      linksConvention: "implicit_sequential",
      geometryKind: "polyline",
      vertexAttributes: [radius, swcType],
    });
    expect(chunk.vertexAttributes.length).toBe(2);
    expect(chunk.vertexAttributes[0]).toBe(radius);
    expect(chunk.vertexAttributes[1]).toBe(swcType);
  });
});

// ---------------------------------------------------------------------------
// recomputeTangentsForBridges
// ---------------------------------------------------------------------------

describe("recomputeTangentsForBridges", () => {
  function coarseChunk(positions: number[]): ReturnType<typeof buildSkeletonChunk> {
    // Coarser-pyramid-level layout: one metavertex per fragment.
    // computeTangents will assign zero tangents to all of them.
    const n = positions.length / 3;
    const fragments = Array.from({ length: n }, (_, i) => ({
      range: { start: i, count: 1 },
    }));
    return buildSkeletonChunk({
      rank: 3,
      positions: new Float32Array(positions),
      fragmentIndex: buildFragmentIndex(fragments),
      linksConvention: "implicit_sequential",
      geometryKind: "streamline",
      vertexAttributes: [Float32Array.from(Array(n).fill(0))],
    });
  }

  it("derives central-difference tangents from a chain of bridges", () => {
    // Three metavertices on a straight +X line: (0,0,0), (1,0,0), (2,0,0).
    // Bridges: 0→1 (predecessor=0, successor=1) and 1→2.
    const chunk = coarseChunk([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    // All initial tangents are zero (single-vertex fragments).
    expect(Array.from(chunk.tangents!)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const result = recomputeTangentsForBridges(chunk, [
      { predecessorLocalIdx: 0, successorLocalIdx: 1 },
      { predecessorLocalIdx: 1, successorLocalIdx: 2 },
    ]);
    // Endpoint 0: only one incident bridge contributing +X.  Normalised = (1,0,0).
    expect(Array.from(result.tangents!.slice(0, 3))).toEqual([1, 0, 0]);
    // Endpoint 2: only one incident bridge contributing +X.
    expect(Array.from(result.tangents!.slice(6, 9))).toEqual([1, 0, 0]);
    // Interior 1: TWO incident bridges (from 0→1 and 1→2), each +X.
    // Accumulator = (2,0,0), normalised = (1,0,0).
    expect(Array.from(result.tangents!.slice(3, 6))).toEqual([1, 0, 0]);
  });

  it("leaves un-bridged vertices' tangents untouched", () => {
    // Three vertices; only bridge (0→1).  Vertex 2 has no bridge.
    const chunk = coarseChunk([0, 0, 0, 1, 0, 0, 5, 5, 5]);
    const result = recomputeTangentsForBridges(chunk, [
      { predecessorLocalIdx: 0, successorLocalIdx: 1 },
    ]);
    expect(Array.from(result.tangents!.slice(0, 3))).toEqual([1, 0, 0]);
    expect(Array.from(result.tangents!.slice(3, 6))).toEqual([1, 0, 0]);
    // Vertex 2 stays at the original zero tangent.
    expect(Array.from(result.tangents!.slice(6, 9))).toEqual([0, 0, 0]);
  });

  it("returns input unchanged for empty bridge list", () => {
    const chunk = coarseChunk([0, 0, 0, 1, 0, 0]);
    const result = recomputeTangentsForBridges(chunk, []);
    expect(result).toBe(chunk);
  });

  it("returns input unchanged for skeleton geometry (no walk-order bridge fixup)", () => {
    const chunk = buildSkeletonChunk({
      rank: 3,
      positions: new Float32Array([0, 0, 0, 1, 0, 0]),
      fragmentIndex: buildFragmentIndex([
        { range: { start: 0, count: 1 } },
        { range: { start: 1, count: 1 } },
      ]),
      linksConvention: "implicit_sequential_with_branches",
      geometryKind: "skeleton",
      vertexAttributes: [Uint32Array.from([0, 0])],
    });
    // Skeletons now carry edge-adjacency tangents (here both vertices are
    // isolated → zero tangents); bridge recompute sets the bridge-pair
    // tangent to the connecting direction (0→1 = +x).
    expect(chunk.tangents).toBeDefined();
    const result = recomputeTangentsForBridges(chunk, [
      { predecessorLocalIdx: 0, successorLocalIdx: 1 },
    ]);
    expect(result.tangents).toBeDefined();
    expect(result.tangents!.length).toBe(2 * 3);
    expect(result.tangents![0]).toBeCloseTo(1);
  });

  it("handles diagonal bridges (non-axis-aligned tangents)", () => {
    // Two metavertices at (0,0,0) and (1,1,1).  Bridge direction is
    // normalize(1,1,1) = (1,1,1)/sqrt(3).
    const chunk = coarseChunk([0, 0, 0, 1, 1, 1]);
    const result = recomputeTangentsForBridges(chunk, [
      { predecessorLocalIdx: 0, successorLocalIdx: 1 },
    ]);
    const expected = 1 / Math.sqrt(3);
    expect(result.tangents![0]).toBeCloseTo(expected);
    expect(result.tangents![1]).toBeCloseTo(expected);
    expect(result.tangents![2]).toBeCloseTo(expected);
    expect(result.tangents![3]).toBeCloseTo(expected);
  });

  it("skips bridge records with out-of-range endpoints", () => {
    const chunk = coarseChunk([0, 0, 0, 1, 0, 0]);
    const result = recomputeTangentsForBridges(chunk, [
      { predecessorLocalIdx: 0, successorLocalIdx: 99 }, // out of range
      { predecessorLocalIdx: 0, successorLocalIdx: 1 },
    ]);
    // The valid record (0→1) gives both vertices tangent +X; the
    // out-of-range record is silently dropped.
    expect(Array.from(result.tangents!.slice(0, 3))).toEqual([1, 0, 0]);
    expect(Array.from(result.tangents!.slice(3, 6))).toEqual([1, 0, 0]);
  });

  it("keeps tangent at zero when incident bridges cancel (symmetric P+S)", () => {
    // Three metavertices at (-1,0,0), (0,0,0), (1,0,0).  Vertex 1 has
    // a predecessor 0 (step +X) AND a successor 2 (step +X).  Both
    // contribute (1,0,0).  Accumulator = (2,0,0).  Normalises to
    // (1,0,0), NOT zero.  But if we had a STAR pattern with two
    // opposite neighbors, cancellation would occur.
    //
    // For this test, construct the cancellation case: vertex 0 is the
    // predecessor of vertex 1 with step (+1,0,0), and ALSO the
    // successor of vertex 1 (in another bridge) with step (-1,0,0).
    // Both bridges contribute opposite steps; accumulator sums to 0.
    const chunk = coarseChunk([0, 0, 0, 1, 0, 0]);
    const result = recomputeTangentsForBridges(chunk, [
      { predecessorLocalIdx: 0, successorLocalIdx: 1 }, // step +X
      { predecessorLocalIdx: 1, successorLocalIdx: 0 }, // step -X
    ]);
    // Both vertices' accumulators cancel.  Tangent stays at original
    // (zero) value.
    expect(Array.from(result.tangents!.slice(0, 3))).toEqual([0, 0, 0]);
    expect(Array.from(result.tangents!.slice(3, 6))).toEqual([0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// appendIntraChunkEdges
// ---------------------------------------------------------------------------

describe("appendIntraChunkEdges", () => {
  function streamline2(): ReturnType<typeof buildSkeletonChunk> {
    return buildSkeletonChunk({
      rank: 3,
      positions: new Float32Array([0, 0, 0, 1, 0, 0]),
      fragmentIndex: buildFragmentIndex([
        { range: { start: 0, count: 1 } },
        { range: { start: 1, count: 1 } },
      ]),
      linksConvention: "implicit_sequential",
      geometryKind: "streamline",
      vertexAttributes: [Float32Array.from([0.1, 0.5])],
    });
  }

  it("appends one extra edge between two existing vertices", () => {
    // Two 1-vertex fragments → 0 implicit edges.  Add an explicit
    // intra-chunk edge connecting them.
    const chunk = streamline2();
    expect(chunk.numEdges).toBe(0);
    const result = appendIntraChunkEdges(chunk, Uint32Array.from([0, 1]));
    expect(result.numEdges).toBe(1);
    expect(Array.from(result.edges)).toEqual([0, 1]);
    // Vertex texture unchanged.
    expect(result.positions).toBe(chunk.positions);
    expect(result.vertexAttributes).toBe(chunk.vertexAttributes);
  });

  it("appends multiple extra edges, preserving original edges", () => {
    const chunk = buildSkeletonChunk({
      rank: 3,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]),
      fragmentIndex: buildFragmentIndex([{ range: { start: 0, count: 3 } }]),
      linksConvention: "implicit_sequential",
      geometryKind: "streamline",
      vertexAttributes: [Float32Array.from([0, 0, 0])],
    });
    // Original chunk has 2 implicit edges: (0,1), (1,2).
    expect(chunk.numEdges).toBe(2);
    // Add 2 explicit intra-chunk edges: (0,2), (2,0) — meaningless but
    // tests the appending logic.
    const result = appendIntraChunkEdges(chunk, Uint32Array.from([0, 2, 2, 0]));
    expect(result.numEdges).toBe(4);
    expect(Array.from(result.edges)).toEqual([0, 1, 1, 2, 0, 2, 2, 0]);
  });

  it("returns the input unchanged for an empty edge list", () => {
    const chunk = streamline2();
    const result = appendIntraChunkEdges(chunk, new Uint32Array(0));
    expect(result).toBe(chunk);
  });

  it("throws when extra edges length is odd", () => {
    const chunk = streamline2();
    expect(() =>
      appendIntraChunkEdges(chunk, Uint32Array.from([0, 1, 0])),
    ).toThrow(/not a multiple of 2/);
  });

  it("throws when an endpoint index is out of range", () => {
    const chunk = streamline2();
    expect(() =>
      appendIntraChunkEdges(chunk, Uint32Array.from([0, 99])),
    ).toThrow(/out of/);
  });
});

// ---------------------------------------------------------------------------
// appendGhostVertices
// ---------------------------------------------------------------------------

describe("appendGhostVertices", () => {
  function streamlineChunk(numVerts: number): ReturnType<typeof buildSkeletonChunk> {
    const positions = new Float32Array(numVerts * 3);
    for (let i = 0; i < numVerts; ++i) {
      positions[i * 3] = i;
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = 0;
    }
    return buildSkeletonChunk({
      rank: 3,
      positions,
      fragmentIndex: buildFragmentIndex([{ range: { start: 0, count: numVerts } }]),
      linksConvention: "implicit_sequential",
      geometryKind: "streamline",
      vertexAttributes: [Float32Array.from({ length: numVerts }, (_, i) => i + 1)],
    });
  }

  it("returns the input unchanged when ghosts is empty", () => {
    const chunk = streamlineChunk(3);
    const result = appendGhostVertices(chunk, []);
    expect(result).toBe(chunk);
  });

  it("appends one ghost: positions, edges, attributes, and bridge-direction tangent", () => {
    const chunk = streamlineChunk(3);
    // Host: 3 vertices at (0,0,0), (1,0,0), (2,0,0).  Ghost neighbor at
    // (3, 0, 0) — directly in front of the host's last vertex.
    const result = appendGhostVertices(chunk, [
      {
        position: Float32Array.from([3, 0, 0]),
        attributes: [Float32Array.from([99])],
        bridgeFromLocalVertex: 2,
        isGhostPredecessor: false, // successor — typical X-side
      },
    ]);
    expect(result.numVertices).toBe(4);
    expect(Array.from(result.positions)).toEqual([
      0, 0, 0, // host vert 0
      1, 0, 0, // host vert 1
      2, 0, 0, // host vert 2
      3, 0, 0, // ghost
    ]);
    expect(result.numEdges).toBe(3); // 2 intra-fragment + 1 bridge
    // Bridge edge appended at the end: (host vert 2, ghost vert 3).
    expect(Array.from(result.edges.slice(-2))).toEqual([2, 3]);
    // Attribute extended.
    expect(result.vertexAttributes).toHaveLength(1);
    expect(Array.from(result.vertexAttributes[0] as Float32Array)).toEqual([
      1, 2, 3, 99,
    ]);
    // Ghost tangent = normalize((3,0,0) - (2,0,0)) = (1, 0, 0).
    expect(result.tangents).toBeDefined();
    expect(Array.from(result.tangents!.slice(-3))).toEqual([1, 0, 0]);
  });

  it("flips ghost tangent when isGhostPredecessor=true (Y-side of a bridge)", () => {
    // Y-side of a chunk crossing: the host is fragment_B's first vertex
    // (w_0), the ghost is fragment_A's last vertex (sitting BEFORE the
    // host in walk order).  We want the ghost's tangent to point in the
    // FORWARD walk direction = host - ghost.
    //
    // Use a host fragment whose own tangent at v_0 points along +X (so
    // the bug would show as ghost.tangent ≈ -1,0,0 — opposite to host
    // — and interpolated tangent ≈ 0 at the midpoint).
    const chunk = streamlineChunk(3); // verts at (0,0,0),(1,0,0),(2,0,0)
    const result = appendGhostVertices(chunk, [
      {
        // Ghost at world (-1,0,0): sits BEFORE the host (vert 0 at origin)
        // along the +X walk direction.
        position: Float32Array.from([-1, 0, 0]),
        attributes: [Float32Array.from([0])],
        bridgeFromLocalVertex: 0,
        isGhostPredecessor: true,
      },
    ]);
    // Ghost tangent should be +X (host - ghost = (0,0,0) - (-1,0,0) =
    // (1,0,0)), NOT -X.  Bug would have set this to (-1,0,0).
    const ghostT = result.tangents!.slice(-3);
    expect(ghostT[0]).toBeCloseTo(1);
    expect(ghostT[1]).toBeCloseTo(0);
    expect(ghostT[2]).toBeCloseTo(0);
    // Host vertex 0's tangent is unchanged — should also be +X (forward
    // step direction inside the fragment).  Both tangents now agree, so
    // the interpolated bridge tangent stays +X and the shader gets red
    // (not black) across the bridge.
    const hostT = result.tangents!.slice(0, 3);
    expect(hostT[0]).toBeCloseTo(1);
    expect(hostT[1]).toBeCloseTo(0);
    expect(hostT[2]).toBeCloseTo(0);
  });

  it("appends multiple ghosts in order", () => {
    const chunk = streamlineChunk(3);
    const result = appendGhostVertices(chunk, [
      {
        position: Float32Array.from([3, 0, 0]),
        attributes: [Float32Array.from([10])],
        bridgeFromLocalVertex: 2,
        isGhostPredecessor: false,
      },
      {
        position: Float32Array.from([0, -1, 0]),
        attributes: [Float32Array.from([20])],
        bridgeFromLocalVertex: 0,
        isGhostPredecessor: false,
      },
    ]);
    expect(result.numVertices).toBe(5);
    expect(result.numEdges).toBe(4); // 2 intra + 2 bridges
    // Bridges at the END of the edge array (after the 2 intra-fragment
    // edges (0,1),(1,2)).  Bridge order matches ghost order.
    expect(Array.from(result.edges)).toEqual([0, 1, 1, 2, 2, 3, 0, 4]);
  });

  it("leaves the fragment index unchanged (ghosts don't belong to any fragment)", () => {
    const chunk = streamlineChunk(3);
    const result = appendGhostVertices(chunk, [
      {
        position: Float32Array.from([3, 0, 0]),
        attributes: [Float32Array.from([0])],
        bridgeFromLocalVertex: 2,
      },
    ]);
    expect(result.fragmentIndex).toBe(chunk.fragmentIndex);
    expect(result.fragmentIndex.numFragments).toBe(1);
  });

  it("zero tangent on coincident host/ghost (boundary-deduplication case)", () => {
    const chunk = streamlineChunk(3);
    // Ghost coincident with host vertex 2.
    const result = appendGhostVertices(chunk, [
      {
        position: Float32Array.from([2, 0, 0]),
        attributes: [Float32Array.from([0])],
        bridgeFromLocalVertex: 2,
      },
    ]);
    expect(Array.from(result.tangents!.slice(-3))).toEqual([0, 0, 0]);
  });

  it("works for skeleton geometry (edge-adjacency tangents extended for ghost)", () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    const chunk = buildSkeletonChunk({
      rank: 3,
      positions,
      fragmentIndex: buildFragmentIndex([{ range: { start: 0, count: 3 } }]),
      linksConvention: "implicit_sequential_with_branches",
      geometryKind: "skeleton",
      vertexAttributes: [Uint32Array.from([1, 2, 3])],
    });
    expect(chunk.tangents).toBeDefined();
    const result = appendGhostVertices(chunk, [
      {
        position: Float32Array.from([3, 0, 0]),
        attributes: [Uint32Array.from([99])],
        bridgeFromLocalVertex: 2,
      },
    ]);
    expect(result.tangents).toBeDefined();
    expect(result.tangents!.length).toBe(4 * 3);
    expect(result.numVertices).toBe(4);
    expect(Array.from(result.vertexAttributes[0] as Uint32Array)).toEqual([
      1, 2, 3, 99,
    ]);
  });

  it("ghost inherits its host endpoint's segment id (bridge stays one colour)", () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    const chunk = buildSkeletonChunk({
      rank: 3,
      positions,
      fragmentIndex: buildFragmentIndex([{ range: { start: 0, count: 3 } }]),
      linksConvention: "implicit_sequential_with_branches",
      geometryKind: "skeleton",
      vertexAttributes: [],
      segmentIds: Uint32Array.from([42, 42, 42]),
    });
    const result = appendGhostVertices(chunk, [
      {
        position: Float32Array.from([3, 0, 0]),
        attributes: [],
        bridgeFromLocalVertex: 2,
      },
    ]);
    expect(result.segmentIds).toBeDefined();
    // Ghost (index 3) copies host vertex 2's segment id (42).
    expect(Array.from(result.segmentIds!)).toEqual([42, 42, 42, 42]);
  });

  it("preserves attribute dtype (uint8 host → uint8 output)", () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0]);
    const chunk = buildSkeletonChunk({
      rank: 3,
      positions,
      fragmentIndex: buildFragmentIndex([{ range: { start: 0, count: 2 } }]),
      linksConvention: "implicit_sequential",
      geometryKind: "streamline",
      vertexAttributes: [Uint8Array.from([7, 13])],
    });
    const result = appendGhostVertices(chunk, [
      {
        position: Float32Array.from([2, 0, 0]),
        attributes: [Uint8Array.from([200])],
        bridgeFromLocalVertex: 1,
      },
    ]);
    expect(result.vertexAttributes[0]).toBeInstanceOf(Uint8Array);
    expect(Array.from(result.vertexAttributes[0] as Uint8Array)).toEqual([
      7, 13, 200,
    ]);
  });

  it("throws when bridgeFromLocalVertex is out of range", () => {
    const chunk = streamlineChunk(3);
    expect(() =>
      appendGhostVertices(chunk, [
        {
          position: Float32Array.from([3, 0, 0]),
          attributes: [Float32Array.from([0])],
          bridgeFromLocalVertex: 99,
        },
      ]),
    ).toThrow(/bridgeFromLocalVertex/);
  });

  it("throws when ghost position rank doesn't match host", () => {
    const chunk = streamlineChunk(2);
    expect(() =>
      appendGhostVertices(chunk, [
        {
          position: Float32Array.from([1, 2]), // length 2, host rank=3
          attributes: [Float32Array.from([0])],
          bridgeFromLocalVertex: 0,
        },
      ]),
    ).toThrow(/position length/);
  });

  it("throws when ghost attribute count doesn't match host", () => {
    const chunk = streamlineChunk(2);
    expect(() =>
      appendGhostVertices(chunk, [
        {
          position: Float32Array.from([1, 0, 0]),
          attributes: [Float32Array.from([0]), Float32Array.from([0])], // host has 1 attr
          bridgeFromLocalVertex: 0,
        },
      ]),
    ).toThrow(/attributes/);
  });
});
