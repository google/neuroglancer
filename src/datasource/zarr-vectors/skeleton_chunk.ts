/**
 * @license
 * Copyright 2026 Allen Institute for Brain Science
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

/**
 * Decode one zarr-vectors spatial chunk into a `SkeletonChunk`: per-vertex
 * positions, intra-chunk edges (synthesised and/or explicit), optional
 * per-vertex tangent vectors (streamline/polyline), and per-vertex
 * attributes carried verbatim.  Cross-chunk continuity is handled at the
 * render-layer level via `cross_chunk_links/0/data` — not in this module.
 *
 * The fragment-index format and per-object manifest format are documented
 * in the zarr-vectors spec §7.3 and §7.6.  This module consumes the
 * decoder in `./fragment_index.ts` and is consumed by the chunk-source
 * backend that downloads the underlying byte blobs.
 */

import { FragmentIndex } from "#src/datasource/zarr-vectors/fragment_index.js";

/**
 * How edges between vertices in a chunk are encoded.  Mirrors the spec's
 * root-level `links_convention` field; this drives whether we synthesise
 * edges from fragment ranges, read them explicitly, or both.
 */
export type LinksConvention =
  | "implicit_sequential"
  | "implicit_sequential_with_branches"
  | "explicit";

/**
 * Geometry type (a subset of the spec's `geometry_types` values that map
 * to this render path).  Streamlines and polylines pre-compute per-vertex
 * tangents; skeletons don't (branching breaks the "direction at this
 * vertex" abstraction).
 */
export type SkeletonGeometryKind = "streamline" | "polyline" | "skeleton";

/** Backing array for per-vertex attribute data (matches zarr-vectors dtypes). */
export type AttributeTypedArray =
  | Float32Array
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Int8Array
  | Int16Array
  | Int32Array;

/**
 * One decoded chunk ready for upload to the render layer.
 *
 * - `positions` is flat `(numVertices, rank)`; `rank` is fixed per store.
 * - `edges` is flat `(numEdges, 2)` chunk-local vertex indices.
 * - `tangents` is flat `(numVertices, 3)` for streamline/polyline; absent
 *   for skeletons (no canonical "direction").
 * - `vertexAttributes` is parallel to the caller's `attributeNames`,
 *   already reinterpreted to its declared dtype.
 * - `fragmentIndex` is retained so pass 2 can extract just the fragments
 *   named by a per-object manifest entry without re-decoding bytes.
 */
export interface SkeletonChunk {
  readonly rank: number;
  readonly numVertices: number;
  readonly positions: Float32Array;
  readonly numEdges: number;
  readonly edges: Uint32Array;
  readonly tangents?: Float32Array;
  readonly vertexAttributes: AttributeTypedArray[];
  readonly fragmentIndex: FragmentIndex;
}

/**
 * Synthesise intra-chunk edges from a fragment index using the
 * `implicit_sequential` convention: vertex `i` connects to vertex `i+1`
 * inside each fragment.  Edges never cross fragment boundaries — the
 * next fragment is a separate skeleton / streamline / polyline.
 *
 * For range fragments of length N: emit `N - 1` edges.
 * For explicit fragments of length N: emit `N - 1` edges connecting the
 *   indices in their declared order (so an explicit fragment with rows
 *   `[12, 7, 19]` emits edges `(12, 7)` and `(7, 19)`).
 *
 * Returns a flat `Uint32Array` of `(2 * num_edges)` chunk-local vertex
 * indices.
 */
export function synthesizeSequentialEdges(fi: FragmentIndex): Uint32Array {
  // First pass: count edges to allocate exactly.
  let numEdges = 0;
  for (let f = 0; f < fi.numFragments; ++f) {
    if (fi.isRange(f)) {
      const { count } = fi.range(f);
      if (count > 1) numEdges += count - 1;
    } else {
      const idx = fi.indices(f);
      if (idx.length > 1) numEdges += idx.length - 1;
    }
  }
  const out = new Uint32Array(numEdges * 2);
  let cursor = 0;
  for (let f = 0; f < fi.numFragments; ++f) {
    if (fi.isRange(f)) {
      const { start, count } = fi.range(f);
      for (let i = 0; i < count - 1; ++i) {
        out[cursor++] = start + i;
        out[cursor++] = start + i + 1;
      }
    } else {
      const idx = fi.indices(f);
      for (let i = 0; i < idx.length - 1; ++i) {
        out[cursor++] = idx[i];
        out[cursor++] = idx[i + 1];
      }
    }
  }
  return out;
}

/**
 * Merge two edge arrays (implicit-sequential + explicit branches) into
 * one flat array.  Used by the `implicit_sequential_with_branches`
 * skeleton convention: implicit edges come from the fragment ranges,
 * explicit edges come from `links/0/<chunk>`.
 *
 * Both inputs are flat `Uint32Array` of `(2*E)` chunk-local indices.
 */
