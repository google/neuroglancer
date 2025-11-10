/**
 * @license
 * Copyright 2025.
 */

import type { VolumeChunk } from '#src/sliceview/volume/backend.js';
import { VolumeChunkSource as BaseVolumeChunkSource } from '#src/sliceview/volume/backend.js';
import { DataType } from '#src/util/data_type.js';
import { VOX_CHUNK_SOURCE_RPC_ID, VOX_COMMIT_VOXELS_RPC_ID } from "#src/voxel_annotation/base.js";
import type { RPC } from '#src/worker_rpc.js';
import { registerRPC, registerSharedObject } from '#src/worker_rpc.js';

/** Backend-side persisted storage for voxel annotation chunks. */
interface SavedChunk {
  data: ArrayBufferView;
  size: Uint32Array; // [sx, sy, sz] used for linearization
}

/**
 * Backend volume source that persists voxel edits per chunk. It returns saved data if available,
 * otherwise returns an empty chunk (filled with zeros).
 */
@registerSharedObject(VOX_CHUNK_SOURCE_RPC_ID)
export class VoxChunkSource extends BaseVolumeChunkSource {
  private saved = new Map<string, SavedChunk>();

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
  }

  /** Commit voxel edits from the frontend. */
  commitVoxels(edits: { key: string; indices: number[] | Uint32Array; value?: number; values?: ArrayLike<number>; size?: number[] }[]) {
    const { dataType } = this.spec;
    for (const e of edits) {
      const key = e.key;
      // Determine the target size for this chunk. If not provided, fall back to spec chunkDataSize.
      const sizeArr = e.size ? Uint32Array.from(e.size) : this.spec.chunkDataSize;
      let entry = this.saved.get(key);
      if (!entry || !arraysEqual(entry.size, sizeArr)) {
        // Allocate new backing store for this key with the requested size.
        const total = sizeArr[0] * sizeArr[1] * sizeArr[2];
        const arr = this.allocateTypedArray(dataType, total, 0);
        entry = { data: arr, size: Uint32Array.from(sizeArr) };
        this.saved.set(key, entry);
      }
      const dest = entry.data as any;
      const idxs: number[] = Array.from(e.indices as ArrayLike<number>) as number[];
      if (e.values != null) {
        const vals: ArrayLike<number> = e.values as ArrayLike<number>;
        const n = Math.min(idxs.length, vals.length);
        for (let i = 0; i < n; ++i) {
          const idx = (idxs[i] as number) | 0;
          if (idx >= 0 && idx < (dest as ArrayLike<number>).length) (dest as any)[idx] = vals[i] as any;
        }
      } else if (e.value != null) {
        const v = e.value as number;
        for (let i = 0; i < idxs.length; ++i) {
          const idx = (idxs[i] as number) | 0;
          if (idx >= 0 && idx < (dest as ArrayLike<number>).length) (dest as any)[idx] = v as any;
        }
      }
    }
  }

  async download(chunk: VolumeChunk, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason ?? new Error('aborted');
    // Determine chunk key and size (may be clipped at upper bound).
    this.computeChunkBounds(chunk);
    const cds = chunk.chunkDataSize!;
    const key = chunk.chunkGridPosition.join();
    const total = cds[0] * cds[1] * cds[2];
    const array = this.allocateTypedArray(this.spec.dataType, total, 0);
    const saved = this.saved.get(key);
    if (saved) {
      // Copy overlapping region from saved into array, accounting for possibly different strides.
      const sxS = saved.size[0], syS = saved.size[1], szS = saved.size[2];
      const sxD = cds[0], syD = cds[1], szD = cds[2];
      const ox = Math.min(sxS, sxD);
      const oy = Math.min(syS, syD);
      const oz = Math.min(szS, szD);
      const src = saved.data as any;
      const dst = array as any;
      for (let z = 0; z < oz; ++z) {
        for (let y = 0; y < oy; ++y) {
          const baseSrc = (z * syS + y) * sxS;
          const baseDst = (z * syD + y) * sxD;
          for (let x = 0; x < ox; ++x) {
            dst[baseDst + x] = src[baseSrc + x];
          }
        }
      }
    }
    (chunk as any).data = array;
  }

  private allocateTypedArray(dataType: number, size: number, fill: number) {
    switch (dataType) {
      case DataType.UINT8:
        return new Uint8Array(size).fill(fill & 0xff);
      case DataType.INT8:
        return new Int8Array(size).fill((fill << 24) >> 24);
      case DataType.UINT16:
        return new Uint16Array(size).fill(fill & 0xffff);
      case DataType.INT16:
        return new Int16Array(size).fill((fill << 16) >> 16);
      case DataType.UINT32:
        return new Uint32Array(size).fill(fill >>> 0);
      case DataType.INT32:
        return new Int32Array(size).fill(fill | 0);
      case DataType.UINT64: {
        const big = BigInt(fill >>> 0);
        return new BigUint64Array(size).fill(big);
      }
      case DataType.FLOAT32:
        return new Float32Array(size).fill(fill);
      default:
        return new Uint32Array(size).fill(fill >>> 0);
    }
  }
}

function arraysEqual(a: Uint32Array, b: Uint32Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; ++i) if (a[i] !== b[i]) return false;
  return true;
}

// RPC to commit voxel edits.
registerRPC(VOX_COMMIT_VOXELS_RPC_ID, function (x: any) {
  const obj = this.get(x.id) as VoxChunkSource;
  obj.commitVoxels(x.edits || []);
});
