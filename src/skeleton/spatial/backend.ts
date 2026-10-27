/**
 * @license
 * Copyright 2026 Google Inc.
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

/**
 * @file Downloads the visible chunks of the selected spatial index level for
 * each view and packs their nodes into vertex, edge and ID arrays. It runs on
 * the chunk worker.
 */

import { withChunkManager } from "#src/chunk_manager/backend.js";
import { ChunkState } from "#src/chunk_manager/base.js";
import {
  type DisplayDimensionRenderInfo,
  validateDisplayDimensionRenderInfoProperty,
} from "#src/navigation_state.js";
import type {
  RenderLayerBackendAttachment,
  RenderedViewBackend,
} from "#src/render_layer_backend.js";
import { RenderLayerBackend } from "#src/render_layer_backend.js";
import type { SharedWatchableValue } from "#src/shared_watchable_value.js";
import type {
  SkeletonNode,
  SkeletonSpatialIndexSource,
} from "#src/skeleton/api.js";
import {
  freeSkeletonChunkSystemMemory,
  getVertexAttributeBytes,
  serializeSkeletonChunkData,
  type SkeletonChunkData,
} from "#src/skeleton/chunk_serialization.js";
import {
  forEachVisibleSpatialSkeletonChunk,
  type SpatiallyIndexedSkeletonChunkSpecification,
  SPATIALLY_INDEXED_SKELETON_RENDER_LAYER_RPC_ID,
  SPATIALLY_INDEXED_SKELETON_RENDER_LAYER_UPDATE_SOURCES_RPC_ID,
} from "#src/skeleton/spatial/base.js";
import {
  deserializeTransformedSources,
  SCALE_PRIORITY_MULTIPLIER,
  SliceViewChunk,
  SliceViewChunkSourceBackend,
} from "#src/sliceview/backend.js";
import { type TransformedSource } from "#src/sliceview/base.js";
import type { TypedNumberArray } from "#src/util/array.js";
import { vec3 } from "#src/util/geom.js";
import {
  getBasePriority,
  getPriorityTier,
} from "#src/visibility_priority/backend.js";

import type { RPC } from "#src/worker_rpc.js";
import { registerRPC, registerSharedObject } from "#src/worker_rpc.js";

const tempCenter = vec3.create();
const tempChunkSize = vec3.create();
const tempCenterDataPosition = vec3.create();

function distanceToChunk(
  localCenter: Float32Array,
  chunkSize: Float32Array,
  positionInChunks: Float32Array,
) {
  let distanceSq = 0;
  for (let i = 0; i < 3; ++i) {
    const delta = localCenter[i] - positionInChunks[i] * chunkSize[i];
    distanceSq += delta * delta;
  }
  return Math.sqrt(distanceSq);
}

function disposeTransformedSources(allSources: readonly TransformedSource[][]) {
  for (const scales of allSources) {
    for (const tsource of scales) {
      tsource.source.dispose();
    }
  }
}

registerRPC(
  SPATIALLY_INDEXED_SKELETON_RENDER_LAYER_UPDATE_SOURCES_RPC_ID,
  function (x) {
    const view: RenderedViewBackend = this.get(x.view);
    const layer = this.get(
      x.layer,
    ) as SpatiallyIndexedSkeletonRenderLayerBackend;
    const attachment = layer.attachments.get(
      view,
    )! as RenderLayerBackendAttachment<
      RenderedViewBackend,
      SpatiallyIndexedSkeletonRenderLayerAttachmentState
    >;
    const previousSources = attachment.state!.transformedSources;
    attachment.state!.transformedSources = deserializeTransformedSources<
      SpatiallyIndexedSkeletonSourceBackend,
      any
    >(this, x.sources, layer);
    disposeTransformedSources(previousSources);
    attachment.state!.displayDimensionRenderInfo = x.displayDimensionRenderInfo;
    layer.chunkManager.scheduleUpdateChunkPriorities();
  },
);

export class SpatiallyIndexedSkeletonChunk
  extends SliceViewChunk
  implements SkeletonChunkData
{
  vertexPositions: Float32Array | null = null;
  vertexAttributes: TypedNumberArray[] | null = null;
  indices: Uint32Array | null = null;
  nodeIds: BigUint64Array | undefined;
  segmentIds: BigUint64Array | undefined;

  freeSystemMemory() {
    freeSkeletonChunkSystemMemory(this);
  }

  serialize(msg: any, transfers: any[]) {
    super.serialize(msg, transfers);
    serializeSkeletonChunkData(this, msg, transfers);
    freeSkeletonChunkSystemMemory(this);
  }

  downloadSucceeded() {
    this.gpuMemoryBytes =
      this.indices!.byteLength +
      getVertexAttributeBytes(this) +
      this.segmentIds!.byteLength;
    this.systemMemoryBytes = this.gpuMemoryBytes + this.nodeIds!.byteLength;
    super.downloadSucceeded();
  }
}

