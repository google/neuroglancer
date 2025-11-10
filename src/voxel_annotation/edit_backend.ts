/**
 * Edit controller backend: owns the authoritative VoxSourceWriter for a given map
 * and handles applying edits and label persistence independent of the volume chunk
 * streaming backend. This enables multiple VoxChunkSource instances (read-only)
 * while keeping a single writer per map owned by the edit controller.
 */

import {
  VOX_EDIT_BACKEND_RPC_ID,
  VOX_EDIT_COMMIT_VOXELS_RPC_ID,
  VOX_EDIT_LABELS_ADD_RPC_ID,
  VOX_EDIT_LABELS_GET_RPC_ID,
  VOX_EDIT_MAP_INIT_RPC_ID,
  VOX_RELOAD_CHUNKS_RPC_ID,
} from "#src/voxel_annotation/base.js";
import type { VoxSourceWriter } from "#src/voxel_annotation/index.js";
import { LocalVoxSourceWriter } from "#src/voxel_annotation/local_source.js";
import type { VoxMapConfig } from "#src/voxel_annotation/map.js";
import type { RPC} from "#src/worker_rpc.js";
import { SharedObject , registerPromiseRPC, registerRPC, registerSharedObject, initializeSharedObjectCounterpart } from "#src/worker_rpc.js";

@registerSharedObject(VOX_EDIT_BACKEND_RPC_ID)
export class VoxelEditController extends SharedObject {
  private source?: VoxSourceWriter;
  private mapReadyPromise: Promise<void>;
  private resolveMapReady!: () => void;

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

  constructor(rpc: RPC, options: any) {
    super();
    // Initialize as a counterpart in the worker so RPC references are valid.
    // This registers the object under the provided rpc/id and sets up ref counting.
    initializeSharedObjectCounterpart(this, rpc, options);
    this.mapReadyPromise = new Promise<void>((resolve) => {
      this.resolveMapReady = resolve;
    });
  }

  async initMap(arg: { map?: VoxMapConfig } | VoxMapConfig) {
    const map: VoxMapConfig = (arg as any)?.map ?? (arg as any);
    if (!map) throw new Error("VoxEditBackend.initMap: map configuration is required");
    const src = new LocalVoxSourceWriter(this);
    await src.init(map);
    this.source = src;
    try { this.resolveMapReady(); } catch {/* ignore */}
  }

  private async flushPending(): Promise<void> {
    await this.mapReadyPromise;
    const src = this.source;
    if (!src) throw new Error("VoxEditBackend.flushPending: source not initialized");
    const edits = this.pendingEdits;
    this.pendingEdits = [];
    this.commitDebounceTimer = undefined;
    if (edits.length === 0) return;
    await src.applyEdits(edits);
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
    await this.mapReadyPromise;
    if (!this.source) throw new Error("VoxEditBackend.commitVoxels: source not initialized");
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
    await this.mapReadyPromise;
    const src = this.source;
    if (!src) throw new Error("VoxEditBackend.getLabelIds: source not initialized");
    return await src.getLabelIds();
  }

  async addLabel(value: number): Promise<number[]> {
    await this.mapReadyPromise;
    const src = this.source;
    if (!src) throw new Error("VoxEditBackend.addLabel: source not initialized");
    return await src.addLabel(value >>> 0);
  }

  callChunkReload(voxChunkKeys: string[]){
    this.rpc?.invoke(VOX_RELOAD_CHUNKS_RPC_ID, {
      rpcId: this.rpcId,
      voxChunkKeys: voxChunkKeys,
    })
  }
}

// RPC wire-up
registerRPC(VOX_EDIT_MAP_INIT_RPC_ID, function (x: any) {
  const obj = this.get(x.rpcId) as VoxelEditController;
  obj.initMap(x?.map || x || {});
});

registerRPC(VOX_EDIT_COMMIT_VOXELS_RPC_ID, function (x: any) {
  const obj = this.get(x.rpcId) as VoxelEditController;
  obj.commitVoxels(x.edits || []);
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
