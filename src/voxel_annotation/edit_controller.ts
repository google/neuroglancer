/**
 * @license
 * Copyright 2025.
 */

import type { MultiscaleVolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import {
  parseVoxChunkKey,
  VOX_EDIT_BACKEND_RPC_ID,
  VOX_EDIT_COMMIT_VOXELS_RPC_ID,
  VOX_EDIT_LABELS_ADD_RPC_ID,
  VOX_EDIT_LABELS_GET_RPC_ID,
  VOX_EDIT_MAP_INIT_RPC_ID,
  VOX_RELOAD_CHUNKS_RPC_ID,
} from "#src/voxel_annotation/base.js";
import type { VoxChunkSource } from "#src/voxel_annotation/frontend.js";
import type { VoxMapConfig } from "#src/voxel_annotation/map.js";
import {
  registerRPC,
  registerSharedObjectOwner,
  SharedObject,
} from "#src/worker_rpc.js";

@registerSharedObjectOwner(VOX_EDIT_BACKEND_RPC_ID)
export class VoxelEditController extends SharedObject {
  constructor(private multiscale: MultiscaleVolumeChunkSource) {
    super();
    const rpc = (this.multiscale as any)?.chunkManager?.rpc;
    if (!rpc) {
      throw new Error("VoxelEditController: Missing RPC from multiscale chunk manager.");
    }
    this.initializeCounterpart(rpc, {});
  }
  private static readonly qualityFactor = 16.0;
  private static readonly restrictToMinLOD = true;
  private mapConfig?: VoxMapConfig;

  private getIdentitySliceViewSourceOptions() {
    const rank = (this.multiscale as any).rank as number | undefined;
    if (!Number.isInteger(rank) || (rank as number) <= 0) {
      throw new Error("VoxelEditController: Invalid multiscale rank.");
    }
    const r = rank as number;
    // Identity mapping from multiscale to view for our purposes.
    const displayRank = r;
    const multiscaleToViewTransform = new Float32Array(displayRank * r);
    for (let chunkDim = 0; chunkDim < r; ++chunkDim) {
      for (let displayDim = 0; displayDim < displayRank; ++displayDim) {
        multiscaleToViewTransform[displayRank * chunkDim + displayDim] =
          chunkDim === displayDim ? 1 : 0;
      }
    }
    return {
      displayRank,
      multiscaleToViewTransform,
      modelChannelDimensionIndices: [],
    } as const;
  }

  initializeMap(map: VoxMapConfig) {
    if (!this.rpc) throw new Error("VoxelEditController.initializeMap: RPC not initialized.");
    this.mapConfig = map;
    this.rpc.invoke(VOX_EDIT_MAP_INIT_RPC_ID, { rpcId: this.rpcId, map });
  }

  // Required: compute desired voxel size (power-of-two) from brush radius.
  getOptimalVoxelSize(brushRadius: number, minLOD = 1, maxLOD = 128) {
    if (VoxelEditController.restrictToMinLOD) {
      return minLOD;
    }
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
    if (VoxelEditController.restrictToMinLOD) {
      return 0;
    }
    if (!Number.isFinite(brushRadiusCanonical) || brushRadiusCanonical <= 0) {
      throw new Error(
        "getEditLodIndexForBrush: brushRadiusCanonical must be > 0",
      );
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
      void basis; // basis is currently unused for disk alignment in this refactor
      throw new Error("paintBrushWithShape: 'radius' must be > 0.");
    }
    if (!centerCanonical || centerCanonical.length < 3) {
      throw new Error(
        "paintBrushWithShape: 'center' must be a Float32Array[3].",
      );
    }

    const voxelSize = this.getOptimalVoxelSize(radiusCanonical);
    const sourceIndex = Math.floor(Math.log2(voxelSize));
    const src2D = this.multiscale.getSources(this.getIdentitySliceViewSourceOptions());
    if (!src2D || !src2D[0] || src2D[0].length <= sourceIndex) {
      throw new Error("VoxelEditController: No multiscale levels available.");
    }
    const source = src2D[0][sourceIndex]?.chunkSource as VoxChunkSource;
    if (!source)
      throw new Error("paintVoxelsBatch: Selected level has no chunk source.");

    // Convert center and radius to the level’s voxel grid.
    const cx = Math.floor((centerCanonical[0] ?? 0) / voxelSize);
    const cy = Math.floor((centerCanonical[1] ?? 0) / voxelSize);
    const cz = Math.floor((centerCanonical[2] ?? 0) / voxelSize);
    const r = Math.round(radiusCanonical / voxelSize);
    if (r <= 0) {
      throw new Error(
        "paintBrushWithShape: radius too small for selected LOD.",
      );
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

    const editsPayload = source.paintVoxelsBatch(voxelsLOD, value);

    if (!this.rpc) throw new Error("VoxelEditController.paintBrushWithShape: RPC not initialized.");
    this.rpc.invoke(VOX_EDIT_COMMIT_VOXELS_RPC_ID, {
      rpcId: this.rpcId,
      edits: editsPayload,
    });
  }

  async getLabelIds(): Promise<number[]> {
    if (!this.rpc) throw new Error("VoxelEditController.getLabelIds: RPC not initialized.");
    return this.rpc.promiseInvoke(VOX_EDIT_LABELS_GET_RPC_ID, {
      rpcId: this.rpcId,
    });
  }

  async addLabel(value: number): Promise<number[]> {
    if (!this.rpc) throw new Error("VoxelEditController.addLabel: RPC not initialized.");
    return this.rpc.promiseInvoke(VOX_EDIT_LABELS_ADD_RPC_ID, {
      rpcId: this.rpcId,
      value,
    });
  }

  /** Commit helper for UI tools. */
  commitEdits(edits: { key: string; indices: number[] | Uint32Array; value?: number; values?: ArrayLike<number>; size?: number[] }[]): void {
    if (!this.rpc) throw new Error("VoxelEditController.commitEdits: RPC not initialized.");
    if (!Array.isArray(edits)) {
      throw new Error("VoxelEditController.commitEdits: edits must be an array.");
    }
    this.rpc.invoke(VOX_EDIT_COMMIT_VOXELS_RPC_ID, {
      rpcId: this.rpcId,
      edits,
    });
  }

  /**
   * Frontend 2D flood fill helper: computes on currently selected LOD and returns an edits payload
   * suitable for VOX_EDIT_COMMIT_VOXELS without committing. Hard-cap deny semantics.
   * The seed is simply the first clicked voxel in canonical/world units.
   */
  floodFillPlane2D(
    startPositionCanonical: Float32Array,
    fillValue: number,
    maxVoxels: number,
  ): { edits: { key: string; indices: number[]; value: number }[]; filledCount: number; originalValue: number } {
    if (!startPositionCanonical || startPositionCanonical.length < 3) {
      throw new Error("VoxelEditController.floodFillPlane2D: startPositionCanonical must be Float32Array[3].");
    }
    if (!Number.isFinite(maxVoxels) || maxVoxels <= 0) {
      throw new Error("VoxelEditController.floodFillPlane2D: maxVoxels must be > 0.");
    }

    // For V1 we use the minimum LOD (index 0) to keep behavior predictable.
    const voxelSize = this.getOptimalVoxelSize(1); // will return min when restrictToMinLOD=true
    const sourceIndex = Math.floor(Math.log2(voxelSize));
    const src2D = this.multiscale.getSources(this.getIdentitySliceViewSourceOptions());
    if (!src2D || !src2D[0] || src2D[0].length <= sourceIndex) {
      throw new Error("VoxelEditController.floodFillPlane2D: No multiscale levels available.");
    }
    const source = src2D[0][sourceIndex]?.chunkSource as VoxChunkSource;
    if (!source) throw new Error("VoxelEditController.floodFillPlane2D: Selected level has no chunk source.");

    // Convert canonical/world to level grid coordinates.
    const startVoxelLod = new Float32Array([
      Math.floor((startPositionCanonical[0] ?? NaN) / voxelSize),
      Math.floor((startPositionCanonical[1] ?? NaN) / voxelSize),
      Math.floor((startPositionCanonical[2] ?? NaN) / voxelSize),
    ]);

    return source.floodFillPlane2D(startVoxelLod, fillValue >>> 0, maxVoxels | 0);
  }

  callChunkReload(voxChunkKeys: string[]) {
    const src2D = this.multiscale.getSources(this.getIdentitySliceViewSourceOptions());
    if (!src2D || !src2D[0] || src2D[0].length === 0) {
      throw new Error("VoxelEditController: No multiscale levels available.");
    }
    const chkByLod = new Map<number, Set<string>>();
    for (const key of voxChunkKeys) {
      const parsed = parseVoxChunkKey(key);
      if (!parsed) {
        throw new Error(`VoxelEditController.callChunkReload: invalid chunk key '${key}'.`);
      }
      if (!this.mapConfig?.steps) {
        throw new Error(`VoxelEditController.callChunkReload: missing map config steps.`);
      }
      const levelIndex = this.mapConfig?.steps.indexOf(parsed.lod);
      if (levelIndex < 0) {
        throw new Error(
          `VoxelEditController.callChunkReload: LOD ${parsed.lod} not present in steps [${this.mapConfig?.steps.join(",")}].`,
        );
      }
      if (!chkByLod.has(levelIndex)){
        chkByLod.set(levelIndex, new Set<string>());
      }
      chkByLod.get(levelIndex)?.add(parsed.chunkKey);
      }
    for (const [levelIndex, keys] of chkByLod) {
      const level = src2D[0][levelIndex];
      if (!level || !level.chunkSource) {
        throw new Error(`VoxelEditController.callChunkReload: missing chunk source for LOD ${levelIndex}.`);
      }
      const source = level.chunkSource as unknown as VoxChunkSource;
      source.invalidateChunksByKey(Array.from(keys));
    }
  }
}

registerRPC(VOX_RELOAD_CHUNKS_RPC_ID, function (x: any) {
  const obj = this.get(x.rpcId) as VoxelEditController;
  const keys: string[] = Array.isArray(x.voxChunkKeys) ? x.voxChunkKeys : [];
  obj.callChunkReload(keys);
});
