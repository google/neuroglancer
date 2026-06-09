/**
 * @license
 * Copyright 2016 Google Inc.
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

import { debounce } from "lodash-es";
import type { ChunkManager } from "#src/chunk_manager/backend.js";
import {
  Chunk,
  ChunkRenderLayerBackend,
  ChunkSource,
  withChunkManager,
} from "#src/chunk_manager/backend.js";
import { ChunkState } from "#src/chunk_manager/base.js";
import { decodeVertexPositionsAndIndices } from "#src/mesh/backend.js";
import {
  type DisplayDimensionRenderInfo,
  validateDisplayDimensionRenderInfoProperty,
} from "#src/navigation_state.js";
import type {
  RenderLayerBackendAttachment,
  RenderedViewBackend,
} from "#src/render_layer_backend.js";
import { RenderLayerBackend } from "#src/render_layer_backend.js";
import { withSegmentationLayerBackendState } from "#src/segmentation_display_state/backend.js";
import {
  forEachVisibleSegment,
  getObjectKey,
} from "#src/segmentation_display_state/base.js";
import type { SharedWatchableValue } from "#src/shared_watchable_value.js";
import type { SpatialSkeletonSourceState } from "#src/skeleton/api.js";
import {
  SKELETON_LAYER_RPC_ID,
  SPATIALLY_INDEXED_SKELETON_RENDER_LAYER_RPC_ID,
  SPATIALLY_INDEXED_SKELETON_RENDER_LAYER_UPDATE_SOURCES_RPC_ID,
} from "#src/skeleton/base.js";
import {
  freeSkeletonChunkSystemMemory,
  getVertexAttributeBytes,
  serializeSkeletonChunkData,
  type SkeletonChunkData,
} from "#src/skeleton/chunk_serialization.js";
import {
  getSpatiallyIndexedSkeletonGridIndex,
  selectSpatiallyIndexedSkeletonEntriesByGridWithFallback,
} from "#src/skeleton/source_selection.js";
import {
  BASE_PRIORITY,
  deserializeTransformedSources,
  SCALE_PRIORITY_MULTIPLIER,
  SliceViewChunk,
  SliceViewChunkSourceBackend,
} from "#src/sliceview/backend.js";
import {
  forEachVisibleVolumetricChunk,
  type SliceViewChunkSpecification,
  type SliceViewProjectionParameters,
  type TransformedSource,
} from "#src/sliceview/base.js";
import type { TypedNumberArray } from "#src/util/array.js";
import type { Endianness } from "#src/util/endian.js";
import { vec3 } from "#src/util/geom.js";
import { getObjectId } from "#src/util/object_id.js";
import {
  getBasePriority,
  getPriorityTier,
  withSharedVisibility,
} from "#src/visibility_priority/backend.js";

import type { RPC } from "#src/worker_rpc.js";
import { registerRPC, registerSharedObject } from "#src/worker_rpc.js";
export interface SpatiallyIndexedSkeletonChunkSpecification
  extends SliceViewChunkSpecification {
  chunkLayout: any;
}

const SKELETON_CHUNK_PRIORITY = 60;
export const SPATIALLY_INDEXED_SKELETON_PRIORITY_BOOST = -BASE_PRIORITY;
const SPATIALLY_INDEXED_SKELETON_LOD_DEBOUNCE_MS = 300;
const tempCenter = vec3.create();
const tempChunkSize = vec3.create();
const tempCenterDataPosition = vec3.create();
const tempArbitrationChunkCenterWorld = vec3.create();
const tempArbitrationCandidateChunkPos = vec3.create();
const tempArbitrationLocalPoint = vec3.create();

function getChunkSpacing(size: Float32Array): number {
  return Math.max(Math.min(size[0], size[1], size[2]), 1e-6);
}

function computePhysicalUnitsPerScreenPixelAtPoint(
  modelViewProjection: Float32Array,
  viewportWidth: number,
  viewportHeight: number,
  worldPoint: Float32Array,
  displayDimensionScales?: Float64Array,
): number {
  const m = modelViewProjection;
  const m00 = m[0],
    m10 = m[1];
  const m01 = m[4],
    m11 = m[5];
  const m02 = m[8],
    m12 = m[9];
  const m30 = m[3],
    m31 = m[7],
    m32 = m[11],
    m33 = m[15];
  const w =
    m30 * worldPoint[0] + m31 * worldPoint[1] + m32 * worldPoint[2] + m33;
  if (!Number.isFinite(w) || w <= 0) return Number.POSITIVE_INFINITY;

  const sx =
    displayDimensionScales !== undefined &&
    displayDimensionScales.length > 0 &&
    Number.isFinite(displayDimensionScales[0]) &&
    displayDimensionScales[0] > 0
      ? displayDimensionScales[0]
      : 1;
  const sy =
    displayDimensionScales !== undefined &&
    displayDimensionScales.length > 1 &&
    Number.isFinite(displayDimensionScales[1]) &&
    displayDimensionScales[1] > 0
      ? displayDimensionScales[1]
      : sx;
  const sz =
    displayDimensionScales !== undefined &&
    displayDimensionScales.length > 2 &&
    Number.isFinite(displayDimensionScales[2]) &&
    displayDimensionScales[2] > 0
      ? displayDimensionScales[2]
      : sy;

  const xScale = Math.sqrt(
    ((m00 / sx) * viewportWidth) ** 2 + ((m10 / sx) * viewportHeight) ** 2,
  );
  const yScale = Math.sqrt(
    ((m01 / sy) * viewportWidth) ** 2 + ((m11 / sy) * viewportHeight) ** 2,
  );
  const zScale = Math.sqrt(
    ((m02 / sz) * viewportWidth) ** 2 + ((m12 / sz) * viewportHeight) ** 2,
  );
  const scaleFactor = Math.max(xScale, yScale, zScale);
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return w / scaleFactor;
}

function getChunkGridPositionForWorldPoint(
  tsource: TransformedSource<
    SpatiallyIndexedSkeletonRenderLayerBackend,
    SpatiallyIndexedSkeletonSourceBackend
  >,
  worldPoint: Float32Array,
  out: Float32Array,
): boolean {
  tsource.chunkLayout.globalToLocalSpatial(
    tempArbitrationLocalPoint,
    worldPoint as vec3,
  );
  const { size } = tsource.chunkLayout;
  const { lowerChunkBound, upperChunkBound } = tsource.source.spec;
  for (let i = 0; i < 3; ++i) {
    const dimSize = size[i];
    if (!Number.isFinite(dimSize) || dimSize <= 0) return false;
    const chunkCoord = Math.floor(tempArbitrationLocalPoint[i] / dimSize);
    if (
      Number.isFinite(lowerChunkBound[i]) &&
      Number.isFinite(upperChunkBound[i]) &&
      (chunkCoord < lowerChunkBound[i] || chunkCoord >= upperChunkBound[i])
    ) {
      return false;
    }
    out[i] = chunkCoord;
  }
  return true;
}

function getMetersPerUnit(projectionParameters: {
  displayDimensionRenderInfo?: { displayDimensionScales?: Float64Array };
}): number {
  const ddScales =
    projectionParameters.displayDimensionRenderInfo?.displayDimensionScales;
  if (ddScales === undefined || ddScales.length === 0) {
    return 1;
  }
  let metersPerUnit = Infinity;
  for (let i = 0; i < ddScales.length; ++i) {
    const s = ddScales[i];
    if (Number.isFinite(s) && s > 0) {
      metersPerUnit = Math.min(metersPerUnit, s);
    }
  }
  return Number.isFinite(metersPerUnit) ? metersPerUnit : 1;
}

function quantizeSpacingForArbitration(spacing: number): number {
  const clamped = Math.max(spacing, 1e-12);
  const log2Spacing = Math.log2(clamped);
  const quantizedLog = Math.round(log2Spacing * 4) / 4;
  return 2 ** quantizedLog;
}

export function getSpatiallyIndexedSkeletonChunkPriority(
  localCenter: Float32Array,
  chunkSize: Float32Array,
  positionInChunks: Float32Array,
) {
  let sum = 0;
  for (let i = 0; i < 3; ++i) {
    const delta = localCenter[i] - positionInChunks[i] * chunkSize[i];
    sum += delta * delta;
  }
  return -Math.sqrt(sum);
}

export function getSpatiallyIndexedSkeletonRenderPriority(
  basePriority: number,
  scaleIndex: number,
  localCenter: Float32Array,
  chunkSize: Float32Array,
  positionInChunks: Float32Array,
) {
  return (
    basePriority +
    SPATIALLY_INDEXED_SKELETON_PRIORITY_BOOST +
    SCALE_PRIORITY_MULTIPLIER * scaleIndex +
    getSpatiallyIndexedSkeletonChunkPriority(
      localCenter,
      chunkSize,
      positionInChunks,
    )
  );
}

export enum SpatiallyIndexedSkeletonChunkRequestOwner {
  NONE = 0,
  VIEW_2D = 1 << 0,
  VIEW_3D = 1 << 1,
}

export function markSpatiallyIndexedSkeletonChunkRequested(
  chunk: SpatiallyIndexedSkeletonChunk,
  currentGeneration: number,
  owner: SpatiallyIndexedSkeletonChunkRequestOwner,
) {
  if (
    owner === SpatiallyIndexedSkeletonChunkRequestOwner.NONE ||
    currentGeneration < 0
  ) {
    return;
  }
  if (chunk.requestGeneration !== currentGeneration) {
    chunk.requestGeneration = currentGeneration;
    chunk.requestOwners = owner;
    return;
  }
  chunk.requestOwners |= owner;
}

export function cancelStaleSpatiallyIndexedSkeletonDownloads(
  chunkManager: ChunkManager,
  sources: Iterable<SpatiallyIndexedSkeletonSourceBackend>,
  currentGeneration: number,
) {
  const queueManager = chunkManager.queueManager;
  for (const source of sources) {
    for (const chunk of source.chunks.values()) {
      const typedChunk = chunk as SpatiallyIndexedSkeletonChunk;
      if (typedChunk.state !== ChunkState.DOWNLOADING) continue;
      if (
        typedChunk.requestGeneration === currentGeneration &&
        typedChunk.requestOwners !==
          SpatiallyIndexedSkeletonChunkRequestOwner.NONE
      ) {
        continue;
      }
      const controller = typedChunk.downloadAbortController;
      if (controller === undefined) continue;
      typedChunk.downloadAbortController = undefined;
      controller.abort(
        new DOMException("stale spatial skeleton LOD download", "AbortError"),
      );
      queueManager.updateChunkState(typedChunk, ChunkState.QUEUED);
    }
  }
}

registerRPC(
  SPATIALLY_INDEXED_SKELETON_RENDER_LAYER_UPDATE_SOURCES_RPC_ID,
  function (x) {
    const view = this.get(x.view) as RenderedViewBackend;
    const layer = this.get(
      x.layer,
    ) as SpatiallyIndexedSkeletonRenderLayerBackend;
    const attachment = layer.attachments.get(
      view,
    )! as RenderLayerBackendAttachment<
      RenderedViewBackend,
      SpatiallyIndexedSkeletonRenderLayerAttachmentState
    >;
    attachment.state!.transformedSources = deserializeTransformedSources<
      SpatiallyIndexedSkeletonSourceBackend,
      SpatiallyIndexedSkeletonRenderLayerBackend
    >(this, x.sources, layer);
    attachment.state!.displayDimensionRenderInfo = x.displayDimensionRenderInfo;
    layer.chunkManager.scheduleUpdateChunkPriorities();
  },
);

// Chunk that contains the skeleton of a single object.
export class SkeletonChunk extends Chunk implements SkeletonChunkData {
  objectId: bigint = 0n;
  vertexPositions: Float32Array | null = null;
  vertexAttributes: TypedNumberArray[] | null = null;
  indices: Uint32Array | null = null;

  initializeSkeletonChunk(key: string, objectId: bigint) {
    super.initialize(key);
    this.objectId = objectId;
  }

  freeSystemMemory() {
    freeSkeletonChunkSystemMemory(this);
  }

  serialize(msg: any, transfers: any[]) {
    super.serialize(msg, transfers);
    serializeSkeletonChunkData(this, msg, transfers);
    freeSkeletonChunkSystemMemory(this);
  }

  downloadSucceeded() {
    this.systemMemoryBytes = this.gpuMemoryBytes =
      this.indices!.byteLength + getVertexAttributeBytes(this);
    super.downloadSucceeded();
  }
}

export class SkeletonSource extends ChunkSource {
  declare chunks: Map<string, SkeletonChunk>;
  getChunk(objectId: bigint) {
    const key = getObjectKey(objectId);
    let chunk = this.chunks.get(key);
    if (chunk === undefined) {
      chunk = this.getNewChunk_(SkeletonChunk);
      chunk.initializeSkeletonChunk(key, objectId);
      this.addChunk(chunk);
    }
    return chunk;
  }
}

@registerSharedObject(SKELETON_LAYER_RPC_ID)
export class SkeletonLayer extends withSegmentationLayerBackendState(
  withSharedVisibility(withChunkManager(ChunkRenderLayerBackend)),
) {
  source: SkeletonSource;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.source = this.registerDisposer(
      rpc.getRef<SkeletonSource>(options.source),
    );
    this.registerDisposer(
      this.chunkManager.recomputeChunkPriorities.add(() => {
        this.updateChunkPriorities();
      }),
    );
  }

  private updateChunkPriorities() {
    const visibility = this.visibility.value;
    if (visibility === Number.NEGATIVE_INFINITY) {
      return;
    }
    this.chunkManager.registerLayer(this);
    const priorityTier = getPriorityTier(visibility);
    const basePriority = getBasePriority(visibility);
    const { source, chunkManager } = this;
    forEachVisibleSegment(this, (objectId) => {
      const chunk = source.getChunk(objectId);
      ++this.numVisibleChunksNeeded;
      if (chunk.state === ChunkState.GPU_MEMORY) {
        ++this.numVisibleChunksAvailable;
      }
      chunkManager.requestChunk(
        chunk,
        priorityTier,
        basePriority + SKELETON_CHUNK_PRIORITY,
      );
    });
  }
}

/**
 * Extracts vertex positions and edge vertex indices of the specified endianness from `data'.
 *
 * See documentation of decodeVertexPositionsAndIndices.
 */
