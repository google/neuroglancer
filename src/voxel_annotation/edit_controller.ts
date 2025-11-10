/**
 * @license
 * Copyright 2025.
 */

import type { MultiscaleVolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import type { VoxChunkSource } from "#src/voxel_annotation/frontend.js";

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

  paintVoxelsBatch(voxels: Float32Array[], value: number) {
    if (!voxels || voxels.length === 0) return;
    try {
      const source = this.getSource();
      source?.paintVoxelsBatch(voxels, value);
    } catch {
      // no-op
    }
  }

  /** Paint a brush with selectable shape: 'disk' (2D oriented to slice plane) or 'sphere' (3D). Default: 'disk'. */
  paintBrushWithShape(
    center: Float32Array,
    radius: number,
    value: number,
    shape: "disk" | "sphere" = "disk",
    basis?: { u: Float32Array; v: Float32Array },
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
    if (shape === "sphere") {
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
      // Oriented disk in the provided slice plane; if basis not provided, fall back to XY at fixed Z = cz.
      const u = basis?.u;
      const v = basis?.v;
      if (
        u &&
        v &&
        Number.isFinite(u[0]) &&
        Number.isFinite(u[1]) &&
        Number.isFinite(u[2]) &&
        Number.isFinite(v[0]) &&
        Number.isFinite(v[1]) &&
        Number.isFinite(v[2])
      ) {
        // Normalize u and v for safety.
        const ul = Math.hypot(u[0], u[1], u[2]) || 1;
        const vl = Math.hypot(v[0], v[1], v[2]) || 1;
        const un = [u[0] / ul, u[1] / ul, u[2] / ul];
        const vn = [v[0] / vl, v[1] / vl, v[2] / vl];
        const seen = new Set<string>();
        for (let dy = -r; dy <= r; ++dy) {
          for (let dx = -r; dx <= r; ++dx) {
            if (dx * dx + dy * dy <= rr) {
              const px = cx + dx * un[0] + dy * vn[0];
              const py = cy + dx * un[1] + dy * vn[1];
              const pz = cz + dx * un[2] + dy * vn[2];
              const ix = Math.round(px);
              const iy = Math.round(py);
              const iz = Math.round(pz);
              const key = ix + "," + iy + "," + iz;
              if (!seen.has(key)) {
                seen.add(key);
                voxels.push(new Float32Array([ix, iy, iz]));
              }
            }
          }
        }
      } else {
        console.warn(
          "No basis provided for disk brush, falling back to XY plane at fixed Z = cz.",
        );
        // Fallback: Disk in XY plane at fixed Z = cz
        for (let dy = -r; dy <= r; ++dy) {
          for (let dx = -r; dx <= r; ++dx) {
            if (dx * dx + dy * dy <= rr) {
              voxels.push(new Float32Array([cx + dx, cy + dy, cz]));
            }
          }
        }
      }
    }
    source.paintVoxelsBatch(voxels, value);
  }

  /** Backward-compat spherical brush API. */
  paintBrush(center: Float32Array, radius: number, value: number) {
    this.paintBrushWithShape(center, radius, value, "sphere");
  }

  async getLabelIds(): Promise<number[]> {
    try {
      const source = this.getSource();
      if (!source) return [];
      return await source.getLabelIds();
    } catch {
      return [];
    }
  }

  setLabelIds(ids: number[]) {
    try {
      const source = this.getSource();
      source?.setLabelIds(ids);
    } catch {
      // ignore
    }
  }
}
