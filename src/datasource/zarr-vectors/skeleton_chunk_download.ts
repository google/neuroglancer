/**
 * @license
 * Copyright 2026 Allen Institute for Brain Science
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

/**
 * Worker-side orchestrator: fetch the byte blobs for one spatial chunk
 * of a zarr-vectors skeleton / polyline / streamline store and decode
 * them into a `SkeletonChunk` ready for upload to the render layer.
 *
 * This module is deliberately decoupled from neuroglancer's SharedObject
 * / RPC scaffolding so it can be unit-tested with a mock kvstore.  The
 * slice-4 chunk-source backend will provide a real kvstore reader from
 * `SharedKvStoreContext` and forward the result.
 */

import { decodeFragments } from "#src/datasource/zarr-vectors/fragment_index.js";
import {
  buildSkeletonChunk,
  type AttributeTypedArray,
  type GhostVertexRecord,
  type LinksConvention,
  type SkeletonChunk,
  type SkeletonGeometryKind,
} from "#src/datasource/zarr-vectors/skeleton_chunk.js";

/** Supported on-disk integer dtype for `links/0/<chunk>`. */
export type LinkDtype =
  | "uint8"
  | "uint16"
  | "uint32"
  | "int8"
  | "int16"
  | "int32"
  | "int64";

/** Supported on-disk dtype for a per-vertex attribute. */
export type AttributeDtype =
  | "float32"
  | "uint8"
  | "uint16"
  | "uint32"
  | "int8"
  | "int16"
  | "int32";

/**
 * Inputs the orchestrator needs to download a chunk.
 *
 * The caller is responsible for joining `baseUrl + "<sub-path>"` to form
 * the actual fetch URLs and for any decompression (zstd) before handing
 * raw bytes to the decoder via the `kvStoreRead` callback.
 *
 * `kvStoreRead` returns `undefined` for a missing key (sparse chunk
 * presence) — the orchestrator interprets that as "no data here" and
 * returns an empty `SkeletonChunk` when even the vertex blob is absent.
 */
export interface SkeletonChunkDownloadOptions {
  /** Spatial chunk key, e.g. `"3.0.2"`. */
  readonly chunkKey: string;
  /** Rank of the position vectors (== sid_ndim). */
  readonly rank: number;
  /**
   * On-disk dtype of `links/0/<chunk>` (per `.zattrs.dtype`); used to
   * reinterpret link bytes correctly.  Not consulted for
   * `implicit_sequential` stores (which don't have a `links/0` array).
   */
  readonly linkDtype: LinkDtype;
  /** Per-vertex attribute names, in the order the render layer expects. */
  readonly attributeNames: readonly string[];
  /** Per-vertex attribute dtypes, parallel to `attributeNames`. */
  readonly attributeDtypes: readonly AttributeDtype[];
  /** How vertex-to-vertex edges are encoded for this geometry type. */
  readonly linksConvention: LinksConvention;
  /** Geometry kind (drives whether per-vertex tangents are precomputed). */
  readonly geometryKind: SkeletonGeometryKind;
  /**
   * Async key-value-store read.  Resolves to a decompressed byte buffer,
   * or `undefined` if the key is absent (sparse chunk presence).  The
   * `subpath` is relative to the level group, e.g.
   * `"vertices/3.0.2/c/0"`.
   */
  readonly kvStoreRead: (
    subpath: string,
    signal: AbortSignal,
  ) => Promise<Uint8Array | undefined>;
}

/** Number of bytes per element of an attribute / link dtype. */
const BYTES_PER_ELEMENT: Record<LinkDtype | AttributeDtype, number> = {
  float32: 4,
  uint8: 1,
  uint16: 2,
  uint32: 4,
  int8: 1,
  int16: 2,
  int32: 4,
  int64: 8,
};

const ATTRIBUTE_CTORS: Record<
  AttributeDtype,
  | Float32ArrayConstructor
  | Uint8ArrayConstructor
  | Uint16ArrayConstructor
  | Uint32ArrayConstructor
  | Int8ArrayConstructor
  | Int16ArrayConstructor
  | Int32ArrayConstructor
> = {
  float32: Float32Array,
  uint8: Uint8Array,
  uint16: Uint16Array,
  uint32: Uint32Array,
  int8: Int8Array,
  int16: Int16Array,
  int32: Int32Array,
};

/**
 * Reinterpret a byte blob as a typed array of the given dtype.  Returns
 * a possibly-aligned view (zero-copy when the source buffer is aligned
 * to the element size) or a copy when alignment forbids the in-place
 * view.  Throws if the byte length is not a multiple of the dtype size.
 */
