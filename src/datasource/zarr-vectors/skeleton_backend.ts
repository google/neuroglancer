/**
 * @license
 * Copyright 2026 Allen Institute for Brain Science
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

/**
 * Worker-side `SharedObject` chunk-source backends for zarr-vectors
 * skeleton / polyline / streamline rendering.  Provides:
 *
 * - `ZarrVectorsSpatiallyIndexedSkeletonSourceBackend` — the **pass-1**
 *   backing store.  Subclasses neuroglancer's existing
 *   `SpatiallyIndexedSkeletonSourceBackend` and overrides `download()`
 *   to fetch + decode zarr-vectors chunks via the
 *   `downloadSkeletonChunk()` orchestrator.
 *
 * - `ZarrVectorsObjectKeyedSkeletonSourceBackend` — the **pass-2**
 *   backing store, intentionally **not implemented in this slice**.
 *   Will subclass `SkeletonSource` once the `object_index/manifests`
 *   zarr-vlen-bytes reader is in place (slice 4b).
 *
 * Mirrors the CATMAID pattern at
 * `src/datasource/catmaid/backend.ts:40-83`.
 */

import { decodeZstd } from "#src/async_computation/decode_zstd_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import { WithParameters } from "#src/chunk_manager/backend.js";
import {
  ZarrVectorsObjectKeyedSkeletonSourceParameters,
  ZarrVectorsSpatiallyIndexedSkeletonSourceParameters,
  type ZarrVectorsLinkDtype,
  type ZarrVectorsLinksConvention,
  type ZarrVectorsSkeletonGeometryKind,
} from "#src/datasource/zarr-vectors/base.js";
import {
  readCrossChunkLinks,
  type CrossChunkLinksTable,
} from "#src/datasource/zarr-vectors/cross_chunk_links.js";
import { hasSynthesisedTangent } from "#src/datasource/zarr-vectors/geometry_kind.js";
import {
  appendGhostVertices,
  appendIntraChunkEdges,
  recomputeTangentsForBridges,
  type ResolvedBridge,
} from "#src/datasource/zarr-vectors/skeleton_chunk.js";
import {
  downloadSkeletonChunk,
  fetchGhostVertices,
  type AttributeDtype,
  type GhostVertexRequest,
  type LinkDtype,
} from "#src/datasource/zarr-vectors/skeleton_chunk_download.js";
import { downloadSegmentSkeleton } from "#src/datasource/zarr-vectors/skeleton_segment_download.js";
import { WithSharedKvStoreContextCounterpart } from "#src/kvstore/backend.js";
import { joinBaseUrlAndPath } from "#src/kvstore/url.js";
import {
  SkeletonChunk,
  SkeletonSource,
  SpatiallyIndexedSkeletonChunk,
  SpatiallyIndexedSkeletonSourceBackend,
} from "#src/skeleton/backend.js";
import { registerSharedObject } from "#src/worker_rpc.js";

const ZSTD_MAGIC = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]);

function looksLikeZstd(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  return (
    bytes[0] === ZSTD_MAGIC[0] &&
    bytes[1] === ZSTD_MAGIC[1] &&
    bytes[2] === ZSTD_MAGIC[2] &&
    bytes[3] === ZSTD_MAGIC[3]
  );
}

/**
 * Decompress a zstd-framed byte buffer; pass through other formats.
 *
 * Duplicated from the point-cloud backend.ts intentionally — keeps this
 * slice's diff scoped to new files only.  If a third caller appears,
 * promote both copies to a shared helper module.
 */
async function maybeDecompress(
  bytes: Uint8Array<ArrayBuffer>,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!looksLikeZstd(bytes)) return bytes;
  return await requestAsyncComputation(
    decodeZstd,
    signal,
    [bytes.buffer],
    bytes,
  );
}

/**
 * Build a `kvStoreRead` callback bound to a base URL and the worker-side
 * shared kvstore context.  Resolves to a decompressed `Uint8Array` (or
 * `undefined` for a missing key).
 */
function makeKvStoreRead(
  baseUrl: string,
  sharedKvStoreContext: {
    kvStoreContext: { read: (url: string, options: { signal: AbortSignal }) => Promise<any> };
  },
) {
  return async (
    subpath: string,
    signal: AbortSignal,
  ): Promise<Uint8Array | undefined> => {
    const url = joinBaseUrlAndPath(baseUrl, subpath);
    const response = await sharedKvStoreContext.kvStoreContext.read(url, {
      signal,
    });
    if (response === undefined) return undefined;
    const bytes = new Uint8Array(
      (await response.response.arrayBuffer()) as ArrayBuffer,
    );
    return await maybeDecompress(bytes, signal);
  };
}

