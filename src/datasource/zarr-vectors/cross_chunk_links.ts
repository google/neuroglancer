/**
 * @license
 * Copyright 2026 Allen Institute for Brain Science
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

/**
 * Read and decode the ``cross_chunk_links/<delta>/`` table emitted by
 * zarr-vectors writers under the ``"explicit_links"`` cross-chunk
 * strategy.
 *
 * Each record holds ``link_width`` endpoints; each endpoint is
 * ``sid_ndim + 1`` int64 values laid out as
 * ``[chunk_coord_0, …, chunk_coord_{sid_ndim-1}, local_vertex_index]``.
 *
 * Storage layout on disk (see
 * ``zarr-vectors-py/zarr_vectors/core/arrays.py:write_cross_chunk_links``):
 *
 * ``cross_chunk_links/<delta>/zarr.json``      — group metadata holding
 *     ``link_width``, ``num_links``, ``sid_ndim``.
 * ``cross_chunk_links/<delta>/data/zarr.json`` — 1-D ``uint8`` zarr
 *     array spec (single chunk).
 * ``cross_chunk_links/<delta>/data/c/0``       — raw byte blob; the
 *     bytes are an int64 array concatenated record-major:
 *     ``records[i].endpoints[j].chunkCoords[k]`` followed by
 *     ``records[i].endpoints[j].vertexIndex``.
 *
 * For the pass-2 streamline path (``link_width = 2``) the records
 * encode the cross-chunk edges that bridge fragments split at chunk
 * boundaries.  The pass-2 segment aggregator filters them to just the
 * edges whose endpoints both land in the current object's owned
 * vertices.
 */

/** One endpoint of a cross-chunk record. */
export interface CrossChunkLinkEndpoint {
  /** Length-``sidNdim`` chunk-grid coordinates of the endpoint's chunk. */
  readonly chunkCoords: number[];
  /** 0-based vertex index inside that chunk's ``vertices/`` array. */
  readonly vertexIndex: number;
}

/** One ``link_width``-arity cross-chunk record. */
export interface CrossChunkLinkRecord {
  readonly endpoints: CrossChunkLinkEndpoint[];
}

/** Whole table for one ``(level, delta)`` pair. */
export interface CrossChunkLinksTable {
  readonly linkWidth: number;
  readonly sidNdim: number;
  readonly records: CrossChunkLinkRecord[];
}

/**
 * Configuration for {@link readCrossChunkLinks}.  Lets callers
 * substitute a kvstore reader at the test boundary.
 */
export interface CrossChunkLinksReaderOptions {
  /**
   * Reads one byte blob relative to the resolution-level base URL.
   * Returns ``undefined`` for missing keys; mirrors the callback
   * convention used by ``downloadSkeletonChunk`` and ``readObjectManifest``.
   */
  readonly kvStoreRead: (
    subpath: string,
    signal: AbortSignal,
  ) => Promise<Uint8Array | undefined>;
  /** Level delta; 0 for intra-level, ±N for cross-level pyramids. */
  readonly delta?: number;
}

/**
 * Parse a flat int64 byte blob into structured records.  Exported so
 * tests can drive the decoder with hand-crafted byte fixtures.
 */
