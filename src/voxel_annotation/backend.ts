/**
 * @license
 * Copyright 2025.
 */

import type { VolumeChunk } from '#src/sliceview/volume/backend.js';
import { VolumeChunkSource as BaseVolumeChunkSource } from '#src/sliceview/volume/backend.js';
import { DataType } from '#src/util/data_type.js';
import { VOX_DUMMY_CHUNK_SOURCE_RPC_ID } from "#src/voxel_annotation/base.js";
import type { RPC } from '#src/worker_rpc.js';
import { registerSharedObject } from '#src/worker_rpc.js';


/**
 * Minimal backend volume source that procedurally generates data for voxel annotations demo.
 * It fills chunk.data with a simple pattern (checkerboard based on voxel coords).
 */
@registerSharedObject(VOX_DUMMY_CHUNK_SOURCE_RPC_ID)
export class VoxDummyChunkSource extends BaseVolumeChunkSource {
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
  }

  async download(chunk: VolumeChunk, signal: AbortSignal): Promise<void> {
    // Respect aborts
    if (signal.aborted) throw signal.reason ?? new Error('aborted');
    const { spec } = this;
    const { dataType, fillValue } = spec;
    // Compute bounds and chunkDataSize (may be clipped at upper bound)
    const origin = this.computeChunkBounds(chunk);

    // Allocate a typed array matching the spec.dataType and size
    const size = this.getChunkVoxelCount(chunk);
    const array = this.allocateTypedArray(dataType, size, Number(fillValue ?? 0));

    // Populate a simple 3D pattern for visualization
    const cds = chunk.chunkDataSize!;
    let index = 0;
    for (let z = 0; z < cds[2]; ++z) {
      for (let y = 0; y < cds[1]; ++y) {
        for (let x = 0; x < cds[0]; ++x, ++index) {
          const gx = origin[0] + x;
          const gy = origin[1] + y;
          const gz = origin[2] + z;
          // Checker pattern in world space with large squares
          const square = ((Math.floor(gx / 16) + Math.floor(gy / 16) + Math.floor(gz / 16)) & 1) !== 0;
          array[index] = square ? 255 : 0;
        }
      }
    }

    // Stash data on chunk for transfer to frontend
    (chunk as any).data = array;
  }

  private getChunkVoxelCount(chunk: VolumeChunk) {
    const cds = chunk.chunkDataSize!;
    let n = 1;
    for (let i = 0; i < cds.length; ++i) n *= cds[i];
    return n;
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
        // Represent as 64-bit unsigned. Use BigUint64Array; frontend will reinterpret as Uint32Array.
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