/**
 * The parameter types in `base.ts` declare `ZarrVectorsLinkDtype` and
 * `ZarrVectorsAttributeDtype` as union subsets of the orchestrator's
 * dtypes.  The orchestrator's `LinkDtype` / `AttributeDtype` are
 * structurally identical at the value level — the two type names exist
 * separately so the parameter classes can carry semantically-named
 * unions while the orchestrator stays decoupled from the parameter
 * surface.  Cast through here.
 */
function asLinkDtype(d: ZarrVectorsLinkDtype): LinkDtype {
  return d as LinkDtype;
}
function asAttributeDtype(d: string): AttributeDtype {
  return d as AttributeDtype;
}

/**
 * Spatially-indexed skeleton chunk source — the **pass-1** backing
 * store.  One chunk per `(chunkGridPosition, lod)` pair.
 *
 * For each chunk, `download()` fetches the relevant byte blobs and
 * decodes them into a `SpatiallyIndexedSkeletonChunk` whose
 * `vertexPositions`, `indices`, and `vertexAttributes` fields the render
 * layer consumes.
 *
 * Streamline / polyline geometry kinds prepend a synthesised
 * `tangent` vec3 attribute to `vertexAttributes` so the default shader's
 * `prop_tangent()` resolves to the per-vertex unit direction.
 * Skeleton geometry skips this — branching breaks the
 * "direction at this vertex" abstraction.
 */
