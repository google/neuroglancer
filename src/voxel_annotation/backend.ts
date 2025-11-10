/**
 * @license
 * Copyright 2025.
 */

import type { VolumeChunk } from "#src/sliceview/volume/backend.js";
import { VolumeChunkSource as BaseVolumeChunkSource } from "#src/sliceview/volume/backend.js";
import { DataType } from "#src/util/data_type.js";
import {
  makeVoxChunkKey,
  VOX_CHUNK_SOURCE_RPC_ID,
  VOX_COMMIT_VOXELS_RPC_ID,
  VOX_LABELS_ADD_RPC_ID,
  VOX_LABELS_GET_RPC_ID,
  VOX_MAP_INIT_RPC_ID,
  VOX_RELOAD_CHUNKS_RPC_ID,
} from "#src/voxel_annotation/base.js";
import type { VoxSource } from "#src/voxel_annotation/index.js";
import { LocalVoxSource } from "#src/voxel_annotation/local_source.js";
import type { VoxMapConfig } from "#src/voxel_annotation/map.js";
import { RemoteVoxSource } from "#src/voxel_annotation/remote_source.js";
import type { RPC } from "#src/worker_rpc.js";
import { registerPromiseRPC, registerRPC, registerSharedObject } from "#src/worker_rpc.js";

/**
 * Backend volume source that persists voxel edits per chunk. It returns saved data if available,
 * otherwise returns an empty chunk (filled with zeros).
 */
// --- VoxSource registry: share per (serverUrl, token, mapId, scaleKey) ---
const voxSourceRegistry = new Map<string, VoxSource>();

function makeServerKey(serverUrl?: string, token?: string): string {
  if (!serverUrl) return "local";
  return `remote:${serverUrl}|${token ?? ""}`;
}

function toScaleKeySafe(map: VoxMapConfig): string {
  const cds = Array.from(map.chunkDataSize);
  const lower = Array.from(map.baseVoxelOffset);
  const upper = Array.from(map.upperVoxelBound);
  return `${cds.join(',')}:${lower.join(',')}-${upper.join(',')}`;
}

function makeRegistryKey(serverUrl: string | undefined, token: string | undefined, map: VoxMapConfig): string {
  const sk = makeServerKey(serverUrl, token);
  const scaleKey = toScaleKeySafe(map);
  return `${sk}|${map.id}|${scaleKey}`;
}

async function getOrCreateRegisteredVoxSource(serverUrl: string | undefined, token: string | undefined, map: VoxMapConfig, vcsInstance: VoxChunkSource): Promise<VoxSource> {
  const key = makeRegistryKey(serverUrl, token, map);
  const existing = voxSourceRegistry.get(key);
  if (existing)
  {
    existing.addVoxChunkSource(vcsInstance);
    return existing;
  }
  const src = serverUrl ? new RemoteVoxSource(serverUrl, token) : new LocalVoxSource();
  await src.init(map);
  voxSourceRegistry.set(key, src);
  src.addVoxChunkSource(vcsInstance);
  return src;
}

