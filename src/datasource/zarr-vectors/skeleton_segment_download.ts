/**
 * @license
 * Copyright 2026 Allen Institute for Brain Science
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

/**
 * Aggregate one object's skeleton geometry across the chunks that the
 * `object_index/manifests` reader reports for it.
 *
 * The pass-2 chunk-source backend calls `downloadSegmentSkeleton(oid,
 * ...)`: this resolves the manifest, fetches every named source chunk,
 * filters each one to just the fragments the object owns, and emits a
 * single merged geometry — `vertexPositions`, `indices`, and
 * `vertexAttributes` — ready to drop into a per-segment `SkeletonChunk`.
 */

import type { CrossChunkLinksTable } from "#src/datasource/zarr-vectors/cross_chunk_links.js";
import { hasSynthesisedTangent } from "#src/datasource/zarr-vectors/geometry_kind.js";
import { resolveFragmentRef } from "#src/datasource/zarr-vectors/object_manifest.js";
import {
  readObjectManifest,
  type ObjectManifestReaderOptions,
} from "#src/datasource/zarr-vectors/object_manifest_reader.js";
import type {
  AttributeTypedArray,
  LinksConvention,
  SkeletonChunk,
  SkeletonGeometryKind,
} from "#src/datasource/zarr-vectors/skeleton_chunk.js";
import {
  downloadSkeletonChunk,
  type AttributeDtype,
  type LinkDtype,
} from "#src/datasource/zarr-vectors/skeleton_chunk_download.js";

/**
 * The merged geometry for one object.  Shapes match the per-segment
 * `SkeletonChunk` fields that the render layer consumes.
 */
export interface AggregatedSegmentSkeleton {
  /** `(numVertices * rank)` floats. */
  readonly vertexPositions: Float32Array;
  /** `(numEdges * 2)` chunk-local-then-global vertex indices. */
  readonly indices: Uint32Array;
  /**
   * Per-vertex attributes, in the order the render layer will reference.
   * For streamline / polyline geometry kinds, index 0 is the synthesised
   * `tangent` (vec3); subsequent entries are the user-declared
   * attributes from `attributeNames` in declaration order.  For
   * skeleton geometry, only user-declared attributes are present.
   */
  readonly vertexAttributes: AttributeTypedArray[];
}

/**
 * Pure function: filter one decoded `SkeletonChunk` to just the
 * vertices and edges named by `fragmentIndices`.  Returns chunk-local
 * geometry (positions in float-flat layout, edges as chunk-local
 * vertex indices into the filtered output), plus the filtered attribute
 * arrays parallel to the positions.
 *
 * The render layer's vertex-attribute ordering convention is mirrored
 * here: when `chunk.tangents` is present (streamline/polyline) it is
 * emitted as the first attribute; user attributes follow.
 *
 * Vertices that don't belong to any of the named fragments are
 * dropped; edges with at least one endpoint dropped are also dropped
 * (no dangling references).
 */
