/**
 * @license
 * Copyright 2018 The Neuroglancer Authors
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

import debounce from 'lodash/debounce';
import {withChunkManager, Chunk, ChunkSource} from 'neuroglancer/chunk_manager/backend';
import {ChunkPriorityTier, ChunkState} from 'neuroglancer/chunk_manager/base';
import {TransformedSource, forEachPlaneIntersectingVolumetricChunk, getNormalizedChunkLayout, SliceViewProjectionParameters} from 'neuroglancer/sliceview/base';
import {CHUNKED_GRAPH_LAYER_RPC_ID, ChunkedGraphChunkSource as ChunkedGraphChunkSourceInterface, ChunkedGraphChunkSpecification, CHUNKED_GRAPH_RENDER_LAYER_UPDATE_SOURCES_RPC_ID, RENDER_RATIO_LIMIT} from 'neuroglancer/sliceview/chunked_graph/base';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {vec3, vec3Key} from 'neuroglancer/util/geom';
import {Uint64} from 'neuroglancer/util/uint64';
import {registerRPC, registerSharedObject, RPC} from 'neuroglancer/worker_rpc';

import * as vector from 'neuroglancer/util/vector';
import { deserializeTransformedSources, SliceViewChunkSourceBackend } from 'neuroglancer/sliceview/backend';
import { getBasePriority, getPriorityTier, withSharedVisibility } from 'neuroglancer/visibility_priority/backend';
import {isBaseSegmentId} from 'neuroglancer/datasource/graphene/base';
import { withSegmentationLayerBackendState } from 'neuroglancer/segmentation_display_state/backend';
import { RenderedViewBackend, RenderLayerBackend, RenderLayerBackendAttachment } from 'neuroglancer/render_layer_backend';
import { SharedWatchableValue } from 'neuroglancer/shared_watchable_value';
import { DisplayDimensionRenderInfo } from 'neuroglancer/navigation_state';

export class ChunkedGraphChunk extends Chunk {
  backendOnly = true;
  chunkGridPosition: Float32Array;
  source: ChunkedGraphChunkSource|null = null;
  segment: Uint64;
  leaves: Uint64[] = [];
  chunkDataSize: Uint32Array|null;
  
  constructor() {
    super();
  }

  initializeVolumeChunk(key: string, chunkGridPosition: Float32Array) {
    super.initialize(key);
    this.chunkGridPosition = Float32Array.from(chunkGridPosition);
  }

  initializeChunkedGraphChunk(key: string, chunkGridPosition: Float32Array, segment: Uint64) {
    this.initializeVolumeChunk(key, chunkGridPosition);
    this.chunkDataSize = null;
    this.systemMemoryBytes = 16;
    this.gpuMemoryBytes = 0;
    this.segment = segment;
  }

  downloadSucceeded() {
    this.systemMemoryBytes = 16; // this.segment
    this.systemMemoryBytes += 16 * this.leaves.length;
    this.queueManager.updateChunkState(this, ChunkState.SYSTEM_MEMORY_WORKER);
    if (this.priorityTier < ChunkPriorityTier.RECENT) {
      this.source!.chunkManager.scheduleUpdateChunkPriorities();
    }
    super.downloadSucceeded();
  }

  freeSystemMemory() {
    this.leaves = [];
  }
}

export function decodeSupervoxelArray(leaves: string[]) {
  const final: Uint64[] = new Array(leaves.length);
  for (let i = 0; i < final.length; ++i) {
    final[i] = Uint64.parseString(leaves[i]);
  }
  return final;
}

export class ChunkedGraphChunkSource extends ChunkSource implements
    ChunkedGraphChunkSourceInterface {
  spec: ChunkedGraphChunkSpecification;
  chunks: Map<string, ChunkedGraphChunk>;

  private tempChunkDataSize: Uint32Array;
  private tempChunkPosition: Float32Array;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.spec = options.spec;
    const rank = this.spec.rank;
    this.tempChunkDataSize = new Uint32Array(rank);
    this.tempChunkPosition = new Float32Array(rank);
  }

  getChunk(chunkGridPosition: Float32Array, segment: Uint64) {
    const key = `${vec3Key(chunkGridPosition)}-${segment}`;
    let chunk = <ChunkedGraphChunk>this.chunks.get(key);

    if (chunk === undefined) {
      chunk = this.getNewChunk_(ChunkedGraphChunk);
      chunk.initializeChunkedGraphChunk(key, chunkGridPosition, segment);
      this.addChunk(chunk);
    }
    return chunk;
  }

  /**
   * Helper function for computing the voxel bounds of a chunk based on its chunkGridPosition.
   *
   * This assumes that the grid of chunk positions starts at this.baseVoxelOffset.  Chunks are
   * clipped to lie within upperVoxelBound, but are not clipped to lie within lowerVoxelBound.  (The
   * frontend code currently cannot handle chunks clipped at their lower corner, and the chunk
   * layout can generally be chosen so that lowerVoxelBound lies on a chunk boundary.)
   *
   * This sets chunk.chunkDataSize to a copy of the returned chunkDataSize if it differs from
   * this.spec.chunkDataSize; otherwise, it is set to this.spec.chunkDataSize.
   *
   * @returns A globally-allocated Vec3 containing the chunk corner position in voxel coordinates.
   * The returned Vec3 will be invalidated by any subsequent call to this method, even on a
   * different VolumeChunkSource instance.
   */
  computeChunkBounds(chunk: ChunkedGraphChunk) {
    const {spec} = this;
    const {upperVoxelBound} = spec;

    let origChunkDataSize = spec.chunkDataSize;
    let newChunkDataSize = this.tempChunkDataSize;

    // Chunk start position in voxel coordinates.
    let chunkPosition =
        vector.multiply(this.tempChunkPosition, chunk.chunkGridPosition, origChunkDataSize);

    // Specifies whether the chunk only partially fits within the data bounds.
    let partial = false;
    for (let i = 0; i < 3; ++i) {
      let upper = Math.min(upperVoxelBound[i], chunkPosition[i] + origChunkDataSize[i]);
      let size = newChunkDataSize[i] = upper - chunkPosition[i];
      if (size !== origChunkDataSize[i]) {
        partial = true;
      }
    }

    vector.add(chunkPosition, chunkPosition, this.spec.baseVoxelOffset);

    if (partial) {
      chunk.chunkDataSize = Uint32Array.from(newChunkDataSize);
    } else {
      chunk.chunkDataSize = origChunkDataSize;
    }

    return chunkPosition;
  }
}

