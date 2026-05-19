/**
 * @license
 * Copyright 2026 Allen Institute for Brain Science
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { describe, expect, it } from "vitest";
import { FragmentIndex } from "#src/datasource/zarr-vectors/fragment_index.js";
import {
  buildSkeletonChunk,
  computeTangents,
  mergeEdges,
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

  it("produces a skeleton chunk with both implicit + explicit edges and no tangents", () => {
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
    expect(chunk.tangents).toBeUndefined();
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