export function decodeSkeletonVertexPositionsAndIndices(
  chunk: SkeletonChunk,
  data: ArrayBuffer,
  endianness: Endianness,
  vertexByteOffset: number,
  numVertices: number,
  indexByteOffset?: number,
  numEdges?: number,
) {
  const meshData = decodeVertexPositionsAndIndices(
    /*verticesPerPrimitive=*/ 2,
    data,
    endianness,
    vertexByteOffset,
    numVertices,
    indexByteOffset,
    numEdges,
  );
  chunk.vertexPositions = meshData.vertexPositions as Float32Array;
  chunk.indices = meshData.indices as Uint32Array;
}

export class SpatiallyIndexedSkeletonChunk
  extends SliceViewChunk
  implements SkeletonChunkData
{
  vertexPositions: Float32Array | null = null;
  vertexAttributes: TypedNumberArray[] | null = null;
  indices: Uint32Array | null = null;
  lod: number = 0;
  requestGeneration = -1;
  requestOwners = SpatiallyIndexedSkeletonChunkRequestOwner.NONE;
  nodeIds: Int32Array | undefined;
  nodeSourceStates: Array<SpatialSkeletonSourceState | undefined> | undefined;

  freeSystemMemory() {
    freeSkeletonChunkSystemMemory(this);
  }

  serialize(msg: any, transfers: any[]) {
    super.serialize(msg, transfers);
    serializeSkeletonChunkData(this, msg, transfers);
    freeSkeletonChunkSystemMemory(this);
  }

  downloadSucceeded() {
    this.systemMemoryBytes = this.gpuMemoryBytes =
      this.indices!.byteLength + getVertexAttributeBytes(this);
    super.downloadSucceeded();
  }
}