export function decodeCrossChunkLinks(
  bytes: Uint8Array,
  linkWidth: number,
  sidNdim: number,
): CrossChunkLinkRecord[] {
  if (linkWidth < 1) {
    throw new Error(
      `cross_chunk_links: link_width must be >= 1; got ${linkWidth}`,
    );
  }
  if (sidNdim < 1) {
    throw new Error(`cross_chunk_links: sid_ndim must be >= 1; got ${sidNdim}`);
  }
  // BigInt64 view onto the bytes; each int64 is one chunk coord or one
  // vertex index.  Realigned to a fresh buffer if the caller's bytes
  // aren't 8-byte aligned at offset 0.
  const aligned = bytes.byteOffset % 8 === 0 ? bytes : new Uint8Array(bytes); // copy realigns
  const i64 = new BigInt64Array(
    aligned.buffer,
    aligned.byteOffset,
    aligned.byteLength >>> 3,
  );
  const endpointStride = sidNdim + 1;
  const recordStride = linkWidth * endpointStride;
  if (i64.length % recordStride !== 0) {
    throw new Error(
      `cross_chunk_links: byte blob ${bytes.byteLength} bytes is not a ` +
        `multiple of one record (${recordStride} int64 = ` +
        `${recordStride * 8} bytes)`,
    );
  }
  const numRecords = i64.length / recordStride;
  const records: CrossChunkLinkRecord[] = [];
  for (let r = 0; r < numRecords; ++r) {
    const recBase = r * recordStride;
    const endpoints: CrossChunkLinkEndpoint[] = [];
    for (let e = 0; e < linkWidth; ++e) {
      const epBase = recBase + e * endpointStride;
      const chunkCoords: number[] = [];
      for (let d = 0; d < sidNdim; ++d) {
        chunkCoords.push(Number(i64[epBase + d]));
      }
      const vertexIndex = Number(i64[epBase + sidNdim]);
      endpoints.push({ chunkCoords, vertexIndex });
    }
    records.push({ endpoints });
  }
  return records;
}

/**
 * Fetch + decode ``cross_chunk_links/<delta>/`` for one resolution
 * level.  Returns ``undefined`` if the group is absent (older stores
 * without the ``explicit_links`` cross-chunk strategy).
 */
export async function readCrossChunkLinks(
  options: CrossChunkLinksReaderOptions,
  signal: AbortSignal,
): Promise<CrossChunkLinksTable | undefined> {
  const { kvStoreRead, delta = 0 } = options;
  const base = `cross_chunk_links/${delta}`;

  // 1. Group metadata: link_width, num_links, sid_ndim.
  const groupMetaBytes = await kvStoreRead(`${base}/zarr.json`, signal);
  if (groupMetaBytes === undefined) {
    // Older stores have no cross-chunk-links blob — silent absence.
    return undefined;
  }
  let groupMeta: any;
  try {
    groupMeta = JSON.parse(new TextDecoder().decode(groupMetaBytes));
  } catch (e) {
    throw new Error(
      `cross_chunk_links/${delta}/zarr.json: invalid JSON: ${(e as Error).message}`,
    );
  }
  const attrs = groupMeta?.attributes;
  if (attrs === undefined) {
    throw new Error(
      `cross_chunk_links/${delta}/zarr.json: missing 'attributes' object`,
    );
  }
  const linkWidth = Number(attrs.link_width);
  const numLinks = Number(attrs.num_links ?? 0);
  if (!Number.isInteger(linkWidth) || linkWidth < 1) {
    throw new Error(
      `cross_chunk_links/${delta}: invalid link_width ${attrs.link_width}`,
    );
  }

  // A linkless table needs no `sid_ndim` (there are no chunk-coord tuples
  // to decode).  Coarse pyramid levels with zero cross-chunk links never
  // get `sid_ndim` stamped — the writer only stamps it when it writes
  // records — so tolerate its absence here and return an empty table.
  const sidNdimRaw = Number(attrs.sid_ndim);
  if (numLinks === 0) {
    return {
      linkWidth,
      sidNdim: Number.isInteger(sidNdimRaw) && sidNdimRaw >= 1 ? sidNdimRaw : 0,
      records: [],
    };
  }
  const sidNdim = sidNdimRaw;
  if (!Number.isInteger(sidNdim) || sidNdim < 1) {
    throw new Error(
      `cross_chunk_links/${delta}: invalid sid_ndim ${attrs.sid_ndim}`,
    );
  }

  // 2. Raw byte blob.
  const blob = await kvStoreRead(`${base}/data/c/0`, signal);
  if (blob === undefined || blob.byteLength === 0) {
    return { linkWidth, sidNdim, records: [] };
  }
  const records = decodeCrossChunkLinks(blob, linkWidth, sidNdim);
  if (records.length !== numLinks) {
    throw new Error(
      `cross_chunk_links/${delta}: zarr.json reports num_links=${numLinks} ` +
        `but data blob decoded into ${records.length} records`,
    );
  }
  return { linkWidth, sidNdim, records };
}
