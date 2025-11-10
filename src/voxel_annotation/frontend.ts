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
    vox?: { serverUrl?: string; token?: string };
    lodFactor?: number;
  };
  private voxOptions?: { serverUrl?: string; token?: string };
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
    options: { spec: VolumeChunkSpecification; vox?: { serverUrl?: string; token?: string }; lodFactor?: number },
  ) {
    super(chunkManager, options);
    this.voxOptions = options.vox;
    this.lodFactor = options.lodFactor ?? 1;
  }

  override initializeCounterpart(rpc: any, options: any) {
    const opts = { ...(options || {}), spec: this.spec };
    if (this.voxOptions) {
      (opts as any).vox = { ...this.voxOptions };
    }
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
    const cds = (chunk?.chunkDataSize as Uint32Array) ?? null;
    if (cds) {
      if (local[0] < cds[0] && local[1] < cds[1] && local[2] < cds[2]) {
        chunkLocalIndex = this.localIndexFromLocalPosition(local, cds);
      }
    } else {
      chunkLocalIndex = this.localIndexFromLocalPosition(
        local,
        this.spec.chunkDataSize as Uint32Array,
      );
    }
    return { key, canonicalIndex, chunkLocalIndex };
  }

  private getCpuArrayForChunk(chunk: VolumeChunk): TypedArray | null {
    const data = (chunk as any).data as TypedArray | null | undefined;
    return data ?? null;
  }

  /**
   * 2D flood fill on a z-constant plane using 4-connectivity. Operates only on loaded chunks.
   * Throws if the seed chunk is not loaded, if the fill would exceed maxVoxels, or if it crosses
   * into any unloaded chunk. Returns a backend edits payload and some stats. It enqueues all
   * voxel updates during BFS and only applies them to the CPU arrays after the BFS completes
   * successfully, then schedules GPU uploads for live feedback.
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

    // Determine the target value at the seed from loaded CPU data.
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
    const pushIfNew = (x: number, y: number) => {
      const k = `${x},${y}`;
      if (visited.has(k)) return false;
      visited.add(k);
      queue.push([x, y]);
      return true;
    };

    pushIfNew(seed[0] | 0, seed[1] | 0);

    // Collect edits without touching CPU arrays until BFS succeeds.
    const indicesByInnerKey = new Map<string, number[]>(); // canonical indices for backend edits
    const localIndicesByInnerKey = new Map<string, number[]>(); // chunk-local indices for CPU painting
    let filledCount = 0;

    // BFS 4-connected on (x,y) at fixed zPlane
    while (queue.length > 0) {
      const [x, y] = queue.shift()!;
      // Check cap early
      if (filledCount >= maxVoxels) {
        throw new Error(`VoxChunkSource.floodFillPlane2D: region exceeds maxVoxels (${maxVoxels}).`);
      }

      const voxel = new Float32Array([x, y, zPlane]);
      const { key, canonicalIndex, chunkLocalIndex } = this.computeIndices(voxel);
      const chunk = this.chunks.get(key) as VolumeChunk | undefined;
      const cpu = chunk ? this.getCpuArrayForChunk(chunk) : null;
      if (!cpu || chunkLocalIndex < 0) {
        throw new Error(
          `VoxChunkSource.floodFillPlane2D: encountered unloaded chunk at (${x},${y},${zPlane}) key=${key}.`,
        );
      }

      const currentValue = Number((cpu as any)[chunkLocalIndex]);
      if ((currentValue >>> 0) !== (originalValue >>> 0)) {
        continue; // boundary
      }

      // Enqueue to apply after BFS completes.
      let arr = indicesByInnerKey.get(key);
      if (!arr) indicesByInnerKey.set(key, (arr = []));
      arr.push(canonicalIndex);

      let locals = localIndicesByInnerKey.get(key);
      if (!locals) localIndicesByInnerKey.set(key, (locals = []));
      locals.push(chunkLocalIndex);

      filledCount++;

      // 4-neighbors
      pushIfNew(x + 1, y);
      pushIfNew(x - 1, y);
      pushIfNew(x, y + 1);
      pushIfNew(x, y - 1);
    }

    // If we get here, BFS succeeded. Now apply to CPU arrays and schedule uploads.
    const chunksToUpdate = new Set<string>();
    for (const [innerKey, localIndices] of localIndicesByInnerKey.entries()) {
      const chunk = this.chunks.get(innerKey) as VolumeChunk | undefined;
      const cpu = chunk ? this.getCpuArrayForChunk(chunk) : null;
      if (!cpu) {
        throw new Error(`VoxChunkSource.floodFillPlane2D: missing CPU array when applying updates for key=${innerKey}`);
      }
      for (const li of localIndices) {
        (cpu as any)[li] = fillValue as any;
      }
      chunksToUpdate.add(innerKey);
    }

    for (const key of chunksToUpdate) this.scheduleUpdate(key);

    // Build backend edits payload using full keys (including LOD)
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

