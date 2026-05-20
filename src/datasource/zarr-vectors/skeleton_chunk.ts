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
 * attributes carried verbatim.
 *
 * Cross-chunk continuity for pass-1 is handled by `appendGhostVertices`
 * (also in this module): after the host chunk is decoded, the backend
 * fetches the neighbor's boundary vertex (position + attribute values)
 * for each incident `cross_chunk_links` record, appends it as a "ghost"
 * vertex, and synthesises one bridge edge per ghost.  Each chunk
 * therefore renders independently with its existing per-chunk-isolated
 * GPU resources, but the visible line is continuous across boundaries.
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

/**
 * One bridge whose endpoints have both been resolved to chunk-local
 * vertex indices (either real or ghost) within the host chunk.  Used
 * by {@link recomputeTangentsForBridges} to refresh per-vertex
 * tangents at coarser pyramid levels where the writer's "one
 * metavertex per fragment" model leaves `computeTangents` with no
 * in-fragment neighbor to difference against.
 *
 * Convention matches `cross_chunk_links` semantics: `predecessor` is
 * `endpoint[0]` (the "before" vertex in walk order), `successor` is
 * `endpoint[1]` (the "after" vertex).
 */
export interface ResolvedBridge {
  readonly predecessorLocalIdx: number;
  readonly successorLocalIdx: number;
}

/**
 * Re-derive per-vertex tangents for metavertices whose
 * `computeTangents`-supplied value is zero (single-vertex fragments at
 * coarser pyramid levels).  For each bridge `predecessor → successor`,
 * accumulate the step direction `pos[successor] - pos[predecessor]` at
 * BOTH endpoints; normalise the accumulators in-place.
 *
 * Vertices with at least one incident bridge get their tangent
 * overwritten.  Vertices with no incident bridge keep their existing
 * tangent (whatever `computeTangents` produced — usually correct at
 * level 0, zero at coarser levels for isolated metavertices).
 *
 * Returns a new `SkeletonChunk` with updated `tangents`; no mutation
 * of inputs.  Returns the chunk unchanged for non-streamline /
 * non-polyline geometry (no tangents to update) or when `bridges` is
 * empty.
 */
export function recomputeTangentsForBridges(
  chunk: SkeletonChunk,
  bridges: readonly ResolvedBridge[],
): SkeletonChunk {
  if (chunk.tangents === undefined || bridges.length === 0) return chunk;
  const { rank, numVertices, positions, tangents } = chunk;
  // Touch mask: 1 if this vertex has at least one incident bridge.
  const touched = new Uint8Array(numVertices);
  const accum = new Float32Array(numVertices * 3);
  for (const bridge of bridges) {
    const p = bridge.predecessorLocalIdx;
    const s = bridge.successorLocalIdx;
    if (p < 0 || p >= numVertices || s < 0 || s >= numVertices) continue;
    const dx = positions[s * rank] - positions[p * rank];
    const dy = positions[s * rank + 1] - positions[p * rank + 1];
    const dz = rank === 3 ? positions[s * rank + 2] - positions[p * rank + 2] : 0;
    // Step direction `p → s` contributes to BOTH endpoints' forward-walk
    // tangent (predecessor sees `s` ahead; successor sees `p` behind).
    accum[p * 3] += dx;
    accum[p * 3 + 1] += dy;
    accum[p * 3 + 2] += dz;
    accum[s * 3] += dx;
    accum[s * 3 + 1] += dy;
    accum[s * 3 + 2] += dz;
    touched[p] = 1;
    touched[s] = 1;
  }
  const newTangents = new Float32Array(tangents);
  for (let v = 0; v < numVertices; ++v) {
    if (touched[v] === 0) continue;
    const dx = accum[v * 3];
    const dy = accum[v * 3 + 1];
    const dz = accum[v * 3 + 2];
    const norm = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (norm > 0) {
      newTangents[v * 3] = dx / norm;
      newTangents[v * 3 + 1] = dy / norm;
      newTangents[v * 3 + 2] = dz / norm;
    }
    // else: accumulator cancelled (predecessor + successor symmetric);
    // keep existing tangent.
  }
  return { ...chunk, tangents: newTangents };
}

/**
 * Append extra edges (flat `(a, b)` chunk-local vertex-index pairs) to
 * the chunk's existing edge list.  Used by the pass-1 backend to add
 * intra-chunk bridge edges from same-chunk `cross_chunk_links` records
 * (the coarser-pyramid-level case where the writer encodes
 * metavertex-to-metavertex transitions inside one chunk).
 *
 * No vertex insertion: both endpoints already live in the host
 * chunk's vertex texture, so the renderer treats these as ordinary
 * intra-chunk edges.
 *
 * Returns the input chunk unchanged when `extraEdges.length === 0`.
 * Throws if `extraEdges.length` isn't a multiple of 2, or if any
 * referenced vertex index is out of range.
 */
