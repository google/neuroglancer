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

import { BrushShape, VoxUserLayer } from "#src/layer/vox/index.js";
import type { ChunkChannelAccessParameters } from "#src/render_coordinate_transform.js";
import type {
  VolumeChunkSource,
  MultiscaleVolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import { StatusMessage } from "#src/status.js";
import { WatchableValue } from "#src/trackable_value.js";
import { vec3 } from "#src/util/geom.js";
import type { VoxelLayerResolution } from "#src/voxel_annotation/base.js";
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
} from "#src/voxel_annotation/base.js";
import {
  registerRPC,
  registerSharedObjectOwner,
  SharedObject,
} from "#src/worker_rpc.js";

@registerSharedObjectOwner(VOX_EDIT_BACKEND_RPC_ID)
export class VoxelEditController extends SharedObject {
  public undoCount = new WatchableValue<number>(0);
  public redoCount = new WatchableValue<number>(0);

  constructor(
    private layer: VoxUserLayer,
    private multiscale: MultiscaleVolumeChunkSource,
  ) {
    super();
    const rpc = (this.multiscale as any)?.chunkManager?.rpc;
    if (!rpc) {
      throw new Error(
        "VoxelEditController: Missing RPC from multiscale chunk manager.",
      );
    }

    // Get all sources for all scales and orientations
    const sourcesByScale = this.multiscale.getSources(
      this.getIdentitySliceViewSourceOptions(),
    );
    const sources = sourcesByScale[0];
    if (!sources) {
      throw new Error(
        "VoxelEditController: Could not retrieve sources from multiscale object.",
      );
    }

    const resolutions: VoxelLayerResolution[] = [];

    for (let i = 0; i < sources.length; ++i) {
      const source = sources[i]!.chunkSource;
      const rpcId = source.rpcId;
      if (rpcId == null) {
        throw new Error(
          `VoxelEditController: Source at LOD index ${i} has null rpcId during initialization.`,
        );
      }
      resolutions.push({
        lodIndex: i,
        transform: Array.from(sources[i]!.chunkToMultiscaleTransform),
        chunkSize: Array.from(source.spec.chunkDataSize),
        sourceRpc: rpcId,
      });
    }

    this.initializeCounterpart(rpc, { resolutions });
  }

  private morphologicalConfig = {
    growthThresholds: [
      { count: 100, size: 1 },
      { count: 1000, size: 3 },
      { count: 10000, size: 5 },
      { count: 100000, size: 7 },
    ],
    maxSize: 9,
  };

  readonly singleChannelAccess: ChunkChannelAccessParameters = {
    numChannels: 1,
    channelSpaceShape: new Uint32Array([]),
    chunkChannelDimensionIndices: [],
    chunkChannelCoordinates: new Uint32Array([0]),
  };

  private getIdentitySliceViewSourceOptions() {
    const rank = (this.multiscale as any).rank as number | undefined;
    if (!Number.isInteger(rank) || (rank as number) <= 0) {
      throw new Error("VoxelEditController: Invalid multiscale rank.");
    }
    const r = rank as number;
    // Identity mapping from multiscale to view for our purposes.
    const displayRank = r;
    const multiscaleToViewTransform = new Float32Array(displayRank * r);
    for (let chunkDim = 0; chunkDim < r; ++chunkDim) {
      for (let displayDim = 0; displayDim < displayRank; ++displayDim) {
        multiscaleToViewTransform[displayRank * chunkDim + displayDim] =
          chunkDim === displayDim ? 1 : 0;
      }
    }
    return {
      displayRank,
      multiscaleToViewTransform,
      modelChannelDimensionIndices: [],
    } as const;
  }

  getSourceForLOD(lodIndex: number): VolumeChunkSource {
    const sourcesByScale = this.multiscale.getSources(
      this.getIdentitySliceViewSourceOptions(),
    );
    // Assuming a single orientation, which is correct for this use case.
    const sources = sourcesByScale[0];
    if (!sources || sources.length <= lodIndex) {
      throw new Error(
        `VoxelEditController: LOD index ${lodIndex} is out of bounds.`,
      );
    }
    const source = sources[lodIndex]?.chunkSource;
    if (!source) {
      throw new Error(
        `VoxelEditController: No chunk source found for LOD index ${lodIndex}.`,
      );
    }
    return source;
  }

