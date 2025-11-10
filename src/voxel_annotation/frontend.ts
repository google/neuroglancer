/**
 * @license
 * Copyright 2025.
 */

import { ChunkState } from '#src/chunk_manager/base.js';
import type { ChunkManager } from '#src/chunk_manager/frontend.js';
import type { VolumeChunkSpecification } from '#src/sliceview/volume/base.js';
import type { VolumeChunk } from '#src/sliceview/volume/frontend.js';
import { VolumeChunkSource as BaseVolumeChunkSource } from '#src/sliceview/volume/frontend.js';
import { animationFrameDebounce } from "#src/util/animation_frame_debounce.js";
import type { TypedArray } from '#src/util/array.js';
import { VOX_CHUNK_SOURCE_RPC_ID } from '#src/voxel_annotation/base.js';
import { registerSharedObjectOwner } from "#src/worker_rpc.js";

/** Small sparse overlay storing per-chunk edits as index->value maps. */
class VoxelEditOverlay {
  private edits = new Map<string, Map<number, number>>();

  applyEdit(key: string, localIndex: number, value: number) {
    let m = this.edits.get(key);
    if (!m) {
      m = new Map();
      this.edits.set(key, m);
    }
    m.set(localIndex, value);
  }

  mergeIntoChunkData(key: string, baseArray: TypedArray) {
    const m = this.edits.get(key);
    if (!m) return;
    for (const [idx, val] of m) {
      if (idx >= 0 && idx < baseArray.length) {
        (baseArray as any)[idx] = val as any;
      }
    }
  }

  getOverlayValue(key: string, localIndex: number): number | undefined {
    const m = this.edits.get(key);
    return m?.get(localIndex);
  }

  discardChunk(key: string) {
    this.edits.delete(key);
  }

  clear() {
    this.edits.clear();
  }
}

/**
 * Frontend owner for VoxChunkSource, extended with a local optimistic edit overlay.
 */
@registerSharedObjectOwner(VOX_CHUNK_SOURCE_RPC_ID)
export class VoxChunkSource extends BaseVolumeChunkSource {
  private overlay = new VoxelEditOverlay();
  private tempVoxChunkGridPosition = new Float32Array(3);
  private tempLocalPosition = new Uint32Array(3);
  private dirtyChunks = new Set<string>();
  private scheduleProcessPendingUploads = animationFrameDebounce(
    () => this.processPendingUploads()
  );

  constructor(chunkManager: ChunkManager, options: { spec: VolumeChunkSpecification }) {
    super(chunkManager, options);
  }

  /** Patch newly added chunks with any overlayed voxels and force re-upload. */
  override addChunk(key: string, chunk: VolumeChunk) {
    super.addChunk(key, chunk);
    const baseArray = this.getCpuArrayForChunk(chunk);
    if (baseArray) {
      this.overlay.mergeIntoChunkData(key, baseArray);
      this.invalidateChunkUpload(chunk);
    }
  }

  /** Public paint API called by the tool/controller. */
  paintVoxel(voxel: Float32Array, value: number) {
    const { key, localIndex } = this.computeChunkKeyAndIndex(voxel);
    if (localIndex < 0) return;
    this.overlay.applyEdit(key, localIndex, value);
    const chunk = this.chunks.get(key) as VolumeChunk | undefined;
    if (chunk) {
      const baseArray = this.getCpuArrayForChunk(chunk);
      if (baseArray) {
        // Merge and mark for re-upload.
        this.overlay.mergeIntoChunkData(key, baseArray);
        this.scheduleUpdate(key);
      }
    }
  }

  private scheduleUpdate(key: string) {
    this.dirtyChunks.add(key);
    this.scheduleProcessPendingUploads();
  }

