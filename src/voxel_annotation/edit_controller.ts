/**
 * @license
 * Copyright 2025.
 */

import type { VoxUserLayer } from "#src/layer/vox/index.js";
import type { ChunkChannelAccessParameters } from "#src/render_coordinate_transform.js";
import type { VolumeChunkSource , MultiscaleVolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import { StatusMessage } from "#src/status.js";
import { WatchableValue } from "#src/trackable_value.js";
import { vec3 } from "#src/util/geom.js";
import type {
  VoxelLayerResolution} from "#src/voxel_annotation/base.js";
import {
  VOX_EDIT_BACKEND_RPC_ID,
  VOX_EDIT_COMMIT_VOXELS_RPC_ID,
  VOX_RELOAD_CHUNKS_RPC_ID,
  VOX_EDIT_FAILURE_RPC_ID,
  VOX_EDIT_UNDO_RPC_ID,
  VOX_EDIT_REDO_RPC_ID,
  VOX_EDIT_HISTORY_UPDATE_RPC_ID,
  makeVoxChunkKey,
  parseVoxChunkKey
} from "#src/voxel_annotation/base.js";
import {
  registerRPC,
  registerSharedObjectOwner,
  SharedObject,
} from "#src/worker_rpc.js";

@registerSharedObjectOwner(VOX_EDIT_BACKEND_RPC_ID)
export class VoxelEditController extends SharedObject {
  public undoCount = new WatchableValue<number>(0);
  public redoCount = new WatchableValue<number>(0);

  constructor(private layer: VoxUserLayer, private multiscale: MultiscaleVolumeChunkSource) {
    super();
    const rpc = (this.multiscale as any)?.chunkManager?.rpc;
    if (!rpc) {
      throw new Error("VoxelEditController: Missing RPC from multiscale chunk manager.");
    }

    // Get all sources for all scales and orientations
    const sourcesByScale = this.multiscale.getSources(this.getIdentitySliceViewSourceOptions());
    const sources = sourcesByScale[0];
    if (!sources) {
      throw new Error("VoxelEditController: Could not retrieve sources from multiscale object.");
    }

    const resolutions: VoxelLayerResolution[] = [];

    for (let i = 0; i < sources.length; ++i) {
      const source = sources[i]!.chunkSource;
      const rpcId = source.rpcId;
      if (rpcId == null) {
        throw new Error(`VoxelEditController: Source at LOD index ${i} has null rpcId during initialization.`);
      }
      resolutions.push({
        lodIndex: i,
        transform: Array.from(sources[i]!.chunkToMultiscaleTransform),
        chunkSize: Array.from(source.spec.chunkDataSize),
        sourceRpc: rpcId
      });
    }

    this.initializeCounterpart(rpc, { resolutions });
  }

  private morphologicalConfig = {
    // At what `filledCount` thresholds the neighborhood size increases.
    growthThresholds: [
      { count: 1000, size: 3 },  // Requires 3px thick channels
      { count: 10000, size: 5 },  // Requires 5px thick channels
      { count: 100000, size: 7 }, // Requires 7px thick channels
    ],
    maxSize: 9,
  };

  readonly singleChannelAccess: ChunkChannelAccessParameters = {
    numChannels: 1,
    channelSpaceShape: new Uint32Array([]),
    chunkChannelDimensionIndices: [],
    chunkChannelCoordinates: new Uint32Array([0])
  };


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

  getSourceForLOD(lodIndex: number): VolumeChunkSource {
    const sourcesByScale = this.multiscale.getSources(this.getIdentitySliceViewSourceOptions());
    // Assuming a single orientation, which is correct for this use case.
    const sources = sourcesByScale[0];
    if (!sources || sources.length <= lodIndex) {
      throw new Error(`VoxelEditController: LOD index ${lodIndex} is out of bounds.`);
    }
    const source = sources[lodIndex]?.chunkSource;
    if (!source) {
      throw new Error(`VoxelEditController: No chunk source found for LOD index ${lodIndex}.`);
    }
    return source;
  }

  // Paint a disk (slice-aligned via basis) or sphere in WORLD/ canonical units; we transform to LOD grid before sending.
  paintBrushWithShape(
    centerCanonical: Float32Array,
    radiusCanonical: number,
    value: bigint,
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

    // For V1 we use the minimum LOD (index 0)
    const voxelSize = 1;
    const sourceIndex = 0;
    const source = this.getSourceForLOD(sourceIndex);

    // Convert center and radius to the level’s voxel grid.
    const cx = Math.round((centerCanonical[0] ?? 0) / voxelSize);
    const cy = Math.round((centerCanonical[1] ?? 0) / voxelSize);
    const cz = Math.round((centerCanonical[2] ?? 0) / voxelSize);
    const r = Math.round(radiusCanonical / voxelSize);
    if (r <= 0) {
      throw new Error(
        "paintBrushWithShape: radius too small for selected LOD.",
      );
    }
    const rr = r * r;

    const voxelsToPaint: Float32Array[] = [];

    if (shape === "sphere") {
      for (let dz = -r; dz <= r; ++dz) {
        for (let dy = -r; dy <= r; ++dy) {
          for (let dx = -r; dx <= r; ++dx) {
            if (dx * dx + dy * dy + dz * dz <= rr) {
              voxelsToPaint.push(new Float32Array([cx + dx, cy + dy, cz + dz]));
            }
          }
        }
      }
    } else {
      if (basis === undefined) {
        // Fallback to old XY-plane behavior if no basis is provided
        for (let dy = -r; dy <= r; ++dy) {
          for (let dx = -r; dx <= r; ++dx) {
            if (dx * dx + dy * dy <= rr) {
              voxelsToPaint.push(new Float32Array([cx + dx, cy + dy, cz]));
            }
          }
        }
      } else {
        // New logic for arbitrary plane
        const { u, v } = basis;
        for (let j = -r; j <= r; ++j) {
          for (let i = -r; i <= r; ++i) {
            if (i * i + j * j <= rr) {
              const point = vec3.fromValues(cx, cy, cz);
              vec3.scaleAndAdd(point, point, u as vec3, i);
              vec3.scaleAndAdd(point, point, v as vec3, j);
              voxelsToPaint.push(point as Float32Array);
            }
          }
        }
      }
    }

    if (!voxelsToPaint || voxelsToPaint.length === 0) return;
    const editsByVoxKey = new Map<string, { indices: number[], value: bigint }>();

    for (const voxelCoord of voxelsToPaint) {
      const { chunkGridPosition, positionWithinChunk } = source.computeChunkIndices(voxelCoord);
      const chunkKey = chunkGridPosition.join();
      const voxKey = makeVoxChunkKey(chunkKey, sourceIndex);

      let entry = editsByVoxKey.get(voxKey);
      if (!entry) {
        entry = { indices: [], value };
        editsByVoxKey.set(voxKey, entry);
      }

      const { chunkDataSize } = source.spec;
      const index = (positionWithinChunk[2] * chunkDataSize[1] + positionWithinChunk[1]) * chunkDataSize[0] + positionWithinChunk[0];
      entry.indices.push(index);
    }

    // Apply edits locally on the specific source for immediate feedback.
    const localEdits = new Map<string, {indices: number[], value: bigint}>();
    for (const [voxKey, edit] of editsByVoxKey.entries()) {
      const parsed = parseVoxChunkKey(voxKey);
      if (!parsed) continue;
      localEdits.set(parsed.chunkKey, edit);
    }
    source.applyLocalEdits(localEdits);

    const backendEdits = [] as { key: string; indices: number[]; value: bigint }[];
    for (const [voxKey, edit] of editsByVoxKey.entries()) {
      backendEdits.push({ key: voxKey, indices: edit.indices, value: edit.value });
    }

    this.commitEdits(backendEdits);
  }

  /** Commit helper for UI tools. */
  commitEdits(edits: { key: string; indices: number[] | Uint32Array; value?: bigint; values?: ArrayLike<number>; size?: number[] }[]): void {
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
  async floodFillPlane2D(
    startPositionCanonical: Float32Array,
    fillValue: bigint,
    maxVoxels: number,
   _planeNormal: vec3,
  ): Promise<{ edits: { key: string; indices: number[]; value: bigint }[]; filledCount: number; originalValue: bigint }> {
    if (!startPositionCanonical || startPositionCanonical.length < 3) {
      throw new Error("VoxelEditController.floodFillPlane2D: startPositionCanonical must be Float32Array[3].");
    }
    if (!Number.isFinite(maxVoxels) || maxVoxels <= 0) {
      throw new Error("VoxelEditController.floodFillPlane2D: maxVoxels must be > 0.");
    }

    // For V1 we use the minimum LOD (index 0)
    const voxelSize = 1;
    const sourceIndex = 0;
    const source = this.getSourceForLOD(sourceIndex);

    // Convert canonical/world to level grid coordinates.
    const startVoxelLod = new Float32Array([
      Math.round((startPositionCanonical[0] ?? NaN) / voxelSize),
      Math.round((startPositionCanonical[1] ?? NaN) / voxelSize),
      Math.round((startPositionCanonical[2] ?? NaN) / voxelSize),
    ]);

    if (!startVoxelLod || startVoxelLod.length < 3) {
      throw new Error("VoxChunkSource.floodFillPlane2D: startVoxelLod must be Float32Array[3].");
    }
    if (!Number.isFinite(maxVoxels) || maxVoxels <= 0) {
      throw new Error("VoxChunkSource.floodFillPlane2D: maxVoxels must be > 0.");
    }

    const originalValueResult = await source.getEnsuredValueAt(startVoxelLod, this.singleChannelAccess);
    if (originalValueResult === null) {
      throw new Error("Flood fill seed is in an unloaded or out-of-bounds chunk.");
    }
    const originalValue = typeof originalValueResult !== "bigint" ? BigInt(originalValueResult as number) : originalValueResult;
    if (originalValue === fillValue) {
      return { edits: [], filledCount: 0, originalValue };
    }

    const zPlane = startVoxelLod[2] | 0;
    const visited = new Set<string>();
    const queue: [number, number][] = [];
    let filledCount = 0;

    const isOriginalAt = async (px: number, py: number): Promise<boolean> => {
      const value = await source.getEnsuredValueAt(new Float32Array([px, py, zPlane]), this.singleChannelAccess);
      return (typeof value !== "bigint" ? BigInt(value as number) : value) === originalValue;
    };

    const getCurrentThickness = (): number => {
      let thickness = 1;
      for (const threshold of this.morphologicalConfig.growthThresholds) {
        if (filledCount >= threshold.count) {
          thickness = Math.max(thickness, threshold.size);
        }
      }
      return Math.min(thickness, this.morphologicalConfig.maxSize);
    };

    const hasThickEnoughChannel = (
      x: number,
      y: number,
      nx: number,
      ny: number,
      requiredThickness: number
    ): boolean => {
      if (requiredThickness <= 1) return true;

      const dx = nx - x;
      const dy = ny - y;

      if ((dx === 0) === (dy === 0)) return false;

      const halfThickness = Math.floor(requiredThickness / 2);

      if (dx !== 0) {
        for (const checkX of [x, nx]) {
          for (let offset = -halfThickness; offset <= halfThickness; offset++) {
            if (!isOriginalAt(checkX, ny + offset)) {
              return false;
            }
          }
        }
      } else {
        for (const checkY of [y, ny]) {
          for (let offset = -halfThickness; offset <= halfThickness; offset++) {
            if (!isOriginalAt(nx + offset, checkY)) {
              return false;
            }
          }
        }
      }

      return true;
    };

    const fillBorderRegion = async (
      startX: number,
      startY: number,
      requiredThickness: number
    ) => {
      const subQueue: [number, number][] = [];
      const halfThickness = Math.floor(requiredThickness / 2) + 1;

      const k = `${startX},${startY}`;
      if (visited.has(k)) return;

      subQueue.push([startX, startY]);
      visited.add(k); // Mark as visited immediately to avoid re-processing

      while (subQueue.length > 0) {
        const [cx, cy] = subQueue.shift()!;
        filledCount++;
        voxelsToFill.push(new Float32Array([cx, cy, zPlane]));

        const neighbors: [number, number][] = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
        for (const [nnx, nny] of neighbors) {
          if (nnx < startX - halfThickness || nnx > startX + halfThickness ||
            nny < startY - halfThickness || nny > startY + halfThickness) {
            continue; // Outside the bounding box
          }
          const nk = `${nnx},${nny}`;
          if (visited.has(nk)) continue;

          if (await isOriginalAt(nnx, nny)) {
            visited.add(nk);
            subQueue.push([nnx, nny]);
          }
        }
      }
    };

    // Seed the queue
    queue.push([startVoxelLod[0] | 0, startVoxelLod[1] | 0]);
    visited.add(`${startVoxelLod[0] | 0},${startVoxelLod[1] | 0}`);
    const voxelsToFill: Float32Array[] = [];

    // BFS with thickness constraints
    while (queue.length > 0) {
      if (filledCount >= maxVoxels) {
        throw new Error(`VoxChunkSource.floodFillPlane2D: region exceeds maxVoxels (${maxVoxels}).`);
      }
      const [x, y] = queue.shift()!;

      // Schedule this pixel for filling
      filledCount++;
      voxelsToFill.push(new Float32Array([x, y, zPlane]));

      // Get current thickness requirement
      const requiredThickness = getCurrentThickness();

      // Check 4-neighbors
      const neighbors: [number, number][] = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
      for (const [nx, ny] of neighbors) {
        const k = `${nx},${ny}`;
        if (visited.has(k)) continue;

        if (await isOriginalAt(nx, ny)) {
          // The neighbor is a valid fill target. Now check if we can propagate from it.
          if (hasThickEnoughChannel(x, y, nx, ny, requiredThickness)) {
            // Channel is thick enough: Add to queue to propagate.
            visited.add(k);
            queue.push([nx, ny]);
          } else {
            await fillBorderRegion(nx, ny, requiredThickness);
          }
        }
      }
    }

    const editsByVoxKey = new Map<string, { indices: number[], value: bigint }>();
    for (const voxelCoord of voxelsToFill) {
      const { chunkGridPosition, positionWithinChunk } = source.computeChunkIndices(voxelCoord);
      const chunkKey = chunkGridPosition.join();
      const voxKey = makeVoxChunkKey(chunkKey, sourceIndex);

      let entry = editsByVoxKey.get(voxKey);
      if (!entry) {
        entry = { indices: [], value: fillValue };
        editsByVoxKey.set(voxKey, entry);
      }
      const { chunkDataSize } = source.spec;
      const index = (positionWithinChunk[2] * chunkDataSize[1] + positionWithinChunk[1]) * chunkDataSize[0] + positionWithinChunk[0];
      entry.indices.push(index);
    }

    // Apply edits locally for preview on this source.
    const localEdits = new Map<string, {indices: number[], value: bigint}>();
    for (const [voxKey, edit] of editsByVoxKey.entries()) {
      const parsed = parseVoxChunkKey(voxKey);
      if (!parsed) continue;
      localEdits.set(parsed.chunkKey, edit);
    }
    source.applyLocalEdits(localEdits);

    // Prepare edits for the backend keyed by voxKey.
    const backendEdits: { key: string; indices: number[]; value: bigint }[] = [];
    for (const [voxKey, edit] of editsByVoxKey.entries()) {
      backendEdits.push({ key: voxKey, indices: edit.indices, value: edit.value });
    }

    this.commitEdits(backendEdits);

    return { edits: backendEdits, filledCount, originalValue: originalValue };
  }

  callChunkReload(voxChunkKeys: string[]) {
    if (!Array.isArray(voxChunkKeys) || voxChunkKeys.length === 0) return;
    // This assumes the multiscale source has a single orientation.
    const sourcesByScale = (this.multiscale as any).getSources(this.getIdentitySliceViewSourceOptions());
    const sources = sourcesByScale && sourcesByScale[0];
    if (!sources) return;

    const chunksToInvalidateBySource = new Map<VolumeChunkSource, string[]>();

    for (const voxKey of voxChunkKeys) {
      const parsed = parseVoxChunkKey(voxKey);
      if (!parsed) continue;
      const source = sources[parsed.lodIndex]?.chunkSource as VolumeChunkSource | undefined;
      if (!source) continue;
      let arr = chunksToInvalidateBySource.get(source);
      if (!arr) {
        arr = [];
        chunksToInvalidateBySource.set(source, arr);
      }
      arr.push(parsed.chunkKey);
    }

    for (const [source, keys] of chunksToInvalidateBySource.entries()) {
      if (keys.length > 0) {
        source.invalidateChunks(keys);
      }
    }
  }

  /** Backend failure notification handler: revert optimistic preview and show UI message. */
  handleCommitFailure(voxChunkKeys: string[], message: string): void {
    try {
      this.callChunkReload(voxChunkKeys);
    } finally {
      this.layer.setDrawErrorMessage(message);
    }
  }

  public undo(): void {
    if (!this.rpc) throw new Error("VoxelEditController.undo: RPC not initialized.");
    console.log("VoxelEditController.undo");
    this.rpc.promiseInvoke<void>(VOX_EDIT_UNDO_RPC_ID, { rpcId: this.rpcId }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      StatusMessage.showTemporaryMessage(`Undo failed: ${message}`, 3000);
    });
  }

  public redo(): void {
    if (!this.rpc) throw new Error("VoxelEditController.redo: RPC not initialized.");
    console.log("VoxelEditController.redo");
    this.rpc.promiseInvoke<void>(VOX_EDIT_REDO_RPC_ID, { rpcId: this.rpcId }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      StatusMessage.showTemporaryMessage(`Redo failed: ${message}`, 3000);
    });
  }
}

registerRPC(VOX_RELOAD_CHUNKS_RPC_ID, function (x: any) {
  const obj = this.get(x.rpcId) as VoxelEditController;
  const keys: string[] = Array.isArray(x.voxChunkKeys) ? x.voxChunkKeys : [];
  obj.callChunkReload(keys);
});

registerRPC(VOX_EDIT_FAILURE_RPC_ID, function (x: any) {
  const obj = this.get(x.rpcId) as VoxelEditController;
  const keys: string[] = Array.isArray(x.voxChunkKeys) ? x.voxChunkKeys : [];
  const message: string = typeof x.message === 'string' ? x.message : 'Voxel edit failed.';
  obj.handleCommitFailure(keys, message);
});

registerRPC(VOX_EDIT_HISTORY_UPDATE_RPC_ID, function (x: any) {
  const obj = this.get(x.rpcId) as VoxelEditController;
  const undoCount = typeof x.undoCount === 'number' ? x.undoCount : 0;
  const redoCount = typeof x.redoCount === 'number' ? x.redoCount : 0;
  obj.undoCount.value = undoCount;
  obj.redoCount.value = redoCount;
});