@registerSharedObject()
export class ZarrVectorsSpatiallyIndexedSkeletonSourceBackend extends WithParameters(
  WithSharedKvStoreContextCounterpart(SpatiallyIndexedSkeletonSourceBackend),
  ZarrVectorsSpatiallyIndexedSkeletonSourceParameters,
) {
  /**
   * Cached decoded ``cross_chunk_links/0/`` table for this level.  Read
   * lazily on first ``download()`` and reused for every subsequent chunk
   * — the table is per-level, not per-chunk.
   *
   * ``null`` means "probed, store has no such table" (older zarr-vectors
   * stores written without ``cross_chunk_strategy="explicit_links"``).
   * ``undefined`` means "not yet probed".
   *
   * Mirror of the same field on
   * {@link ZarrVectorsObjectKeyedSkeletonSourceBackend}; the two
   * backends share a parameter type's ``baseUrl`` for the same store
   * level, but each holds its own cache copy.  Could be promoted to a
   * per-level shared cache later if memory becomes a concern (16832-
   * byte tables are typical, so two copies is fine for now).
   */
  private crossChunkLinks_: CrossChunkLinksTable | null | undefined;

  private async getCrossChunkLinks(
    kvStoreRead: (
      subpath: string,
      signal: AbortSignal,
    ) => Promise<Uint8Array | undefined>,
    signal: AbortSignal,
  ): Promise<CrossChunkLinksTable | undefined> {
    if (this.crossChunkLinks_ !== undefined) {
      return this.crossChunkLinks_ ?? undefined;
    }
    const table = await readCrossChunkLinks({ kvStoreRead }, signal);
    this.crossChunkLinks_ = table ?? null;
    return table;
  }

  /**
   * Filter the cross-chunk-link table down to records incident on the
   * named chunk.  Output has two kinds of items:
   *
   * - `ghostRequests`: cross-chunk records where one endpoint is in
   *   this chunk and the other is in a different chunk.  Each becomes
   *   a {@link GhostVertexRequest} so the backend can fetch the
   *   neighbor's boundary vertex and append it as a ghost.
   * - `intraChunkEdges`: records where BOTH endpoints are in this
   *   chunk.  At coarser pyramid levels the writer encodes intra-chunk
   *   metavertex-to-metavertex bridges (consecutive same-chunk
   *   fragments of one streamline) here too — no ghost vertex needed
   *   because both endpoints already live in this chunk's vertex
   *   texture.  Each record becomes one flat `(a, b)` pair of chunk-
   *   local vertex indices appended directly to the chunk's edge list.
   *
   * Triangle / metanode records (``linkWidth !== 2``) are skipped —
   * those describe mesh-style face stitching, not line edges.
   */
  private buildBridgeRequests(
    table: CrossChunkLinksTable,
    selfChunkCoords: Float32Array,
    selfNumVertices: number,
  ): {
    ghostRequests: GhostVertexRequest[];
    intraChunkEdges: Uint32Array;
    /**
     * Intra-chunk bridges resolved to chunk-local predecessor/successor
     * indices.  Cross-chunk bridges (one endpoint is a future ghost)
     * are appended later in `download()` once we know each ghost's
     * chunk-local index — see the comment on the ghost-append step.
     */
    intraChunkBridges: ResolvedBridge[];
    /**
     * Per-ghost-request side info needed to extend `intraChunkBridges`
     * after ghosts are appended.  `ghostIsPredecessor[i]` mirrors
     * `ghostRequests[i].isGhostPredecessor`.
     */
    ghostIsPredecessor: boolean[];
  } {
    if (table.linkWidth !== 2) {
      return {
        ghostRequests: [],
        intraChunkEdges: new Uint32Array(0),
        intraChunkBridges: [],
        ghostIsPredecessor: [],
      };
    }
    const selfCoords = Array.from(selfChunkCoords, (v) => Number(v));
    const ghostRequests: GhostVertexRequest[] = [];
    const intraEdges: number[] = [];
    const intraChunkBridges: ResolvedBridge[] = [];
    const ghostIsPredecessor: boolean[] = [];
    for (const record of table.records) {
      // Cross-chunk records encode walk order: endpoint[0] is the
      // PREDECESSOR (last vertex of fragment A) and endpoint[1] is
      // the SUCCESSOR (first vertex of fragment B).  See the polyline
      // writer at `zarr_vectors/types/polylines.py` and the boundary
      // helper at `zarr_vectors/spatial/boundary.py:75-114`.
      //
      // For cross-chunk records, the ghost's tangent must point in the
      // forward walk direction.  When this chunk matches endpoint[0],
      // the ghost is the successor — it sits AFTER the host.  When
      // this chunk matches endpoint[1], the ghost is the predecessor.
      // `appendGhostVertices` flips the synthesised ghost-tangent
      // sign based on `isGhostPredecessor` so both sides of the
      // bridge interpolate the same forward walk direction.
      const a = record.endpoints[0];
      const b = record.endpoints[1];
      const aMatches = endpointMatchesChunk(a.chunkCoords, selfCoords);
      const bMatches = endpointMatchesChunk(b.chunkCoords, selfCoords);
      if (aMatches && bMatches) {
        // Intra-chunk bridge: writer-emitted record connecting two
        // fragments inside the SAME chunk (coarser-pyramid-level
        // metavertex-to-metavertex transition).  Drop the record if
        // either endpoint is out of range.
        if (
          a.vertexIndex < 0 ||
          a.vertexIndex >= selfNumVertices ||
          b.vertexIndex < 0 ||
          b.vertexIndex >= selfNumVertices
        ) {
          continue;
        }
        intraEdges.push(a.vertexIndex, b.vertexIndex);
        intraChunkBridges.push({
          predecessorLocalIdx: a.vertexIndex,
          successorLocalIdx: b.vertexIndex,
        });
      } else if (aMatches) {
        ghostRequests.push({
          hostLocalVertex: a.vertexIndex,
          neighborChunkKey: b.chunkCoords.join("."),
          neighborLocalVertex: b.vertexIndex,
          isGhostPredecessor: false, // ghost is endpoint[1] = successor
        });
        ghostIsPredecessor.push(false);
      } else if (bMatches) {
        ghostRequests.push({
          hostLocalVertex: b.vertexIndex,
          neighborChunkKey: a.chunkCoords.join("."),
          neighborLocalVertex: a.vertexIndex,
          isGhostPredecessor: true, // ghost is endpoint[0] = predecessor
        });
        ghostIsPredecessor.push(true);
      }
      // Neither-match records (not ours) are silently ignored.
    }
    return {
      ghostRequests,
      intraChunkEdges: Uint32Array.from(intraEdges),
      intraChunkBridges,
      ghostIsPredecessor,
    };
  }

  async download(
    chunk: SpatiallyIndexedSkeletonChunk,
    signal: AbortSignal,
  ): Promise<void> {
    const {
      baseUrl,
      rank,
      attributeNames,
      attributeDtypes,
      linksConvention,
      geometryKind,
      linkDtype,
    } = this.parameters;
    const { chunkGridPosition } = chunk;
    const chunkKey = Array.from(chunkGridPosition, (v) => String(v)).join(".");
    const kvStoreRead = makeKvStoreRead(baseUrl, this.sharedKvStoreContext);

    const decoded = await downloadSkeletonChunk(
      {
        chunkKey,
        rank,
        linkDtype: asLinkDtype(linkDtype),
        attributeNames,
        attributeDtypes: attributeDtypes.map(asAttributeDtype),
        linksConvention: linksConvention as ZarrVectorsLinksConvention,
        geometryKind: geometryKind as ZarrVectorsSkeletonGeometryKind,
        kvStoreRead,
      },
      signal,
    );

    if (decoded === undefined) {
      // Sparse chunk presence — no vertices/<chunk> blob.  Set zero-
      // length buffers so the render layer's draw call short-circuits
      // safely.
      chunk.vertexPositions = new Float32Array(0);
      chunk.indices = new Uint32Array(0);
      chunk.vertexAttributes = attributeNames.map(() => new Float32Array(0));
      return;
    }

    // Pass-1 cross-chunk bridge insertion.  For each cross_chunk_links
    // record incident on this chunk, fetch ONE boundary vertex from the
    // neighbor and append it as a ghost vertex + bridge edge.  Each
    // chunk renders independently with its existing per-chunk-isolated
    // GPU resources, but the visible line is continuous across chunk
    // boundaries.  See the design plan at
    // ~/.claude/plans/i-wanted-you-to-spicy-candy.md (option 3) for
    // the full rationale.
    let withBridges = decoded;
    const table = await this.getCrossChunkLinks(kvStoreRead, signal);
    if (table !== undefined) {
      const { ghostRequests, intraChunkEdges, intraChunkBridges, ghostIsPredecessor } =
        this.buildBridgeRequests(
          table,
          chunkGridPosition,
          decoded.numVertices,
        );
      // Intra-chunk bridges first: both endpoints already live in the
      // chunk's vertex texture, so we just append flat (a, b) pairs to
      // the edges array.  Affects coarser pyramid levels where the
      // writer encodes metavertex-to-metavertex transitions inside one
      // chunk via cross_chunk_links records with same-chunk endpoints.
      if (intraChunkEdges.length > 0) {
        withBridges = appendIntraChunkEdges(withBridges, intraChunkEdges);
      }
      // Cross-chunk bridges next: fetch neighbor boundary data and
      // append ghost vertices with bridge edges.
      const resolvedBridges: ResolvedBridge[] = [...intraChunkBridges];
      if (ghostRequests.length > 0) {
        const ghosts = await fetchGhostVertices(
          ghostRequests,
          {
            rank,
            attributeNames,
            attributeDtypes: attributeDtypes.map(asAttributeDtype),
            kvStoreRead,
          },
          signal,
        );
        if (ghosts.length > 0) {
          // Note: `fetchGhostVertices` drops requests whose neighbor
          // data is missing.  The remaining ghosts are appended in
          // order; ghost `g` lands at chunk-local index
          // `decodedNumVertices + intraChunkAppend + g`.
          //
          // We track each ghost's `isPredecessor` so the resolved
          // bridge points its predecessor/successor sides correctly
          // for tangent accumulation.  Drop alignment with the
          // original requests by matching `ghosts[g].bridgeFromLocalVertex`
          // back to `ghostRequests` — but in practice
          // `fetchGhostVertices` preserves request order; just skip
          // the dropped requests.
          const baseGhostIndex = withBridges.numVertices;
          withBridges = appendGhostVertices(withBridges, ghosts);
          // Walk ghosts and ghostRequests in parallel to build
          // resolved bridges.  Use bridgeFromLocalVertex to match
          // each surviving ghost back to its original request.
          let requestCursor = 0;
          for (let g = 0; g < ghosts.length; ++g) {
            const ghost = ghosts[g];
            // Advance requestCursor to the first request matching this
            // ghost's host vertex.  fetchGhostVertices is order-
            // preserving, so this is monotonic.
            while (
              requestCursor < ghostRequests.length &&
              ghostRequests[requestCursor].hostLocalVertex !== ghost.bridgeFromLocalVertex
            ) {
              requestCursor++;
            }
            if (requestCursor >= ghostRequests.length) break;
            const isPredecessor = ghostIsPredecessor[requestCursor];
            requestCursor++;
            const ghostIdx = baseGhostIndex + g;
            const hostIdx = ghost.bridgeFromLocalVertex;
            resolvedBridges.push({
              predecessorLocalIdx: isPredecessor ? ghostIdx : hostIdx,
              successorLocalIdx: isPredecessor ? hostIdx : ghostIdx,
            });
          }
        }
      }
      // Finally: refresh per-vertex tangents so the default RGB-by-
      // tangent shader gives non-black colors on metavertex centroids
      // at coarser pyramid levels (where `computeTangents` would
      // otherwise leave single-vertex-fragment tangents at zero).
      // Vertices not touched by any bridge keep their existing
      // tangent (correct at level 0 for multi-vertex fragments).
      if (resolvedBridges.length > 0 && withBridges.tangents !== undefined) {
        withBridges = recomputeTangentsForBridges(withBridges, resolvedBridges);
      }
    }

    chunk.vertexPositions = withBridges.positions;
    chunk.indices = withBridges.edges;
    // Order: synthesised tangent first (streamline/polyline only), then
    // user-declared attributes in declaration order.  The frontend
    // shader bridge mirrors this ordering when generating
    // `prop_<name>()` macros.
    const attrs: (Float32Array | Uint8Array | Uint16Array | Uint32Array | Int8Array | Int16Array | Int32Array)[] = [];
    if (withBridges.tangents !== undefined) {
      attrs.push(withBridges.tangents);
    }
    for (const a of withBridges.vertexAttributes) attrs.push(a);
    chunk.vertexAttributes = attrs;
  }
}