function packSpatiallyIndexedSkeletonNodes(
  chunk: SpatiallyIndexedSkeletonChunk,
  nodes: readonly SkeletonNode[],
) {
  const numVertices = nodes.length;
  const vertexPositions = new Float32Array(numVertices * 3);
  const segmentIds = new BigUint64Array(numVertices);
  const nodeIds = new BigUint64Array(numVertices);
  // Node ids may repeat across segments.
  const vertexIndexBySegmentAndNodeId = new Map<bigint, Map<bigint, number>>();
  for (let vertexIndex = 0; vertexIndex < numVertices; ++vertexIndex) {
    const node = nodes[vertexIndex];
    let vertexIndexByNodeId = vertexIndexBySegmentAndNodeId.get(node.segmentId);
    if (vertexIndexByNodeId === undefined) {
      vertexIndexByNodeId = new Map();
      vertexIndexBySegmentAndNodeId.set(node.segmentId, vertexIndexByNodeId);
    }
    vertexIndexByNodeId.set(node.nodeId, vertexIndex);
    nodeIds[vertexIndex] = node.nodeId;
    segmentIds[vertexIndex] = node.segmentId;
    vertexPositions[vertexIndex * 3] = node.position[0];
    vertexPositions[vertexIndex * 3 + 1] = node.position[1];
    vertexPositions[vertexIndex * 3 + 2] = node.position[2];
  }
  const indices: number[] = [];
  for (let vertexIndex = 0; vertexIndex < numVertices; ++vertexIndex) {
    const { segmentId, parentNodeId } = nodes[vertexIndex];
    if (parentNodeId === undefined) continue;
    const parentVertexIndex = vertexIndexBySegmentAndNodeId
      .get(segmentId)!
      .get(parentNodeId);
    if (parentVertexIndex !== undefined) {
      indices.push(vertexIndex, parentVertexIndex);
    }
  }
  chunk.vertexPositions = vertexPositions;
  chunk.indices = new Uint32Array(indices);
  chunk.nodeIds = nodeIds;
  chunk.segmentIds = segmentIds;
}

// Mixins do not accept abstract classes, so subclasses supply downloadChunk through this interface.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging, @typescript-eslint/no-empty-object-type
export interface SpatiallyIndexedSkeletonSourceBackend
  extends SkeletonSpatialIndexSource {}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class SpatiallyIndexedSkeletonSourceBackend extends SliceViewChunkSourceBackend<
  SpatiallyIndexedSkeletonChunkSpecification,
  SpatiallyIndexedSkeletonChunk
> {
  chunkConstructor = SpatiallyIndexedSkeletonChunk;

  async download(chunk: SpatiallyIndexedSkeletonChunk, signal: AbortSignal) {
    const nodes = await this.downloadChunk(chunk.chunkGridPosition, signal);
    packSpatiallyIndexedSkeletonNodes(chunk, nodes);
  }
}

interface SpatiallyIndexedSkeletonRenderLayerAttachmentState {
  displayDimensionRenderInfo: DisplayDimensionRenderInfo;
  transformedSources: TransformedSource<
    any,
    SpatiallyIndexedSkeletonSourceBackend
  >[][];
}

@registerSharedObject(SPATIALLY_INDEXED_SKELETON_RENDER_LAYER_RPC_ID)
export class SpatiallyIndexedSkeletonRenderLayerBackend extends withChunkManager(
  RenderLayerBackend,
) {
  localPosition: SharedWatchableValue<Float32Array>;
  spacingTarget: SharedWatchableValue<number>;
  browseChunksNeeded: SharedWatchableValue<boolean>;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.spacingTarget = rpc.get(options.spacingTarget);
    this.localPosition = rpc.get(options.localPosition);
    this.browseChunksNeeded = rpc.get(options.browseChunksNeeded);
    const scheduleUpdateChunkPriorities = () =>
      this.chunkManager.scheduleUpdateChunkPriorities();
    this.registerDisposer(
      this.localPosition.changed.add(scheduleUpdateChunkPriorities),
    );
    this.registerDisposer(
      this.spacingTarget.changed.add(scheduleUpdateChunkPriorities),
    );
    this.registerDisposer(
      this.browseChunksNeeded.changed.add(scheduleUpdateChunkPriorities),
    );
    this.registerDisposer(
      this.chunkManager.recomputeChunkPriorities.add(() =>
        this.recomputeChunkPriorities(),
      ),
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
    attachment.registerDisposer(() =>
      disposeTransformedSources(attachment.state!.transformedSources),
    );
  }

  private recomputeChunkPriorities() {
    if (!this.browseChunksNeeded.value) {
      return;
    }
    this.chunkManager.registerLayer(this);
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
      const basePriority = getBasePriority(visibility);
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
      const spacingTarget = this.spacingTarget.value;
      for (const scales of transformedSources) {
        forEachVisibleSpatialSkeletonChunk(
          projectionParameters,
          this.localPosition.value,
          spacingTarget,
          scales,
          () => {},
          (tsource, scaleIndex) => {
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
            const chunk = source.getChunk(tsource.curPositionInChunks);
            ++this.numVisibleChunksNeeded;
            if (chunk.state === ChunkState.GPU_MEMORY) {
              ++this.numVisibleChunksAvailable;
            }
            chunkManager.requestChunk(
              chunk,
              priorityTier,
              basePriority +
                SCALE_PRIORITY_MULTIPLIER * scaleIndex -
                distanceToChunk(
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
