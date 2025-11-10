/**
 * @license
 * Copyright 2025.
 */

import type { VolumeChunk } from "#src/sliceview/volume/backend.js";
import { VolumeChunkSource as BaseVolumeChunkSource } from "#src/sliceview/volume/backend.js";
import { DataType } from "#src/util/data_type.js";
import {
  VOX_CHUNK_SOURCE_RPC_ID,
  VOX_COMMIT_VOXELS_RPC_ID,
  VOX_MAP_INIT_RPC_ID,
  VOX_LABELS_GET_RPC_ID,
  VOX_LABELS_SET_RPC_ID,
} from "#src/voxel_annotation/base.js";
import type { VoxMapInitOptions } from "#src/voxel_annotation/index.js";
import { LocalVoxSource, toScaleKey } from "#src/voxel_annotation/index.js";
import type { RPC } from "#src/worker_rpc.js";
import {
  registerRPC,
  registerPromiseRPC,
  registerSharedObject,
} from "#src/worker_rpc.js";

/**
 * Backend volume source that persists voxel edits per chunk. It returns saved data if available,
 * otherwise returns an empty chunk (filled with zeros).
 */
@registerSharedObject(VOX_CHUNK_SOURCE_RPC_ID)
export class VoxChunkSource extends BaseVolumeChunkSource {
  local = new LocalVoxSource();

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
  }

  /** Initialize map metadata and persistence backend. */
  async initMap(opts: {
    mapId?: string;
    dataType?: number;
    chunkDataSize?: number[];
    upperVoxelBound?: number[];
    baseVoxelOffset?: number[];
    unit?: string;
    scaleKey?: string;
  }) {
    const cds: number[] = Array.from(
      opts.chunkDataSize ?? Array.from(this.spec.chunkDataSize),
    );
    const uvb: number[] = Array.from(
      opts.upperVoxelBound ??
        Array.from(this.spec.upperVoxelBound ?? ([0, 0, 0] as any)),
    );
    const dt = opts.dataType ?? this.spec.dataType;
    // Default base offset to spec.baseVoxelOffset if not provided
    const bvo: number[] = Array.from(
      opts.baseVoxelOffset ??
        Array.from((this.spec as any).baseVoxelOffset ?? [0, 0, 0]),
    );
    const scaleKey = opts.scaleKey ?? toScaleKey(cds, bvo, uvb);
    const initOpts = {
      mapId: opts.mapId,
      dataType: dt,
      chunkDataSize: cds as number[],
      upperVoxelBound: uvb as number[],
      baseVoxelOffset: bvo as number[],
      unit: opts.unit,
      scaleKey,
    } satisfies VoxMapInitOptions;
    return await this.local.init(initOpts);
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
    await this.local.applyEdits(edits);
  }

  async download(chunk: VolumeChunk, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason ?? new Error("aborted");
    // Determine chunk key and size (may be clipped at upper bound).
    this.computeChunkBounds(chunk);
    const cds = chunk.chunkDataSize!;
    const key = chunk.chunkGridPosition.join();
    const total = cds[0] * cds[1] * cds[2];
    // Always produce a typed array matching the spec type; MVP uses UINT32
    const array = this.allocateTypedArray(this.spec.dataType, total, 0);
    // Load saved chunk if present and copy overlapping region
    const saved = await this.local.getSavedChunk(key);
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
      const src = saved.data as any;
      const dst = array as any;
      for (let z = 0; z < oz; ++z) {
        for (let y = 0; y < oy; ++y) {
          const baseSrc = (z * syS + y) * sxS;
          const baseDst = (z * syD + y) * sxD;
          for (let x = 0; x < ox; ++x) {
            dst[baseDst + x] = src[baseSrc + x];
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
  obj.initMap(x || {});
});

// RPCs for label persistence (promise-based)
registerPromiseRPC<number[]>(
  VOX_LABELS_GET_RPC_ID,
  async function (x: any): Promise<any> {
    const obj = this.get(x.rpcId) as VoxChunkSource;
    const ids = await obj.local.getLabelIds();
    return { value: ids };
  },
);

registerRPC(VOX_LABELS_SET_RPC_ID, function (x: any) {
  const obj = this.get(x.id) as VoxChunkSource;
  obj.local.setLabelIds(Array.isArray(x?.ids) ? x.ids : []);
});