export function filterChunkByFragments(
  chunk: SkeletonChunk,
  fragmentIndices: Uint32Array,
): {
  positions: Float32Array;
  edges: Uint32Array;
  attributes: AttributeTypedArray[];
  /** Map from source chunk-local vertex index → position in the filtered output. */
  vertexRemap: Int32Array;
} {
  const { rank, numVertices, positions, edges, vertexAttributes, tangents } =
    chunk;

  // Collect chunk-local vertex indices owned by the named fragments.
  // Use a `seen` mask to dedupe (the same vertex can be referenced by
  // multiple fragments — e.g. a branch point at level 0).  Walk-order
  // is preserved for the first occurrence so attribute lookups stay
  // deterministic.
  const seen = new Uint8Array(numVertices);
  const owned: number[] = [];
  for (let i = 0; i < fragmentIndices.length; ++i) {
    const f = fragmentIndices[i];
    const fragVerts = chunk.fragmentIndex.indices(f);
    for (let j = 0; j < fragVerts.length; ++j) {
      const v = fragVerts[j];
      if (seen[v] === 0) {
        seen[v] = 1;
        owned.push(v);
      }
    }
  }
  const numOwned = owned.length;

  // Build the source→filtered vertex remap.  -1 means "not in output".
  const vertexRemap = new Int32Array(numVertices).fill(-1);
  for (let i = 0; i < numOwned; ++i) vertexRemap[owned[i]] = i;

  // Gather positions for owned vertices, in walk order.
  const filteredPositions = new Float32Array(numOwned * rank);
  for (let i = 0; i < numOwned; ++i) {
    const v = owned[i];
    for (let d = 0; d < rank; ++d) {
      filteredPositions[i * rank + d] = positions[v * rank + d];
    }
  }

  // Filter edges: keep only those whose endpoints are both in the owned
  // set, and remap to filtered-output indices.
  const keptEdges: number[] = [];
  for (let e = 0; e < edges.length; e += 2) {
    const a = edges[e];
    const b = edges[e + 1];
    if (seen[a] === 1 && seen[b] === 1) {
      keptEdges.push(vertexRemap[a]);
      keptEdges.push(vertexRemap[b]);
    }
  }
  const filteredEdges = new Uint32Array(keptEdges);

  // Filter attribute arrays (tangents first if present, then user attrs)
  // in the same conventional order the spatially-indexed backend uses.
  const filteredAttrs: AttributeTypedArray[] = [];
  if (tangents !== undefined) {
    const t = new Float32Array(numOwned * 3);
    for (let i = 0; i < numOwned; ++i) {
      const v = owned[i];
      t[i * 3] = tangents[v * 3];
      t[i * 3 + 1] = tangents[v * 3 + 1];
      t[i * 3 + 2] = tangents[v * 3 + 2];
    }
    filteredAttrs.push(t);
  }
  for (const src of vertexAttributes) {
    // Each `src` is a per-vertex array of length `numVertices` (scalar
    // attribute) — the higher-level zarr-vectors writer paths don't
    // currently emit multi-component vertex attributes via the
    // ZarrVectorsAttributeDtype enum, so a 1:1 element copy suffices.
    const Ctor = src.constructor as new (n: number) => AttributeTypedArray;
    const dst = new Ctor(numOwned);
    for (let i = 0; i < numOwned; ++i) dst[i] = src[owned[i]] as never;
    filteredAttrs.push(dst);
  }

  return {
    positions: filteredPositions,
    edges: filteredEdges,
    attributes: filteredAttrs,
    vertexRemap,
  };
}

export interface DownloadSegmentSkeletonOptions {
  /** Manifest reader configuration (numObjects, chunkSize, sidNdim, kvStoreRead). */
  readonly manifestReader: ObjectManifestReaderOptions;
  /** Spatial-chunk download parameters (rank, dtypes, links convention, etc.). */
  readonly rank: number;
  readonly linkDtype: LinkDtype;
  readonly attributeNames: readonly string[];
  readonly attributeDtypes: readonly AttributeDtype[];
  readonly linksConvention: LinksConvention;
  readonly geometryKind: SkeletonGeometryKind;
  /**
   * Optional decoded ``cross_chunk_links/0/`` table for the level.  When
   * present, ``downloadSegmentSkeleton`` appends one edge per record
   * whose two endpoints both land on vertices the current object owns
   * (i.e. survived the per-block fragment filter).  Records of
   * ``linkWidth !== 2`` are ignored — they're for meshes / metanode
   * pyramids, not streamlines.
   *
   * Pass-2 callers (the segment-keyed backend) should fetch this table
   * once per level via {@link readCrossChunkLinks} and share it across
   * objects.
   */
  readonly crossChunkLinks?: CrossChunkLinksTable;
}

/**
 * Per-source-chunk bookkeeping kept while {@link downloadSegmentSkeleton}
 * processes a manifest.  Used after concatenation to translate
 * cross-chunk endpoint references into the merged-output vertex index
 * space.
 */
interface OwnedChunkInfo {
  /** Map from chunk-local vertex index → filtered-output position (-1 = dropped). */
  readonly vertexRemap: Int32Array;
  /** Cumulative merged-output index at which this chunk's vertices start. */
  readonly vertexOffset: number;
}

/**
 * Pure helper: given a decoded cross-chunk table and the per-chunk
 * remap/offset info collected during fragment aggregation, emit the
 * subset of edges whose endpoints both land on owned vertices.
 *
 * Exported so unit tests can drive it with hand-crafted fixtures
 * without staging a whole manifest/chunk pipeline.
 */
/**
 * Per-block bookkeeping carried by {@link downloadSegmentSkeleton}'s
 * manifest walk.  Exposed via the helper signatures so unit tests can
 * drive {@link deriveImplicitSequentialCrossChunkEdges} without
 * staging a whole download.
 */
export interface OrderedManifestBlock {
  /** Joined chunk-coordinate string, e.g. ``"0.-1.2"``. */
  readonly chunkKey: string;
  /** Maps chunk-local vertex index → filtered-output position (-1 = dropped). */
  readonly vertexRemap: Int32Array;
  /** Cumulative merged-output index at which this block's vertices start. */
  readonly vertexOffset: number;
  /** Chunk-local first vertex of this block's single fragment (-1 if N/A). */
  readonly firstFragmentLocalVert: number;
  /** Chunk-local last vertex of this block's single fragment (-1 if N/A). */
  readonly lastFragmentLocalVert: number;
}

