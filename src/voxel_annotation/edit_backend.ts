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

import { DataType } from "#src/sliceview/base.js";
import { decodeChannel as decodeChannelUint32 } from "#src/sliceview/compressed_segmentation/decode_uint32.js";
import { decodeChannel as decodeChannelUint64 } from "#src/sliceview/compressed_segmentation/decode_uint64.js";
import type { VolumeChunkSource } from "#src/sliceview/volume/backend.js";
import { mat4, vec3 } from "#src/util/geom.js";
import * as matrix from "#src/util/matrix.js";
import type {
  VoxelLayerResolution,
  EditAction,
  VoxelChange,
} from "#src/voxel_annotation/base.js";
import {
  VOX_EDIT_BACKEND_RPC_ID,
  VOX_EDIT_COMMIT_VOXELS_RPC_ID,
  VOX_RELOAD_CHUNKS_RPC_ID,
  VOX_EDIT_FAILURE_RPC_ID,
  VOX_EDIT_UNDO_RPC_ID,
  VOX_EDIT_REDO_RPC_ID,
  VOX_EDIT_HISTORY_UPDATE_RPC_ID,
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
  private commitDebounceTimer: number | undefined;
  private readonly commitDebounceDelayMs: number = 300;

  // Undo/redo history
  private undoStack: EditAction[] = [];
  private redoStack: EditAction[] = [];
  private readonly MAX_HISTORY_SIZE: number = 100;

  private downsampleQueue: string[] = [];
  private downsampleQueueSet: Set<string> = new Set();
  private isProcessingDownsampleQueue: boolean = false;

  constructor(rpc: RPC, options: any) {
    super();
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
        this.callChunkReload(allModifiedKeys, true);
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
        // Stop processing this action on the first failure
        break;
      }
    }

    if (success) {
      // Only move the action to the target stack if all operations succeeded.
      targetStack.push(action);
    } else {
      // On failure, return the action to its original stack to maintain consistency.
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
}

registerRPC(VOX_EDIT_COMMIT_VOXELS_RPC_ID, function (x: any) {
  const obj = this.get(x.rpcId) as VoxelEditController;
  void obj.commitVoxels(Array.isArray(x.edits) ? x.edits : []);
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
