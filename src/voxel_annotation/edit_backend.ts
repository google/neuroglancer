/**
 * Edit controller backend: owns the authoritative VoxSourceWriter for a given map
 * and handles applying edits and label persistence independent of the volume chunk
 * streaming backend. This enables multiple VoxChunkSource instances (read-only)
 * while keeping a single writer per map owned by the edit controller.
 */

import type { VolumeChunkSource } from "#src/sliceview/volume/backend.js";
import {
  VOX_EDIT_BACKEND_RPC_ID,
  VOX_EDIT_COMMIT_VOXELS_RPC_ID,
  VOX_EDIT_LABELS_ADD_RPC_ID,
  VOX_EDIT_LABELS_GET_RPC_ID,
  VOX_RELOAD_CHUNKS_RPC_ID,
  makeVoxChunkKey,
  parseVoxChunkKey,
} from "#src/voxel_annotation/base.js";
import type { RPC} from "#src/worker_rpc.js";
import { SharedObject , registerPromiseRPC, registerSharedObject, initializeSharedObjectCounterpart } from "#src/worker_rpc.js";

@registerSharedObject(VOX_EDIT_BACKEND_RPC_ID)
export class VoxelEditController extends SharedObject {
  private sources = new Map<number, VolumeChunkSource>();

  // Short debounce to coalesce rapid edits coming from tools.
  private pendingEdits: {
    key: string;
    indices: number[] | Uint32Array;
    value?: number;
    values?: ArrayLike<number>;
    size?: number[];
  }[] = [];
  private commitDebounceTimer: number | undefined;
  private readonly commitDebounceDelayMs: number = 300;

  // Downsampling queue to serialize and coalesce work across edits.
  private downsampleQueue: string[] = [];
  private downsampleQueueSet: Set<string> = new Set();
  private isProcessingDownsampleQueue: boolean = false;

  constructor(rpc: RPC, options: any) {
    super();
    // Initialize as a counterpart in the worker so RPC references are valid.
    // This registers the object under the provided rpc/id and sets up ref counting.
    initializeSharedObjectCounterpart(this, rpc, options);

    const passedSources = options?.sources;
    if (passedSources === undefined || typeof passedSources !== 'object') {
      throw new Error("VoxelEditBackend: missing required 'sources' map during initialization");
    }

    for (const lodFactorStr in passedSources) {
      const lodFactor = Number(lodFactorStr);
      const sourceId = passedSources[lodFactorStr];
      const resolved = rpc.get(sourceId) as VolumeChunkSource | undefined;
      if (!resolved) {
        throw new Error(`VoxelEditBackend: failed to resolve VolumeChunkSource for LOD factor ${lodFactor}`);
      }
      this.sources.set(lodFactor, resolved);
    }
  }

  private async flushPending(): Promise<void> {
    const edits = this.pendingEdits;
    this.pendingEdits = [];
    this.commitDebounceTimer = undefined;
    if (edits.length === 0) return;

    // 1. Group edits by vox chunk key (includes LOD).
    const editsByVoxKey = new Map<string, { indices: number[]; values: number[] }>();
    for (const edit of edits) {
      if (!editsByVoxKey.has(edit.key)) {
        editsByVoxKey.set(edit.key, { indices: [], values: [] });
      }
      const entry = editsByVoxKey.get(edit.key)!;
      if (edit.values) {
        const vals = Array.from(edit.values);
        if (vals.length !== edit.indices.length) {
          throw new Error("flushPending: values length mismatch with indices");
        }
        for (let i = 0; i < edit.indices.length; ++i) {
          entry.indices.push(Number(edit.indices[i]!));
          entry.values.push(Number(vals[i]!));
        }
      } else if (edit.value !== undefined) {
        const inds = edit.indices as ArrayLike<number>;
        for (let i = 0; i < inds.length; ++i) {
          const index = inds[i]!;
          entry.indices.push(Number(index));
          entry.values.push(Number(edit.value));
        }
      } else {
        throw new Error("flushPending: edit missing value(s)");
      }
    }

    // 2. For each modified vox chunk, apply edits via the correct source and record vox keys to reload.
    const touchedVoxChunkKeys: string[] = [];
    for (const [voxKey, chunkEdits] of editsByVoxKey.entries()) {
      try {
        const parsedKey = parseVoxChunkKey(voxKey);
        if (!parsedKey) {
          console.error(`flushPending: Failed to parse vox chunk key: ${voxKey}`);
          continue;
        }
        const source = this.sources.get(parsedKey.lod);
        if (!source) {
          console.error(`flushPending: No source found for LOD factor ${parsedKey.lod}`);
          continue;
        }
        await (source as any).applyEdits(parsedKey.chunkKey, chunkEdits.indices, chunkEdits.values);
        touchedVoxChunkKeys.push(voxKey);
      } catch (e) {
        console.error(`Failed to write chunk ${voxKey}:`, e);
      }
    }

    // After base edits, enqueue downsampling for affected chunks (do not await here).
    const touched = new Set<string>();
    for (const e of edits) touched.add(e.key);
    for (const key of touched) {
      this.enqueueDownsample(key);
    }
  }