@registerSharedObject(VOX_CHUNK_SOURCE_RPC_ID)
export class VoxChunkSource extends BaseVolumeChunkSource {
  private source?: VoxSource;
  private voxServerUrl?: string;
  private voxToken?: string;
  public lodFactor: number;
  private mapReadyPromise: Promise<void>;
  private resolveMapReady!: () => void;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    // Detect remote server configuration from options (flexible keys)
    const o = options || {};
    this.voxServerUrl = o.voxServerUrl || o.serverUrl || o.vox?.serverUrl;
    this.voxToken = o.voxToken || o.token || o.vox?.token;
    this.lodFactor = o.lodFactor;
    if (this.lodFactor == undefined) {
      throw new Error("lodFactor is required");
    }
    this.mapReadyPromise = new Promise<void>((resolve) => {
      this.resolveMapReady = resolve;
    });
  }

  /** Initialize map metadata and persistence backend using a VoxMapConfig. */
  async initMap(arg: { map?: VoxMapConfig } | VoxMapConfig) {
    const map: VoxMapConfig = (arg as any)?.map ?? (arg as any);
    if (!map) throw new Error("initMap: map configuration is required");
    // Allow runtime override/validation of server settings via map
    if (map.serverUrl) {
      if (this.voxServerUrl && this.voxServerUrl !== map.serverUrl) {
        throw new Error("initMap: conflicting serverUrl provided");
      }
      this.voxServerUrl = map.serverUrl;
    }
    if (map.token) {
      if (this.voxToken && this.voxToken !== map.token) {
        throw new Error("initMap: conflicting token provided");
      }
      this.voxToken = map.token;
    }
    // Bind to a per-(server,map,scaleKey) registered source
    this.source = await getOrCreateRegisteredVoxSource(
      this.voxServerUrl,
      this.voxToken,
      map,
      this
    );
    // Signal readiness for any pending downloads/commits
    try { this.resolveMapReady(); } catch { /* ignore multiple resolutions */ }
  }

  reloadChunksByKey(keys: string[]) {
    this.rpc?.invoke(VOX_RELOAD_CHUNKS_RPC_ID, {
      id: this.rpcId,
      keys,
    });
  }

  /** Commit voxel edits from the frontend. */
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
    const src = this.source;
    if (!src) throw new Error("commitVoxels: source is not initialized for this map");
    await src.applyEdits(edits);
  }

  async getLabelIds(): Promise<number[]> {
    await this.mapReadyPromise;
    const src = this.source;
    if (!src) throw new Error("getLabelIds: source is not initialized for this map");
    return await src.getLabelIds();
  }

  async addLabel(value: number): Promise<number[]> {
    await this.mapReadyPromise;
    const src = this.source;
    if (!src) throw new Error("addLabel: source is not initialized for this map");
    return await src.addLabel(value >>> 0);
  }

  async download(chunk: VolumeChunk, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason ?? new Error("aborted");
    await this.mapReadyPromise;
    const src = this.source;
    if (!src) throw new Error("download: source is not initialized for this map");
    // Determine chunk key and size (may be clipped at upper bound).
    this.computeChunkBounds(chunk);
    const cds = chunk.chunkDataSize!;
    const key = chunk.chunkGridPosition.join();
    const total = cds[0] * cds[1] * cds[2];
    // Always produce a typed array matching the spec type; MVP uses UINT32
    const array = this.allocateTypedArray(this.spec.dataType, total, 0);
    // Load saved chunk if present and copy overlapping region
    const saved = await src.getSavedChunk(makeVoxChunkKey(key, this.lodFactor));
    if (saved) {
      const sxS = saved.size[0],
        syS = saved.size[1],
        szS = saved.size[2];
      const sxD = cds[0],
        syD = cds[1],
        szD = cds[2];
      const ox = Math.min(sxS, sxD);
      const oy = Math.min(syS, syD);
      const oz = Math.min(szS, szD);
      const srcArr = saved.data as any;
      const dst = array as any;
      for (let z = 0; z < oz; ++z) {
        for (let y = 0; y < oy; ++y) {
          const baseSrc = (z * syS + y) * sxS;
          const baseDst = (z * syD + y) * sxD;
          for (let x = 0; x < ox; ++x) {
            dst[baseDst + x] = srcArr[baseSrc + x];
          }
        }
      }
    }
    (chunk as any).data = array;
  }

  private allocateTypedArray(dataType: number, size: number, fill: number) {
    switch (dataType) {
      case DataType.UINT8:
        return new Uint8Array(size).fill(fill & 0xff);
      case DataType.INT8:
        return new Int8Array(size).fill((fill << 24) >> 24);
      case DataType.UINT16:
        return new Uint16Array(size).fill(fill & 0xffff);
      case DataType.INT16:
        return new Int16Array(size).fill((fill << 16) >> 16);
      case DataType.UINT32:
        return new Uint32Array(size).fill(fill >>> 0);
      case DataType.INT32:
        return new Int32Array(size).fill(fill | 0);
      case DataType.UINT64: {
        const big = BigInt(fill >>> 0);
        return new BigUint64Array(size).fill(big);
      }
      case DataType.FLOAT32:
        return new Float32Array(size).fill(fill);
      default:
        return new Uint32Array(size).fill(fill >>> 0);
    }
  }
}

// RPC to commit voxel edits.
registerRPC(VOX_COMMIT_VOXELS_RPC_ID, function (x: any) {
  const obj = this.get(x.id) as VoxChunkSource;
  obj.commitVoxels(x.edits || []);
});

// RPC to initialize map
registerRPC(VOX_MAP_INIT_RPC_ID, function (x: any) {
  const obj = this.get(x.id) as VoxChunkSource;
  obj.initMap(x?.map || x || {});
});

// RPCs for label persistence (promise-based)
registerPromiseRPC<number[]>(
  VOX_LABELS_GET_RPC_ID,
  async function (x: any): Promise<any> {
    const obj = this.get(x.rpcId) as VoxChunkSource;
    const ids = await obj.getLabelIds();
    return { value: ids };
  },
);


registerPromiseRPC<number[]>(VOX_LABELS_ADD_RPC_ID, async function (x: any) {
  const obj = this.get(x.rpcId) as VoxChunkSource;
  const ids = await obj.addLabel(x?.value >>> 0);
  return { value: ids };
});