/**
 * Compare a cross-chunk endpoint's chunk-coordinates array to a
 * spatial chunk's grid position.  Both inputs are arrays of length
 * ``sid_ndim`` (3 for streamlines).  Returns ``true`` when the two
 * point at the same chunk.
 */
function endpointMatchesChunk(
  endpointCoords: readonly number[],
  selfCoords: readonly number[],
): boolean {
  if (endpointCoords.length !== selfCoords.length) return false;
  for (let i = 0; i < endpointCoords.length; ++i) {
    if (endpointCoords[i] !== selfCoords[i]) return false;
  }
  return true;
}

/**
 * Per-segment (object-keyed) skeleton chunk source — the **pass-2**
 * backing store.  One chunk per `objectId`.  The render layer (a
 * subclass of `SkeletonLayer`) iterates `forEachVisibleSegment` and
 * requests one chunk per visible object_id; this backend resolves each
 * `objectId` against the store's `object_index/manifests` array and
 * aggregates the named fragments across spatial chunks into one
 * merged geometry.
 *
 * Configuration of `numObjects` and `manifestChunkSize` is supplied
 * via the parameter object — the frontend dispatch (slice 4c) reads
 * `object_index/.zattrs` and `object_index/manifests/zarr.json` to fill
 * these fields before constructing the source.
 */