export function appendIntraChunkEdges(
  chunk: SkeletonChunk,
  extraEdges: Uint32Array,
): SkeletonChunk {
  if (extraEdges.length === 0) return chunk;
  if (extraEdges.length % 2 !== 0) {
    throw new Error(
      `appendIntraChunkEdges: extraEdges.length=${extraEdges.length} ` +
        `is not a multiple of 2`,
    );
  }
  for (let i = 0; i < extraEdges.length; ++i) {
    if (extraEdges[i] >= chunk.numVertices) {
      throw new Error(
        `appendIntraChunkEdges: edge endpoint ${extraEdges[i]} out of ` +
          `[0, ${chunk.numVertices})`,
      );
    }
  }
  const merged = new Uint32Array(chunk.edges.length + extraEdges.length);
  merged.set(chunk.edges, 0);
  merged.set(extraEdges, chunk.edges.length);
  return {
    ...chunk,
    numEdges: merged.length >> 1,
    edges: merged,
  };
}

/**
 * One "ghost" vertex to append to a `SkeletonChunk`.  A ghost is a copy
 * of a neighbor chunk's boundary vertex placed inside the host chunk's
 * vertex texture so the host can draw one edge from its real boundary
 * endpoint to the neighbor's endpoint without needing the neighbor's
 * GPU buffers bound at draw time.
 *
 * - `position`: length-`rank` world-space coordinates copied verbatim
 *   from the neighbor chunk.
 * - `attributes`: parallel to the host chunk's `vertexAttributes`.
 *   Each element holds the neighbor's stored value at the bridging
 *   vertex.  When the neighbor lacks an attribute file (e.g. pyramid
 *   levels without `vertex_attributes/<name>/`), the caller may emit a
 *   zero-filled typed-array of length 1 — matches the existing
 *   per-chunk zero-fill rule in `downloadSkeletonChunk`.
 * - `bridgeFromLocalVertex`: chunk-local index of the host endpoint
 *   that should be connected to this ghost.  Out-of-range indices are
 *   rejected by `appendGhostVertices`.
 */
export interface GhostVertexRecord {
  readonly position: Float32Array;
  readonly attributes: AttributeTypedArray[];
  readonly bridgeFromLocalVertex: number;
  /**
   * True when this ghost represents the **predecessor** of the host in
   * the streamline's walk order (i.e. it sits "before" the host along
   * the polyline).  False (default) when it's the successor.
   *
   * Why this matters: the ghost's synthesised tangent must point in
   * the FORWARD walk direction so it matches the host's
   * fragment-derived tangent across the bridge edge.  When the
   * ghost is the successor (typical X-side of a chunk crossing), the
   * forward direction is `normalize(ghost - host)`.  When it's the
   * predecessor (typical Y-side of the same crossing), the forward
   * direction is `normalize(host - ghost)` — the SIGN-FLIPPED form.
   * Getting this wrong made one side of every bridge interpolate
   * `forward + backward` ≈ `0`, producing visible black gaps in the
   * default RGB-by-tangent streamline shader.
   *
   * Skeletons / polylines without a meaningful walk direction simply
   * leave the synthesised tangent at zero, and this flag has no
   * effect.
   */
  readonly isGhostPredecessor?: boolean;
}

/**
 * Pure function: append ghost vertices + their bridge edges to an
 * existing `SkeletonChunk`, returning a new `SkeletonChunk`.  Does not
 * mutate the input.
 *
 * Ghost vertices are inserted at the end of the chunk's vertex space:
 * positions, vertex attributes, and (for streamline/polyline) tangents
 * all grow by `ghosts.length` entries.  The edge array grows by one
 * entry per ghost — connecting `ghost.bridgeFromLocalVertex` to the
 * newly-appended ghost index.  The fragment index is preserved
 * verbatim: ghosts are not part of any fragment.
 *
 * Ghost tangents (streamline/polyline only) are derived from the bridge
 * direction itself: `normalize(ghost.position - hostPosition)`.  This
 * is the only well-defined choice — a ghost has no neighbor in the
 * host chunk to do a central difference against, and the bridge edge
 * IS the only direction this vertex participates in locally.  Note
 * the host vertex retains its original fragment-derived tangent.
 *
 * Returns the input chunk unchanged when `ghosts.length === 0`.
 */