  // Paint a disk (slice-aligned via basis) or sphere in WORLD/ canonical units; we transform to LOD grid before sending.
  paintBrushWithShape(
    centerCanonical: Float32Array,
    radiusCanonical: number,
    value: bigint,
    shape: BrushShape,
    basis?: { u: Float32Array; v: Float32Array },
  ) {
    if (!Number.isFinite(radiusCanonical) || radiusCanonical <= 0) {
      void basis; // basis is currently unused for disk alignment in this refactor
      throw new Error("paintBrushWithShape: 'radius' must be > 0.");
    }
    if (!centerCanonical || centerCanonical.length < 3) {
      throw new Error(
        "paintBrushWithShape: 'center' must be a Float32Array[3].",
      );
    }

    // For V1 we use the minimum LOD (index 0)
    const voxelSize = 1;
    const sourceIndex = 0;
    const source = this.getSourceForLOD(sourceIndex);

    // Convert center and radius to the level’s voxel grid.
    const cx = Math.round((centerCanonical[0] ?? 0) / voxelSize);
    const cy = Math.round((centerCanonical[1] ?? 0) / voxelSize);
    const cz = Math.round((centerCanonical[2] ?? 0) / voxelSize);
    const r = Math.round(radiusCanonical / voxelSize);
    if (r <= 0) {
      throw new Error(
        "paintBrushWithShape: radius too small for selected LOD.",
      );
    }
    const rr = r * r;

    const voxelsToPaint: Float32Array[] = [];

    if (shape === BrushShape.sphere) {
      for (let dz = -r; dz <= r; ++dz) {
        for (let dy = -r; dy <= r; ++dy) {
          for (let dx = -r; dx <= r; ++dx) {
            if (dx * dx + dy * dy + dz * dz <= rr) {
              voxelsToPaint.push(new Float32Array([cx + dx, cy + dy, cz + dz]));
            }
          }
        }
      }
    } else {
      if (basis === undefined) {
        throw new Error(
          "paintBrushWithShape: 'basis' must be defined for disk alignment.",
        );
      }
      const { u, v } = basis;
      for (let j = -r; j <= r; ++j) {
        for (let i = -r; i <= r; ++i) {
          if (i * i + j * j <= rr) {
            const point = vec3.fromValues(cx, cy, cz);
            vec3.scaleAndAdd(point, point, u as vec3, i);
            vec3.scaleAndAdd(point, point, v as vec3, j);
            voxelsToPaint.push(point as Float32Array);
          }
        }
      }
    }

    if (!voxelsToPaint || voxelsToPaint.length === 0) return;
    const editsByVoxKey = new Map<
      string,
      { indices: number[]; value: bigint }
    >();

    for (const voxelCoord of voxelsToPaint) {
      const { chunkGridPosition, positionWithinChunk } =
        source.computeChunkIndices(voxelCoord);
      const chunkKey = chunkGridPosition.join();
      const voxKey = makeVoxChunkKey(chunkKey, sourceIndex);

      let entry = editsByVoxKey.get(voxKey);
      if (!entry) {
        entry = { indices: [], value };
        editsByVoxKey.set(voxKey, entry);
      }

      const { chunkDataSize } = source.spec;
      const index =
        (positionWithinChunk[2] * chunkDataSize[1] + positionWithinChunk[1]) *
          chunkDataSize[0] +
        positionWithinChunk[0];
      entry.indices.push(index);
    }

    // Apply edits locally on the specific source for immediate feedback.
    const localEdits = new Map<string, { indices: number[]; value: bigint }>();
    for (const [voxKey, edit] of editsByVoxKey.entries()) {
      const parsed = parseVoxChunkKey(voxKey);
      if (!parsed) continue;
      localEdits.set(parsed.chunkKey, edit);
    }
    source.applyLocalEdits(localEdits);

    const backendEdits = [] as {
      key: string;
      indices: number[];
      value: bigint;
    }[];
    for (const [voxKey, edit] of editsByVoxKey.entries()) {
      backendEdits.push({
        key: voxKey,
        indices: edit.indices,
        value: edit.value,
      });
    }

    this.commitEdits(backendEdits);
  }

  /** Commit helper for UI tools. */
  commitEdits(
    edits: {
      key: string;
      indices: number[] | Uint32Array;
      value?: bigint;
      values?: ArrayLike<number>;
      size?: number[];
    }[],
  ): void {
    if (!this.rpc)
      throw new Error("VoxelEditController.commitEdits: RPC not initialized.");
    if (!Array.isArray(edits)) {
      throw new Error(
        "VoxelEditController.commitEdits: edits must be an array.",
      );
    }
    this.rpc.invoke(VOX_EDIT_COMMIT_VOXELS_RPC_ID, {
      rpcId: this.rpcId,
      edits,
    });
  }