@registerSharedObject()
export class ZarrVectorsObjectKeyedSkeletonSourceBackend extends WithParameters(
  WithSharedKvStoreContextCounterpart(SkeletonSource),
  ZarrVectorsObjectKeyedSkeletonSourceParameters,
) {
  /**
   * Cached decoded ``cross_chunk_links/0/`` table for this level.  Read
   * lazily on the first ``download()`` and reused across all subsequent
   * object downloads — the table is per-level, not per-object.
   *
   * ``null`` means "checked, store has no such table" (older
   * zarr-vectors stores written without ``cross_chunk_strategy =
   * "explicit_links"``).  ``undefined`` means "not yet probed".
   */
  private crossChunkLinks_: CrossChunkLinksTable | null | undefined;

  private async getCrossChunkLinks(
    kvStoreRead: (
      subpath: string,
      signal: AbortSignal,
    ) => Promise<Uint8Array | undefined>,
    signal: AbortSignal,
  ): Promise<CrossChunkLinksTable | undefined> {
    if (this.crossChunkLinks_ !== undefined) {
      return this.crossChunkLinks_ ?? undefined;
    }
    const table = await readCrossChunkLinks({ kvStoreRead }, signal);
    this.crossChunkLinks_ = table ?? null;
    return table;
  }

  async download(chunk: SkeletonChunk, signal: AbortSignal): Promise<void> {
    const {
      baseUrl,
      rank,
      attributeNames,
      attributeDtypes,
      linksConvention,
      geometryKind,
      linkDtype,
    } = this.parameters;
    const kvStoreRead = makeKvStoreRead(baseUrl, this.sharedKvStoreContext);

    // The manifests array's `numObjects` / `chunkSize` aren't carried
    // on the parameter blob (slice 4c will plumb them through from
    // `object_index/.zattrs.num_objects` and the array's `zarr.json`).
    // For now the backend reads them on each download — cheap because
    // the kvstore caches the metadata after the first fetch.
    const { numObjects, chunkSize } = await readManifestArrayShape(
      baseUrl,
      this.sharedKvStoreContext,
      signal,
    );

    const crossChunkLinks = await this.getCrossChunkLinks(kvStoreRead, signal);

    const aggregated = await downloadSegmentSkeleton(
      chunk.objectId,
      {
        manifestReader: {
          numObjects,
          chunkSize,
          sidNdim: rank,
          kvStoreRead,
        },
        rank,
        linkDtype: asLinkDtype(linkDtype),
        attributeNames,
        attributeDtypes: attributeDtypes.map(asAttributeDtype),
        linksConvention: linksConvention as ZarrVectorsLinksConvention,
        geometryKind: geometryKind as ZarrVectorsSkeletonGeometryKind,
        crossChunkLinks,
      },
      signal,
    );

    if (aggregated === undefined) {
      // OID not in the manifest, or every named chunk is missing.
      chunk.vertexPositions = new Float32Array(0);
      chunk.indices = new Uint32Array(0);
      chunk.vertexAttributes = attributeNames.map(() => new Float32Array(0));
      // Every geometry kind with synthesised tangents (streamline,
      // polyline, graph) reserves a tangent slot at index 0 — mirror
      // that here so the render layer's attribute count is consistent
      // across passes even when an OID has no geometry.  See
      // `hasSynthesisedTangent` in `geometry_kind.ts` for the canonical
      // per-kind capability table.
      if (hasSynthesisedTangent(geometryKind as ZarrVectorsSkeletonGeometryKind)) {
        chunk.vertexAttributes = [new Float32Array(0), ...chunk.vertexAttributes];
      }
      return;
    }

    chunk.vertexPositions = aggregated.vertexPositions;
    chunk.indices = aggregated.indices;
    chunk.vertexAttributes = aggregated.vertexAttributes;
  }
}