export function mergeEdges(...edgeArrays: Uint32Array[]): Uint32Array {
  let total = 0;
  for (const a of edgeArrays) total += a.length;
  const out = new Uint32Array(total);
  let offset = 0;
  for (const a of edgeArrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

/**
 * Compute per-vertex tangent vectors via central differences inside each
 * fragment.  Inputs:
 *
 * - `positions`: flat `(numVertices, rank)` float positions.
 * - `rank`: spatial-index dimensionality (`positions.length / numVertices`).
 *   Must be 2 or 3.  For rank-2 input the output's Z component is zero.
 * - `fi`: fragment index that partitions the chunk into discrete
 *   skeletons/streamlines.  Tangents are computed independently inside
 *   each fragment; boundaries are never crossed.
 *
 * Output is a flat `Float32Array` of `(numVertices * 3)` unit tangent
 * vectors.  Endpoints use forward / backward differences; interior
 * vertices use central differences.  Singletons (fragments of length 1)
 * get a zero tangent.
 *
 * The output is rank-3 even for rank-2 input — neuroglancer expects 3D
 * directions in shader code and packing always-3D keeps the upload
 * pipeline uniform.
 */
export function computeTangents(
  positions: Float32Array,
  rank: number,
  fi: FragmentIndex,
): Float32Array {
  if (rank !== 2 && rank !== 3) {
    throw new Error(`computeTangents: rank ${rank} not supported (expected 2 or 3)`);
  }
  const numVertices = positions.length / rank;
  if (!Number.isInteger(numVertices)) {
    throw new Error(
      `computeTangents: positions.length=${positions.length} is not a multiple of rank=${rank}`,
    );
  }
  const out = new Float32Array(numVertices * 3);

  // Visit each fragment's vertex indices in walking order.  Range
  // fragments are contiguous; explicit fragments may revisit non-
  // contiguous chunk rows but still have a well-defined walk order
  // (the order they were stored in).
  for (let f = 0; f < fi.numFragments; ++f) {
    let walk: ArrayLike<number>;
    if (fi.isRange(f)) {
      const { start, count } = fi.range(f);
      const arr = new Uint32Array(count);
      for (let i = 0; i < count; ++i) arr[i] = start + i;
      walk = arr;
    } else {
      walk = fi.indices(f);
    }
    const n = walk.length;
    if (n === 0) continue;
    if (n === 1) {
      // Singleton fragment — zero tangent.  Already initialised.
      continue;
    }
    for (let i = 0; i < n; ++i) {
      const vi = walk[i];
      let prev: number;
      let next: number;
      if (i === 0) {
        prev = walk[0];
        next = walk[1];
      } else if (i === n - 1) {
        prev = walk[n - 2];
        next = walk[n - 1];
      } else {
        prev = walk[i - 1];
        next = walk[i + 1];
      }
      // Tangent direction = next - prev (un-normalised), then unit-normalise.
      const dx = positions[next * rank] - positions[prev * rank];
      const dy =
        positions[next * rank + 1] - positions[prev * rank + 1];
      const dz =
        rank === 3
          ? positions[next * rank + 2] - positions[prev * rank + 2]
          : 0;
      const norm = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (norm > 0) {
        out[vi * 3] = dx / norm;
        out[vi * 3 + 1] = dy / norm;
        out[vi * 3 + 2] = dz / norm;
      }
      // else: leave as zero (two coincident neighbours — degenerate).
    }
  }
  return out;
}

/**
 * Build a `SkeletonChunk` from already-decoded inputs.  Callers
 * (typically the chunk-source backend) are responsible for fetching the
 * raw bytes and running the dtype-aware reinterpretations.  This
 * function is the pure decode / shape-assembly step that the unit tests
 * can drive without HTTP machinery.
 */
export function buildSkeletonChunk(args: {
  rank: number;
  positions: Float32Array;
  fragmentIndex: FragmentIndex;
  /** From `links/0/<chunk>`, already reinterpreted to a chunk-local uint
   *  index array.  Flat `(E, 2)`.  Empty / undefined for
   *  `implicit_sequential` stores. */
  explicitEdges?: Uint32Array;
  linksConvention: LinksConvention;
  geometryKind: SkeletonGeometryKind;
  vertexAttributes: AttributeTypedArray[];
}): SkeletonChunk {
  const {
    rank,
    positions,
    fragmentIndex,
    explicitEdges,
    linksConvention,
    geometryKind,
    vertexAttributes,
  } = args;

  const numVertices = positions.length / rank;
  if (!Number.isInteger(numVertices)) {
    throw new Error(
      `buildSkeletonChunk: positions.length=${positions.length} is not a multiple of rank=${rank}`,
    );
  }

  let edges: Uint32Array;
  switch (linksConvention) {
    case "implicit_sequential":
      // Polyline / streamline: edges come purely from fragment ranges.
      edges = synthesizeSequentialEdges(fragmentIndex);
      if (explicitEdges && explicitEdges.length > 0) {
        throw new Error(
          "buildSkeletonChunk: implicit_sequential convention got " +
            "explicit edges; the writer should not emit links/0/<chunk> " +
            "in this mode",
        );
      }
      break;
    case "implicit_sequential_with_branches":
      // Skeleton: implicit sequential edges plus optional explicit
      // branch edges read from links/0/<chunk>.
      edges = mergeEdges(
        synthesizeSequentialEdges(fragmentIndex),
        explicitEdges ?? new Uint32Array(0),
      );
      break;
    case "explicit":
      // General graph: every edge is explicit.
      if (explicitEdges === undefined) {
        throw new Error(
          "buildSkeletonChunk: explicit links_convention requires explicitEdges",
        );
      }
      edges = explicitEdges;
      break;
    default: {
      const _exhaustive: never = linksConvention;
      throw new Error(`Unhandled links_convention: ${_exhaustive}`);
    }
  }

  // Tangents only for streamline / polyline (skeletons branch — no
  // canonical direction at a branch point).
  const tangents =
    geometryKind === "streamline" || geometryKind === "polyline"
      ? computeTangents(positions, rank, fragmentIndex)
      : undefined;

  return {
    rank,
    numVertices,
    positions,
    numEdges: edges.length >> 1,
    edges,
    tangents,
    vertexAttributes,
    fragmentIndex,
  };
}
