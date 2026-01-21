/**
 * @license
 * Copyright 2025 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { ChunkState } from "#src/chunk_manager/base.js";
import type { SharedWatchableValue } from "#src/shared_watchable_value.js";
import { DataType } from "#src/sliceview/base.js";
import { decodeChannel as decodeChannelUint32 } from "#src/sliceview/compressed_segmentation/decode_uint32.js";
import { decodeChannel as decodeChannelUint64 } from "#src/sliceview/compressed_segmentation/decode_uint64.js";
import type {
  VolumeChunk,
  VolumeChunkSource,
} from "#src/sliceview/volume/backend.js";
import type { TypedArray } from "#src/util/array.js";
import { mat4, vec3 } from "#src/util/geom.js";
import * as matrix from "#src/util/matrix.js";
import type {
  VoxelLayerResolution,
  EditAction,
  VoxelChange,
  VoxelOperation,
  BrushOperation,
  FloodFillOperation,
} from "#src/voxel_annotation/base.js";
import {
  VOXEL_EDIT_STAMINA,
  VOX_EDIT_BACKEND_RPC_ID,
  VOX_EDIT_COMMIT_VOXELS_RPC_ID,
  VOX_RELOAD_CHUNKS_RPC_ID,
  VOX_EDIT_FAILURE_RPC_ID,
  VOX_EDIT_UNDO_RPC_ID,
  VOX_EDIT_REDO_RPC_ID,
  VOX_EDIT_HISTORY_UPDATE_RPC_ID,
  VOX_EDIT_OPERATION_RPC_ID,
  VoxelOperationType,
  BrushShape,
  makeVoxChunkKey,
  parseVoxChunkKey,
  makeChunkKey,
} from "#src/voxel_annotation/base.js";
import type { RPC } from "#src/worker_rpc.js";
import {
  registerPromiseRPC,
  SharedObject,
  registerRPC,
  registerSharedObject,
  initializeSharedObjectCounterpart,
} from "#src/worker_rpc.js";

const OFFSETS_26_CONNECTED_BACKEND: number[][] = [];
for (let z = -1; z <= 1; z++) {
  for (let y = -1; y <= 1; y++) {
    for (let x = -1; x <= 1; x++) {
      if (x === 0 && y === 0 && z === 0) continue;
      OFFSETS_26_CONNECTED_BACKEND.push([x, y, z]);
    }
  }
}

function getFlatChunkData(
  chunk: VolumeChunk,
  spec: any,
): Uint32Array | BigUint64Array | TypedArray | null {
  if (!chunk.data) return null;

  if (!spec.compressedSegmentationBlockSize) {
    return chunk.data as TypedArray;
  }

  const size = chunk.chunkDataSize!;
  const numElements = size[0] * size[1] * size[2];
  const compressedData = chunk.data as Uint32Array;
  const baseOffset = compressedData.length > 0 ? compressedData[0] : 0;
  const subchunkSize = spec.compressedSegmentationBlockSize;

  if (spec.dataType === DataType.UINT32) {
    const out = new Uint32Array(numElements);
    if (baseOffset !== 0) {
      decodeChannelUint32(out, compressedData, baseOffset, size, subchunkSize);
    }
    return out;
  } else {
    const out = new BigUint64Array(numElements);
    if (baseOffset !== 0) {
      decodeChannelUint64(out, compressedData, baseOffset, size, subchunkSize);
    }
    return out;
  }
}

interface ChunkContext {
  key: string;
  data: TypedArray | null;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  strideY: number;
  strideZ: number;
}

class BackendVoxelAccessor {
  private chunkContexts = new Map<string, ChunkContext>();
  private pendingLoads = new Map<string, Promise<ChunkContext>>();

  private readonly volMin: Float32Array;
  private readonly volMax: Float32Array;
  private readonly chunkDimension: Uint32Array;
  private readonly fillValue: bigint;

  constructor(private source: VolumeChunkSource) {
    const spec = source.spec;
    this.volMin = spec.lowerVoxelBound;
    this.volMax = spec.upperVoxelBound;
    this.chunkDimension = spec.chunkDataSize;
    const fv = spec.fillValue;
    this.fillValue = typeof fv === "bigint" ? fv : BigInt(fv);
  }

  async getValue(x: number, y: number, z: number): Promise<bigint | null> {
    if (
      x < this.volMin[0] ||
      x >= this.volMax[0] ||
      y < this.volMin[1] ||
      y >= this.volMax[1] ||
      z < this.volMin[2] ||
      z >= this.volMax[2]
    ) {
      return null;
    }

    const cx = Math.floor(x / this.chunkDimension[0]);
    const cy = Math.floor(y / this.chunkDimension[1]);
    const cz = Math.floor(z / this.chunkDimension[2]);
    const key = `${cx},${cy},${cz}`;

    let ctx = this.chunkContexts.get(key);
    if (!ctx) {
      ctx = await this.getOrLoadChunkContext(key, cx, cy, cz);
    }

    return this.readLocal(ctx, x, y, z);
  }

  private getOrLoadChunkContext(
    key: string,
    cx: number,
    cy: number,
    cz: number,
  ): Promise<ChunkContext> {
    let promise = this.pendingLoads.get(key);
    if (promise) return promise;

    promise = this.loadChunkContext(key, cx, cy, cz).then((ctx) => {
      this.chunkContexts.set(key, ctx);
      this.pendingLoads.delete(key);
      return ctx;
    });
    this.pendingLoads.set(key, promise);
    return promise;
  }

  private readLocal(
    ctx: ChunkContext,
    x: number,
    y: number,
    z: number,
  ): bigint {
    if (!ctx.data) return this.fillValue;

    const lx = x - ctx.minX;
    const ly = y - ctx.minY;
    const lz = z - ctx.minZ;
    const index = lz * ctx.strideZ + ly * ctx.strideY + lx;

    const val = ctx.data[index];
    return typeof val === "bigint" ? val : BigInt(val);
  }

  private async loadChunkContext(
    key: string,
    cx: number,
    cy: number,
    cz: number,
  ): Promise<ChunkContext> {
    let chunk = this.source.chunks.get(key) as VolumeChunk | undefined;
    if (!chunk) {
      chunk = this.source.getChunk(
        new Float32Array([cx, cy, cz]),
      ) as VolumeChunk;
    }

    if (chunk.state > ChunkState.SYSTEM_MEMORY_WORKER || !chunk.data) {
      try {
        await this.source.download(chunk, new AbortController().signal);
      } catch {
        return this.createContext(key, null, cx, cy, cz, chunk);
      }
    }

    if (!chunk.chunkDataSize) {
      this.source.computeChunkBounds(chunk);
    }

    const flatData = getFlatChunkData(chunk, this.source.spec);
    return this.createContext(key, flatData, cx, cy, cz, chunk);
  }

  private createContext(
    key: string,
    data: TypedArray | null,
    cx: number,
    cy: number,
    cz: number,
    chunk: VolumeChunk,
  ): ChunkContext {
    const size = chunk.chunkDataSize || this.chunkDimension;
    const minX = cx * this.chunkDimension[0];
    const minY = cy * this.chunkDimension[1];
    const minZ = cz * this.chunkDimension[2];

    return {
      key,
      data,
      minX,
      maxX: minX + size[0],
      minY,
      maxY: minY + size[1],
      minZ,
      maxZ: minZ + size[2],
      strideY: size[0],
      strideZ: size[0] * size[1],
    };
  }
}

type Skipper = (x: number, y: number, z: number) => boolean;

class BrushOptimizationCache {
  private active = false;

  private val: bigint = 0n;
  private shape: BrushShape = BrushShape.SPHERE;
  private cx = 0;
  private cy = 0;
  private cz = 0;
  private r2 = 0;

  private ux = 0;
  private uy = 0;
  private uz = 0;
  private vx = 0;
  private vy = 0;
  private vz = 0;

  reset() {
    this.active = false;
  }

  buildSkipper(
    newValue: bigint,
    newShape: BrushShape,
    newBasis?: { u: Float32Array; v: Float32Array },
  ): Skipper {
    if (!this.active || this.val !== newValue || this.shape !== newShape) {
      return () => false;
    }

    const { cx, cy, cz, r2 } = this;

    if (this.shape === BrushShape.SPHERE) {
      return (x: number, y: number, z: number) => {
        const dx = x - cx;
        const dy = y - cy;
        const dz = z - cz;
        return dx * dx + dy * dy + dz * dz <= r2;
      };
    }

    if (this.shape === BrushShape.DISK && newBasis) {
      const dotU =
        this.ux * newBasis.u[0] +
        this.uy * newBasis.u[1] +
        this.uz * newBasis.u[2];
      const dotV =
        this.vx * newBasis.v[0] +
        this.vy * newBasis.v[1] +
        this.vz * newBasis.v[2];

      if (dotU < 0.9999 || dotV < 0.9999) {
        return () => false;
      }

      const { ux, uy, uz, vx, vy, vz } = this;

      return (x: number, y: number, z: number) => {
        const dx = x - cx;
        const dy = y - cy;
        const dz = z - cz;
        const distU = dx * ux + dy * uy + dz * uz;
        const distV = dx * vx + dy * vy + dz * vz;
        return distU * distU + distV * distV <= r2;
      };
    }

    return () => false;
  }

  update(
    center: { x: number; y: number; z: number },
    radius: number,
    value: bigint,
    shape: BrushShape,
    basis?: { u: Float32Array; v: Float32Array },
  ) {
    this.active = true;
    this.cx = center.x;
    this.cy = center.y;
    this.cz = center.z;
    this.r2 = radius * radius;
    this.val = value;
    this.shape = shape;

    if (basis) {
      this.ux = basis.u[0];
      this.uy = basis.u[1];
      this.uz = basis.u[2];
      this.vx = basis.v[0];
      this.vy = basis.v[1];
      this.vz = basis.v[2];
    }
  }
}

@registerSharedObject(VOX_EDIT_BACKEND_RPC_ID)
export class VoxelEditController extends SharedObject {
  private sources = new Map<number, VolumeChunkSource>();
  private resolutions = new Map<
    number,
    VoxelLayerResolution & { invTransform: mat4 }
  >();

  private pendingEdits: {
    key: string;
    indices: number[] | Uint32Array;
    value?: bigint;
    values?: ArrayLike<bigint>;
    size?: number[];
  }[] = [];
  public pendingOpCount: SharedWatchableValue<number>;

  private updatePendingCount() {
    const editedVoxel = this.pendingEdits.reduce(
      (a, { indices }) => indices.length + a,
      0,
    );
    const pendingEdits = VOXEL_EDIT_STAMINA.pendingEdits(editedVoxel);
    const downsampling = VOXEL_EDIT_STAMINA.downsamplingJobs(
      this.downsampleQueue.length,
      this.resolutions.size,
    );
    this.pendingOpCount.value = pendingEdits + downsampling;
  }

  private commitDebounceTimer: number | undefined;
  private readonly commitDebounceDelayMs: number = 300;

  // Undo/redo history
  private undoStack: EditAction[] = [];
  private redoStack: EditAction[] = [];
  private readonly MAX_HISTORY_SIZE: number = 100;

  private downsampleQueue: string[] = [];
  private downsampleQueueSet: Set<string> = new Set();
  private isProcessingDownsampleQueue: boolean = false;

  private brushCache = new BrushOptimizationCache();

  private morphologicalConfig = {
    growthThresholds: [
      { count: 100, size: 1 },
      { count: 1000, size: 3 },
      { count: 10000, size: 5 },
      { count: 100000, size: 7 },
    ],
    maxSize: 9,
  };

  constructor(rpc: RPC, options: any) {
    super();
    this.pendingOpCount = rpc.get(options.pendingOpCount);
    initializeSharedObjectCounterpart(this, rpc, options);

    const passedResolutions = options?.resolutions as
      | VoxelLayerResolution[]
      | undefined;
    if (passedResolutions === undefined || !Array.isArray(passedResolutions)) {
      throw new Error(
        "VoxelEditBackend: missing required 'resolutions' array during initialization",
      );
    }

    for (const res of passedResolutions) {
      const rank = res.chunkSize.length;
      const invTransform = new Float32Array((rank + 1) ** 2);
      matrix.inverse(
        invTransform,
        rank + 1,
        new Float32Array(res.transform),
        rank + 1,
        rank + 1,
      );
      this.resolutions.set(res.lodIndex, {
        ...res,
        invTransform: invTransform as mat4,
      });
      const resolved = rpc.get(res.sourceRpc) as VolumeChunkSource | undefined;
      if (!resolved) {
        throw new Error(
          `VoxelEditBackend: failed to resolve VolumeChunkSource for LOD ${res.lodIndex}`,
        );
      }
      this.sources.set(res.lodIndex, resolved);
    }

    this.notifyHistoryChanged();
  }

  private async flushPending(): Promise<void> {
    this.brushCache.reset();
    const edits = this.pendingEdits;
    this.pendingEdits = [];
    this.commitDebounceTimer = undefined;
    if (edits.length === 0) {
      // Even if nothing to flush, history sizes may not have changed.
      this.notifyHistoryChanged();
      return;
    }

    const editsByVoxKey = new Map<string, Map<number, bigint>>();

    for (const edit of edits) {
      let chunkMap = editsByVoxKey.get(edit.key);
      if (!chunkMap) {
        chunkMap = new Map<number, bigint>();
        editsByVoxKey.set(edit.key, chunkMap);
      }

      const inds = edit.indices as ArrayLike<number>;
      if (edit.values) {
        // Handle array of values
        const vals = Array.from(edit.values);
        if (vals.length !== inds.length) {
          throw new Error("flushPending: values length mismatch with indices");
        }
        for (let i = 0; i < inds.length; ++i) {
          chunkMap.set(inds[i]!, vals[i]!);
        }
      } else if (edit.value !== undefined) {
        // Handle single value for all indices
        for (let i = 0; i < inds.length; ++i) {
          chunkMap.set(inds[i]!, edit.value);
        }
      } else {
        throw new Error("flushPending: edit missing value(s)");
      }
    }

    const failedVoxChunkKeys: string[] = [];
    let firstErrorMessage: string | undefined = undefined;

    const newAction: EditAction = {
      changes: new Map<string, VoxelChange>(),
      timestamp: Date.now(),
      description: "Voxel Edit",
    };

    for (const [voxKey, chunkEdits] of editsByVoxKey.entries()) {
      try {
        const parsedKey = parseVoxChunkKey(voxKey);
        if (!parsedKey) {
          const msg = `flushPending: Failed to parse vox chunk key: ${voxKey}`;
          console.error(msg);
          failedVoxChunkKeys.push(voxKey);
          if (firstErrorMessage === undefined) firstErrorMessage = msg;
          continue;
        }
        const source = this.sources.get(parsedKey.lodIndex);
        if (!source) {
          const msg = `flushPending: No source found for LOD index ${parsedKey.lodIndex}`;
          console.error(msg);
          failedVoxChunkKeys.push(voxKey);
          if (firstErrorMessage === undefined) firstErrorMessage = msg;
          continue;
        }

        const indices = Array.from(chunkEdits.keys());
        const values = Array.from(chunkEdits.values());

        const change = await source.applyEdits(
          parsedKey.chunkKey,
          indices,
          values,
        );
        newAction.changes.set(voxKey, change);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`Failed to write chunk ${voxKey}:`, e);
        failedVoxChunkKeys.push(voxKey);
        if (firstErrorMessage === undefined) firstErrorMessage = msg;
      }
    }

    this.callChunkReload(editsByVoxKey.keys().toArray());

    if (newAction.changes.size > 0) {
      this.undoStack.push(newAction);
      if (this.undoStack.length > this.MAX_HISTORY_SIZE) {
        this.undoStack.shift();
      }
      this.redoStack.length = 0;
    }

    // Notify frontend of history changes after any commit attempt
    this.notifyHistoryChanged();

    if (failedVoxChunkKeys.length > 0) {
      this.rpc?.invoke(VOX_EDIT_FAILURE_RPC_ID, {
        rpcId: this.rpcId,
        voxChunkKeys: failedVoxChunkKeys,
        message: firstErrorMessage ?? "Voxel edit commit failed.",
      });
    }

    for (const [voxKey, _] of editsByVoxKey.entries()) {
      if (failedVoxChunkKeys.includes(voxKey)) continue;
      this.enqueueDownsample(voxKey);
    }

    this.updatePendingCount();
  }

  commitVoxels(
    edits: {
      key: string;
      indices: number[] | Uint32Array;
      value?: bigint;
      values?: ArrayLike<bigint>;
      size?: number[];
    }[],
  ) {
    for (const e of edits) {
      if (!e || !e.key || !e.indices) {
        throw new Error(
          "VoxelEditController.commitVoxels: invalid edit payload",
        );
      }
      this.pendingEdits.push(e);
    }
    this.updatePendingCount();
    if (this.commitDebounceTimer !== undefined)
      clearTimeout(this.commitDebounceTimer);
    this.commitDebounceTimer = setTimeout(() => {
      void this.flushPending();
    }, this.commitDebounceDelayMs) as unknown as number;
  }

  callChunkReload(voxChunkKeys: string[], isForPreviewChunks = false) {
    this.rpc?.invoke(VOX_RELOAD_CHUNKS_RPC_ID, {
      rpcId: this.rpcId,
      voxChunkKeys: voxChunkKeys,
      isForPreviewChunks,
    });
  }

  // --- Start of Downsampling Logic ---

  /**
   * NOTE: Architecture Limitation
   * The current downsampling architecture assumes a Many-to-1 (or 1-to-1) mapping between
   * child chunks and parent chunks. It calculates a single parent chunk key for a given
   * child chunk.
   */

  private enqueueDownsample(key: string): void {
    if (key.length === 0) return;
    if (!this.downsampleQueueSet.has(key)) {
      this.downsampleQueueSet.add(key);
      this.downsampleQueue.push(key);
    }
    if (!this.isProcessingDownsampleQueue) {
      this.isProcessingDownsampleQueue = true;
      Promise.resolve().then(() => this.processDownsampleQueue());
    }
  }

  private async processDownsampleQueue(): Promise<void> {
    try {
      while (this.downsampleQueue.length > 0) {
        const key = this.downsampleQueue.shift() as string;
        this.downsampleQueueSet.delete(key);
        const allModifiedKeys = new Array<string>();
        let currentKey: string | null = key;
        while (currentKey !== null) {
          allModifiedKeys.push(currentKey);
          currentKey = await this.downsampleStep(currentKey);
        }
        const pendingKeys = new Set(this.pendingEdits.map((e) => e.key));
        const keysToReload = allModifiedKeys.filter((k) => !pendingKeys.has(k));
        if (keysToReload.length > 0) this.callChunkReload(keysToReload, true);
        this.updatePendingCount();
      }
    } finally {
      this.isProcessingDownsampleQueue = false;
      if (
        this.downsampleQueue.length > 0 &&
        !this.isProcessingDownsampleQueue
      ) {
        this.isProcessingDownsampleQueue = true;
        Promise.resolve().then(() => this.processDownsampleQueue());
      }
    }
  }

  /**
   * Performs a single downsampling step from a child chunk to its parent.
   * @returns The key of the parent chunk that was updated, or null if the cascade should stop.
   */
  private async downsampleStep(childKey: string): Promise<string | null> {
    // 1. Get child chunk and ensure its data is loaded.
    const childInfo = parseVoxChunkKey(childKey);
    if (childInfo === null) {
      console.error(`[Downsample] Invalid child key format: ${childKey}`);
      return null;
    }
    const childSource = this.sources.get(childInfo.lodIndex);
    if (!childSource) {
      console.error(
        `[Downsample] No source found for child LOD: ${childInfo.lodIndex}`,
      );
      return null;
    }

    const childChunk = childSource.getChunk(
      new Float32Array([childInfo.x, childInfo.y, childInfo.z]),
    ) as any;
    if (!childChunk.data) {
      try {
        await childSource.download(childChunk, new AbortController().signal);
      } catch (e) {
        console.warn(
          `[Downsample] Failed to download source chunk ${childKey}:`,
          e,
        );
        return null;
      }
    }
    const childChunkData = childChunk.data as Uint32Array | BigUint64Array;
    const childRes = this.resolutions.get(childInfo.lodIndex)!;

    // 2. Determine the parent chunk that corresponds to this child chunk.
    const parentInfo = this._getParentChunkInfo(childKey, childRes);
    if (parentInfo === null) {
      // Reached the coarsest LOD, stop the cascade.
      return null;
    }
    const { parentKey, parentSource, parentRes } = parentInfo;

    let dataToProcess = childChunkData;
    const { compressedSegmentationBlockSize, dataType, chunkDataSize } =
      childSource.spec;
    if (compressedSegmentationBlockSize !== undefined) {
      const numElements =
        chunkDataSize[0] * chunkDataSize[1] * chunkDataSize[2];
      const compressedData = childChunkData as Uint32Array;
      const baseOffset = compressedData.length > 0 ? compressedData[0] : 0;
      if (dataType === DataType.UINT32) {
        const uncompressedData = new Uint32Array(numElements);
        if (baseOffset !== 0) {
          decodeChannelUint32(
            uncompressedData,
            compressedData,
            baseOffset,
            chunkDataSize,
            compressedSegmentationBlockSize,
          );
        }
        dataToProcess = uncompressedData;
      } else {
        // Assumes UINT64
        const uncompressedData = new BigUint64Array(numElements);
        if (baseOffset !== 0) {
          decodeChannelUint64(
            uncompressedData,
            compressedData,
            baseOffset,
            chunkDataSize,
            compressedSegmentationBlockSize,
          );
        }
        dataToProcess = uncompressedData;
      }
    }

    // 3. Calculate the update for the parent chunk based on the child chunk's data.
    const update = this._calculateParentUpdate(
      dataToProcess,
      childRes,
      parentRes,
      childInfo,
    );
    if (update.indices.length === 0) {
      return parentKey;
    }

    // 4. Commit the update to the parent chunk and notify the frontend.
    try {
      await parentSource.applyEdits(
        parentInfo.chunkKey,
        update.indices,
        update.values,
      );
      this.callChunkReload([parentKey]);
    } catch (e) {
      console.error(
        `[Downsample] Failed to apply edits to parent chunk ${parentKey}:`,
        e,
      );
      this.rpc?.invoke(VOX_EDIT_FAILURE_RPC_ID, {
        rpcId: this.rpcId,
        voxChunkKeys: [parentKey],
        message: `Downsampling to ${parentKey} failed.`,
      });
      return null; // Stop cascade on failure.
    }

    return parentKey;
  }

  /**
   * Helper to find and describe the parent chunk.
   */
  private _getParentChunkInfo(
    childKey: string,
    childRes: VoxelLayerResolution,
  ) {
    const childInfo = parseVoxChunkKey(childKey)!;
    const parentLodIndex = childInfo.lodIndex + 1;
    const parentRes = this.resolutions.get(parentLodIndex);
    if (parentRes === undefined) return null; // No parent LOD exists

    const parentSource = this.sources.get(parentLodIndex)!;
    const rank = childRes.chunkSize.length;

    // Find the world coordinate of the child chunk's origin
    const childVoxelOrigin = new Float32Array(rank);
    childVoxelOrigin.set([
      childInfo.x * childRes.chunkSize[0],
      childInfo.y * childRes.chunkSize[1],
      childInfo.z * childRes.chunkSize[2],
    ]);
    const childPhysOrigin = new Float32Array(rank);
    matrix.transformPoint(
      childPhysOrigin,
      new Float32Array(childRes.transform),
      rank + 1,
      childVoxelOrigin,
      rank,
    );

    // Transform that world coordinate into the parent's voxel space
    const parentVoxelCoordOfChildOrigin = new Float32Array(rank);
    matrix.transformPoint(
      parentVoxelCoordOfChildOrigin,
      parentRes.invTransform,
      rank + 1,
      childPhysOrigin,
      rank,
    );

    // Determine the parent chunk's grid position
    const parentX = Math.floor(
      parentVoxelCoordOfChildOrigin[0] / parentRes.chunkSize[0],
    );
    const parentY = Math.floor(
      parentVoxelCoordOfChildOrigin[1] / parentRes.chunkSize[1],
    );
    const parentZ = Math.floor(
      parentVoxelCoordOfChildOrigin[2] / parentRes.chunkSize[2],
    );

    const parentChunkKey = makeChunkKey(parentX, parentY, parentZ);
    const parentKey = makeVoxChunkKey(parentChunkKey, parentLodIndex);
    return { parentKey, chunkKey: parentChunkKey, parentRes, parentSource };
  }

  /**
   * Calculates the downsampled voxel values for a region of a parent chunk.
   * This is the core aggregation logic.
   */
  private _calculateParentUpdate(
    childChunkData: Uint32Array | BigUint64Array,
    childRes: VoxelLayerResolution & { invTransform: mat4 },
    parentRes: VoxelLayerResolution & { invTransform: mat4 },
    childInfo: { x: number; y: number; z: number },
  ) {
    const indices: number[] = [];
    const values: bigint[] = [];
    const rank = childRes.chunkSize.length;
    const childChunkSize = childRes.chunkSize;
    const parentChunkSize = parentRes.chunkSize;

    // Transform to map a point in parent-voxel-space to a point in child-voxel-space.
    const parentVoxelToChildVoxelTransform = mat4.multiply(
      mat4.create(),
      childRes.invTransform,
      new Float32Array(parentRes.transform) as mat4,
    );

    // Calculate the child chunk's origin and extent in absolute child-voxel-space
    const childChunkOrigin = new Float32Array([
      childInfo.x * childChunkSize[0],
      childInfo.y * childChunkSize[1],
      childInfo.z * childChunkSize[2],
    ]);
    const childChunkMax = new Float32Array([
      (childInfo.x + 1) * childChunkSize[0],
      (childInfo.y + 1) * childChunkSize[1],
      (childInfo.z + 1) * childChunkSize[2],
    ]);

    // Transform child chunk bounds to physical space
    const childPhysOrigin = new Float32Array(rank);
    matrix.transformPoint(
      childPhysOrigin,
      new Float32Array(childRes.transform),
      rank + 1,
      childChunkOrigin,
      rank,
    );
    const childPhysMax = new Float32Array(rank);
    matrix.transformPoint(
      childPhysMax,
      new Float32Array(childRes.transform),
      rank + 1,
      childChunkMax,
      rank,
    );

    // Transform to parent-voxel-space to find the affected region
    const parentVoxelMin = new Float32Array(rank);
    matrix.transformPoint(
      parentVoxelMin,
      parentRes.invTransform,
      rank + 1,
      childPhysOrigin,
      rank,
    );
    const parentVoxelMax = new Float32Array(rank);
    matrix.transformPoint(
      parentVoxelMax,
      parentRes.invTransform,
      rank + 1,
      childPhysMax,
      rank,
    );

    // Determine which parent chunk this corresponds to (should match _getParentChunkInfo)
    const parentChunkGridX = Math.floor(parentVoxelMin[0] / parentChunkSize[0]);
    const parentChunkGridY = Math.floor(parentVoxelMin[1] / parentChunkSize[1]);
    const parentChunkGridZ = Math.floor(parentVoxelMin[2] / parentChunkSize[2]);

    // Calculate the parent chunk's origin in absolute parent-voxel-space
    const parentChunkOriginInParentVoxels = new Float32Array([
      parentChunkGridX * parentChunkSize[0],
      parentChunkGridY * parentChunkSize[1],
      parentChunkGridZ * parentChunkSize[2],
    ]);

    // Calculate the region to iterate over in the parent chunk's LOCAL coordinate space (0 to chunkSize)
    const parentLocalMin = new Float32Array(rank);
    const parentLocalMax = new Float32Array(rank);
    for (let i = 0; i < rank; ++i) {
      parentLocalMin[i] = Math.max(
        0,
        Math.floor(parentVoxelMin[i] - parentChunkOriginInParentVoxels[i]),
      );
      parentLocalMax[i] = Math.min(
        parentChunkSize[i],
        Math.ceil(parentVoxelMax[i] - parentChunkOriginInParentVoxels[i]),
      );
    }

    const [startX, startY, startZ] = parentLocalMin;
    const [endX, endY, endZ] = parentLocalMax;

    const corners = new Array(8).fill(0).map(() => vec3.create());
    const transformedCorners = new Array(8).fill(0).map(() => vec3.create());
    const sourceVoxels: bigint[] = [];
    const [childW, childH, childD] = childChunkSize;
    const [parentW, parentH] = parentChunkSize;

    // Iterate over each voxel in the affected region of the parent chunk (in local coordinates)
    for (let pz = startZ; pz < endZ; ++pz) {
      for (let py = startY; py < endY; ++py) {
        for (let px = startX; px < endX; ++px) {
          // Convert from parent-chunk-local to absolute parent-voxel-space
          const absParentX = parentChunkOriginInParentVoxels[0] + px;
          const absParentY = parentChunkOriginInParentVoxels[1] + py;
          const absParentZ = parentChunkOriginInParentVoxels[2] + pz;

          // Define the 8 corners of the current parent voxel in absolute parent-voxel-space
          vec3.set(corners[0], absParentX, absParentY, absParentZ);
          vec3.set(corners[1], absParentX + 1, absParentY, absParentZ);
          vec3.set(corners[2], absParentX, absParentY + 1, absParentZ);
          vec3.set(corners[3], absParentX + 1, absParentY + 1, absParentZ);
          vec3.set(corners[4], absParentX, absParentY, absParentZ + 1);
          vec3.set(corners[5], absParentX + 1, absParentY, absParentZ + 1);
          vec3.set(corners[6], absParentX, absParentY + 1, absParentZ + 1);
          vec3.set(corners[7], absParentX + 1, absParentY + 1, absParentZ + 1);

          // Transform corners to absolute child-voxel-space
          for (let i = 0; i < 8; ++i) {
            vec3.transformMat4(
              transformedCorners[i],
              corners[i],
              parentVoxelToChildVoxelTransform,
            );
          }

          // Find bounding box in absolute child-voxel-space
          const childMin = vec3.clone(transformedCorners[0]);
          const childMax = vec3.clone(transformedCorners[0]);
          for (let i = 1; i < 8; ++i) {
            vec3.min(childMin, childMin, transformedCorners[i]);
            vec3.max(childMax, childMax, transformedCorners[i]);
          }

          // Convert to child-chunk-local coordinates for array indexing
          const localChildMin = vec3.create();
          const localChildMax = vec3.create();
          vec3.subtract(localChildMin, childMin, childChunkOrigin as any);
          vec3.subtract(localChildMax, childMax, childChunkOrigin as any);

          // Collect all child voxels within this bounding box (in local coordinates)
          sourceVoxels.length = 0;
          const cStartX = Math.max(0, Math.floor(localChildMin[0]));
          const cEndX = Math.min(childW, Math.ceil(localChildMax[0]));
          const cStartY = Math.max(0, Math.floor(localChildMin[1]));
          const cEndY = Math.min(childH, Math.ceil(localChildMax[1]));
          const cStartZ = Math.max(0, Math.floor(localChildMin[2]));
          const cEndZ = Math.min(childD, Math.ceil(localChildMax[2]));

          for (let cz = cStartZ; cz < cEndZ; ++cz) {
            for (let cy = cStartY; cy < cEndY; ++cy) {
              for (let cx = cStartX; cx < cEndX; ++cx) {
                const srcIndex = cz * (childW * childH) + cy * childW + cx;
                sourceVoxels.push(BigInt(childChunkData[srcIndex]));
              }
            }
          }

          if (sourceVoxels.length > 0) {
            const mode = this._calculateMode(sourceVoxels);
            // Use local coordinates for the parent chunk index
            const parentIndex = pz * (parentW * parentH) + py * parentW + px;
            indices.push(parentIndex);
            values.push(mode);
          }
        }
      }
    }

    return { indices, values };
  }

  private _calculateMode(values: (bigint | number)[]): bigint {
    if (values.length === 0) return 0n;
    const counts = new Map<bigint, number>();
    let maxCount = 0;
    let mode = 0n;
    for (const v of values) {
      const bigV = BigInt(v);
      if (bigV === 0n) continue;
      const c = (counts.get(bigV) ?? 0) + 1;
      counts.set(bigV, c);
      if (c > maxCount) {
        maxCount = c;
        mode = bigV;
      } else if (c === maxCount && bigV < mode) {
        mode = bigV;
      }
    }
    return mode;
  }
  private notifyHistoryChanged(): void {
    this.rpc?.invoke(VOX_EDIT_HISTORY_UPDATE_RPC_ID, {
      rpcId: this.rpcId,
      undoCount: this.undoStack.length,
      redoCount: this.redoStack.length,
    });
  }

  private async performUndoRedo(
    sourceStack: EditAction[],
    targetStack: EditAction[],
    useOldValues: boolean,
    actionDescription: "undo" | "redo",
  ): Promise<void> {
    await this.flushPending();

    if (sourceStack.length === 0) {
      throw new Error(`Nothing to ${actionDescription}.`);
    }

    const action = sourceStack.pop()!;

    const chunksToReload = new Set<string>();
    let success = true;

    for (const [voxKey, change] of action.changes.entries()) {
      const parsedKey = parseVoxChunkKey(voxKey);
      if (!parsedKey) continue;
      const source = this.sources.get(parsedKey.lodIndex);
      if (!source) continue;

      const valuesToApply = useOldValues ? change.oldValues : change.newValues;
      try {
        await source.applyEdits(
          parsedKey.chunkKey,
          change.indices,
          valuesToApply,
        );
        chunksToReload.add(voxKey);
      } catch (e) {
        success = false;
        console.error(
          `performUndoRedo: failed to apply edits for ${voxKey}`,
          e,
        );
        this.rpc?.invoke(VOX_EDIT_FAILURE_RPC_ID, {
          rpcId: this.rpcId,
          voxChunkKeys: [voxKey],
          message: useOldValues ? "Undo failed." : "Redo failed.",
        });
        break;
      }
    }

    if (success) {
      targetStack.push(action);
    } else {
      sourceStack.push(action);
    }

    if (chunksToReload.size > 0 && success) {
      for (const key of chunksToReload) {
        this.enqueueDownsample(key);
      }
      this.callChunkReload(Array.from(chunksToReload));
    }

    this.notifyHistoryChanged();
  }

  public async undo(): Promise<void> {
    await this.performUndoRedo(this.undoStack, this.redoStack, true, "undo");
  }

  public async redo(): Promise<void> {
    await this.performUndoRedo(this.redoStack, this.undoStack, false, "redo");
  }

  async performOperation(operation: VoxelOperation): Promise<void> {
    switch (operation.type) {
      case VoxelOperationType.BRUSH:
        return this.performBrush(operation);
      case VoxelOperationType.FLOOD_FILL:
        return this.performFloodFill(operation);
      default:
        throw new Error(
          `Unknown voxel operation type: ${(operation as any).type}`,
        );
    }
  }

  private async performBrush(op: BrushOperation): Promise<void> {
    const { center, radius, value, shape, basis, filterValue } = op;
    const voxelSize = 1; // Hardcoded LOD 0
    const sourceIndex = 0;
    const source = this.sources.get(sourceIndex);
    if (!source) throw new Error(`Brush operation requires a source.`);
    const accessor = new BackendVoxelAccessor(source);

    const cx = Math.round((center[0] ?? 0) / voxelSize);
    const cy = Math.round((center[1] ?? 0) / voxelSize);
    const cz = Math.round((center[2] ?? 0) / voxelSize);
    let r = Math.round(radius / voxelSize);
    if (r <= 0) throw new Error(`Brush radius must be positive.`);
    r -= 1;
    const rr = r * r;

    // This capacity should ensure we never get out of bounds
    const maxCapacity = Math.ceil((2 * r + 1) ** 3);
    const voxelBuffer = new Int32Array(maxCapacity * 3);
    let voxelCount = 0;
    const bufferEnqueue = (x: number, y: number, z: number) => {
      // don;t need to check bounds as the capacity is assumed to be large enough
      const base = voxelCount * 3;
      voxelBuffer[base] = x;
      voxelBuffer[base + 1] = y;
      voxelBuffer[base + 2] = z;
      voxelCount++;
    };

    const shouldSkip = this.brushCache.buildSkipper(value, shape, basis);

    const toAwait = new Set<Promise<void>>();
    const pushIf = (x: number, y: number, z: number) => {
      if (shouldSkip(x, y, z)) {
        return;
      }
      if (filterValue == undefined) {
        bufferEnqueue(x, y, z);
        return;
      }
      toAwait.add(
        accessor.getValue(x, y, z).then((v) => {
          if (v == null) return;
          if (v === value || (filterValue !== undefined && v !== filterValue))
            return;
          bufferEnqueue(x, y, z);
        }),
      );
    };

    if (shape !== BrushShape.DISK) {
      for (let dz = -r; dz <= r; ++dz) {
        for (let dy = -r; dy <= r; ++dy) {
          for (let dx = -r; dx <= r; ++dx) {
            if (dx * dx + dy * dy + dz * dz <= rr)
              pushIf(cx + dx, cy + dy, cz + dz);
          }
        }
      }
    } else {
      if (basis === undefined) throw new Error("Brush shape requires a basis.");
      const { u, v } = basis as { u: vec3; v: vec3 };
      const ux = u[0],
        uy = u[1],
        uz = u[2];
      const vx = v[0],
        vy = v[1],
        vz = v[2];

      for (let j = -r; j <= r; ++j) {
        const j2 = j * j;
        const vPartX = vx * j;
        const vPartY = vy * j;
        const vPartZ = vz * j;

        for (let i = -r; i <= r; ++i) {
          if (i * i + j2 <= rr) {
            const px = Math.round(cx + ux * i + vPartX);
            const py = Math.round(cy + uy * i + vPartY);
            const pz = Math.round(cz + uz * i + vPartZ);
            pushIf(px, py, pz);
          }
        }
      }
    }

    await Promise.all(toAwait);
    this.brushCache.update({ x: cx, y: cy, z: cz }, r, value, shape, basis);

    if (voxelCount === 0) return;

    if (basis && shape === BrushShape.DISK) {
      const result = this.fillPlaneAliasingGaps(
        voxelBuffer,
        voxelCount,
        basis,
        center,
      );
      this.processBackendEdits(result.buffer, result.count, value, sourceIndex);
    } else {
      this.processBackendEdits(voxelBuffer, voxelCount, value, sourceIndex);
    }
  }

  private async performFloodFill(op: FloodFillOperation): Promise<void> {
    const { seed, value: fillValue, maxVoxels, basis, filterValue } = op;
    const sourceIndex = 0;
    const source = this.sources.get(sourceIndex);
    if (!source) return;
    const accessor = new BackendVoxelAccessor(source);

    const startVoxelLod = vec3.round(vec3.create(), seed as vec3);
    const originalValue = await accessor.getValue(
      startVoxelLod[0],
      startVoxelLod[1],
      startVoxelLod[2],
    );

    if (originalValue === null) return;
    if (filterValue !== undefined && originalValue !== filterValue) return;
    if (originalValue === fillValue) return;

    const visited = new Set<string>();
    const queue: [number, number][] = [];
    let filledCount = 0;
    const voxelBuffer = new Int32Array(maxVoxels * 3 + 200); // +200 since fillBorderRegion may exceed the maxVoxelCount without failure

    const map2dTo3d = (u: number, v: number): vec3 => {
      const point = vec3.clone(startVoxelLod);
      vec3.scaleAndAdd(point, point, basis.u as vec3, u);
      vec3.scaleAndAdd(point, point, basis.v as vec3, v);
      return vec3.round(vec3.create(), point);
    };

    const isFillable = async (p: vec3): Promise<boolean> => {
      const val = await accessor.getValue(p[0], p[1], p[2]);
      if (val === null) return false;
      if (originalValue === 0n) return val === 0n;
      return val === originalValue;
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

    const hasThickEnoughChannel = async (
      u: number,
      v: number,
      nu: number,
      nv: number,
      requiredThickness: number,
    ): Promise<boolean> => {
      if (requiredThickness <= 1) return true;
      const halfThickness = Math.floor(requiredThickness / 2);
      const du = nu - u;
      const dv = nv - v;
      const perpU = -dv;
      const perpV = du;

      for (let offset = -halfThickness; offset <= halfThickness; ++offset) {
        const testU = nu + perpU * offset;
        const testV = nv + perpV * offset;
        const pointToTest = map2dTo3d(testU, testV);
        if (!(await isFillable(pointToTest))) return false;
      }
      return true;
    };

    const fillBorderRegion = async (
      startU: number,
      startV: number,
      requiredThickness: number,
    ) => {
      const subQueue: [number, number][] = [];
      const halfSize = requiredThickness * 2;
      const startKey = `${startU},${startV}`;
      if (visited.has(startKey)) return;

      subQueue.push([startU, startV]);
      visited.add(startKey);

      while (subQueue.length > 0) {
        if (filledCount >= maxVoxels) return;
        const [u, v] = subQueue.shift()!;
        const currentPoint = map2dTo3d(u, v);
        const base = filledCount * 3;
        voxelBuffer[base] = currentPoint[0];
        voxelBuffer[base + 1] = currentPoint[1];
        voxelBuffer[base + 2] = currentPoint[2];
        filledCount++;

        const neighbors2d: [number, number][] = [
          [u + 1, v],
          [u - 1, v],
          [u, v + 1],
          [u, v - 1],
        ];
        for (const [nu, nv] of neighbors2d) {
          const du = nu - startU;
          const dv = nv - startV;
          if (du * du + dv * dv > halfSize * halfSize) continue;
          const neighborKey = `${nu},${nv}`;
          if (visited.has(neighborKey)) continue;
          if (await isFillable(map2dTo3d(nu, nv))) {
            visited.add(neighborKey);
            subQueue.push([nu, nv]);
          }
        }
      }
    };

    queue.push([0, 0]);
    visited.add("0,0");

    while (queue.length > 0) {
      if (filledCount >= maxVoxels)
        throw new Error(`Flood fill failed: too many voxels filled.`);
      const [u, v] = queue.shift()!;
      const currentPoint = map2dTo3d(u, v);
      const base = filledCount * 3;
      voxelBuffer[base] = currentPoint[0];
      voxelBuffer[base + 1] = currentPoint[1];
      voxelBuffer[base + 2] = currentPoint[2];
      filledCount++;

      const requiredThickness = getCurrentThickness();
      const neighbors2d: [number, number][] = [
        [u + 1, v],
        [u - 1, v],
        [u, v + 1],
        [u, v - 1],
      ];

      for (const [nu, nv] of neighbors2d) {
        const k = `${nu},${nv}`;
        if (visited.has(k)) continue;
        const neighborPoint = map2dTo3d(nu, nv);
        if (await isFillable(neighborPoint)) {
          if (await hasThickEnoughChannel(u, v, nu, nv, requiredThickness)) {
            visited.add(k);
            queue.push([nu, nv]);
          } else {
            await fillBorderRegion(nu, nv, requiredThickness);
          }
        }
      }
    }

    const result = this.fillPlaneAliasingGaps(
      voxelBuffer,
      filledCount,
      basis,
      seed,
    );
    this.processBackendEdits(
      result.buffer,
      result.count,
      fillValue,
      sourceIndex,
    );
  }

  private fillPlaneAliasingGaps(
    inputBuffer: Int32Array,
    inputCount: number,
    basis: { u: Float32Array; v: Float32Array },
    center: Float32Array,
  ): { buffer: Int32Array; count: number } {
    const u = basis.u as vec3;
    const v = basis.v as vec3;
    const normal = vec3.create();
    vec3.cross(normal, u, v);
    vec3.normalize(normal, normal);

    const SKIP_THRESHOLD = 0.99;
    if (
      Math.abs(normal[0]) > SKIP_THRESHOLD ||
      Math.abs(normal[1]) > SKIP_THRESHOLD ||
      Math.abs(normal[2]) > SKIP_THRESHOLD
    ) {
      return { buffer: inputBuffer, count: inputCount };
    }

    const d = -vec3.dot(normal, center as vec3);
    const DISTANCE_THRESHOLD =
      Math.abs(normal[0]) + Math.abs(normal[1]) + Math.abs(normal[2]) + 1e-5;

    const voxelSet = new Set<string>();

    let outputBuffer = inputBuffer;
    let outputCount = inputCount;
    if (inputCount * 6 > inputBuffer.length) {
      const newBuf = new Int32Array(inputCount * 6);
      newBuf.set(inputBuffer.subarray(0, inputCount * 3));
      outputBuffer = newBuf;
    }

    for (let i = 0; i < inputCount; i++) {
      const base = i * 3;
      const px = outputBuffer[base];
      const py = outputBuffer[base + 1];
      const pz = outputBuffer[base + 2];
      voxelSet.add(`${px},${py},${pz}`);
    }

    for (let i = 0; i < inputCount; i++) {
      const base = i * 3;
      const px = inputBuffer[base];
      const py = inputBuffer[base + 1];
      const pz = inputBuffer[base + 2];

      for (const [ox, oy, oz] of OFFSETS_26_CONNECTED_BACKEND) {
        const nx = px + ox;
        const ny = py + oy;
        const nz = pz + oz;

        const dist = Math.abs(
          normal[0] * nx + normal[1] * ny + normal[2] * nz + d,
        );
        if (dist <= DISTANCE_THRESHOLD) {
          const key = `${nx},${ny},${nz}`;
          if (!voxelSet.has(key)) {
            voxelSet.add(key);

            if (outputCount * 3 + 3 > outputBuffer.length) {
              const newBuf = new Int32Array(outputBuffer.length * 2);
              newBuf.set(outputBuffer);
              outputBuffer = newBuf;
            }
            const outBase = outputCount * 3;
            outputBuffer[outBase] = nx;
            outputBuffer[outBase + 1] = ny;
            outputBuffer[outBase + 2] = nz;
            outputCount++;
          }
        }
      }
    }
    return { buffer: outputBuffer, count: outputCount };
  }

  private processBackendEdits(
    voxelBuffer: Int32Array,
    voxelCount: number,
    value: bigint,
    lodIndex: number,
  ) {
    const source = this.sources.get(lodIndex);
    if (!source) return;

    const { chunkDataSize } = source.spec;
    const indicesByVoxKey = new Map<string, number[]>();

    let lastGridX = -Infinity;
    let lastGridY = -Infinity;
    let lastGridZ = -Infinity;
    let currentIndicesList: number[] | undefined;

    const sizeX = chunkDataSize[0];
    const sizeY = chunkDataSize[1];
    const sizeZ = chunkDataSize[2];
    const strideY = sizeX;
    const strideZ = sizeX * sizeY;

    for (let i = 0; i < voxelCount; i++) {
      const base = i * 3;
      const vx = voxelBuffer[base];
      const vy = voxelBuffer[base + 1];
      const vz = voxelBuffer[base + 2];

      const cx = Math.floor(vx / sizeX);
      const cy = Math.floor(vy / sizeY);
      const cz = Math.floor(vz / sizeZ);

      if (cx !== lastGridX || cy !== lastGridY || cz !== lastGridZ) {
        lastGridX = cx;
        lastGridY = cy;
        lastGridZ = cz;

        const voxKey = `lod${lodIndex}#${cx},${cy},${cz}`;

        currentIndicesList = indicesByVoxKey.get(voxKey);
        if (!currentIndicesList) {
          currentIndicesList = [];
          indicesByVoxKey.set(voxKey, currentIndicesList);
        }
      }

      const lx = Math.floor(vx - sizeX * cx);
      const ly = Math.floor(vy - sizeY * cy);
      const lz = Math.floor(vz - sizeZ * cz);

      const index = lz * strideZ + ly * strideY + lx;

      currentIndicesList!.push(index);
    }

    const backendEdits = [];
    for (const [voxKey, indices] of indicesByVoxKey.entries()) {
      backendEdits.push({ key: voxKey, indices, value });
    }
    this.commitVoxels(backendEdits);
  }
}

registerRPC(VOX_EDIT_COMMIT_VOXELS_RPC_ID, function (x: any) {
  const obj = this.get(x.rpcId) as VoxelEditController;
  obj.commitVoxels(Array.isArray(x.edits) ? x.edits : []);
});

registerPromiseRPC(VOX_EDIT_UNDO_RPC_ID, async function (this: RPC, x: any) {
  const obj = this.get(x.rpcId) as VoxelEditController;
  await obj.undo();
  return { value: undefined };
});

registerPromiseRPC(VOX_EDIT_REDO_RPC_ID, async function (this: RPC, x: any) {
  const obj = this.get(x.rpcId) as VoxelEditController;
  await obj.redo();
  return { value: undefined };
});

registerPromiseRPC(
  VOX_EDIT_OPERATION_RPC_ID,
  async function (this: RPC, x: any) {
    const obj = this.get(x.rpcId) as VoxelEditController;
    await obj.performOperation(x.operation);
    return { value: undefined };
  },
);