  async commitVoxels(
    edits: {
      key: string;
      indices: number[] | Uint32Array;
      value?: number;
      values?: ArrayLike<number>;
      size?: number[];
    }[],
  ) {
    for (const e of edits) {
      if (!e || !e.key || !e.indices) {
        throw new Error("VoxEditBackend.commitVoxels: invalid edit payload");
      }
      this.pendingEdits.push(e);
    }
    if (this.commitDebounceTimer !== undefined) clearTimeout(this.commitDebounceTimer);
    this.commitDebounceTimer = setTimeout(() => { void this.flushPending(); }, this.commitDebounceDelayMs) as unknown as number;
  }

  async getLabelIds(): Promise<number[]> {
    // Label operations not yet implemented for multiscale edit backend.
    return [];
  }

  async addLabel(_value: number): Promise<number[]> {
    // Label operations not yet implemented for multiscale edit backend.
    return [];
  }

  callChunkReload(voxChunkKeys: string[]){
    this.rpc?.invoke(VOX_RELOAD_CHUNKS_RPC_ID, {
      rpcId: this.rpcId,
      voxChunkKeys: voxChunkKeys,
    })
  }
  // Downsampling helpers
  private parentKeyOf(childKey: string): string | null {
    const info = parseVoxChunkKey(childKey);
    if (info === null) return null;
    const parentLod = info.lod * 2;
    const px = Math.floor(info.x / 2);
    const py = Math.floor(info.y / 2);
    const pz = Math.floor(info.z / 2);
    return makeVoxChunkKey(`${px},${py},${pz}`, parentLod);
  }

  private calculateDownsamplePasses(chunkSize: number): number {
    if (chunkSize <= 1) return 0;
    return Math.ceil(Math.log2(chunkSize));
  }

  private async performDownsampleCascadeForKey(sourceKey: string): Promise<void> {
    const chunkSize = 64;
    const maxPasses = this.calculateDownsamplePasses(chunkSize);
    const maxLOD = 256;

    let currentKey: string | null = sourceKey;
    for (let i = 0; i < maxPasses; i++) {
      if (currentKey === null) break;
      const info = parseVoxChunkKey(currentKey);
      if (info === null) break;
      if (info.lod >= maxLOD) break;
      const nextKey = await this.downsampleStep(currentKey);
      if (nextKey === null) break;
      currentKey = nextKey;
    }
  }

  private calculateMode(values: number[]): number {
    if (values.length === 0) return 0;
    const counts = new Map<number, number>();
    let maxCount = 0;
    let mode = 0;
    for (const v of values) {
      if (v === 0) continue;
      const c = (counts.get(v) ?? 0) + 1;
      counts.set(v, c);
      if (c > maxCount) {
        maxCount = c;
        mode = v;
      }
    }
    return mode;
  }

  private enqueueDownsample(key: string): void {
    if (key.length === 0) return;
    if (!this.downsampleQueueSet.has(key)) {
      this.downsampleQueueSet.add(key);
      this.downsampleQueue.push(key);
    }
    if (!this.isProcessingDownsampleQueue) {
      // Kick processing asynchronously to avoid blocking the caller.
      this.isProcessingDownsampleQueue = true;
      Promise.resolve().then(() => this.processDownsampleQueue());
    }
  }

  private async processDownsampleQueue(): Promise<void> {
    try {
      while (this.downsampleQueue.length > 0) {
        const key = this.downsampleQueue.shift() as string;
        this.downsampleQueueSet.delete(key);
        await this.performDownsampleCascadeForKey(key);
      }
    } finally {
      this.isProcessingDownsampleQueue = false;
      // If new work was enqueued during processing and flag got reset, loop again.
      if (this.downsampleQueue.length > 0 && !this.isProcessingDownsampleQueue) {
        this.isProcessingDownsampleQueue = true;
        Promise.resolve().then(() => this.processDownsampleQueue());
      }
    }
  }