export class SpatiallyIndexedSkeletonSourceBackend extends SliceViewChunkSourceBackend<
  SpatiallyIndexedSkeletonChunkSpecification,
  SpatiallyIndexedSkeletonChunk
> {
  chunkConstructor = SpatiallyIndexedSkeletonChunk;
  currentLod: number = 0;
  currentRequestGeneration = -1;
  currentRequestOwner = SpatiallyIndexedSkeletonChunkRequestOwner.NONE;

  getChunk(chunkGridPosition: Float32Array) {
    const lodValue = this.currentLod;
    const key = `${chunkGridPosition.join()}:${lodValue}`;
    let chunk = this.chunks.get(key);
    if (chunk === undefined) {
      chunk = this.getNewChunk_(
        this.chunkConstructor,
      ) as SpatiallyIndexedSkeletonChunk;
      chunk.initializeVolumeChunk(key, chunkGridPosition);
      chunk.lod = lodValue;
      this.addChunk(chunk);
    }
    markSpatiallyIndexedSkeletonChunkRequested(
      chunk,
      this.currentRequestGeneration,
      this.currentRequestOwner,
    );
    return chunk;
  }
}

interface SpatiallyIndexedSkeletonRenderLayerAttachmentState {
  displayDimensionRenderInfo: DisplayDimensionRenderInfo;
  transformedSources: TransformedSource<
    SpatiallyIndexedSkeletonRenderLayerBackend,
    SpatiallyIndexedSkeletonSourceBackend
  >[][];
}

