/**
 * @license
 * Copyright 2026 Allen Institute for Brain Science
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

/**
 * Read one per-object manifest from a zarr-vectors store's
 * `object_index/manifests/` array.
 *
 * The array is a 1-D zarr v3 vlen-bytes array of shape `(numObjects,)`
 * and chunk-shape `(chunkSize,)` (`chunkSize` defaults to 16384 in
 * zarr-vectors-py).  To fetch the manifest for object_id `oid`:
 *
 *   1. Compute `chunkIndex = oid / chunkSize` and `withinChunk = oid % chunkSize`.
 *   2. Fetch and (if needed) decompress the chunk at
 *      `object_index/manifests/c/<chunkIndex>`.
 *   3. Decode the chunk via `decodeVlenBytesChunk` and pull element
 *      `[withinChunk]` — the per-object manifest blob.
 *   4. Decode that blob with `decodeObjectManifest` to get the list of
 *      `(chunkCoords, fragmentRef)` blocks.
 *
 * Returns `undefined` for object IDs that are absent from the store
 * (out of bounds, or no chunk file for the containing range — sparse
 * chunk presence).  Throws for malformed data.
 */

import {
  decodeObjectManifest,
  type ManifestBlock,
} from "#src/datasource/zarr-vectors/object_manifest.js";
import {
  readVlenBytesElement,
} from "#src/datasource/zarr-vectors/vlen_bytes.js";

export interface ObjectManifestReaderOptions {
  /** Total number of objects in the store (manifests array shape[0]). */
  readonly numObjects: number;
  /** Chunk size of the manifests array (typically 16384). */
  readonly chunkSize: number;
  /** Spatial-index dimensionality (== rank of vertex positions). */
  readonly sidNdim: number;
  /**
   * Fetch one byte blob relative to the level group.  Resolves to the
   * decompressed bytes, or `undefined` if the key is missing.  The
   * caller is responsible for joining the base URL and for running any
   * outer-codec decompression (the vlen-bytes layer itself is *inside*
   * the codec pipeline, so the bytes the decoder sees are already
   * decompressed).
   */
  readonly kvStoreRead: (
    subpath: string,
    signal: AbortSignal,
  ) => Promise<Uint8Array | undefined>;
}

/**
 * Read the manifest for one object_id.  Returns `undefined` when the
 * OID is out of bounds or the array chunk that would contain it is not
 * materialised on disk.
 */
export async function readObjectManifest(
  oid: number | bigint,
  options: ObjectManifestReaderOptions,
  signal: AbortSignal,
): Promise<ManifestBlock[] | undefined> {
  const { numObjects, chunkSize, sidNdim, kvStoreRead } = options;
  if (chunkSize <= 0) {
    throw new Error(`readObjectManifest: chunkSize must be > 0, got ${chunkSize}`);
  }
  const oidNum = typeof oid === "bigint" ? Number(oid) : oid;
  if (!Number.isInteger(oidNum) || oidNum < 0) {
    throw new Error(
      `readObjectManifest: object_id must be a non-negative integer, got ${oid}`,
    );
  }
  if (oidNum >= numObjects) return undefined;

  const chunkIndex = Math.floor(oidNum / chunkSize);
  const withinChunk = oidNum % chunkSize;

  const chunkBytes = await kvStoreRead(
    `object_index/manifests/c/${chunkIndex}`,
    signal,
  );
  if (chunkBytes === undefined) return undefined;

  // The manifests chunk encodes up to `chunkSize` elements; the last
  // chunk may hold fewer (when `numObjects` is not a multiple of
  // `chunkSize`).  `readVlenBytesElement` throws RangeError if the
  // chunk has fewer elements than `withinChunk` — propagate as
  // "this OID is absent" rather than a hard failure, because the
  // sparse-chunk story applies element-by-element too.
  let manifestBytes: Uint8Array;
  try {
    manifestBytes = readVlenBytesElement(chunkBytes, withinChunk);
  } catch (e) {
    if (e instanceof RangeError) return undefined;
    throw e;
  }
  return decodeObjectManifest(manifestBytes, sidNdim);
}
