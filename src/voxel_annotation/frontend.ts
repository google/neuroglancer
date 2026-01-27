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
import { SharedWatchableValue } from "#src/shared_watchable_value.js";
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
  public pendingOpCount: SharedWatchableValue<number>;

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

    this.pendingOpCount = this.registerDisposer(
      SharedWatchableValue.make(this.host.rpc, 0),
    );

    this.initializeCounterpart(rpc, {
      resolutions,
      pendingOpCount: this.pendingOpCount.rpcId,
    });
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
    const { u: uVec, v: vVec } = basis as { u: vec3; v: vec3 };
    const n = vec3.create();
    vec3.cross(n, uVec, vVec);
    vec3.normalize(n, n);
    const ux = uVec[0],
      uy = uVec[1],
      uz = uVec[2];
    const vx = vVec[0],
      vy = vVec[1],
      vz = vVec[2];
    const nx = n[0],
      ny = n[1],
      nz = n[2];

    // WATCHOUT: update this value if the max possible voxel count changes
    const maxCapacity = Math.ceil((2 * r + 1) ** 2 * 4);
    const voxelBuffer = new Int32Array(maxCapacity * 3);
    let voxelCount = 0;

    let baseSource: VolumeChunkSource | undefined;
    const tempPos = new Float32Array(3);

    if (filterValue !== undefined) {
      const sourcesByScale = this.host.primarySource.getSources(
        this.getIdentitySliceViewSourceOptions(),
      );
      baseSource = sourcesByScale[0][0].chunkSource as VolumeChunkSource;
    }

    const addVoxel = (x: number, y: number, z: number) => {
      if (filterValue && baseSource !== undefined) {
        tempPos[0] = x;
        tempPos[1] = y;
        tempPos[2] = z;
        const val = baseSource.getValueAt(tempPos, this.singleChannelAccess);
        if (val != null) {
          const bigVal = typeof val === "bigint" ? val : BigInt(val);
          if (bigVal !== filterValue) return;
        }
      }

      const base = voxelCount * 3;
      voxelBuffer[base] = x;
      voxelBuffer[base + 1] = y;
      voxelBuffer[base + 2] = z;
      voxelCount++;
    };

    if (shape === BrushShape.DISK) {
      for (let j = -r; j <= r; ++j) {
        for (let i = -r; i <= r; ++i) {
          if (i * i + j * j <= rr) {
            const px = Math.round(cx + ux * i + vx * j);
            const py = Math.round(cy + uy * i + vy * j);
            const pz = Math.round(cz + uz * i + vz * j);
            addVoxel(px, py, pz);
          }
        }
      }
    } else {
      for (let j = -r; j <= r; ++j) {
        for (let i = -r; i <= r; ++i) {
          if (i * i + j * j <= rr) {
            let px = Math.round(cx + ux * i + vx * j);
            let py = Math.round(cy + uy * i + vy * j);
            let pz = Math.round(cz + uz * i + vz * j);
            addVoxel(px, py, pz);

            px = Math.round(cx + ux * i + nx * j);
            py = Math.round(cy + uy * i + ny * j);
            pz = Math.round(cz + uz * i + nz * j);
            addVoxel(px, py, pz);

            px = Math.round(cx + nx * i + vx * j);
            py = Math.round(cy + ny * i + vy * j);
            pz = Math.round(cz + nz * i + vz * j);
            addVoxel(px, py, pz);
          }
        }
      }
    }

    if (voxelCount > 0) {
      const previewSource = this.host.previewSource!.getSources(
        this.getIdentitySliceViewSourceOptions(),
      )[0][0].chunkSource as InMemoryVolumeChunkSource;
      const value = valueGetter(true);

      const edits = new Map<string, { indices: number[]; value: bigint }>();
      const { chunkDataSize } = previewSource.spec;
      const sizeX = chunkDataSize[0];
      const sizeY = chunkDataSize[1];
      const sizeZ = chunkDataSize[2];
      const strideY = sizeX;
      const strideZ = sizeX * sizeY;

      for (let i = 0; i < voxelCount; ++i) {
        const base = i * 3;
        const x = voxelBuffer[base];
        const y = voxelBuffer[base + 1];
        const z = voxelBuffer[base + 2];

        const cx = Math.floor(x / sizeX);
        const cy = Math.floor(y / sizeY);
        const cz = Math.floor(z / sizeZ);

        const lx = x - cx * sizeX;
        const ly = y - cy * sizeY;
        const lz = z - cz * sizeZ;

        const key = `${cx},${cy},${cz}`;
        let entry = edits.get(key);
        if (!entry) {
          entry = { indices: [], value };
          edits.set(key, entry);
        }
        const index = lz * strideZ + ly * strideY + lx;
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

  public async undo() {
    if (!this.rpc)
      throw new Error("VoxelEditController.undo: RPC not initialized.");
    await this.rpc
      .promiseInvoke<void>(VOX_EDIT_UNDO_RPC_ID, { rpcId: this.rpcId })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        StatusMessage.showTemporaryMessage(`Undo failed: ${message}`, 3000);
      });
  }

  public async redo() {
    if (!this.rpc)
      throw new Error("VoxelEditController.redo: RPC not initialized.");
    await this.rpc
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
