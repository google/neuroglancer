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
  const vertexAttributes: AttributeTypedArray[] = await Promise.all(
    attributeNames.map(async (name, i) => {
      const bytes = await kvStoreRead(
        `vertex_attributes/${name}/${chunkKey}/c/0`,
        signal,
      );
      if (bytes === undefined) {
        throw new Error(
          `zarr-vectors chunk ${chunkKey} has vertices but ` +
            `vertex_attributes/${name} is missing`,
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
