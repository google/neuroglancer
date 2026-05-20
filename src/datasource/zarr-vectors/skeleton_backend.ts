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
import {
  downloadSkeletonChunk,
  type AttributeDtype,
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

    chunk.vertexPositions = decoded.positions;
    chunk.indices = decoded.edges;
    // Order: synthesised tangent first (streamline/polyline only), then
    // user-declared attributes in declaration order.  The frontend
    // shader bridge mirrors this ordering when generating
    // `prop_<name>()` macros.
    const attrs: (Float32Array | Uint8Array | Uint16Array | Uint32Array | Int8Array | Int16Array | Int32Array)[] = [];
    if (decoded.tangents !== undefined) {
      attrs.push(decoded.tangents);
    }
    for (const a of decoded.vertexAttributes) attrs.push(a);
    chunk.vertexAttributes = attrs;
  }
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
      // For streamline / polyline kinds, the spatially-indexed source
      // also prepends a tangent attribute slot; mirror that here so
      // the render layer's attribute count is consistent across passes
      // even when an OID has no geometry.
      if (geometryKind === "streamline" || geometryKind === "polyline") {
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