/**
 * Pure helper for the ``implicit_sequential`` inter-fragment bridge
 * path.  Walks the manifest-ordered blocks pairwise; for **every**
 * consecutive pair emits one edge bridging fragment k's last vertex
 * with fragment k+1's first vertex (both translated to the merged-
 * output vertex index space).
 *
 * Bridges connect *consecutive fragments*, not just *cross-chunk*
 * transitions.  Streamlines are partitioned by zarr-vectors' bin grid
 * (writer default: ``bin_shape`` = chunk_shape / 4), so a polyline can
 * generate multiple fragments **inside one chunk**.  Each fragment is
 * its own implicit-sequential edge run, so adjacent fragments — same
 * chunk or not — need an explicit bridge between fragment k's last
 * vertex and fragment k+1's first vertex.  Skipping same-chunk
 * transitions would leave intra-chunk bin-boundary gaps visible.
 *
 * Skips pairs where either side isn't a single-fragment block
 * (``firstFragmentLocalVert`` / ``lastFragmentLocalVert`` are -1) — the
 * endpoint identity becomes ambiguous in that case.  Also skips pairs
 * where the relevant chunk-local vertex was filtered out (remap < 0) —
 * same no-dangling rule the per-chunk filter applies.
 *
 * Exported so unit tests can drive it with hand-crafted block sequences
 * without staging a whole download.
 */
export function deriveImplicitSequentialCrossChunkEdges(
  orderedBlocks: readonly OrderedManifestBlock[],
): Uint32Array {
  const out: number[] = [];
  for (let i = 0; i + 1 < orderedBlocks.length; ++i) {
    const a = orderedBlocks[i];
    const b = orderedBlocks[i + 1];
    if (a.lastFragmentLocalVert < 0 || b.firstFragmentLocalVert < 0) continue;
    if (a.lastFragmentLocalVert >= a.vertexRemap.length) continue;
    if (b.firstFragmentLocalVert >= b.vertexRemap.length) continue;
    const aRemap = a.vertexRemap[a.lastFragmentLocalVert];
    const bRemap = b.vertexRemap[b.firstFragmentLocalVert];
    if (aRemap < 0 || bRemap < 0) continue;
    out.push(aRemap + a.vertexOffset);
    out.push(bRemap + b.vertexOffset);
  }
  return new Uint32Array(out);
}

export function collectOwnedCrossChunkEdges(
  table: CrossChunkLinksTable,
  ownedChunks: Map<string, OwnedChunkInfo>,
): Uint32Array {
  // Only line-arity (linkWidth=2) records describe cross-chunk edges.
  // Triangle / metanode records aren't relevant to streamline rendering.
  if (table.linkWidth !== 2) return new Uint32Array(0);
  const out: number[] = [];
  for (const record of table.records) {
    const [a, b] = record.endpoints;
    const aKey = a.chunkCoords.join(".");
    const bKey = b.chunkCoords.join(".");
    const aInfo = ownedChunks.get(aKey);
    const bInfo = ownedChunks.get(bKey);
    if (aInfo === undefined || bInfo === undefined) continue;
    if (a.vertexIndex < 0 || a.vertexIndex >= aInfo.vertexRemap.length)
      continue;
    if (b.vertexIndex < 0 || b.vertexIndex >= bInfo.vertexRemap.length)
      continue;
    const aRemap = aInfo.vertexRemap[a.vertexIndex];
    const bRemap = bInfo.vertexRemap[b.vertexIndex];
    if (aRemap < 0 || bRemap < 0) continue;
    out.push(aRemap + aInfo.vertexOffset);
    out.push(bRemap + bInfo.vertexOffset);
  }
  return new Uint32Array(out);
}

/**
 * Download and aggregate one object's skeleton geometry across all the
 * chunks the manifest reports for it.  Returns `undefined` when the
 * object is absent (no manifest, or every fragment chunk missing).
 *
 * Algorithm:
 *
 * 1. Resolve `oid` → `ManifestBlock[]` via `readObjectManifest`.
 * 2. For each block:
 *    a. Fetch + decode the spatial chunk via `downloadSkeletonChunk`.
 *    b. Resolve `block.fragmentRef` to a flat list of fragment indices
 *       within that chunk.
 *    c. Call `filterChunkByFragments` to extract just those fragments'
 *       vertices/edges/attributes.
 * 3. Concatenate the per-chunk filtered outputs, re-offsetting the edge
 *    indices so they reference the merged vertex array.
 */
