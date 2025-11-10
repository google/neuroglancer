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

  /** Paint a simple spherical brush (3D) of integer radius around center. */
  paintBrush(center: Float32Array, radius: number, value: number) {
    if (!Number.isFinite(radius) || radius <= 0) return;
    const r = Math.floor(radius);
    const cx = Math.floor(center[0] ?? 0);
    const cy = Math.floor(center[1] ?? 0);
    const cz = Math.floor(center[2] ?? 0);
    const rr = r * r;
    // Attempt to get the source once to reduce repeated dereferencing.
    let source: VoxChunkSource | undefined;
    try {
      const sources2D = this.multiscale.getSources({} as any);
      const single = sources2D?.[0]?.[0];
      source = single?.chunkSource as VoxChunkSource | undefined;
    } catch {
      // ignore
    }
    if (!source) return;
    for (let dz = -r; dz <= r; ++dz) {
      for (let dy = -r; dy <= r; ++dy) {
        for (let dx = -r; dx <= r; ++dx) {
          if (dx*dx + dy*dy + dz*dz <= rr) {
            source.paintVoxel(new Float32Array([cx + dx, cy + dy, cz + dz]), value);
          }
        }
      }
    }
  }
}