  /**
   * Frontend 2D flood fill helper: computes on currently selected LOD and returns an edits payload
   * suitable for VOX_EDIT_COMMIT_VOXELS without committing. Hard-cap deny semantics.
   * The seed is simply the first clicked voxel in canonical/world units.
   */
  async floodFillPlane2D(
    startPositionCanonical: Float32Array,
    fillValue: bigint,
    maxVoxels: number,
    planeNormal: vec3, // MUST be a normalized vector
  ): Promise<{
    edits: { key: string; indices: number[]; value: bigint }[];
    filledCount: number;
    originalValue: bigint;
  }> {
    const sourceIndex = 0;
    const source = this.getSourceForLOD(sourceIndex);
    const startVoxelLod = vec3.round(
      vec3.create(),
      startPositionCanonical as vec3,
    );

    const originalValueResult = await source.getEnsuredValueAt(
      startVoxelLod as Float32Array,
      this.singleChannelAccess,
    );
    if (originalValueResult === null) {
      throw new Error(
        "Flood fill seed is in an unloaded or out-of-bounds chunk.",
      );
    }
    const originalValue =
      typeof originalValueResult !== "bigint"
        ? BigInt(originalValueResult as number)
        : originalValueResult;

    if (originalValue === fillValue) {
      return { edits: [], filledCount: 0, originalValue };
    }

    const U = vec3.create();
    const V = vec3.create();
    const tempVec =
      Math.abs(vec3.dot(planeNormal, vec3.fromValues(1, 0, 0))) < 0.9
        ? vec3.fromValues(1, 0, 0)
        : vec3.fromValues(0, 1, 0);
    vec3.cross(U, tempVec, planeNormal);
    vec3.normalize(U, U);
    vec3.cross(V, planeNormal, U);
    vec3.normalize(V, V);

    const visited = new Set<string>();
    const queue: [number, number][] = [];
    let filledCount = 0;
    const voxelsToFill: Float32Array[] = [];

    const map2dTo3d = (u: number, v: number): vec3 => {
      const point = vec3.clone(startVoxelLod);
      vec3.scaleAndAdd(point, point, U, u);
      vec3.scaleAndAdd(point, point, V, v);
      return vec3.round(vec3.create(), point);
    };

    const isFillable = async (p: vec3): Promise<boolean> => {
      const value = await source.getEnsuredValueAt(
        p as Float32Array,
        this.singleChannelAccess,
      );
      if (value === null) return false;
      const bigValue =
        typeof value !== "bigint" ? BigInt(value as number) : value;
      if (originalValue === 0n) return bigValue === 0n;
      return bigValue === originalValue;
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

      // Perpendicular direction
      const perpU = -dv;
      const perpV = du;

      // Check if the NEIGHBOR position has sufficient thickness on both sides
      for (let offset = -halfThickness; offset <= halfThickness; ++offset) {
        const testU = nu + perpU * offset;
        const testV = nv + perpV * offset;
        const pointToTest = map2dTo3d(testU, testV);

        if (!(await isFillable(pointToTest))) {
          return false;
        }
      }

      return true;
    };

    const fillBorderRegion = async (
      startU: number,
      startV: number,
      requiredThickness: number,
    ) => {
      const subQueue: [number, number][] = [];
      // The bounding box for the local fill is defined in the (u, v) coordinate system
      const halfSize = Math.floor(requiredThickness / 2) + 1;
      const startKey = `${startU},${startV}`;
      if (visited.has(startKey)) return;

      subQueue.push([startU, startV]);
      visited.add(startKey);

      while (subQueue.length > 0) {
        if (filledCount >= maxVoxels) return;
        const [u, v] = subQueue.shift()!;

        const currentPoint = map2dTo3d(u, v);
        filledCount++;
        voxelsToFill.push(currentPoint as Float32Array);

        const neighbors2d: [number, number][] = [
          [u + 1, v],
          [u - 1, v],
          [u, v + 1],
          [u, v - 1],
        ];
        for (const [nu, nv] of neighbors2d) {
          // Constrain this local search to a small bounding box
          if (
            nu < startU - halfSize ||
            nu > startU + halfSize ||
            nv < startV - halfSize ||
            nv > startV + halfSize
          ) {
            continue;
          }

          const neighborKey = `${nu},${nv}`;
          if (visited.has(neighborKey)) continue;

          const neighborPoint = map2dTo3d(nu, nv);
          if (await isFillable(neighborPoint)) {
            visited.add(neighborKey);
            subQueue.push([nu, nv]);
          }
        }
      }
    };

    queue.push([0, 0]);
    visited.add("0,0");

    while (queue.length > 0) {
      if (filledCount >= maxVoxels) {
        throw new Error(
          `Flood fill region exceeds the limit of ${maxVoxels} voxels.`,
        );
      }
      const [u, v] = queue.shift()!;

      const currentPoint = map2dTo3d(u, v);
      filledCount++;
      voxelsToFill.push(currentPoint as Float32Array);

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

    const editsByVoxKey = new Map<
      string,
      { indices: number[]; value: bigint }
    >();
    for (const voxelCoord of voxelsToFill) {
      const { chunkGridPosition, positionWithinChunk } =
        source.computeChunkIndices(voxelCoord);
      const chunkKey = chunkGridPosition.join();
      const voxKey = makeVoxChunkKey(chunkKey, sourceIndex);
      let entry = editsByVoxKey.get(voxKey);
      if (!entry) {
        entry = { indices: [], value: fillValue };
        editsByVoxKey.set(voxKey, entry);
      }
      const { chunkDataSize } = source.spec;
      const index =
        (positionWithinChunk[2] * chunkDataSize[1] + positionWithinChunk[1]) *
          chunkDataSize[0] +
        positionWithinChunk[0];
      entry.indices.push(index);
    }
    const localEdits = new Map<string, { indices: number[]; value: bigint }>();
    for (const [voxKey, edit] of editsByVoxKey.entries()) {
      const parsed = parseVoxChunkKey(voxKey);
      if (!parsed) continue;
      localEdits.set(parsed.chunkKey, edit);
    }
    source.applyLocalEdits(localEdits);
    const backendEdits: { key: string; indices: number[]; value: bigint }[] =
      [];
    for (const [voxKey, edit] of editsByVoxKey.entries()) {
      backendEdits.push({
        key: voxKey,
        indices: edit.indices,
        value: edit.value,
      });
    }
    this.commitEdits(backendEdits);

    return { edits: backendEdits, filledCount, originalValue };
  }

  callChunkReload(voxChunkKeys: string[]) {
    if (!Array.isArray(voxChunkKeys) || voxChunkKeys.length === 0) return;
    // This assumes the multiscale source has a single orientation.
    const sourcesByScale = (this.multiscale as any).getSources(
      this.getIdentitySliceViewSourceOptions(),
    );
    const sources = sourcesByScale && sourcesByScale[0];
    if (!sources) return;

    const chunksToInvalidateBySource = new Map<VolumeChunkSource, string[]>();

    for (const voxKey of voxChunkKeys) {
      const parsed = parseVoxChunkKey(voxKey);
      if (!parsed) continue;
      const source = sources[parsed.lodIndex]?.chunkSource as
        | VolumeChunkSource
        | undefined;
      if (!source) continue;
      let arr = chunksToInvalidateBySource.get(source);
      if (!arr) {
        arr = [];
        chunksToInvalidateBySource.set(source, arr);
      }
      arr.push(parsed.chunkKey);
    }

    for (const [source, keys] of chunksToInvalidateBySource.entries()) {
      if (keys.length > 0) {
        source.invalidateChunks(keys);
      }
    }
  }

  /** Backend failure notification handler: revert optimistic preview and show UI message. */
  handleCommitFailure(voxChunkKeys: string[], message: string): void {
    try {
      this.callChunkReload(voxChunkKeys);
    } finally {
      this.layer.setDrawErrorMessage(message);
    }
  }

  public undo(): void {
    if (!this.rpc)
      throw new Error("VoxelEditController.undo: RPC not initialized.");
    console.log("VoxelEditController.undo");
    this.rpc
      .promiseInvoke<void>(VOX_EDIT_UNDO_RPC_ID, { rpcId: this.rpcId })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        StatusMessage.showTemporaryMessage(`Undo failed: ${message}`, 3000);
      });
  }

  public redo(): void {
    if (!this.rpc)
      throw new Error("VoxelEditController.redo: RPC not initialized.");
    console.log("VoxelEditController.redo");
    this.rpc
      .promiseInvoke<void>(VOX_EDIT_REDO_RPC_ID, { rpcId: this.rpcId })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        StatusMessage.showTemporaryMessage(`Redo failed: ${message}`, 3000);
      });
  }
}

registerRPC(VOX_RELOAD_CHUNKS_RPC_ID, function (x: any) {
  const obj = this.get(x.rpcId) as VoxelEditController;
  const keys: string[] = Array.isArray(x.voxChunkKeys) ? x.voxChunkKeys : [];
  obj.callChunkReload(keys);
});

registerRPC(VOX_EDIT_FAILURE_RPC_ID, function (x: any) {
  const obj = this.get(x.rpcId) as VoxelEditController;
  const keys: string[] = Array.isArray(x.voxChunkKeys) ? x.voxChunkKeys : [];
  const message: string =
    typeof x.message === "string" ? x.message : "Voxel edit failed.";
  obj.handleCommitFailure(keys, message);
});

registerRPC(VOX_EDIT_HISTORY_UPDATE_RPC_ID, function (x: any) {
  const obj = this.get(x.rpcId) as VoxelEditController;
  const undoCount = typeof x.undoCount === "number" ? x.undoCount : 0;
  const redoCount = typeof x.redoCount === "number" ? x.redoCount : 0;
  obj.undoCount.value = undoCount;
  obj.redoCount.value = redoCount;
});
