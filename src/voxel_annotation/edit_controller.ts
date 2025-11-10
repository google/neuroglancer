/**
 * @license
 * Copyright 2025.
 */

import type { MultiscaleVolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import type { VoxChunkSource } from "#src/voxel_annotation/frontend.js";

export class VoxelEditController {
  constructor(private multiscale: MultiscaleVolumeChunkSource) {}
  private static readonly qualityFactor = 16.0;
  private static readonly restrictToMinLOD = true;

  // Required: compute desired voxel size (power-of-two) from brush radius.
  getOptimalVoxelSize(brushRadius: number, minLOD = 1, maxLOD = 128) {
    if (VoxelEditController.restrictToMinLOD) {return minLOD;}
    if (!Number.isFinite(brushRadius) || brushRadius <= 0) {
      return minLOD;
    }
    const targetSize = brushRadius / VoxelEditController.qualityFactor;
    const exponent = Math.round(Math.log2(targetSize));
    let voxelSize = Math.pow(2, exponent);
    voxelSize = Math.max(minLOD, Math.min(voxelSize, maxLOD));
    return voxelSize;
  }

  /** Compute the edit LOD index (scale index) from a brush radius in canonical units. */
  getEditLodIndexForBrush(brushRadiusCanonical: number): number {
    if (VoxelEditController.restrictToMinLOD) {return 0;}
    if (!Number.isFinite(brushRadiusCanonical) || brushRadiusCanonical <= 0) {
      throw new Error("getEditLodIndexForBrush: brushRadiusCanonical must be > 0");
    }
    const voxelSize = this.getOptimalVoxelSize(brushRadiusCanonical);
    const sourceIndex = Math.round(Math.log2(voxelSize));
    if (!Number.isInteger(sourceIndex) || sourceIndex < 0) {
      throw new Error("getEditLodIndexForBrush: computed LOD is invalid");
    }
    return sourceIndex;
  }

  // Paint a disk (slice-aligned via basis) or sphere in WORLD/ canonical units; we transform to LOD grid before sending.
  paintBrushWithShape(
    centerCanonical: Float32Array,
    radiusCanonical: number,
    value: number,
    shape: "disk" | "sphere" = "disk",
    basis?: { u: Float32Array; v: Float32Array },
  ) {
    if (!Number.isFinite(radiusCanonical) || radiusCanonical <= 0) {
      console.log(basis) // TODO remove this line, was only added to suppress ts errors
      throw new Error("paintBrushWithShape: 'radius' must be > 0.");
    }
    if (!centerCanonical || centerCanonical.length < 3) {
      throw new Error("paintBrushWithShape: 'center' must be a Float32Array[3].");
    }

    const voxelSize = this.getOptimalVoxelSize(radiusCanonical);
    const sourceIndex = Math.floor(Math.log2(voxelSize));
    const src2D = this.multiscale.getSources({} as any);
    if (!src2D || !src2D[0] || src2D[0].length <= sourceIndex) {
      throw new Error("VoxelEditController: No multiscale levels available.");
    }
    const source = src2D[0][sourceIndex]?.chunkSource as VoxChunkSource;
    if (!source) throw new Error("paintVoxelsBatch: Selected level has no chunk source.");

    // Convert center and radius to the level’s voxel grid.
    const cx = Math.floor((centerCanonical[0] ?? 0) / voxelSize);
    const cy = Math.floor((centerCanonical[1] ?? 0) / voxelSize);
    const cz = Math.floor((centerCanonical[2] ?? 0) / voxelSize);
    const r = Math.round(radiusCanonical / voxelSize);
    if (r <= 0) {
      throw new Error("paintBrushWithShape: radius too small for selected LOD.");
    }
    const rr = r * r;

    const voxelsLOD: Float32Array[] = [];

    if (shape === "sphere") {
      for (let dz = -r; dz <= r; ++dz) {
        for (let dy = -r; dy <= r; ++dy) {
          for (let dx = -r; dx <= r; ++dx) {
            if (dx * dx + dy * dy + dz * dz <= rr) {
              voxelsLOD.push(new Float32Array([cx + dx, cy + dy, cz + dz]));
            }
          }
        }
      }
    } else {
      for (let dy = -r; dy <= r; ++dy) {
        for (let dx = -r; dx <= r; ++dx) {
          if (dx * dx + dy * dy <= rr) {
            voxelsLOD.push(new Float32Array([cx + dx, cy + dy, cz]));
          }
        }
      }
    }

    source.paintVoxelsBatch(voxelsLOD, value);
  }

  async getLabelIds(): Promise<number[]> {
    const src2D = this.multiscale.getSources({} as any);
    if (!src2D || !src2D[0] || src2D[0].length === 0) return [];
    const src = src2D[0][0].chunkSource as VoxChunkSource | undefined;
    if (!src) return [];
    return await src.getLabelIds();
  }

  async addLabel(value: number): Promise<number[]> {
    const src2D = this.multiscale.getSources({} as any);
    const src = src2D?.[0]?.[0]?.chunkSource as VoxChunkSource | undefined;
    if (!src) throw new Error("Voxel source not ready");
    return await src.addLabel(value >>> 0);
  }
}