  private async downsampleStep(sourceKey: string): Promise<string | null> {
    const info = parseVoxChunkKey(sourceKey);
    if (info === null) return null;

    const src = this.sources.get(info.lod);
    if (!src) return null;

    const sourceChunk = src.getChunk(
      new Float32Array([info.x, info.y, info.z]),
    ) as any;
    if (!sourceChunk) return null;

    if (!sourceChunk.data) {
      try {
        const ac = new AbortController();
        await src.download(sourceChunk, ac.signal);
      } catch (e) {
        console.warn(`Failed to download source chunk ${sourceKey} for downsampling:`, e);
      }
    }

    if (!sourceChunk.data) {
      console.warn(`Cannot downsample from empty or missing chunk: ${sourceKey}`);
      return null;
    }

    const targetKey = this.parentKeyOf(sourceKey);
    if (targetKey === null) return null;

    // Prepare indices and values to write into the target chunk
    const chunkW = sourceChunk.chunkDataSize[0] / 2; // target subregion width
    const chunkH = sourceChunk.chunkDataSize[1] / 2;
    const chunkD = sourceChunk.chunkDataSize[2] / 2;
    const offsetX = (info.x % 2) * chunkW;
    const offsetY = (info.y % 2) * chunkH;
    const offsetZ = (info.z % 2) * chunkD;

    const targetChunkW = sourceChunk.chunkDataSize[0];
    const targetChunkH = sourceChunk.chunkDataSize[1];

    const indices: number[] = [];
    const values: number[] = [];

    for (let z = 0; z < chunkD; z++) {
      for (let y = 0; y < chunkH; y++) {
        for (let x = 0; x < chunkW; x++) {
          const sx = x * 2;
          const sy = y * 2;
          const sz = z * 2;
          const base = sz * (sourceChunk.chunkDataSize[0] * sourceChunk.chunkDataSize[1]) + sy * sourceChunk.chunkDataSize[0] + sx;
          const row = sourceChunk.chunkDataSize[0];
          const plane = sourceChunk.chunkDataSize[0] * sourceChunk.chunkDataSize[1];
          // Gather 8 voxels from source
          const v000 = Number((sourceChunk.data as any)[base]);
          const v100 = Number((sourceChunk.data as any)[base + 1]);
          const v010 = Number((sourceChunk.data as any)[base + row]);
          const v110 = Number((sourceChunk.data as any)[base + row + 1]);
          const v001 = Number((sourceChunk.data as any)[base + plane]);
          const v101 = Number((sourceChunk.data as any)[base + plane + 1]);
          const v011 = Number((sourceChunk.data as any)[base + plane + row]);
          const v111 = Number((sourceChunk.data as any)[base + plane + row + 1]);
          const mode = this.calculateMode([v000, v100, v010, v110, v001, v101, v011, v111]);

          const tx = x + offsetX;
          const ty = y + offsetY;
          const tz = z + offsetZ;
          const tIndex = tz * (targetChunkW * targetChunkH) + ty * targetChunkW + tx;
          indices.push(tIndex);
          values.push(mode >>> 0);
        }
      }
    }

    if (indices.length > 0) {
      const targetInfo = parseVoxChunkKey(targetKey);
      if (targetInfo) {
        const targetSrc = this.sources.get(targetInfo.lod);
        if (targetSrc) {
          await (targetSrc as any).applyEdits(targetInfo.chunkKey, indices, values);
          // Notify frontend to reload the target parent chunk at its LOD.
          this.callChunkReload([targetKey]);
        } else {
          console.error(`Downsampling failed: could not find target source for LOD ${targetInfo.lod}`);
        }
      }
    }

    return targetKey;
  }
}

registerPromiseRPC(VOX_EDIT_COMMIT_VOXELS_RPC_ID, async function (x: any) {
  const obj = this.get(x.rpcId) as VoxelEditController;
  await obj.commitVoxels(x.edits || []);
  return { value: undefined };
});

registerPromiseRPC<number[]>(VOX_EDIT_LABELS_GET_RPC_ID, async function (x: any) {
  const obj = this.get(x.rpcId) as VoxelEditController;
  const ids = await obj.getLabelIds();
  return { value: ids };
});

registerPromiseRPC<number[]>(VOX_EDIT_LABELS_ADD_RPC_ID, async function (x: any) {
  const obj = this.get(x.rpcId) as VoxelEditController;
  const ids = await obj.addLabel(x?.value >>> 0);
  return { value: ids };
});
