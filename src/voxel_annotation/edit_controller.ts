/**
 * @license
 * Copyright 2025.
 */

import type { MultiscaleVolumeChunkSource } from '#src/sliceview/volume/frontend.js';
import type { VoxChunkSource } from '#src/voxel_annotation/frontend.js';

/** Tiny controller to forward voxel edits from tools to the VoxChunkSource. */
export class VoxelEditController {
  constructor(private multiscale: MultiscaleVolumeChunkSource) {}

  private getSource(): VoxChunkSource | undefined {
    try {
      const sources2D = this.multiscale.getSources({} as any);
      const single = sources2D?.[0]?.[0];
      return single?.chunkSource as VoxChunkSource | undefined;
    } catch {
      return undefined;
    }
  }

  paintVoxel(voxel: Float32Array, value: number) {
    try {
      const source = this.getSource();
      source?.paintVoxel(voxel, value);
    } catch {
      // no-op
    }
  }

  paintVoxelsBatch(voxels: Float32Array[], value: number) {
    if (!voxels || voxels.length === 0) return;
    try {
      const source = this.getSource();
      source?.paintVoxelsBatch(voxels, value);
    } catch {
      // no-op
    }
  }

  /** Paint a brush with selectable shape: 'disk' (2D in XY plane) or 'sphere' (3D). Default: 'disk'. */
  paintBrushWithShape(
    center: Float32Array,
    radius: number,
    value: number,
    shape: 'disk' | 'sphere' = 'disk',
  ) {
    if (!Number.isFinite(radius) || radius <= 0) return;
    const r = Math.floor(radius);
    const cx = Math.floor(center[0] ?? 0);
    const cy = Math.floor(center[1] ?? 0);
    const cz = Math.floor(center[2] ?? 0);
    const rr = r * r;
    const source = this.getSource();
    if (!source) return;
    const voxels: Float32Array[] = [];
    if (shape === 'sphere') {
      for (let dz = -r; dz <= r; ++dz) {
        for (let dy = -r; dy <= r; ++dy) {
          for (let dx = -r; dx <= r; ++dx) {
            if (dx * dx + dy * dy + dz * dz <= rr) {
              voxels.push(new Float32Array([cx + dx, cy + dy, cz + dz]));
            }
          }
        }
      }
    } else {
      // Disk in XY plane at fixed Z = cz
      for (let dy = -r; dy <= r; ++dy) {
        for (let dx = -r; dx <= r; ++dx) {
          if (dx * dx + dy * dy <= rr) {
            voxels.push(new Float32Array([cx + dx, cy + dy, cz]));
          }
        }
      }
    }
    source.paintVoxelsBatch(voxels, value);
  }

  /** Backward-compat spherical brush API. */
  paintBrush(center: Float32Array, radius: number, value: number) {
    this.paintBrushWithShape(center, radius, value, 'sphere');
  }
}
