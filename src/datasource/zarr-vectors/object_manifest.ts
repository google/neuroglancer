/**
 * @license
 * Copyright 2026 Allen Institute for Brain Science
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

/**
 * Decoder for the per-object manifest blob format used by zarr-vectors
 * `object_index/manifests/<chunk>`.  Each element of the vlen-bytes zarr
 * array is one **per-object manifest**: a sequence of per-chunk *blocks*
 * naming where the object's fragments live.
 *
 * Layout (all little-endian):
 *
 *   uint32 num_blocks B
 *   per block:
 *     int64 chunk_coords[sid_ndim]
 *     uint8 mode
 *       mode = 0 (single):    int64 fragment_index
 *       mode = 1 (range):     int64 start, int64 count
 *       mode = 2 (explicit):  uint32 count, int64 fragment_indices[count]
 *
 * Fragment references are **chunk-local** — they index into the
 * `vertex_fragments/<chunk_coords>` array of the block's named chunk only.
 * An empty manifest is 4 bytes (B = 0).
 *
 * See the zarr-vectors spec §7.6 "Per-object manifest block format
 * (shared)" for the canonical specification.
 */

export const MANIFEST_MODE_SINGLE = 0;
export const MANIFEST_MODE_RANGE = 1;
export const MANIFEST_MODE_EXPLICIT = 2;

/**
 * A single fragment reference within one chunk of an object's manifest.
 *
 * - `mode === "single"`: one fragment, by index.
 * - `mode === "range"`: a contiguous run `[start, start + count)` of
 *   fragment indices.
 * - `mode === "explicit"`: an arbitrary list of fragment indices.
 *
 * Fragment indices are local to the named chunk's
 * `vertex_fragments/<chunk_coords>` array.
 */
export type ManifestFragmentRef =
  | { mode: "single"; fragmentIndex: number }
  | { mode: "range"; start: number; count: number }
  | { mode: "explicit"; indices: Uint32Array };

/**
 * One block of a per-object manifest: a chunk's coordinates plus the
 * fragment references the object owns inside that chunk.
 */
export interface ManifestBlock {
  /** Chunk grid coordinates (length === sid_ndim). */
  readonly chunkCoords: number[];
  /** Which fragments of `vertex_fragments/<chunkCoords>` belong to this object. */
  readonly fragmentRef: ManifestFragmentRef;
}

/**
 * Decode one per-object manifest blob into its constituent blocks.
 *
 * @param raw  The raw bytes of one element from the
 *             `object_index/manifests` zarr array.
 * @param sidNdim  Spatial-index dimensionality (== rank of vertex
 *             positions).  Per-chunk coords are `sidNdim × int64`.
 *
 * Throws on bad layout: truncation, unknown mode tag, or trailing bytes.
 */
export function decodeObjectManifest(
  raw: ArrayBufferView | ArrayBuffer,
  sidNdim: number,
): ManifestBlock[] {
  if (sidNdim < 1) {
    throw new Error(
      `decodeObjectManifest: sid_ndim must be >= 1, got ${sidNdim}`,
    );
  }

  const u8 =
    raw instanceof ArrayBuffer
      ? new Uint8Array(raw)
      : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  if (view.byteLength < 4) {
    throw new Error(`Manifest blob too short: ${view.byteLength} < 4 (header)`);
  }

  const numBlocks = view.getUint32(0, /* littleEndian */ true);
  const coordsBytes = sidNdim * 8;
  let offset = 4;
  const blocks: ManifestBlock[] = [];

  for (let b = 0; b < numBlocks; ++b) {
    if (view.byteLength < offset + coordsBytes + 1) {
      throw new Error(
        `Manifest blob truncated at block ${b} header (need ${coordsBytes + 1} bytes)`,
      );
    }
    const chunkCoords: number[] = new Array(sidNdim);
    for (let i = 0; i < sidNdim; ++i) {
      // chunk_coords are int64.  Coords are small (chunk-grid indices),
      // so the loss when narrowing to Number is fine in practice and
      // matches the existing zarr-vectors chunkGridPosition idiom.  If
      // a coord is genuinely > 2^53 we'd have other problems first.
      chunkCoords[i] = Number(view.getBigInt64(offset, true));
      offset += 8;
    }
    const mode = view.getUint8(offset);
    offset += 1;

    let fragmentRef: ManifestFragmentRef;
    switch (mode) {
      case MANIFEST_MODE_SINGLE: {
        if (view.byteLength < offset + 8) {
          throw new Error(
            `Manifest blob truncated in single-mode payload (block ${b})`,
          );
        }
        const idx = Number(view.getBigInt64(offset, true));
        offset += 8;
        if (idx < 0) {
          throw new Error(
            `Manifest single-mode fragment_index must be >= 0, got ${idx} (block ${b})`,
          );
        }
        fragmentRef = { mode: "single", fragmentIndex: idx };
        break;
      }
      case MANIFEST_MODE_RANGE: {
        if (view.byteLength < offset + 16) {
          throw new Error(
            `Manifest blob truncated in range-mode payload (block ${b})`,
          );
        }
        const start = Number(view.getBigInt64(offset, true));
        const count = Number(view.getBigInt64(offset + 8, true));
        offset += 16;
        if (count < 0) {
          throw new Error(
            `Manifest range-mode count must be >= 0, got ${count} (block ${b})`,
          );
        }
        fragmentRef = { mode: "range", start, count };
        break;
      }
      case MANIFEST_MODE_EXPLICIT: {
        if (view.byteLength < offset + 4) {
          throw new Error(
            `Manifest blob truncated in explicit-mode header (block ${b})`,
          );
        }
        const count = view.getUint32(offset, true);
        offset += 4;
        const indicesBytes = count * 8;
        if (view.byteLength < offset + indicesBytes) {
          throw new Error(
            `Manifest blob truncated in explicit-mode indices (block ${b}, need ${indicesBytes} bytes for ${count} indices)`,
          );
        }
        const indices = new Uint32Array(count);
        for (let i = 0; i < count; ++i) {
          const v = view.getBigInt64(offset + i * 8, true);
          if (v < 0n) {
            throw new Error(
              `Manifest explicit indices must be >= 0, got ${v} (block ${b}, index ${i})`,
            );
          }
          indices[i] = Number(v);
        }
        offset += indicesBytes;
        fragmentRef = { mode: "explicit", indices };
        break;
      }
      default:
        throw new Error(`Unknown manifest block mode ${mode} (block ${b})`);
    }

    blocks.push({ chunkCoords, fragmentRef });
  }

  if (offset !== view.byteLength) {
    throw new Error(
      `Manifest blob has ${view.byteLength - offset} trailing bytes after ${numBlocks} blocks`,
    );
  }

  return blocks;
}

/**
 * Resolve a manifest's fragment ref into a flat list of fragment indices
 * within the chunk's `vertex_fragments/<chunkCoords>` array.  Useful for
 * pass-2 chunk-source code that needs a uniform shape regardless of how
 * the writer encoded the reference.
 */
export function resolveFragmentRef(ref: ManifestFragmentRef): Uint32Array {
  switch (ref.mode) {
    case "single":
      return new Uint32Array([ref.fragmentIndex]);
    case "range": {
      const out = new Uint32Array(ref.count);
      for (let i = 0; i < ref.count; ++i) out[i] = ref.start + i;
      return out;
    }
    case "explicit":
      return ref.indices;
  }
}
