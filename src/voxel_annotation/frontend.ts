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
  VOX_COMMIT_VOXELS_RPC_ID,
  VOX_MAP_INIT_RPC_ID,
  VOX_LABELS_GET_RPC_ID,
  VOX_LABELS_ADD_RPC_ID,
} from "#src/voxel_annotation/base.js";
import { registerSharedObjectOwner } from "#src/worker_rpc.js";

/**
 * Frontend owner for VoxChunkSource, extended with a local optimistic edit overlay.
 */
@registerSharedObjectOwner(VOX_CHUNK_SOURCE_RPC_ID)
export class VoxChunkSource extends BaseVolumeChunkSource {
  declare OPTIONS: {
    spec: VolumeChunkSpecification;
    vox?: { serverUrl?: string; token?: string };
  };
  private voxOptions?: { serverUrl?: string; token?: string };
  private tempVoxChunkGridPosition = new Float32Array(3);
  private tempLocalPosition = new Uint32Array(3);
  private dirtyChunks = new Set<string>();
  private scheduleProcessPendingUploads = animationFrameDebounce(() =>
    this.processPendingUploads(),
  );

  /** Initialize map in the worker/backend for this source. */
  initializeMap(opts: {
    mapId?: string;
    dataType?: number;
    chunkDataSize?: number[];
    upperVoxelBound?: number[];
    baseVoxelOffset?: number[];
    unit?: string;
    scaleKey?: string;
  }) {
    try {
      this.rpc!.invoke(VOX_MAP_INIT_RPC_ID, { id: this.rpcId, ...opts });
    } catch {
      // initialization is best-effort; continue even if it fails
      console.warn(
        "VoxChunkSource.initializeMap: Failed to initialize voxel map.",
      );
    }
  }

  constructor(
    chunkManager: ChunkManager,
    options: { spec: VolumeChunkSpecification; vox?: { serverUrl?: string; token?: string } },
  ) {
    super(chunkManager, options);
    this.voxOptions = options.vox;
  }

  override initializeCounterpart(rpc: any, options: any) {
    const opts = { ...(options || {}), spec: this.spec };
    if (this.voxOptions) {
      (opts as any).vox = { ...this.voxOptions };
    }
    super.initializeCounterpart(rpc, opts);
  }

  static override encodeOptions(options: {
    spec: VolumeChunkSpecification;
    vox?: { serverUrl?: string; token?: string };
  }) {
    const base = (BaseVolumeChunkSource as any).encodeOptions(options);
    if (options?.vox) {
      (base as any).vox = {
        serverUrl: options.vox.serverUrl,
        token: options.vox.token,
      };
    }
    return base;
  }

  async getLabelIds(): Promise<number[]> {
    try {
      /*
      NOTE: do not pass the rpcId as { id: this.rpcId } since the id field it will be overwritten by promiseInvoke, use another name like { rpcId: this.rpcId }
       */
      return await this.rpc!.promiseInvoke<number[]>(VOX_LABELS_GET_RPC_ID, {
        rpcId: this.rpcId,
      });
    } catch {
      return [];
    }
  }


  async addLabel(value: number): Promise<number[]> {
    // Do not swallow errors; caller should display them to the user and avoid UI updates on failure.
    return await this.rpc!.promiseInvoke<number[]>(VOX_LABELS_ADD_RPC_ID, {
      rpcId: this.rpcId,
      value,
    });
  }

  private scheduleUpdate(key: string) {
    this.dirtyChunks.add(key);
    this.scheduleProcessPendingUploads();
  }

  private processPendingUploads() {
    for (const key of this.dirtyChunks) {
      const chunk = this.chunks.get(key) as VolumeChunk | undefined;
      if (chunk && this.getCpuArrayForChunk(chunk)) {
        this.invalidateChunkUpload(chunk);
      }
    }
    this.dirtyChunks.clear();
    this.chunkManager.chunkQueueManager.visibleChunksChanged.dispatch();
  }

  /** Batch paint API to minimize GPU uploads by chunk. */
  paintVoxelsBatch(voxels: Float32Array[], value: number) {
    if (!voxels || voxels.length === 0) return;
    const editsByKey = new Map<string, number[]>();
    const chunksToUpdate = new Set<string>();

    for (const v of voxels) {
      if (!v) continue;
      const { key, canonicalIndex, chunkLocalIndex } = this.computeIndices(v);
      // Immediate draw on CPU array if present
      if (chunkLocalIndex >= 0) {
        const chunk = this.chunks.get(key) as VolumeChunk | undefined;
        const baseArray = chunk && this.getCpuArrayForChunk(chunk);
        if (baseArray) {
          (baseArray as any)[chunkLocalIndex] = value as any;
          chunksToUpdate.add(key);
        }
      }
      let arr = editsByKey.get(key);
      if (!arr) editsByKey.set(key, (arr = []));
      arr.push(canonicalIndex);
    }

    for (const key of chunksToUpdate) this.scheduleUpdate(key);

    if (editsByKey.size > 0) {
      const size = Array.from(this.spec.chunkDataSize);
      const edits = Array.from(editsByKey, ([key, indices]) => ({
        key,
        indices,
        value,
        size,
      }));
      try {
        this.rpc!.invoke(VOX_COMMIT_VOXELS_RPC_ID, { id: this.rpcId, edits });
      } catch {
        // ignore
      }
    }
  }

  /** getValueAt simply defers to base; edits are persisted in backend and applied to CPU array when present. */
  override getValueAt(chunkPosition: Float32Array, channelAccess: any) {
    return super.getValueAt(chunkPosition, channelAccess);
  }

  private localIndexFromLocalPosition(local: Uint32Array, size: Uint32Array) {
    // (z * sy + y) * sx + x
    return (local[2] * size[1] + local[1]) * size[0] + local[0];
  }

  /** Compute indices for both canonical (spec-sized) and actual loaded chunk. */
  private computeIndices(voxel: Float32Array) {
    const rank = this.spec.rank;
    const { baseVoxelOffset, chunkDataSize } = this.spec as any;
    const keyParts = this.tempVoxChunkGridPosition;
    const local = this.tempLocalPosition;
    for (let i = 0; i < rank; ++i) {
      const v = voxel[i] - baseVoxelOffset[i];
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
      // If the chunk is not loaded yet, the spec size is a reasonable fallback for immediate updates (no-op if no CPU array).
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

  private invalidateChunkUpload(chunk: VolumeChunk) {
    const gl = chunk.gl;
    // If already on GPU and the concrete implementation supports in-place update, use it.
    const anyChunk = chunk as any;
    if (
      chunk.state === ChunkState.GPU_MEMORY &&
      typeof anyChunk.updateFromCpuData === "function"
    ) {
      anyChunk.updateFromCpuData(gl);
      return;
    }
    // Otherwise, just upload (don’t free first).
    chunk.copyToGPU(gl);
  }
}