@registerSharedObject(SPATIALLY_INDEXED_SKELETON_RENDER_LAYER_RPC_ID)
export class SpatiallyIndexedSkeletonRenderLayerBackend extends withChunkManager(
  RenderLayerBackend,
) {
  localPosition: SharedWatchableValue<Float32Array>;
  renderScaleTarget: SharedWatchableValue<number>;
  skeletonLod: SharedWatchableValue<number>;
  skeletonGridLevel: SharedWatchableValue<number>;
  skeletonLod2d: SharedWatchableValue<number>;
  skeletonGridLevel2d: SharedWatchableValue<number>;
  skeletonGridResolutionTarget3d: SharedWatchableValue<number>;
  private pendingLodCleanup = false;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.renderScaleTarget = rpc.get(options.renderScaleTarget);
    this.localPosition = rpc.get(options.localPosition);
    this.skeletonLod = rpc.get(options.skeletonLod);
    this.skeletonGridLevel = rpc.get(options.skeletonGridLevel);
    this.skeletonLod2d = rpc.get(options.skeletonLod2d);
    this.skeletonGridLevel2d = rpc.get(options.skeletonGridLevel2d);
    this.skeletonGridResolutionTarget3d = rpc.get(
      options.skeletonGridResolutionTarget3d,
    );
    const scheduleUpdateChunkPriorities = () =>
      this.chunkManager.scheduleUpdateChunkPriorities();
    this.registerDisposer(
      this.localPosition.changed.add(scheduleUpdateChunkPriorities),
    );
    this.registerDisposer(
      this.renderScaleTarget.changed.add(scheduleUpdateChunkPriorities),
    );
    this.registerDisposer(
      this.skeletonGridLevel.changed.add(scheduleUpdateChunkPriorities),
    );
    this.registerDisposer(
      this.skeletonGridLevel2d.changed.add(scheduleUpdateChunkPriorities),
    );
    this.registerDisposer(
      this.skeletonGridResolutionTarget3d.changed.add(
        scheduleUpdateChunkPriorities,
      ),
    );

    // Debounce LOD changes to avoid making requests for every slider value
    const debouncedLodUpdate = debounce(() => {
      scheduleUpdateChunkPriorities();
    }, SPATIALLY_INDEXED_SKELETON_LOD_DEBOUNCE_MS);
    this.registerDisposer(() => debouncedLodUpdate.cancel());

    const onLodChanged = () => {
      this.pendingLodCleanup = true;
      debouncedLodUpdate();
    };
    this.registerDisposer(this.skeletonLod.changed.add(onLodChanged));
    this.registerDisposer(this.skeletonLod2d.changed.add(onLodChanged));
    this.registerDisposer(
      this.chunkManager.recomputeChunkPriorities.add(() =>
        this.recomputeChunkPriorities(),
      ),
    );
    this.registerDisposer(
      this.chunkManager.recomputeChunkPrioritiesLate.add(() => {
        if (!this.pendingLodCleanup) return;
        const sources = new Set<SpatiallyIndexedSkeletonSourceBackend>();
        for (const attachment of this.attachments.values()) {
          const attachmentState = attachment.state as
            | SpatiallyIndexedSkeletonRenderLayerAttachmentState
            | undefined;
          if (attachmentState === undefined) continue;
          for (const scales of attachmentState.transformedSources) {
            for (const tsource of scales) {
              sources.add(
                tsource.source as SpatiallyIndexedSkeletonSourceBackend,
              );
            }
          }
        }
        cancelStaleSpatiallyIndexedSkeletonDownloads(
          this.chunkManager,
          sources,
          this.chunkManager.recomputeChunkPriorities.count,
        );
        this.pendingLodCleanup = false;
      }),
    );
  }

  attach(
    attachment: RenderLayerBackendAttachment<
      RenderedViewBackend,
      SpatiallyIndexedSkeletonRenderLayerAttachmentState
    >,
  ) {
    const scheduleUpdateChunkPriorities = () =>
      this.chunkManager.scheduleUpdateChunkPriorities();
    const { view } = attachment;
    attachment.registerDisposer(scheduleUpdateChunkPriorities);
    attachment.registerDisposer(
      view.projectionParameters.changed.add(scheduleUpdateChunkPriorities),
    );
    attachment.registerDisposer(
      view.visibility.changed.add(scheduleUpdateChunkPriorities),
    );
    attachment.state = {
      displayDimensionRenderInfo:
        view.projectionParameters.value.displayDimensionRenderInfo,
      transformedSources: [],
    };
  }

  private recomputeChunkPriorities() {
    this.chunkManager.registerLayer(this);
    const currentGeneration = this.chunkManager.recomputeChunkPriorities.count;
    for (const attachment of this.attachments.values()) {
      const { view } = attachment;
      const visibility = view.visibility.value;
      if (visibility === Number.NEGATIVE_INFINITY) {
        continue;
      }
      const attachmentState =
        attachment.state! as SpatiallyIndexedSkeletonRenderLayerAttachmentState;
      const { transformedSources } = attachmentState;
      if (
        transformedSources.length === 0 ||
        !validateDisplayDimensionRenderInfoProperty(
          attachmentState,
          view.projectionParameters.value.displayDimensionRenderInfo,
        )
      ) {
        continue;
      }
      const priorityTier = getPriorityTier(visibility);
      const basePriority = getBasePriority(visibility) + BASE_PRIORITY;
      const projectionParameters = view.projectionParameters.value;
      const { chunkManager } = this;
      const localCenter = tempCenter;
      const chunkSize = tempChunkSize;
      const centerDataPosition = tempCenterDataPosition;
      const {
        globalPosition,
        displayDimensionRenderInfo: { displayDimensionIndices },
      } = projectionParameters;
      for (let displayDim = 0; displayDim < 3; ++displayDim) {
        const globalDim = displayDimensionIndices[displayDim];
        centerDataPosition[displayDim] =
          globalDim === -1 ? 0 : globalPosition[globalDim];
      }
      const sliceProjectionParameters =
        projectionParameters as SliceViewProjectionParameters;
      const pixelSize =
        "pixelSize" in sliceProjectionParameters
          ? sliceProjectionParameters.pixelSize
          : undefined;
      let resolvedPixelSize = pixelSize;
      if (resolvedPixelSize === undefined) {
        const voxelPhysicalScales =
          projectionParameters.displayDimensionRenderInfo?.voxelPhysicalScales;
        if (voxelPhysicalScales) {
          let computedPixelSize = 0;
          const { invViewMatrix } = projectionParameters;
          for (let i = 0; i < 3; ++i) {
            const s = voxelPhysicalScales[i];
            const x = invViewMatrix[i];
            computedPixelSize += (s * x) ** 2;
          }
          resolvedPixelSize = Math.sqrt(computedPixelSize);
        }
      }
      const renderScaleTarget = this.renderScaleTarget.value;
      const is2dView = pixelSize !== undefined;
      const skeletonGridLevel = (
        is2dView ? this.skeletonGridLevel2d : this.skeletonGridLevel
      ).value;

      const selectScales = (
        scales: TransformedSource<
          SpatiallyIndexedSkeletonRenderLayerBackend,
          SpatiallyIndexedSkeletonSourceBackend
        >[],
      ): Array<{
        tsource: TransformedSource<
          SpatiallyIndexedSkeletonRenderLayerBackend,
          SpatiallyIndexedSkeletonSourceBackend
        >;
        scaleIndex: number;
      }> => {
        if (scales.length === 0) {
          return [];
        }
        if (
          scales.every(
            (scale) =>
              getSpatiallyIndexedSkeletonGridIndex(scale) !== undefined,
          )
        ) {
          return selectSpatiallyIndexedSkeletonEntriesByGridWithFallback(
            scales.map((tsource, scaleIndex) => ({ tsource, scaleIndex })),
            skeletonGridLevel,
            ({ tsource }) => getSpatiallyIndexedSkeletonGridIndex(tsource),
          );
        }
        if (resolvedPixelSize === undefined) {
          return scales.map((tsource, scaleIndex) => ({
            tsource,
            scaleIndex,
          }));
        }
        const pixelSizeWithMargin = resolvedPixelSize * 1.1;
        const smallestVoxelSize = scales[0].effectiveVoxelSize;
        const canImproveOnVoxelSize = (voxelSize: Float32Array) => {
          const targetSize = pixelSizeWithMargin * renderScaleTarget;
          for (let i = 0; i < 3; ++i) {
            const size = voxelSize[i];
            if (size > targetSize && size > 1.01 * smallestVoxelSize[i]) {
              return true;
            }
          }
          return false;
        };
        const improvesOnPrevVoxelSize = (
          voxelSize: Float32Array,
          prevVoxelSize: Float32Array,
        ) => {
          const targetSize = pixelSizeWithMargin * renderScaleTarget;
          for (let i = 0; i < 3; ++i) {
            const size = voxelSize[i];
            const prevSize = prevVoxelSize[i];
            if (
              Math.abs(targetSize - size) < Math.abs(targetSize - prevSize) &&
              size < 1.01 * prevSize
            ) {
              return true;
            }
          }
          return false;
        };

        const selected: Array<{
          tsource: TransformedSource<
            SpatiallyIndexedSkeletonRenderLayerBackend,
            SpatiallyIndexedSkeletonSourceBackend
          >;
          scaleIndex: number;
        }> = [];
        let scaleIndex = scales.length - 1;
        let prevVoxelSize: Float32Array | undefined;
        while (true) {
          const tsource = scales[scaleIndex];
          const selectionVoxelSize = tsource.effectiveVoxelSize;
          if (
            prevVoxelSize !== undefined &&
            !improvesOnPrevVoxelSize(selectionVoxelSize, prevVoxelSize)
          ) {
            break;
          }
          selected.push({ tsource, scaleIndex });
          if (scaleIndex === 0) break;
          if (!canImproveOnVoxelSize(selectionVoxelSize)) break;
          prevVoxelSize = selectionVoxelSize;
          --scaleIndex;
        }
        return selected;
      };

      const lodValue = (is2dView ? this.skeletonLod2d : this.skeletonLod).value;
      for (const scales of transformedSources) {
        if (
          !is2dView &&
          scales.length > 1 &&
          scales.every(
            (scale) =>
              getSpatiallyIndexedSkeletonGridIndex(scale) !== undefined,
          )
        ) {
          const orderedCandidates =
            selectSpatiallyIndexedSkeletonEntriesByGridWithFallback(
              scales.map((tsource, scaleIndex) => ({ tsource, scaleIndex })),
              skeletonGridLevel,
              ({ tsource }) => getSpatiallyIndexedSkeletonGridIndex(tsource),
            );
          if (orderedCandidates.length > 0) {
            const metersPerUnit = getMetersPerUnit(projectionParameters);
            const spacingMeters = (candidate: {
              tsource: TransformedSource<
                SpatiallyIndexedSkeletonRenderLayerBackend,
                SpatiallyIndexedSkeletonSourceBackend
              >;
            }) =>
              getChunkSpacing(candidate.tsource.chunkLayout.size) *
              metersPerUnit;
            const anchor = orderedCandidates.reduce((best, candidate) =>
              spacingMeters(candidate) < spacingMeters(best) ? candidate : best,
            );
            const targetSpacingMeters =
              Number.isFinite(this.skeletonGridResolutionTarget3d.value) &&
              this.skeletonGridResolutionTarget3d.value > 0
                ? this.skeletonGridResolutionTarget3d.value
                : spacingMeters(anchor);
            const refPoint =
              projectionParameters.globalPosition.length >= 3
                ? projectionParameters.globalPosition
                : this.localPosition.value;
            const referencePixelSizeRaw =
              computePhysicalUnitsPerScreenPixelAtPoint(
                projectionParameters.viewProjectionMat,
                projectionParameters.width,
                projectionParameters.height,
                refPoint,
                projectionParameters.displayDimensionRenderInfo
                  ?.displayDimensionScales,
              );
            const referencePixelSize =
              Number.isFinite(referencePixelSizeRaw) &&
              referencePixelSizeRaw > 0
                ? referencePixelSizeRaw
                : 1;

            const emitted = new Set<string>();
            forEachVisibleVolumetricChunk(
              projectionParameters,
              this.localPosition.value,
              anchor.tsource,
              (anchorPosInChunks) => {
                tempArbitrationChunkCenterWorld[0] =
                  (anchorPosInChunks[0] + 0.5) *
                  anchor.tsource.chunkLayout.size[0];
                tempArbitrationChunkCenterWorld[1] =
                  (anchorPosInChunks[1] + 0.5) *
                  anchor.tsource.chunkLayout.size[1];
                tempArbitrationChunkCenterWorld[2] =
                  (anchorPosInChunks[2] + 0.5) *
                  anchor.tsource.chunkLayout.size[2];
                vec3.transformMat4(
                  tempArbitrationChunkCenterWorld,
                  tempArbitrationChunkCenterWorld,
                  anchor.tsource.chunkLayout.transform,
                );

                const chunkPixelSize =
                  computePhysicalUnitsPerScreenPixelAtPoint(
                    projectionParameters.viewProjectionMat,
                    projectionParameters.width,
                    projectionParameters.height,
                    tempArbitrationChunkCenterWorld,
                    projectionParameters.displayDimensionRenderInfo
                      ?.displayDimensionScales,
                  );
                const desiredSpacingRaw =
                  Number.isFinite(chunkPixelSize) && chunkPixelSize > 0
                    ? targetSpacingMeters *
                      (chunkPixelSize / referencePixelSize)
                    : targetSpacingMeters;
                const desiredSpacing =
                  quantizeSpacingForArbitration(desiredSpacingRaw);

                const candidatesByDesired = [...orderedCandidates].sort(
                  (a, b) => {
                    const da = Math.abs(spacingMeters(a) - desiredSpacing);
                    const db = Math.abs(spacingMeters(b) - desiredSpacing);
                    if (da !== db) return da - db;
                    return a.scaleIndex - b.scaleIndex;
                  },
                );

                let selected:
                  | {
                      tsource: TransformedSource<
                        SpatiallyIndexedSkeletonRenderLayerBackend,
                        SpatiallyIndexedSkeletonSourceBackend
                      >;
                      scaleIndex: number;
                      position: Float32Array;
                      key: string;
                    }
                  | undefined;
                for (const candidate of candidatesByDesired) {
                  if (
                    !getChunkGridPositionForWorldPoint(
                      candidate.tsource,
                      tempArbitrationChunkCenterWorld,
                      tempArbitrationCandidateChunkPos,
                    )
                  ) {
                    continue;
                  }
                  const key = `${tempArbitrationCandidateChunkPos.join()}:${lodValue}`;
                  const state = candidate.tsource.source.chunks.get(key)?.state;
                  // A failed candidate should not block fallback to the next
                  // ranked level, but loaded/system/queued candidates remain
                  // valid so target levels are still actively requested.
                  if (state === ChunkState.FAILED) {
                    continue;
                  }
                  const pos = vec3.fromValues(
                    tempArbitrationCandidateChunkPos[0],
                    tempArbitrationCandidateChunkPos[1],
                    tempArbitrationCandidateChunkPos[2],
                  );
                  selected = {
                    tsource: candidate.tsource,
                    scaleIndex: candidate.scaleIndex,
                    position: pos,
                    key,
                  };
                  break;
                }
                if (selected === undefined) {
                  return;
                }
                const emitKey = `${getObjectId(selected.tsource.source)}|${selected.key}`;
                if (emitted.has(emitKey)) {
                  return;
                }
                emitted.add(emitKey);

                const source = selected.tsource.source;
                source.currentLod = lodValue;
                source.currentRequestGeneration = currentGeneration;
                source.currentRequestOwner =
                  SpatiallyIndexedSkeletonChunkRequestOwner.VIEW_3D;

                const { chunkLayout } = selected.tsource;
                chunkLayout.globalToLocalSpatial(
                  localCenter,
                  centerDataPosition,
                );
                const { size, finiteRank } = chunkLayout;
                vec3.copy(chunkSize, size);
                for (let i = finiteRank; i < 3; ++i) {
                  chunkSize[i] = 0;
                  localCenter[i] = 0;
                }

                const chunk = source.getChunk(selected.position);
                ++this.numVisibleChunksNeeded;
                if (chunk.state === ChunkState.GPU_MEMORY) {
                  ++this.numVisibleChunksAvailable;
                }
                chunkManager.requestChunk(
                  chunk,
                  priorityTier,
                  getSpatiallyIndexedSkeletonRenderPriority(
                    basePriority,
                    selected.scaleIndex,
                    localCenter,
                    chunkSize,
                    selected.position,
                  ),
                );
              },
            );
            continue;
          }
        }

        const selectedScales = selectScales(scales);
        for (const { tsource, scaleIndex } of selectedScales) {
          const source =
            tsource.source as SpatiallyIndexedSkeletonSourceBackend;
          const { chunkLayout } = tsource;
          chunkLayout.globalToLocalSpatial(localCenter, centerDataPosition);
          const { size, finiteRank } = chunkLayout;
          vec3.copy(chunkSize, size);
          for (let i = finiteRank; i < 3; ++i) {
            chunkSize[i] = 0;
            localCenter[i] = 0;
          }
          source.currentLod = lodValue;
          source.currentRequestGeneration = currentGeneration;
          source.currentRequestOwner = is2dView
            ? SpatiallyIndexedSkeletonChunkRequestOwner.VIEW_2D
            : SpatiallyIndexedSkeletonChunkRequestOwner.VIEW_3D;
          forEachVisibleVolumetricChunk(
            projectionParameters,
            this.localPosition.value,
            tsource,
            () => {
              const chunk = source.getChunk(tsource.curPositionInChunks);
              ++this.numVisibleChunksNeeded;
              if (chunk.state === ChunkState.GPU_MEMORY) {
                ++this.numVisibleChunksAvailable;
              }
              chunkManager.requestChunk(
                chunk,
                priorityTier,
                getSpatiallyIndexedSkeletonRenderPriority(
                  basePriority,
                  scaleIndex,
                  localCenter,
                  chunkSize,
                  tsource.curPositionInChunks,
                ),
              );
            },
          );
        }
      }
    }
  }
}
