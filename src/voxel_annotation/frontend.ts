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
import type { ChunkChannelAccessParameters } from "#src/render_coordinate_transform.js";
import { SharedWatchableValue } from "#src/shared_watchable_value.js";
import type {
  InMemoryVolumeChunkSource,
  LocalVolumeEdit,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import { StatusMessage } from "#src/status.js";
import { WatchableValue } from "#src/trackable_value.js";
import type { vec3 } from "#src/util/geom.js";
import type {
  VoxelEditControllerHost,
  VoxelLayerResolution,
  VoxelOperation,
  VoxelValueGetter,
} from "#src/voxel_annotation/base.js";
import {
  BrushShape,
  getDiskStencilKernel,
  getSphereRowRangesKernel,
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

  // Monotonic counter identifying each stroke/operation dispatched to the
  // backend.
  private dispatchSeq = 0;

  // Overlay swaps awaiting their refetched real chunk, keyed by real vox
  // chunk key and resolved by observing visibleChunksChanged: the real
  // chunk's object identity distinguishes the lazily kept stale chunk
  // (recorded at arming) from the refetched one, since a `new` chunk update
  // always builds a fresh Chunk object. A newer reload for the same chunk
  // overwrites its entry, so the map never grows beyond the set of chunks
  // awaiting a swap.
  private pendingOverlaySwaps = new Map<
    string,
    {
      source: VolumeChunkSource;
      chunkKey: string;
      staleChunk: unknown;
      overlaySource: InMemoryVolumeChunkSource;
      overlayChunkKey: string;
      coveredSeq: number;
    }
  >();

  private processPendingOverlaySwaps(): void {
    if (this.pendingOverlaySwaps.size === 0) return;
    for (const [voxKey, swap] of this.pendingOverlaySwaps) {
      const chunk = swap.source.chunks.get(swap.chunkKey);
      // Still the stale chunk (or gone): the refetch has not landed yet.
      if (chunk === undefined || chunk === swap.staleChunk) continue;
      // Refetched but not yet displayed: keep waiting.
      if (chunk.state !== ChunkState.GPU_MEMORY) continue;
      this.pendingOverlaySwaps.delete(voxKey);
      // The overlay tag is read now, at swap time: a stroke that touched the
      // chunk since arming raised it above coveredSeq, keeping the overlay on
      // screen; the covering write's own reload re-arms the swap.
      if (
        swap.coveredSeq < swap.overlaySource.getOverlaySeq(swap.overlayChunkKey)
      ) {
        continue;
      }
      swap.overlaySource.invalidateChunks([swap.overlayChunkKey]);
    }
  }

  // Allocates a stroke's seq before its first preview. Previews tag the
  // overlay chunks they touch with it and the dispatch carries the same
  // value, so what the overlay shows and what the write covers cannot
  // diverge.
  beginStroke(): number {
    return ++this.dispatchSeq;
  }

  private getOverlaySource(): InMemoryVolumeChunkSource | undefined {
    return this.host.previewSource?.getSources(
      this.getIdentitySliceViewSourceOptions(),
    )[0]?.[0]?.chunkSource as InMemoryVolumeChunkSource | undefined;
  }

  // For a stroke whose edits will never be written: stamina/permission
  // refusal, empty stroke, dispatch failure.
  rollbackStroke(seq: number): void {
    this.reconcileStroke(seq, []);
  }

  // Drops the overlay chunks a stroke tagged that its backend write does not
  // cover: nothing will be written there, so no reload would ever clear them
  // and the real data beneath is already correct. Chunks re-tagged by a newer
  // stroke no longer match `seq` and are left untouched.
  reconcileStroke(seq: number, coveredVoxKeys: string[]): void {
    const overlaySource = this.getOverlaySource();
    if (overlaySource === undefined) return;
    const tagged = overlaySource.keysWithOverlaySeq(seq);
    if (tagged.length === 0) return;
    let stale = tagged;
    if (coveredVoxKeys.length > 0) {
      const covered = new Set<string>();
      for (const voxKey of coveredVoxKeys) {
        const parsed = parseVoxChunkKey(voxKey);
        if (parsed !== null && parsed.lodIndex === 0) {
          covered.add(parsed.chunkKey);
        }
      }
      stale = tagged.filter((key) => !covered.has(key));
    }
    if (stale.length > 0) overlaySource.invalidateChunks(stale);
  }

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

    // Pending overlay swaps are resolved by observing chunk changes rather
    // than by hooks inside the chunk manager: the signal fires after every
    // applied batch of chunk updates, and the check below is a cheap scan of
    // the (small) pending map.
    this.registerDisposer(
      this.host.primarySource.chunkManager.chunkQueueManager.visibleChunksChanged.add(
        () => this.processPendingOverlaySwaps(),
      ),
    );
  }

  private async dispatchOperation(
    operation: VoxelOperation,
  ): Promise<string[]> {
    if (!this.rpc) throw new Error("RPC unavailable");
    const coveredVoxKeys = await this.rpc.promiseInvoke<string[]>(
      VOX_EDIT_OPERATION_RPC_ID,
      {
        rpcId: this.rpcId,
        operation,
      },
    );
    return Array.isArray(coveredVoxKeys) ? coveredVoxKeys : [];
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

  async applyBrushPreview(
    points: Float32Array[],
    radiusCanonical: number,
    valueGetter: VoxelValueGetter,
    shape: BrushShape,
    basis: { u: Float32Array; v: Float32Array },
    seq: number,
    filterValue?: bigint,
  ) {
    if (!this.host.previewSource) return;

    const voxelSize = 1; // Assuming LOD 0
    let r = Math.round(radiusCanonical / voxelSize);
    if (r <= 0) {
      throw new Error("Brush radius must be positive.");
    }
    r -= 1;

    const previewSource = this.host.previewSource.getSources(
      this.getIdentitySliceViewSourceOptions(),
    )[0][0].chunkSource as InMemoryVolumeChunkSource;

    const { chunkDataSize } = previewSource.spec;
    const sizeX = chunkDataSize[0];
    const sizeY = chunkDataSize[1];
    const sizeZ = chunkDataSize[2];
    const strideY = sizeX;
    const strideZ = sizeX * sizeY;

    // Deduplicate centers that round to the same voxel position
    const centers: [number, number, number][] = [];
    if (points.length <= 1) {
      const c = points[0]!;
      centers.push([
        Math.round((c[0] ?? 0) / voxelSize),
        Math.round((c[1] ?? 0) / voxelSize),
        Math.round((c[2] ?? 0) / voxelSize),
      ]);
    } else {
      const seen = new Set<string>();
      for (const c of points) {
        const cx = Math.round((c[0] ?? 0) / voxelSize);
        const cy = Math.round((c[1] ?? 0) / voxelSize);
        const cz = Math.round((c[2] ?? 0) / voxelSize);
        const key = `${cx},${cy},${cz}`;
        if (seen.has(key)) continue;
        seen.add(key);
        centers.push([cx, cy, cz]);
      }
    }

    // filterValue setup (slow path only)
    let baseSource: VolumeChunkSource | undefined;
    const tempPos = new Float32Array(3);
    if (filterValue !== undefined) {
      const sourcesByScale = this.host.primarySource.getSources(
        this.getIdentitySliceViewSourceOptions(),
      );
      baseSource = sourcesByScale[0][0].chunkSource as VolumeChunkSource;
    }

    const passesFilter = (x: number, y: number, z: number): boolean => {
      tempPos[0] = x;
      tempPos[1] = y;
      tempPos[2] = z;
      const val = baseSource!.getValueAt(tempPos, this.singleChannelAccess);
      if (val == null) return true;
      const bigVal = typeof val === "bigint" ? val : BigInt(val);
      return bigVal === filterValue;
    };

    type EditEntry = LocalVolumeEdit & {
      indices: number[];
      indexRanges: number[];
    };
    const edits = new Map<string, EditEntry>();
    const previewValue = valueGetter(true);

    const getOrCreateEdit = (
      chunkX: number,
      chunkY: number,
      chunkZ: number,
    ): EditEntry => {
      const key = `${chunkX},${chunkY},${chunkZ}`;
      let entry = edits.get(key);
      if (entry !== undefined) return entry;
      entry = {
        indices: [],
        indexRanges: [],
        value: previewValue,
        chunkGridPosition: Float32Array.of(chunkX, chunkY, chunkZ),
      };
      edits.set(key, entry);
      return entry;
    };

    // Append a single voxel to the correct chunk edit (used by slow paths)
    const appendVoxel = (x: number, y: number, z: number) => {
      const chunkX = Math.floor(x / sizeX);
      const chunkY = Math.floor(y / sizeY);
      const chunkZ = Math.floor(z / sizeZ);
      const lx = x - chunkX * sizeX;
      const ly = y - chunkY * sizeY;
      const lz = z - chunkZ * sizeZ;
      getOrCreateEdit(chunkX, chunkY, chunkZ).indices.push(
        lz * strideZ + ly * strideY + lx,
      );
    };

    // Append a contiguous x-run [xStart, xEndExcl) at (y, z), splitting at chunk boundaries.
    // Merges adjacent ranges within the same chunk entry.
    const appendRange = (
      xStart: number,
      xEndExcl: number,
      y: number,
      z: number,
    ) => {
      const chunkY = Math.floor(y / sizeY);
      const chunkZ = Math.floor(z / sizeZ);
      const ly = y - chunkY * sizeY;
      const lz = z - chunkZ * sizeZ;
      const baseIndex = lz * strideZ + ly * strideY;

      let currentX = xStart;
      while (currentX < xEndExcl) {
        const chunkX = Math.floor(currentX / sizeX);
        const segEnd = Math.min(xEndExcl, (chunkX + 1) * sizeX);
        const startIndex = baseIndex + (currentX - chunkX * sizeX);
        const length = segEnd - currentX;

        const entry = getOrCreateEdit(chunkX, chunkY, chunkZ);
        if (length === 1) {
          entry.indices.push(startIndex);
        } else {
          const ranges = entry.indexRanges;
          const last = ranges.length - 1;
          if (last >= 1 && ranges[last - 1]! + ranges[last]! === startIndex) {
            ranges[last] = ranges[last]! + length;
          } else {
            ranges.push(startIndex, length);
          }
        }
        currentX = segEnd;
      }
    };

    if (shape === BrushShape.SPHERE) {
      const kernel = getSphereRowRangesKernel(r);
      if (filterValue === undefined) {
        // Fast path: contiguous row ranges → TypedArray.fill()
        for (const [cx, cy, cz] of centers) {
          for (let i = 0; i < kernel.length; i += 4) {
            appendRange(
              cx + kernel[i + 2]!,
              cx + kernel[i + 3]!,
              cy + kernel[i]!,
              cz + kernel[i + 1]!,
            );
          }
        }
      } else {
        // Slow path: per-voxel filter check
        for (const [cx, cy, cz] of centers) {
          for (let i = 0; i < kernel.length; i += 4) {
            const dy = kernel[i]!;
            const dz = kernel[i + 1]!;
            const xStart = kernel[i + 2]!;
            const xEndExcl = kernel[i + 3]!;
            for (let dx = xStart; dx < xEndExcl; ++dx) {
              const x = cx + dx;
              const y = cy + dy;
              const z = cz + dz;
              if (passesFilter(x, y, z)) appendVoxel(x, y, z);
            }
          }
        }
      }
    } else {
      // DISK: project stencil through basis vectors, no axis-aligned runs possible
      const { u: uVec, v: vVec } = basis as { u: vec3; v: vec3 };
      const ux = uVec[0],
        uy = uVec[1],
        uz = uVec[2];
      const vx = vVec[0],
        vy = vVec[1],
        vz = vVec[2];
      const stencil = getDiskStencilKernel(r);

      for (const [cx, cy, cz] of centers) {
        for (let i = 0; i < stencil.length; i += 2) {
          const si = stencil[i]!;
          const sj = stencil[i + 1]!;
          const x = Math.round(cx + ux * si + vx * sj);
          const y = Math.round(cy + uy * si + vy * sj);
          const z = Math.round(cz + uz * si + vz * sj);
          if (filterValue !== undefined && !passesFilter(x, y, z)) continue;
          appendVoxel(x, y, z);
        }
      }
    }

    if (edits.size > 0) {
      previewSource.applyLocalEdits(edits);
      for (const key of edits.keys()) previewSource.setOverlaySeq(key, seq);
    }
  }

  async dispatchBrushStroke(
    centers: Float32Array[],
    radiusCanonical: number,
    valueGetter: VoxelValueGetter,
    shape: BrushShape,
    basis: { u: Float32Array; v: Float32Array },
    seq: number,
    filterValue?: bigint,
  ) {
    if (centers.length === 0) {
      // Nothing will be written for this stroke; drop whatever its previews
      // tagged so the overlay does not wait for a write that never comes.
      this.rollbackStroke(seq);
      return;
    }
    const storageValue = valueGetter(false);
    const coveredVoxKeys = await this.dispatchOperation({
      type: VoxelOperationType.BRUSH,
      seq,
      centers,
      radius: radiusCanonical,
      value: storageValue,
      shape,
      basis,
      filterValue,
    });
    this.reconcileStroke(seq, coveredVoxKeys);
  }

  async floodFillPlane2D(
    startPositionCanonical: Float32Array,
    fillValueGetter: VoxelValueGetter,
    maxVoxels: number,
    basis: { u: Float32Array; v: Float32Array },
    filterValue?: bigint,
    morphological = true,
  ) {
    const seq = this.beginStroke();
    const previewValue = fillValueGetter(true);
    const sourcesByScale = this.host.primarySource.getSources(
      this.getIdentitySliceViewSourceOptions(),
    );
    const primaryChunkSource = sourcesByScale[0][0]
      .chunkSource as VolumeChunkSource;

    const previewMultiscale = this.host.previewSource;
    if (!previewMultiscale) return;
    const previewChunkSource = previewMultiscale.getSources(
      this.getIdentitySliceViewSourceOptions(),
    )[0][0].chunkSource as InMemoryVolumeChunkSource;

    const startX = Math.round(startPositionCanonical[0]);
    const startY = Math.round(startPositionCanonical[1]);
    const startZ = Math.round(startPositionCanonical[2]);

    const tempPos = new Float32Array(3);

    const getValue = (x: number, y: number, z: number): bigint | null => {
      tempPos[0] = x;
      tempPos[1] = y;
      tempPos[2] = z;

      const previewVal = previewChunkSource.getValueAt(
        tempPos,
        this.singleChannelAccess,
      );
      if (previewVal != null) {
        return typeof previewVal === "bigint" ? previewVal : BigInt(previewVal);
      }

      const primaryVal = primaryChunkSource.getValueAt(
        tempPos,
        this.singleChannelAccess,
      );
      if (primaryVal != null) {
        return typeof primaryVal === "bigint" ? primaryVal : BigInt(primaryVal);
      }
      return null;
    };

    const originalValue = getValue(startX, startY, startZ);
    if (originalValue === null) {
      // Chunk not yet loaded on the frontend — skip preview and dispatch directly
      // to the backend, which will load the chunk itself.
      await this.dispatchOperation({
        type: VoxelOperationType.FLOOD_FILL,
        seq,
        seed: startPositionCanonical,
        value: fillValueGetter(false),
        maxVoxels,
        basis,
        filterValue,
        morphological,
      });
      return;
    }
    if (filterValue !== undefined && originalValue !== filterValue) return;
    if (originalValue === previewValue) return;

    const visited = new Set<string>();
    const queue: [number, number][] = [[0, 0]];
    visited.add("0,0");

    const edits = new Map<string, { indices: number[]; value: bigint }>();
    const { chunkDataSize } = previewChunkSource.spec;
    const sizeX = chunkDataSize[0];
    const sizeY = chunkDataSize[1];
    const sizeZ = chunkDataSize[2];
    const strideY = sizeX;
    const strideZ = sizeX * sizeY;

    let filledCount = 0;
    const start = Date.now();
    const MAX_TIME_MS = 50;
    const ux = basis.u[0],
      uy = basis.u[1],
      uz = basis.u[2];
    const vx = basis.v[0],
      vy = basis.v[1],
      vz = basis.v[2];

    while (queue.length > 0 && filledCount < maxVoxels) {
      if ((filledCount & 63) === 0 && Date.now() - start > MAX_TIME_MS) break;

      const [u, v] = queue.shift()!;
      const x = Math.round(startX + ux * u + vx * v);
      const y = Math.round(startY + uy * u + vy * v);
      const z = Math.round(startZ + uz * u + vz * v);

      const cx = Math.floor(x / sizeX);
      const cy = Math.floor(y / sizeY);
      const cz = Math.floor(z / sizeZ);
      const lx = x - cx * sizeX;
      const ly = y - cy * sizeY;
      const lz = z - cz * sizeZ;

      const key = `${cx},${cy},${cz}`;
      let entry = edits.get(key);
      if (!entry) {
        entry = { indices: [], value: previewValue };
        edits.set(key, entry);
      }
      const index = lz * strideZ + ly * strideY + lx;
      entry.indices.push(index);
      filledCount++;

      const neighbors: [number, number][] = [
        [u + 1, v],
        [u - 1, v],
        [u, v + 1],
        [u, v - 1],
      ];

      for (const [nu, nv] of neighbors) {
        const k = `${nu},${nv}`;
        if (visited.has(k)) continue;
        visited.add(k);

        const nx = Math.round(startX + ux * nu + vx * nv);
        const ny = Math.round(startY + uy * nu + vy * nv);
        const nz = Math.round(startZ + uz * nu + vz * nv);

        const val = getValue(nx, ny, nz);
        if (val !== null && val === originalValue) {
          queue.push([nu, nv]);
        }
      }
    }

    if (filledCount > 0) {
      previewChunkSource.applyLocalEdits(edits);
      for (const key of edits.keys()) {
        previewChunkSource.setOverlaySeq(key, seq);
      }
    }

    const storageValue = fillValueGetter(false);
    try {
      const coveredVoxKeys = await this.dispatchOperation({
        type: VoxelOperationType.FLOOD_FILL,
        seq,
        seed: startPositionCanonical,
        value: storageValue,
        maxVoxels,
        basis,
        filterValue,
        morphological,
      });
      this.reconcileStroke(seq, coveredVoxKeys);
    } catch (e) {
      this.rollbackStroke(seq);
      throw e;
    }
  }

  callChunkReload(
    voxChunkKeys: string[],
    isForPreviewChunks: boolean,
    overlayKeysToClear?: Record<string, string>,
    coveredSeqs?: Record<string, number>,
    isRollback = false,
  ) {
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

    if (!isForPreviewChunks) {
      // Real chunks: invalidate lazily so the current GPU chunk stays on screen,
      // and clear the matching overlay chunk only once the refetched real data
      // has actually arrived on the GPU (swap-on-arrival), never on a timer.
      //
      // The overlay to clear defaults to the same key/LOD (max-res edits). For
      // downsampled parents the backend passes the originating LOD-0 key, so the
      // visible (forced LOD-0) overlay is cleared as soon as the real chunk of
      // whatever LOD is on screen arrives. A never-swapped overlay simply stays
      // displayed (correct) at worst leaking a little memory — far better than a
      // timer that would clear it with nothing to show.
      const previewSources = this.host.previewSource?.getSources(
        this.getIdentitySliceViewSourceOptions(),
      )[0];
      // Known, accepted race: a refetch predating the write we are reloading
      // for may still sit in the frontend's pending-update queue at arming
      // time; its arrival is indistinguishable from the fresh one and can
      // clear the overlay over pre-write data. The window requires the queue
      // to lag behind RPC processing (heavy load only), and the backend's
      // in-flight download cancellation on write guarantees a correct
      // refetch follows within one round trip, so the effect is a rare,
      // self-healing flicker — the trade-off for keeping the chunk manager
      // free of voxel-specific hooks.
      for (const voxKey of voxChunkKeys) {
        const parsed = parseVoxChunkKey(voxKey);
        if (!parsed) continue;
        const source = sources[parsed.lodIndex]?.chunkSource as
          | VolumeChunkSource
          | undefined;
        if (!source) continue;
        const { chunkKey } = parsed;

        const overlayParsed = parseVoxChunkKey(
          overlayKeysToClear?.[voxKey] ?? voxKey,
        );
        const overlaySource = overlayParsed
          ? (previewSources?.[overlayParsed.lodIndex]?.chunkSource as
              | InMemoryVolumeChunkSource
              | undefined)
          : undefined;
        if (overlaySource) {
          // The backend echoes, per reloaded chunk, the highest stroke seq
          // its write covers. The overlay chunk carries the seq of the last
          // stroke whose preview touched it (including a stroke still under
          // the mouse — its seq is allocated before its first preview), read
          // when the swap resolves. Clearing only when coverage reaches that
          // tag guarantees the arriving data contains everything the overlay
          // shows. A skipped clear is re-armed by the covering write's own
          // reload; a stroke that never gets written is rolled back
          // explicitly (rollbackStroke) instead of waited for.
          if (isRollback) {
            // Undo/redo: whatever arrives next is the truth — purge the tag
            // so the swap clears on first arrival. An in-progress stroke's
            // chunk would lose its preview until its dispatch rewrites it
            // (Ctrl+Z mid-drag, accepted).
            overlaySource.clearOverlaySeq(overlayParsed!.chunkKey);
          }
          this.pendingOverlaySwaps.set(voxKey, {
            source,
            chunkKey,
            staleChunk: source.chunks.get(chunkKey),
            overlaySource,
            overlayChunkKey: overlayParsed!.chunkKey,
            coveredSeq: coveredSeqs?.[voxKey] ?? 0,
          });
        }
        let arr = chunksToInvalidateBySource.get(source);
        if (!arr) {
          arr = [];
          chunksToInvalidateBySource.set(source, arr);
        }
        arr.push(chunkKey);
      }

      for (const [source, keys] of chunksToInvalidateBySource.entries()) {
        if (keys.length > 0) {
          source.invalidateChunks(keys, { lazy: true });
        }
      }
      return;
    }

    // Preview chunks: clear the optimistic overlay immediately (write-failure
    // rollback, and downsampled-overlay cleanup).
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

function asRecordOrUndefined<T>(x: unknown): Record<string, T> | undefined {
  return x !== null && typeof x === "object"
    ? (x as Record<string, T>)
    : undefined;
}

registerRPC(VOX_RELOAD_CHUNKS_RPC_ID, function (x: any) {
  const obj = this.get(x.rpcId) as VoxelEditController;
  const keys: string[] = Array.isArray(x.voxChunkKeys) ? x.voxChunkKeys : [];
  obj.callChunkReload(
    keys,
    x.isForPreviewChunks,
    asRecordOrUndefined<string>(x.overlayKeysToClear),
    asRecordOrUndefined<number>(x.coveredSeqs),
    x.isRollback === true,
  );
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