  private processPendingUploads() {
    for (const key of this.dirtyChunks) {
      const chunk = this.chunks.get(key) as VolumeChunk | undefined;
      if (chunk && this.getCpuArrayForChunk(chunk)) {
        // The original blocking upload logic is now here
        const gl = chunk.gl;
        if (chunk.state === ChunkState.GPU_MEMORY) {
          chunk.freeGPUMemory(gl);
        }
        chunk.copyToGPU(gl);
      }
    }
    this.dirtyChunks.clear();
    this.chunkManager.chunkQueueManager.visibleChunksChanged.dispatch();
  }

  /** Batch paint API to minimize GPU uploads by chunk. */
  paintVoxelsBatch(voxels: Float32Array[], value: number) {
    if (!voxels || voxels.length === 0) return;
    const affectedKeys = new Set<string>();
    // Apply edits to overlay and collect affected chunk keys.
    for (const v of voxels) {
      if (!v) continue;
      const { key, localIndex } = this.computeChunkKeyAndIndex(v);
      if (localIndex < 0) continue;
      this.overlay.applyEdit(key, localIndex, value);
      affectedKeys.add(key);
    }
    // For each affected chunk currently resident on CPU, merge and re-upload once.
    for (const key of affectedKeys) {
      const chunk = this.chunks.get(key) as VolumeChunk | undefined;
      if (!chunk) continue;
      const baseArray = this.getCpuArrayForChunk(chunk);
      if (!baseArray) continue;
      this.overlay.mergeIntoChunkData(key, baseArray);
      this.scheduleUpdate(key);
    }
    }

  /** getValueAt that respects overlay if present. */
  override getValueAt(chunkPosition: Float32Array, channelAccess: any) {
    // Compute key and local position based on the provided chunkPosition in voxel coordinates.
    const rank = this.spec.rank;
    const keyParts: number[] = [];
    const local = this.tempLocalPosition;
    const { chunkDataSize } = this.spec;
    for (let dim = 0; dim < rank; ++dim) {
      const voxel = chunkPosition[dim];
      const size = chunkDataSize[dim];
      const c = Math.floor(voxel / size);
      keyParts.push(c);
      local[dim] = Math.floor(voxel - c * size);
    }
    const key = keyParts.join();
    const chunk = this.chunks.get(key) as VolumeChunk | undefined;
    if (chunk) {
      const cds = chunk.chunkDataSize;
      if (cds && (local[0] >= cds[0] || local[1] >= cds[1] || local[2] >= cds[2])) {
        return undefined;
      }
      const localIndex = this.localIndexFromLocalPosition(local, cds ?? this.spec.chunkDataSize);
      const ov = this.overlay.getOverlayValue(key, localIndex);
      if (ov !== undefined) return ov;
    }
    return super.getValueAt(chunkPosition, channelAccess);
  }

  private localIndexFromLocalPosition(local: Uint32Array, size: Uint32Array) {
    // (z * sy + y) * sx + x
    return (local[2] * size[1] + local[1]) * size[0] + local[0];
  }

  private computeChunkKeyAndIndex(voxel: Float32Array) {
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
    const chunk = this.chunks.get(key) as VolumeChunk | undefined;
    const size = (chunk?.chunkDataSize as Uint32Array) ?? (this.spec.chunkDataSize as Uint32Array);
    const localIndex = this.localIndexFromLocalPosition(local, size);
    return { key, localIndex };
  }

  private getCpuArrayForChunk(chunk: VolumeChunk): TypedArray | null {
    const data = (chunk as any).data as TypedArray | null | undefined;
    return (data ?? null);
  }

  private invalidateChunkUpload(chunk: VolumeChunk) {
    const gl = chunk.gl;
    // If already on GPU and the concrete implementation supports in-place update, use it.
    const anyChunk = chunk as any;
    if (chunk.state === ChunkState.GPU_MEMORY && typeof anyChunk.updateFromCpuData === 'function') {
      anyChunk.updateFromCpuData(gl);
      return;
    }
    // Otherwise, just upload (don’t free first).
    chunk.copyToGPU(gl);
  }
}
