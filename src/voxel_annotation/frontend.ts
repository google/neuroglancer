/**
 * @license
 * Copyright 2025.
 */

import { ChunkState } from "#src/chunk_manager/base.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import type { VolumeChunkSpecification } from "#src/sliceview/volume/base.js";
import type { VolumeChunk } from "#src/sliceview/volume/frontend.js";
import { VolumeChunkSource as BaseVolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import { animationFrameDebounce } from "#src/util/animation_frame_debounce.js";
import type { TypedArray } from "#src/util/array.js";
import {
  VOX_CHUNK_SOURCE_RPC_ID,
  VOX_MAP_INIT_RPC_ID,
  makeVoxChunkKey,
} from "#src/voxel_annotation/base.js";
import type { VoxMapConfig } from "#src/voxel_annotation/map.js";
import { registerSharedObjectOwner } from "#src/worker_rpc.js";

/**
 * Frontend owner for VoxChunkSource, extended with a local optimistic edit overlay.
 */
@registerSharedObjectOwner(VOX_CHUNK_SOURCE_RPC_ID)
export class VoxChunkSource extends BaseVolumeChunkSource {
  declare OPTIONS: {
    spec: VolumeChunkSpecification;
    lodFactor?: number;
  };
  private tempVoxChunkGridPosition = new Float32Array(3);
  private tempLocalPosition = new Uint32Array(3);
  private dirtyChunks = new Set<string>();
  private scheduleProcessPendingUploads = animationFrameDebounce(() =>
    this.processPendingUploads(),
  );
  private lodFactor: number;

  /** Initialize map in the worker/backend for this source. */
  initializeMap(map: VoxMapConfig) {
    try {
      this.rpc!.invoke(VOX_MAP_INIT_RPC_ID, { id: this.rpcId, map });
    } catch {
      // initialization is best-effort; continue even if it fails
      console.warn(
        "VoxChunkSource.initializeMap: Failed to initialize voxel map.",
      );
    }
  }

  constructor(
    chunkManager: ChunkManager,
    options: { spec: VolumeChunkSpecification; lodFactor?: number },
  ) {
    super(chunkManager, options);
    this.lodFactor = options.lodFactor ?? 1;
  }

  override initializeCounterpart(rpc: any, options: any) {
    const opts = { ...(options || {}), spec: this.spec };
    opts.lodFactor = this.lodFactor;
    super.initializeCounterpart(rpc, opts);
  }

  static override encodeOptions(options: {
    spec: VolumeChunkSpecification;
    vox?: { serverUrl?: string; token?: string };
    lodFactor?: number;
  }) {
    const base = (BaseVolumeChunkSource as any).encodeOptions(options);
    if (options?.vox) {
      (base as any).vox = {
        serverUrl: options.vox.serverUrl,
        token: options.vox.token,
      };
    }
    if (options?.lodFactor) {
      (base as any).lodFactor = options.lodFactor;
    }
    return base;
  }

  private scheduleUpdate(key: string) {
    this.dirtyChunks.add(key);
    this.scheduleProcessPendingUploads();
  }

  private processPendingUploads() {
    const remaining = new Set<string>();
    for (const key of this.dirtyChunks) {
      const chunk = this.chunks.get(key) as VolumeChunk | undefined;
      const cpuArray = chunk ? this.getCpuArrayForChunk(chunk) : null;
      if (chunk && cpuArray) {
        this.invalidateChunkUpload(chunk);
      } else {
        remaining.add(key);
      }
    }
    this.dirtyChunks = remaining;
    this.chunkManager.chunkQueueManager.visibleChunksChanged.dispatch();
  }

  invalidateChunksByKey(keys: string[]) {
    console.log("invalidateChunksByKey", this.lodFactor, keys);
    // TODO: Avoid invalidating the whole cache, instead invalidate only the chunks that are affected by the edits.
    this.invalidateCache();
  }

  /** Batch paint API to minimize GPU uploads by chunk. Returns backend edits payload. */
  paintVoxelsBatch(voxels: Float32Array[], value: number): { key: string; indices: number[]; value: number }[] {
    if (!voxels || voxels.length === 0) return [];
    const indicesByInnerKey = new Map<string, number[]>();
    const editsByFullKey = new Map<string, number[]>();
    const chunksToUpdate = new Set<string>();

    for (const v of voxels) {
      if (!v) continue;
      const { key, canonicalIndex, chunkLocalIndex } = this.computeIndices(v);
      // Immediate draw on CPU array if present
      if (chunkLocalIndex >= 0) {
        const chunk = this.chunks.get(key) as VolumeChunk | undefined;
        const cpuArray = chunk ? this.getCpuArrayForChunk(chunk) : null;

        if (cpuArray) {
          (cpuArray as any)[chunkLocalIndex] = value as any;
        }
        chunksToUpdate.add(key);
      }

      let arrInner = indicesByInnerKey.get(key);
      if (!arrInner) indicesByInnerKey.set(key, (arrInner = []));
      arrInner.push(canonicalIndex);
    }

    // Schedule GPU uploads for updated chunks (using inner keys)
    for (const key of chunksToUpdate) this.scheduleUpdate(key);

    // Build backend edits payload using full keys (including LOD)
    for (const [innerKey, indices] of indicesByInnerKey.entries()) {
      const fullKey = makeVoxChunkKey(innerKey, this.lodFactor);
      editsByFullKey.set(fullKey, indices);
    }

    const edits: { key: string; indices: number[]; value: number }[] = [];
    for (const [key, indices] of editsByFullKey.entries()) {
      edits.push({ key, indices, value });
    }
    return edits;
  }

  /** getValueAt simply defers to base; edits are persisted in backend and applied to CPU array when present. */
  override getValueAt(chunkPosition: Float32Array, channelAccess: any) {
    return super.getValueAt(chunkPosition, channelAccess);
  }

  private localIndexFromLocalPosition(local: Uint32Array, size: Uint32Array) {
    // (z * sy + y) * sx + x
    return (local[2] * size[1] + local[1]) * size[0] + local[0];
  }

  private computeIndices(voxel: Float32Array) {
    const rank = this.spec.rank;
    const { baseVoxelOffset, chunkDataSize } = this.spec as any;
    const keyParts = this.tempVoxChunkGridPosition;
    const local = this.tempLocalPosition;

    for (let i = 0; i < rank; ++i) {
      const v = (voxel[i] as number) - baseVoxelOffset[i];
      const size = chunkDataSize[i];
      const c = Math.floor(v / size);
      keyParts[i] = c;
      local[i] = Math.floor(v - c * size);
    }

    const key = `${keyParts[0]},${keyParts[1]},${keyParts[2]}`;

    const canonicalIndex = this.localIndexFromLocalPosition(
      local,
      this.spec.chunkDataSize as Uint32Array,
    );

    const chunk = this.chunks.get(key) as VolumeChunk | undefined;
    let chunkLocalIndex = -1;
    if (chunk) {
      const cds = chunk.chunkDataSize as Uint32Array;
      if (local[0] < cds[0] && local[1] < cds[1] && local[2] < cds[2]) {
        chunkLocalIndex = this.localIndexFromLocalPosition(local, cds);
      }
    }
    return { key, canonicalIndex, chunkLocalIndex };
  }

  private getCpuArrayForChunk(chunk: VolumeChunk): TypedArray | null {
    const data = (chunk as any).data as TypedArray | null | undefined;
    return data ?? null;
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

  /**
   * 2D flood fill with thickness constraint to prevent leaking through narrow passages
   */
  floodFillPlane2D(
    startVoxelLod: Float32Array,
    fillValue: number,
    maxVoxels: number,
  ): { edits: { key: string; indices: number[]; value: number }[]; filledCount: number; originalValue: number } {
    if (!startVoxelLod || startVoxelLod.length < 3) {
      throw new Error("VoxChunkSource.floodFillPlane2D: startVoxelLod must be Float32Array[3].");
    }
    if (!Number.isFinite(maxVoxels) || maxVoxels <= 0) {
      throw new Error("VoxChunkSource.floodFillPlane2D: maxVoxels must be > 0.");
    }

    const seed = new Float32Array([
      Math.floor(startVoxelLod[0] ?? NaN),
      Math.floor(startVoxelLod[1] ?? NaN),
      Math.floor(startVoxelLod[2] ?? NaN),
    ]);

    if (!Number.isFinite(seed[0]) || !Number.isFinite(seed[1]) || !Number.isFinite(seed[2])) {
      throw new Error("VoxChunkSource.floodFillPlane2D: startVoxelLod contains invalid coordinates.");
    }

    const seedIdx = this.computeIndices(seed);
    const seedChunk = this.chunks.get(seedIdx.key) as VolumeChunk | undefined;
    const seedCpu = seedChunk ? this.getCpuArrayForChunk(seedChunk) : null;
    if (!seedCpu || seedIdx.chunkLocalIndex < 0) {
      throw new Error("VoxChunkSource.floodFillPlane2D: seed lies in an unloaded chunk or out of bounds.");
    }

    const originalValue = Number((seedCpu as any)[seedIdx.chunkLocalIndex] ?? NaN);
    if (!Number.isFinite(originalValue)) {
      throw new Error("VoxChunkSource.floodFillPlane2D: unable to read seed value.");
    }
    if ((originalValue >>> 0) === (fillValue >>> 0)) {
      return { edits: [], filledCount: 0, originalValue };
    }

    const zPlane = seed[2] | 0;
    const visited = new Set<string>();
    const queue: [number, number][] = [];
    const indicesByInnerKey = new Map<string, number[]>();
    const localIndicesByInnerKey = new Map<string, number[]>();
    let filledCount = 0;

    const isOriginalAt = (px: number, py: number): boolean => {
      const voxel = new Float32Array([px, py, zPlane]);
      const { key, chunkLocalIndex } = this.computeIndices(voxel);
      const chunk = this.chunks.get(key) as VolumeChunk | undefined;
      const cpu = chunk ? this.getCpuArrayForChunk(chunk) : null;
      if (!cpu || chunkLocalIndex < 0) {
        // For thickness checking, treat unloaded as non-original (conservative approach)
        return false;
      }
      const v = Number((cpu as any)[chunkLocalIndex]);
      return (v >>> 0) === (originalValue >>> 0);
    };

    const scheduleFill = (x: number, y: number) => {
      if (filledCount >= maxVoxels) {
        throw new Error(`VoxChunkSource.floodFillPlane2D: region exceeds maxVoxels (${maxVoxels}).`);
      }

      const voxel = new Float32Array([x, y, zPlane]);
      const { key, canonicalIndex, chunkLocalIndex } = this.computeIndices(voxel);

      let arr = indicesByInnerKey.get(key);
      if (!arr) indicesByInnerKey.set(key, (arr = []));
      arr.push(canonicalIndex);

      let locals = localIndicesByInnerKey.get(key);
      if (!locals) localIndicesByInnerKey.set(key, (locals = []));
      locals.push(chunkLocalIndex);
      filledCount++;
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
      if (requiredThickness <= 1) return true; // No thickness constraint

      const dx = nx - x;
      const dy = ny - y;

      // Only allow exactly one-axis moves (4-connectivity)
      if ((dx === 0) === (dy === 0)) return false;

      const halfThickness = Math.floor(requiredThickness / 2);

      if (dx !== 0) {
        // Horizontal move: check vertical thickness at BOTH current and destination
        // We need the channel to be thick enough along the entire path
        for (const checkX of [x, nx]) {
          for (let offset = -halfThickness; offset <= halfThickness; offset++) {
            if (!isOriginalAt(checkX, ny + offset)) {
              return false; // Channel not thick enough
            }
          }
        }
      } else {
        // Vertical move: check horizontal thickness at BOTH current and destination
        for (const checkY of [y, ny]) {
          for (let offset = -halfThickness; offset <= halfThickness; offset++) {
            if (!isOriginalAt(nx + offset, checkY)) {
              return false; // Channel not thick enough
            }
          }
        }
      }

      return true;
    };

    const fillBorderRegion = (
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
        scheduleFill(cx, cy); // Schedule the current pixel of the sub-fill

        const neighbors: [number, number][] = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
        for (const [nnx, nny] of neighbors) {
          if (nnx < startX - halfThickness || nnx > startX + halfThickness ||
              nny < startY - halfThickness || nny > startY + halfThickness) {
            continue; // Outside the bounding box
          }
          const nk = `${nnx},${nny}`;
          if (visited.has(nk)) continue;

          if (isOriginalAt(nnx, nny)) {
            visited.add(nk);
            subQueue.push([nnx, nny]);
          }
        }
      }
    };

    // Seed the queue
    queue.push([seed[0] | 0, seed[1] | 0]);
    visited.add(`${seed[0] | 0},${seed[1] | 0}`);

    // BFS with thickness constraints
    while (queue.length > 0) {
      const [x, y] = queue.shift()!;

      // Schedule this pixel for filling
      scheduleFill(x, y);

      // Get current thickness requirement
      const requiredThickness = getCurrentThickness();

      // Check 4-neighbors
      const neighbors: [number, number][] = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
      for (const [nx, ny] of neighbors) {
        const k = `${nx},${ny}`;
        if (visited.has(k)) continue;

        if (isOriginalAt(nx, ny)) {
          // The neighbor is a valid fill target. Now check if we can propagate from it.
          if (hasThickEnoughChannel(x, y, nx, ny, requiredThickness)) {
            // Channel is thick enough: Add to queue to propagate.
            visited.add(k);
            queue.push([nx, ny]);
          } else {
            fillBorderRegion(nx, ny, requiredThickness);
          }
        }
      }
    }

    // Apply changes to CPU arrays and schedule updates
    const chunksToUpdate = new Set<string>();
    for (const [innerKey, localIndices] of localIndicesByInnerKey.entries()) {
      const chunk = this.chunks.get(innerKey) as VolumeChunk | undefined;
      const cpu = chunk ? this.getCpuArrayForChunk(chunk) : null;
      if (!cpu) {
        throw new Error(`VoxChunkSource.floodFillPlane2D: missing CPU array for key=${innerKey}`);
      }
      for (const li of localIndices) {
        (cpu as any)[li] = fillValue as any;
      }
      chunksToUpdate.add(innerKey);
    }

    for (const key of chunksToUpdate) this.scheduleUpdate(key);

    // Build backend edits payload
    const edits: { key: string; indices: number[]; value: number }[] = [];
    for (const [innerKey, indices] of indicesByInnerKey.entries()) {
      const fullKey = makeVoxChunkKey(innerKey, this.lodFactor);
      edits.push({ key: fullKey, indices, value: fillValue >>> 0 });
    }

    return { edits, filledCount, originalValue: originalValue >>> 0 };
  }

  private invalidateChunkUpload(chunk: VolumeChunk) {
    const gl = chunk.gl;
    const anyChunk = chunk as any;
    if (
      chunk.state === ChunkState.GPU_MEMORY &&
      typeof anyChunk.updateFromCpuData === "function"
    ) {
      anyChunk.updateFromCpuData(gl);
      return;
    }
    chunk.copyToGPU(gl);
  }
}

