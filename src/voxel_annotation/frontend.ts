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

import type { ChunkChannelAccessParameters } from "#src/render_coordinate_transform.js";
import type {
  InMemoryVolumeChunkSource,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import { StatusMessage } from "#src/status.js";
import { WatchableValue } from "#src/trackable_value.js";
import { vec3 } from "#src/util/geom.js";
import type {
  VoxelEditControllerHost,
  VoxelLayerResolution,
  VoxelOperation,
  VoxelValueGetter,
} from "#src/voxel_annotation/base.js";
import {
  BrushShape,
  parseVoxChunkKey,
  VOX_EDIT_BACKEND_RPC_ID,
  VOX_EDIT_FAILURE_RPC_ID,
  VOX_EDIT_HISTORY_UPDATE_RPC_ID,
  VOX_EDIT_OPERATION_RPC_ID,
  VOX_EDIT_REDO_RPC_ID,
  VOX_EDIT_UNDO_RPC_ID,
  VOX_RELOAD_CHUNKS_RPC_ID,
  VoxelOperationType,
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

  constructor(private host: VoxelEditControllerHost) {
    super();
    const rpc = this.host.rpc;
    if (!rpc) {
      throw new Error(
        "VoxelEditController: Missing RPC from multiscale chunk manager.",
      );
    }

    const sourcesByScale = this.host.primarySource.getSources(
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

  private async dispatchOperation(operation: VoxelOperation) {
    if (!this.rpc) throw new Error("RPC unavailable");
    await this.rpc.promiseInvoke(VOX_EDIT_OPERATION_RPC_ID, {
      rpcId: this.rpcId,
      operation,
    });
  }

  readonly singleChannelAccess: ChunkChannelAccessParameters = {
    numChannels: 1,
    channelSpaceShape: new Uint32Array([]),
    chunkChannelDimensionIndices: [],
    chunkChannelCoordinates: new Uint32Array([0]),
  };

  private getIdentitySliceViewSourceOptions() {
    const rank = this.host.primarySource.rank as number | undefined;
    if (!Number.isInteger(rank) || (rank as number) <= 0) {
      throw new Error("VoxelEditController: Invalid multiscale rank.");
    }
    const r = rank as number;
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

  async paintBrushWithShape(
    centerCanonical: Float32Array,
    radiusCanonical: number,
    valueGetter: VoxelValueGetter,
    shape: BrushShape,
    basis: { u: Float32Array; v: Float32Array },
    filterValue?: bigint,
  ) {
    const voxelSize = 1; // Assuming LOD 0
    const cx = Math.round((centerCanonical[0] ?? 0) / voxelSize);
    const cy = Math.round((centerCanonical[1] ?? 0) / voxelSize);
    const cz = Math.round((centerCanonical[2] ?? 0) / voxelSize);
    let r = Math.round(radiusCanonical / voxelSize);
    if (r <= 0) {
      throw new Error("Brush radius must be positive.");
    }
    r -= 1;
    const rr = r * r;
    const { u, v } = basis as { u: vec3; v: vec3 };
    const n = vec3.create();
    vec3.cross(n, u, v);
    vec3.normalize(n, n);
    const voxelsToPaint: Float32Array[] = [];

    if (
      shape === BrushShape.DISK ||
      shape === BrushShape.SPHERE_DISPLAYING_DISK
    ) {
      for (let j = -r; j <= r; ++j) {
        for (let i = -r; i <= r; ++i) {
          if (i * i + j * j <= rr) {
            const point = vec3.fromValues(cx, cy, cz);
            vec3.scaleAndAdd(point, point, u, i);
            vec3.scaleAndAdd(point, point, v, j);
            voxelsToPaint.push(point as Float32Array);
          }
        }
      }
    } else if (shape === BrushShape.SPHERE) {
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
      const point = vec3.create();
      const center = vec3.fromValues(cx, cy, cz);

      for (let j = -r; j <= r; ++j) {
        for (let i = -r; i <= r; ++i) {
          if (i * i + j * j <= rr) {
            vec3.copy(point, center);
            vec3.scaleAndAdd(point, point, u, i);
            vec3.scaleAndAdd(point, point, v, j);
            voxelsToPaint.push(Float32Array.from(point));

            vec3.copy(point, center);
            vec3.scaleAndAdd(point, point, u, i);
            vec3.scaleAndAdd(point, point, n, j);
            voxelsToPaint.push(Float32Array.from(point));

            vec3.copy(point, center);
            vec3.scaleAndAdd(point, point, n, i);
            vec3.scaleAndAdd(point, point, v, j);
            voxelsToPaint.push(Float32Array.from(point));
          }
        }
      }
    }

    if (voxelsToPaint.length > 0) {
      const previewSource = this.host.previewSource!.getSources(
        this.getIdentitySliceViewSourceOptions(),
      )[0][0].chunkSource as InMemoryVolumeChunkSource;
      const value = valueGetter(true);

      const edits = new Map<string, { indices: number[]; value: bigint }>();

      for (const voxelCoord of voxelsToPaint) {
        const { chunkGridPosition, positionWithinChunk } =
          previewSource.computeChunkIndices(voxelCoord);
        const key = chunkGridPosition.join();
        let entry = edits.get(key);
        if (!entry) {
          entry = { indices: [], value };
          edits.set(key, entry);
        }
        const { chunkDataSize } = previewSource.spec;
        const index =
          (positionWithinChunk[2] * chunkDataSize[1] + positionWithinChunk[1]) *
            chunkDataSize[0] +
          positionWithinChunk[0];
        entry.indices.push(index);
      }
      previewSource.applyLocalEdits(edits);
    }

    const storageValue = valueGetter(false);
    await this.dispatchOperation({
      type: VoxelOperationType.BRUSH,
      center: centerCanonical,
      radius: radiusCanonical,
      value: storageValue,
      shape,
      basis,
      filterValue,
    });
  }

  async floodFillPlane2D(
    startPositionCanonical: Float32Array,
    fillValueGetter: VoxelValueGetter,
    maxVoxels: number,
    basis: { u: Float32Array; v: Float32Array },
    filterValue?: bigint,
  ) {
    const storageValue = fillValueGetter(false);
    await this.dispatchOperation({
      type: VoxelOperationType.FLOOD_FILL,
      seed: startPositionCanonical,
      value: storageValue,
      maxVoxels,
      basis,
      filterValue,
    });
  }

  callChunkReload(voxChunkKeys: string[], isForPreviewChunks: boolean) {
    if (!Array.isArray(voxChunkKeys) || voxChunkKeys.length === 0) return;
    const multiscaleSource = isForPreviewChunks
      ? this.host.previewSource
      : this.host.primarySource;
    if (!multiscaleSource) {
      throw new Error(
        "VoxelEditController.callChunkReload: ERROR Missing source",
      );
    }
    const sources = multiscaleSource.getSources(
      this.getIdentitySliceViewSourceOptions(),
    )[0];
    if (!sources) {
      throw new Error(
        "VoxelEditController.callChunkReload: Missing base source",
      );
    }

    const chunksToInvalidateBySource = new Map<VolumeChunkSource, string[]>();

    for (const voxKey of voxChunkKeys) {
      const parsed = parseVoxChunkKey(voxKey);
      if (!parsed) continue;
      const source = sources[parsed.lodIndex]?.chunkSource as
        | VolumeChunkSource
        | undefined;
      if (source) {
        let arr = chunksToInvalidateBySource.get(source);
        if (!arr) {
          arr = [];
          chunksToInvalidateBySource.set(source, arr);
        }
        arr.push(parsed.chunkKey);
      }
    }

    for (const [source, keys] of chunksToInvalidateBySource.entries()) {
      if (keys.length > 0) {
        source.invalidateChunks(keys);
      }
    }
  }

  handleCommitFailure(voxChunkKeys: string[], message: string): void {
    try {
      this.callChunkReload(voxChunkKeys, true);
    } finally {
      StatusMessage.showTemporaryMessage(message);
    }
  }

  public undo(): void {
    if (!this.rpc)
      throw new Error("VoxelEditController.undo: RPC not initialized.");
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
  obj.callChunkReload(keys, x.isForPreviewChunks);
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
