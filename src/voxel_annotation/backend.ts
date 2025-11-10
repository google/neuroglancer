/**
 * @license
 * Copyright 2025.
 */

import type { RPC } from '#src/worker_rpc.js';
import { registerSharedObject } from '#src/worker_rpc.js';
import { VolumeChunkSource as BaseVolumeChunkSource } from '#src/sliceview/volume/backend.js';
import type { VolumeChunk } from '#src/sliceview/volume/backend.js';

// RPC id for the vox dummy chunk source
export const VOX_DUMMY_CHUNK_SOURCE_RPC_ID = 'vox/VoxDummyChunkSource';

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
    // UINT32 is expected by vox dummy; keep simple mapping
    switch (dataType) {
      case 2: // DataType.UINT8
        return new Uint8Array(size).fill(fill & 0xff);
      case 3: // DataType.INT8
        return new Int8Array(size).fill(fill & 0xff);
      case 4: // DataType.UINT16
        return new Uint16Array(size).fill(fill & 0xffff);
      case 5: // DataType.INT16
        return new Int16Array(size).fill(fill & 0xffff);
      case 6: // DataType.UINT32
        return new Uint32Array(size).fill(fill >>> 0);
      case 7: // DataType.INT32
        return new Int32Array(size).fill(fill | 0);
      case 1: // DataType.FLOAT32
        return new Float32Array(size).fill(fill);
      default:
        return new Uint32Array(size).fill(fill >>> 0);
    }
  }
}