interface ChunkedGraphRenderLayerAttachmentState {
  displayDimensionRenderInfo: DisplayDimensionRenderInfo;
  transformedSource?: TransformedSource<
      ChunkedGraphLayer, ChunkedGraphChunkSource>;
}

registerRPC(CHUNKED_GRAPH_RENDER_LAYER_UPDATE_SOURCES_RPC_ID, function(x) {
  const view = this.get(x.view) as RenderedViewBackend;
  const layer = this.get(x.layer) as ChunkedGraphLayer;
  const attachment = layer.attachments.get(view)! as
      RenderLayerBackendAttachment<RenderedViewBackend, ChunkedGraphRenderLayerAttachmentState>;
  attachment.state!.transformedSource = deserializeTransformedSources<
      SliceViewChunkSourceBackend, ChunkedGraphLayer>(
      this, x.sources, layer)[0][0] as unknown as TransformedSource<
      ChunkedGraphLayer, ChunkedGraphChunkSource>;
  attachment.state!.displayDimensionRenderInfo = x.displayDimensionRenderInfo;
  layer.chunkManager.scheduleUpdateChunkPriorities();
});

const tempChunkPosition = vec3.create();
const tempCenter = vec3.create();
const tempChunkSize = vec3.create();

@registerSharedObject(CHUNKED_GRAPH_LAYER_RPC_ID)
export class ChunkedGraphLayer extends withSegmentationLayerBackendState
(withSharedVisibility(withChunkManager(RenderLayerBackend))) {
  source: ChunkedGraphChunkSource;
  localPosition: SharedWatchableValue<Float32Array>;
  leafRequestsActive: SharedWatchableValue<boolean>;
  nBitsForLayerId: SharedWatchableValue<number>;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.source = this.registerDisposer(rpc.getRef<ChunkedGraphChunkSource>(options['source']));
    this.localPosition = rpc.get(options.localPosition);
    this.leafRequestsActive = rpc.get(options.leafRequestsActive);
    this.nBitsForLayerId = rpc.get(options.nBitsForLayerId);

    this.registerDisposer(this.chunkManager.recomputeChunkPriorities.add(() => {
      this.updateChunkPriorities();
      this.debouncedupdateDisplayState();
    }));
  }

  attach(attachment: RenderLayerBackendAttachment<RenderedViewBackend, ChunkedGraphRenderLayerAttachmentState>): void {
    const scheduleUpdateChunkPriorities = () => this.chunkManager.scheduleUpdateChunkPriorities();
    const {view} = attachment;
    attachment.registerDisposer(scheduleUpdateChunkPriorities);
    attachment.registerDisposer(
        view.projectionParameters.changed.add(scheduleUpdateChunkPriorities));
    attachment.registerDisposer(view.visibility.changed.add(scheduleUpdateChunkPriorities));
    attachment.state = {
      displayDimensionRenderInfo: view.projectionParameters.value.displayDimensionRenderInfo,
    };
  }

  // Used for the sliceview to set a limit on when to
  // make get_leaves to the ChunkedGraph
  get renderRatioLimit() {
    return RENDER_RATIO_LIMIT;
  }

  private updateChunkPriorities() {
    const {source, chunkManager} = this;
    chunkManager.registerLayer(this);
    for (const attachment of this.attachments.values()) {
      const {view} = attachment;
      const visibility = view.visibility.value;
      if (visibility === Number.NEGATIVE_INFINITY) {
        continue;
      }

      const attachmentState = attachment.state! as ChunkedGraphRenderLayerAttachmentState;
      const {transformedSource: tsource} = attachmentState;
      const projectionParameters = view.projectionParameters.value as SliceViewProjectionParameters;

      if (!tsource) {
        continue;
      }

      const pixelSize = projectionParameters.pixelSize * 1.1;
      const smallestVoxelSize = tsource.effectiveVoxelSize;
      this.leafRequestsActive.value = this.renderRatioLimit >= pixelSize / Math.min(...smallestVoxelSize);
      if (!this.leafRequestsActive.value) {
        continue;
      }

      const priorityTier = getPriorityTier(visibility);
      const basePriority = getBasePriority(visibility);

      const {chunkLayout} = tsource;
      const {size, finiteRank} = chunkLayout;

      const chunkSize = tempChunkSize;
      const localCenter = tempCenter;
      vec3.copy(chunkSize, size);
      for (let i = finiteRank; i < 3; ++i) {
        chunkSize[i] = 0;
        localCenter[i] = 0;
      }
      const {centerDataPosition} = projectionParameters;
      chunkLayout.globalToLocalSpatial(localCenter, centerDataPosition);

      forEachPlaneIntersectingVolumetricChunk(
        projectionParameters, this.localPosition.value, tsource,
        getNormalizedChunkLayout(projectionParameters, chunkLayout),
          positionInChunks => {
        vec3.multiply(tempChunkPosition, positionInChunks, chunkSize);
        const priority = -vec3.distance(localCenter, tempChunkPosition);
        const {curPositionInChunks} = tsource;

        for (const segment of this.visibleSegments) {
          if (isBaseSegmentId(segment, this.nBitsForLayerId.value)) return; // TODO maybe support highBitRepresentation?
          const chunk = source.getChunk(curPositionInChunks, segment);
          chunkManager.requestChunk(chunk, priorityTier, basePriority + priority);
          ++this.numVisibleChunksNeeded;
          if (chunk.state === ChunkState.GPU_MEMORY) {
            ++this.numVisibleChunksAvailable;
          }
        }
      });
    }
  }

  private forEachSelectedRootWithLeaves(
    callback: (rootObjectKey: string, leaves: Uint64[]) => void) {
      const {source} = this;

      for (const chunk of source.chunks.values()) {
        if (chunk.state === ChunkState.SYSTEM_MEMORY_WORKER &&
            chunk.priorityTier < ChunkPriorityTier.RECENT) {
          if (this.visibleSegments.has(chunk.segment) && chunk.leaves.length) {
            callback(chunk.segment.toString(), chunk.leaves);
          }
        }
      }
  }

  private debouncedupdateDisplayState = debounce(() => {
    this.updateDisplayState();
  }, 100);

  private updateDisplayState() {
    const visibleLeaves = new Map<string, Uint64Set>();
    const capacities = new Map<string, number>();

    // Reserve
    this.forEachSelectedRootWithLeaves((rootObjectKey, leaves) => {
      if (!capacities.has(rootObjectKey)) {
        capacities.set(rootObjectKey, leaves.length);
      } else {
        capacities.set(rootObjectKey, capacities.get(rootObjectKey)! + leaves.length);
      }
    });

    // Collect unique leaves
    this.forEachSelectedRootWithLeaves((rootObjectKey, leaves) => {
      if (!visibleLeaves.has(rootObjectKey)) {
        visibleLeaves.set(rootObjectKey, new Uint64Set());
        visibleLeaves.get(rootObjectKey)!.reserve(capacities.get(rootObjectKey)!);
        visibleLeaves.get(rootObjectKey)!.add(Uint64.parseString(rootObjectKey));
      }
      visibleLeaves.get(rootObjectKey)!.add(leaves);
    });

    for (const [root, leaves] of visibleLeaves) {      
      // TODO: Delete segments not visible anymore from segmentEquivalences - requires a faster data
      // structure, though.

      /*if (this.segmentEquivalences.has(Uint64.parseString(root))) {
        this.segmentEquivalences.delete([...this.segmentEquivalences.setElements(Uint64.parseString(root))].filter(x
      => !leaves.has(x) && !this.visibleSegments.has(x)));
      }*/
      const filteredLeaves = [...leaves].filter(x => !this.segmentEquivalences.has(x));

      const rootInt = Uint64.parseString(root);

      for (const leaf of filteredLeaves) {
        this.segmentEquivalences.link(rootInt, leaf);
      }
    }
  }
}