/**
 * Read `numObjects` and the manifests array's chunk shape from
 * the store's `object_index/.zattrs` and `object_index/manifests/zarr.json`.
 *
 * Centralised here so the per-segment backend has one read path; slice
 * 4c will move this into the frontend dispatch so the values arrive
 * pre-resolved on the parameter blob.
 */
async function readManifestArrayShape(
  baseUrl: string,
  sharedKvStoreContext: {
    kvStoreContext: { read: (url: string, options: { signal: AbortSignal }) => Promise<any> };
  },
  signal: AbortSignal,
): Promise<{ numObjects: number; chunkSize: number }> {
  const arrayMetaUrl = joinBaseUrlAndPath(
    baseUrl,
    "object_index/manifests/zarr.json",
  );
  const response = await sharedKvStoreContext.kvStoreContext.read(arrayMetaUrl, {
    signal,
  });
  if (response === undefined) {
    throw new Error(
      "zarr-vectors object-keyed skeleton: missing object_index/manifests/zarr.json",
    );
  }
  const text = new TextDecoder().decode(
    new Uint8Array((await response.response.arrayBuffer()) as ArrayBuffer),
  );
  const meta = JSON.parse(text);
  const shape = meta.shape;
  const chunkGrid = meta?.chunk_grid;
  if (!Array.isArray(shape) || shape.length !== 1 || typeof shape[0] !== "number") {
    throw new Error(
      "zarr-vectors object_index/manifests: shape must be a 1-D array of one integer",
    );
  }
  const numObjects = shape[0];
  // Zarr v3 regular chunk grid: chunk_grid.configuration.chunk_shape
  const chunkShape =
    chunkGrid?.configuration?.chunk_shape ?? chunkGrid?.chunk_shape;
  if (!Array.isArray(chunkShape) || chunkShape.length !== 1) {
    throw new Error(
      "zarr-vectors object_index/manifests: missing or non-1-D chunk_shape",
    );
  }
  const chunkSize = chunkShape[0];
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(
      `zarr-vectors object_index/manifests: invalid chunk_shape ${JSON.stringify(chunkShape)}`,
    );
  }
  return { numObjects, chunkSize };
}
