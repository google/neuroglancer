/**
 * @license
 * Copyright 2025.
 */

import type { MultiscaleVolumeChunkSource } from '#src/sliceview/volume/frontend.js';
import type { VoxChunkSource } from '#src/voxel_annotation/frontend.js';

/** Tiny controller to forward voxel edits from tools to the VoxChunkSource. */
export class VoxelEditController {
  constructor(private multiscale: MultiscaleVolumeChunkSource) {}

  paintVoxel(voxel: Float32Array, value: number) {
    try {
      const sources2D = this.multiscale.getSources({} as any);
      const single = sources2D?.[0]?.[0];
      const source = single?.chunkSource as VoxChunkSource | undefined;
      source?.paintVoxel(voxel, value);
    } catch {
      // no-op
    }
  }
}