function reinterpretBytes(
  bytes: Uint8Array,
  dtype: AttributeDtype,
  expectedElements: number,
): AttributeTypedArray {
  const elementSize = BYTES_PER_ELEMENT[dtype];
  const expectedBytes = expectedElements * elementSize;
  if (bytes.byteLength !== expectedBytes) {
    throw new Error(
      `zarr-vectors chunk: dtype=${dtype} expected ${expectedBytes} bytes ` +
        `(${expectedElements} elements), got ${bytes.byteLength}`,
    );
  }
  const Ctor = ATTRIBUTE_CTORS[dtype];
  if (bytes.byteOffset % elementSize === 0) {
    return new (Ctor as any)(bytes.buffer, bytes.byteOffset, expectedElements);
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new (Ctor as any)(copy.buffer, 0, expectedElements);
}

/** Widen any integer dtype's link buffer to chunk-local `Uint32Array`. */
function reinterpretLinkBytes(
  bytes: Uint8Array,
  dtype: LinkDtype,
  numEdges: number,
  linkWidth: number,
): Uint32Array {
  const elementSize = BYTES_PER_ELEMENT[dtype];
  const expectedBytes = numEdges * linkWidth * elementSize;
  if (bytes.byteLength !== expectedBytes) {
    throw new Error(
      `zarr-vectors links chunk: dtype=${dtype} link_width=${linkWidth} ` +
        `expected ${expectedBytes} bytes (${numEdges} edges), got ${bytes.byteLength}`,
    );
  }
  const total = numEdges * linkWidth;
  const out = new Uint32Array(total);
  if (dtype === "int64") {
    const aligned =
      bytes.byteOffset % 8 === 0
        ? new BigInt64Array(bytes.buffer, bytes.byteOffset, total)
        : (() => {
            const copy = new Uint8Array(bytes.byteLength);
            copy.set(bytes);
            return new BigInt64Array(copy.buffer, 0, total);
          })();
    for (let i = 0; i < total; ++i) out[i] = Number(aligned[i]);
    return out;
  }
  const arr = reinterpretBytes(bytes, dtype, total);
  // Copy across to Uint32Array — narrow uints widen losslessly,
  // signed types may carry negative values (rejected upstream by writer).
  for (let i = 0; i < total; ++i) out[i] = arr[i];
  return out;
}

/**
 * Download and decode one spatial chunk into a `SkeletonChunk`.
 *
 * Reads (relative paths under the level group):
 *   - `vertices/<key>/c/0`         — required for non-empty chunks.
 *   - `vertex_fragments/<key>/c/0` — required for non-empty chunks.
 *   - `links/0/<key>/c/0`          — required unless `linksConvention === "implicit_sequential"`.
 *   - `vertex_attributes/<name>/<key>/c/0` — one per declared attribute name.
 *
 * Returns `undefined` when the chunk's `vertices/` blob is absent (the
 * canonical "this chunk has no data" signal).  Throws on any partially-
 * present chunk (vertices but missing fragments, or fragments but
 * missing edges in the explicit-edge cases).
 */
export async function downloadSkeletonChunk(
  options: SkeletonChunkDownloadOptions,
  signal: AbortSignal,
): Promise<SkeletonChunk | undefined> {
  const {
    chunkKey,
    rank,
    linkDtype,
    attributeNames,
    attributeDtypes,
    linksConvention,
    geometryKind,
    kvStoreRead,
  } = options;
  if (attributeNames.length !== attributeDtypes.length) {
    throw new Error(
      `downloadSkeletonChunk: attributeNames (${attributeNames.length}) ` +
        `and attributeDtypes (${attributeDtypes.length}) length mismatch`,
    );
  }

  // 1. Vertices — required.
  const vertexBytes = await kvStoreRead(`vertices/${chunkKey}/c/0`, signal);
  if (vertexBytes === undefined || vertexBytes.byteLength === 0) {
    return undefined;
  }
  const bytesPerVertex = rank * 4; // float32
  if (vertexBytes.byteLength % bytesPerVertex !== 0) {
    throw new Error(
      `zarr-vectors vertices/${chunkKey}: ${vertexBytes.byteLength} bytes ` +
        `not a multiple of ${bytesPerVertex} (rank=${rank} * float32)`,
    );
  }
  const numVertices = vertexBytes.byteLength / bytesPerVertex;
  const positions = reinterpretBytes(
    vertexBytes,
    "float32",
    numVertices * rank,
  ) as Float32Array;

  // 2. Fragment index — required.
  const fragmentBytes = await kvStoreRead(
    `vertex_fragments/${chunkKey}/c/0`,
    signal,
  );
  if (fragmentBytes === undefined) {
    throw new Error(
      `zarr-vectors chunk ${chunkKey} has vertices but vertex_fragments is missing`,
    );
  }
  const fragmentIndex = decodeFragments(fragmentBytes);

  // 3. Explicit edges (links/0/<key>/c/0) — required for explicit /
  // implicit_sequential_with_branches, absent for pure implicit_sequential.
  let explicitEdges: Uint32Array | undefined;
  if (
    linksConvention === "explicit" ||
    linksConvention === "implicit_sequential_with_branches"
  ) {
    const linkBytes = await kvStoreRead(`links/0/${chunkKey}/c/0`, signal);
    if (linkBytes === undefined || linkBytes.byteLength === 0) {
      // implicit_sequential_with_branches with no explicit branches in
      // this chunk is legitimate (a leaf-only sub-skeleton).
      explicitEdges = new Uint32Array(0);
    } else {
      const elementSize = BYTES_PER_ELEMENT[linkDtype];
      const totalElements = linkBytes.byteLength / elementSize;
      if (totalElements % 2 !== 0) {
        throw new Error(
          `zarr-vectors links/0/${chunkKey}: ${totalElements} elements is ` +
            `not a multiple of link_width=2`,
        );
      }
      const numEdges = totalElements / 2;
      explicitEdges = reinterpretLinkBytes(linkBytes, linkDtype, numEdges, 2);
    }
  }

  // 4. Per-vertex attributes — one fetch per declared attribute name.
  // A missing per-chunk attribute blob is tolerated and degrades to a
  // zero-filled array of the declared dtype.  Two situations trigger
  // this in practice:
  //
  //   - The writer's pyramid coarsening doesn't propagate
  //     `vertex_attributes/<name>/` to higher levels (see
  //     `zarr-vectors-py multiresolution/coarsen.py`); coarser levels
  //     have vertices but no attribute arrays.
  //   - Future writers may emit attributes sparsely (per-chunk
  //     opt-in).
  //
  // The user-visible effect is `prop_<name>()` evaluating to 0 inside
  // the shader for chunks without that attribute.  This matches how
  // the spatially-indexed skeleton shader handles "this segment has no
  // value" elsewhere and avoids cascading layer failures from a
  // single missing optional blob.
  const vertexAttributes: AttributeTypedArray[] = await Promise.all(
    attributeNames.map(async (name, i) => {
      const bytes = await kvStoreRead(
        `vertex_attributes/${name}/${chunkKey}/c/0`,
        signal,
      );
      if (bytes === undefined) {
        return reinterpretBytes(
          new Uint8Array(numVertices * BYTES_PER_ELEMENT[attributeDtypes[i]]),
          attributeDtypes[i],
          numVertices,
        );
      }
      return reinterpretBytes(bytes, attributeDtypes[i], numVertices);
    }),
  );

  return buildSkeletonChunk({
    rank,
    positions,
    fragmentIndex,
    explicitEdges,
    linksConvention,
    geometryKind,
    vertexAttributes,
  });
}

/**
 * One request for a ghost vertex.  `hostLocalVertex` identifies the
 * endpoint in the current chunk; `neighborChunkKey` + `neighborLocalVertex`
 * identify the source vertex in a different chunk to copy into the host.
 */
export interface GhostVertexRequest {
  readonly hostLocalVertex: number;
  readonly neighborChunkKey: string;
  readonly neighborLocalVertex: number;
  /**
   * True when the neighbor's vertex precedes the host in the
   * streamline's walk order.  Forwarded onto the resulting
   * `GhostVertexRecord` so `appendGhostVertices` can flip the
   * synthesised ghost-tangent sign accordingly.  Defaults to `false`
   * (ghost is the successor) when callers don't specify it.
   */
  readonly isGhostPredecessor?: boolean;
}

/**
 * Slice a single float32×rank vertex out of a `vertices/<key>/c/0` byte
 * blob.  Returns `undefined` when the requested index is out of range —
 * caller drops the ghost in that case (avoids dangling references on
 * sparse / writer-inconsistent stores).
 */
function sliceVertexFromBytes(
  bytes: Uint8Array,
  vertexIndex: number,
  rank: number,
): Float32Array | undefined {
  const bytesPerVertex = rank * 4;
  const offset = vertexIndex * bytesPerVertex;
  if (vertexIndex < 0 || offset + bytesPerVertex > bytes.byteLength) {
    return undefined;
  }
  // Reinterpret a `rank`-element float32 slice.  Subarray gives a
  // zero-copy view; reinterpretBytes handles alignment.
  return reinterpretBytes(
    bytes.subarray(offset, offset + bytesPerVertex),
    "float32",
    rank,
  ) as Float32Array;
}

/**
 * Slice a single attribute element from a `vertex_attributes/<name>/<key>/c/0`
 * byte blob, packaged as a length-1 typed-array of the declared dtype.
 * Returns `undefined` when the requested index is out of range.
 */
function sliceAttributeFromBytes(
  bytes: Uint8Array,
  vertexIndex: number,
  dtype: AttributeDtype,
): AttributeTypedArray | undefined {
  const elementSize = BYTES_PER_ELEMENT[dtype];
  const offset = vertexIndex * elementSize;
  if (vertexIndex < 0 || offset + elementSize > bytes.byteLength) {
    return undefined;
  }
  return reinterpretBytes(
    bytes.subarray(offset, offset + elementSize),
    dtype,
    1,
  );
}

/**
 * Fetch + slice one ghost vertex per request, grouping by
 * `neighborChunkKey` so each unique neighbor's `vertices/` and per-
 * attribute files are fetched exactly once.  Subsequent fetches for the
 * same key are served from the kvstore cache (and when the neighbor
 * loads as its own render chunk, every byte is already cached — the
 * "prefetch" reorders work rather than adding net traffic).
 *
 * Requests whose neighbor's `vertices/` blob is absent are silently
 * dropped (sparse chunk presence; we never emit a dangling reference).
 * Requests whose `vertex_attributes/<name>/` blob is absent get a
 * zero-filled value for that attribute — same rule the per-chunk
 * download applies for pyramid levels that don't propagate attributes.
 */
export async function fetchGhostVertices(
  requests: readonly GhostVertexRequest[],
  options: {
    readonly rank: number;
    readonly attributeNames: readonly string[];
    readonly attributeDtypes: readonly AttributeDtype[];
    readonly kvStoreRead: SkeletonChunkDownloadOptions["kvStoreRead"];
  },
  signal: AbortSignal,
): Promise<GhostVertexRecord[]> {
  const { rank, attributeNames, attributeDtypes, kvStoreRead } = options;
  if (requests.length === 0) return [];

  // 1. Group by neighbor chunk key — one fetch per unique key per file.
  const uniqueKeys = Array.from(new Set(requests.map((r) => r.neighborChunkKey)));

  // 2. Fetch positions + each attribute for each unique key in parallel.
  type NeighborBlobs = {
    positions: Uint8Array | undefined;
    attrs: Array<Uint8Array | undefined>;
  };
  const byKey = new Map<string, NeighborBlobs>();
  await Promise.all(
    uniqueKeys.map(async (key) => {
      const [positions, ...attrs] = await Promise.all([
        kvStoreRead(`vertices/${key}/c/0`, signal),
        ...attributeNames.map((name) =>
          kvStoreRead(`vertex_attributes/${name}/${key}/c/0`, signal),
        ),
      ]);
      byKey.set(key, { positions, attrs });
    }),
  );

  // 3. Slice each request's element.  Drop requests whose neighbor
  // positions blob is absent (sparse chunk) or whose vertex index is
  // out of range — these would otherwise create dangling bridge edges.
  const out: GhostVertexRecord[] = [];
  for (const req of requests) {
    const blobs = byKey.get(req.neighborChunkKey);
    if (blobs === undefined || blobs.positions === undefined) continue;
    const position = sliceVertexFromBytes(
      blobs.positions,
      req.neighborLocalVertex,
      rank,
    );
    if (position === undefined) continue;
    const attributes: AttributeTypedArray[] = [];
    for (let i = 0; i < attributeNames.length; ++i) {
      const bytes = blobs.attrs[i];
      const sliced =
        bytes === undefined
          ? undefined
          : sliceAttributeFromBytes(bytes, req.neighborLocalVertex, attributeDtypes[i]);
      if (sliced === undefined) {
        // Zero-fill missing attribute — mirrors `downloadSkeletonChunk`
        // behavior for chunk-local attributes (pyramid levels without
        // `vertex_attributes/<name>/`).
        attributes.push(
          reinterpretBytes(
            new Uint8Array(BYTES_PER_ELEMENT[attributeDtypes[i]]),
            attributeDtypes[i],
            1,
          ),
        );
      } else {
        attributes.push(sliced);
      }
    }
    out.push({
      position,
      attributes,
      bridgeFromLocalVertex: req.hostLocalVertex,
      isGhostPredecessor: req.isGhostPredecessor ?? false,
    });
  }
  return out;
}