export function appendGhostVertices(
  chunk: SkeletonChunk,
  ghosts: readonly GhostVertexRecord[],
): SkeletonChunk {
  if (ghosts.length === 0) return chunk;

  const { rank, numVertices, positions, edges, tangents, vertexAttributes } =
    chunk;
  const numGhosts = ghosts.length;
  const newNumVertices = numVertices + numGhosts;

  // Validate inputs early — easier to debug than a downstream texture-
  // upload mismatch.
  if (vertexAttributes.length === 0 && ghosts.some((g) => g.attributes.length > 0)) {
    throw new Error(
      `appendGhostVertices: host chunk has 0 attributes but ghost ` +
        `supplied ${ghosts[0].attributes.length}`,
    );
  }
  for (let g = 0; g < numGhosts; ++g) {
    const ghost = ghosts[g];
    if (ghost.position.length !== rank) {
      throw new Error(
        `appendGhostVertices: ghost ${g} position length ${ghost.position.length} != rank ${rank}`,
      );
    }
    if (ghost.attributes.length !== vertexAttributes.length) {
      throw new Error(
        `appendGhostVertices: ghost ${g} has ${ghost.attributes.length} ` +
          `attributes; host chunk has ${vertexAttributes.length}`,
      );
    }
    if (
      ghost.bridgeFromLocalVertex < 0 ||
      ghost.bridgeFromLocalVertex >= numVertices
    ) {
      throw new Error(
        `appendGhostVertices: ghost ${g} bridgeFromLocalVertex=` +
          `${ghost.bridgeFromLocalVertex} out of [0, ${numVertices})`,
      );
    }
  }

  // Positions: append rank floats per ghost.
  const newPositions = new Float32Array(newNumVertices * rank);
  newPositions.set(positions, 0);
  for (let g = 0; g < numGhosts; ++g) {
    newPositions.set(ghosts[g].position, (numVertices + g) * rank);
  }

  // Tangents (if present): append 3 floats per ghost, computed from the
  // bridge direction `normalize(ghost - host)`.
  let newTangents: Float32Array | undefined;
  if (tangents !== undefined) {
    newTangents = new Float32Array(newNumVertices * 3);
    newTangents.set(tangents, 0);
    for (let g = 0; g < numGhosts; ++g) {
      const ghost = ghosts[g];
      const host = ghost.bridgeFromLocalVertex;
      // Compute the forward walk direction at the ghost's position.
      // Sign depends on whether the ghost sits BEFORE or AFTER the
      // host in walk order — see `isGhostPredecessor` docs above.
      const sign = ghost.isGhostPredecessor === true ? -1 : 1;
      const dx = sign * (ghost.position[0] - positions[host * rank]);
      const dy = sign * (ghost.position[1] - positions[host * rank + 1]);
      const dz =
        rank === 3
          ? sign * (ghost.position[2] - positions[host * rank + 2])
          : 0;
      const norm = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const out = (numVertices + g) * 3;
      if (norm > 0) {
        newTangents[out] = dx / norm;
        newTangents[out + 1] = dy / norm;
        newTangents[out + 2] = dz / norm;
      }
      // Else: leave zero — coincident host/ghost (boundary_deduplication-
      // style writers will hit this).
    }
  }

  // Vertex attributes: each grows by one element per ghost.  Construct
  // a new typed-array of the SAME constructor as the host's so dtype
  // stays consistent across the chunk.
  const newVertexAttributes: AttributeTypedArray[] = [];
  for (let a = 0; a < vertexAttributes.length; ++a) {
    const src = vertexAttributes[a];
    const Ctor = src.constructor as new (n: number) => AttributeTypedArray;
    const dst = new Ctor(newNumVertices);
    (dst as unknown as { set: (a: ArrayLike<number>, o: number) => void }).set(
      src as unknown as ArrayLike<number>,
      0,
    );
    for (let g = 0; g < numGhosts; ++g) {
      const ghostAttr = ghosts[g].attributes[a];
      // Single-element ghost attribute — first slot of the typed-array.
      // Spec note: callers populate ghost.attributes[a].length === 1.
      (dst as unknown as { [k: number]: number })[numVertices + g] =
        (ghostAttr as unknown as { [k: number]: number })[0];
    }
    newVertexAttributes.push(dst);
  }

  // Edges: append one bridge edge per ghost — (hostLocalIdx, ghostIdx).
  const newNumEdges = (edges.length >> 1) + numGhosts;
  const newEdges = new Uint32Array(newNumEdges * 2);
  newEdges.set(edges, 0);
  for (let g = 0; g < numGhosts; ++g) {
    const off = edges.length + g * 2;
    newEdges[off] = ghosts[g].bridgeFromLocalVertex;
    newEdges[off + 1] = numVertices + g;
  }

  return {
    rank,
    numVertices: newNumVertices,
    positions: newPositions,
    numEdges: newNumEdges,
    edges: newEdges,
    tangents: newTangents,
    vertexAttributes: newVertexAttributes,
    fragmentIndex: chunk.fragmentIndex,
  };
}