export async function downloadSegmentSkeleton(
  oid: number | bigint,
  options: DownloadSegmentSkeletonOptions,
  signal: AbortSignal,
): Promise<AggregatedSegmentSkeleton | undefined> {
  const {
    manifestReader,
    rank,
    linkDtype,
    attributeNames,
    attributeDtypes,
    linksConvention,
    geometryKind,
    crossChunkLinks,
  } = options;
  const manifest = await readObjectManifest(oid, manifestReader, signal);
  if (manifest === undefined || manifest.length === 0) return undefined;

  const perChunkPositions: Float32Array[] = [];
  const perChunkEdges: Uint32Array[] = [];
  // Outer array: one slot per attribute.  Inner: one entry per source
  // chunk.  Every geometry kind with synthesised tangents (streamline,
  // polyline, graph) carries the tangent in slot 0 of
  // `filterChunkByFragments`'s output — see `hasSynthesisedTangent` in
  // `geometry_kind.ts` for the canonical per-kind capability table.
  const numAttrsExpected =
    (hasSynthesisedTangent(geometryKind) ? 1 : 0) + attributeNames.length;
  const perChunkAttrs: AttributeTypedArray[][] = Array.from(
    { length: numAttrsExpected },
    () => [] as AttributeTypedArray[],
  );
  // Per-source-chunk remap/offset, indexed by chunk key.  Populated as
  // we walk the manifest; consumed below by the blob-based cross-chunk
  // path (graphs / skeletons with explicit links).  Keyed by chunk so
  // an arbitrary cross-chunk record can find the relevant remap.
  const ownedChunks = new Map<string, OwnedChunkInfo>();
  // Per-block bookkeeping, in manifest order.  Drives the
  // implicit_sequential cross-chunk path: consecutive blocks in
  // different chunks emit one bridging edge (last vertex of fragment k →
  // first vertex of fragment k+1).  See zarr-vectors-py
  // ``polylines.py:325``: the on-disk cross_chunk_links table only
  // records ``((cc_a, 0), (cc_b, 0))`` placeholders for streamlines, so
  // it carries no fragment-specific endpoint info — we have to
  // reconstruct edges from manifest order.
  interface OrderedBlock extends OwnedChunkInfo {
    readonly chunkKey: string;
    /** Chunk-local index of the first vertex of this block's single
     * fragment; -1 if the block has 0 or >1 fragments (cross-chunk edge
     * reconstruction skips those). */
    readonly firstFragmentLocalVert: number;
    /** Chunk-local index of the last vertex of this block's single
     * fragment; -1 if not single-fragment. */
    readonly lastFragmentLocalVert: number;
  }
  const orderedBlocks: OrderedBlock[] = [];

  let runningVertexOffset = 0;

  for (const block of manifest) {
    const chunkKey = block.chunkCoords.join(".");
    const skel = await downloadSkeletonChunk(
      {
        chunkKey,
        rank,
        linkDtype,
        attributeNames,
        attributeDtypes,
        linksConvention,
        geometryKind,
        kvStoreRead: manifestReader.kvStoreRead,
      },
      signal,
    );
    if (skel === undefined) continue;

    const fragmentIds = resolveFragmentRef(block.fragmentRef);
    const filtered = filterChunkByFragments(skel, fragmentIds);
    if (filtered.positions.length === 0) continue;

    // For the implicit_sequential cross-chunk reconstruction, capture
    // the first and last chunk-local vertex of this block's single
    // fragment.  Blocks with 0 or >1 fragments don't participate
    // (cross-chunk endpoint identity becomes ambiguous).
    let firstFragmentLocalVert = -1;
    let lastFragmentLocalVert = -1;
    if (fragmentIds.length === 1) {
      const fragVerts = skel.fragmentIndex.indices(fragmentIds[0]);
      if (fragVerts.length > 0) {
        firstFragmentLocalVert = fragVerts[0];
        lastFragmentLocalVert = fragVerts[fragVerts.length - 1];
      }
    }

    const info: OwnedChunkInfo = {
      vertexRemap: filtered.vertexRemap,
      vertexOffset: runningVertexOffset,
    };
    // Last-write-wins if a chunk shows up multiple times in the
    // manifest.  The blob-based cross-chunk path can't disambiguate
    // either way; the manifest-driven path uses `orderedBlocks` (which
    // does preserve all visits).
    ownedChunks.set(chunkKey, info);
    orderedBlocks.push({
      ...info,
      chunkKey,
      firstFragmentLocalVert,
      lastFragmentLocalVert,
    });

    perChunkPositions.push(filtered.positions);
    // Shift edge indices into the merged-output coordinate space.
    if (filtered.edges.length > 0) {
      if (runningVertexOffset === 0) {
        perChunkEdges.push(filtered.edges);
      } else {
        const shifted = new Uint32Array(filtered.edges.length);
        for (let i = 0; i < filtered.edges.length; ++i) {
          shifted[i] = filtered.edges[i] + runningVertexOffset;
        }
        perChunkEdges.push(shifted);
      }
    }
    if (filtered.attributes.length !== numAttrsExpected) {
      throw new Error(
        `downloadSegmentSkeleton: chunk ${chunkKey} returned ` +
          `${filtered.attributes.length} attributes; expected ${numAttrsExpected}`,
      );
    }
    for (let i = 0; i < numAttrsExpected; ++i) {
      perChunkAttrs[i].push(filtered.attributes[i]);
    }

    runningVertexOffset += filtered.positions.length / rank;
  }

  // Inter-fragment bridge reconstruction.  Two strategies:
  //
  //  - implicit_sequential (polylines / streamlines): walk
  //    `orderedBlocks` pairwise; emit one edge per consecutive pair,
  //    connecting fragment k's last vertex to fragment k+1's first
  //    vertex.  Bridges are needed for both chunk-to-chunk transitions
  //    AND for bin-to-bin transitions within one chunk — zarr-vectors
  //    partitions streamlines by `bin_shape`, so one streamline can
  //    produce multiple same-chunk fragments.  The on-disk
  //    cross_chunk_links blob for these stores carries no usable
  //    endpoint info (its `vi` values are literal `0` placeholders;
  //    see zarr-vectors-py polylines.py:325).
  //
  //  - explicit / implicit_sequential_with_branches (graphs, skeletons):
  //    the on-disk cross_chunk_links blob carries real chunk-local
  //    vertex indices for each endpoint.  Use the blob-based filter on
  //    `ownedChunks`.
  let crossChunkEdges: Uint32Array | undefined;
  if (linksConvention === "implicit_sequential") {
    const edges = deriveImplicitSequentialCrossChunkEdges(orderedBlocks);
    if (edges.length > 0) crossChunkEdges = edges;
  } else if (crossChunkLinks !== undefined && ownedChunks.size > 0) {
    const edges = collectOwnedCrossChunkEdges(crossChunkLinks, ownedChunks);
    if (edges.length > 0) crossChunkEdges = edges;
  }

  if (runningVertexOffset === 0) return undefined;

  // Concatenate per-chunk arrays.
  const totalFloats = runningVertexOffset * rank;
  const vertexPositions = new Float32Array(totalFloats);
  {
    let cursor = 0;
    for (const p of perChunkPositions) {
      vertexPositions.set(p, cursor);
      cursor += p.length;
    }
  }
  let totalEdgeEntries = 0;
  for (const e of perChunkEdges) totalEdgeEntries += e.length;
  if (crossChunkEdges !== undefined) totalEdgeEntries += crossChunkEdges.length;
  const indices = new Uint32Array(totalEdgeEntries);
  {
    let cursor = 0;
    for (const e of perChunkEdges) {
      indices.set(e, cursor);
      cursor += e.length;
    }
    if (crossChunkEdges !== undefined) {
      indices.set(crossChunkEdges, cursor);
    }
  }
  const vertexAttributes: AttributeTypedArray[] = [];
  for (let a = 0; a < numAttrsExpected; ++a) {
    const parts = perChunkAttrs[a];
    // Each attribute keeps its dtype consistent across chunks because
    // the dtypes come from per-array zarr metadata, not per-chunk.
    // Use the first non-empty part's constructor to allocate the merged
    // buffer (fallback to Float32Array if all parts are zero-length).
    let totalLen = 0;
    for (const p of parts) totalLen += p.length;
    let merged: AttributeTypedArray;
    if (parts.length === 0 || totalLen === 0) {
      merged = new Float32Array(0);
    } else {
      const Ctor = parts[0].constructor as new (
        n: number,
      ) => AttributeTypedArray;
      merged = new Ctor(totalLen);
      let cursor = 0;
      for (const p of parts) {
        (
          merged as unknown as {
            set: (a: ArrayLike<number>, o: number) => void;
          }
        ).set(p as unknown as ArrayLike<number>, cursor);
        cursor += p.length;
      }
    }
    vertexAttributes.push(merged);
  }

  return { vertexPositions, indices, vertexAttributes };
}
