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
import {withChunkManager, ChunkRenderLayerBackend, Chunk, ChunkSource} from 'neuroglancer/chunk_manager/backend';
import {ChunkPriorityTier, ChunkState} from 'neuroglancer/chunk_manager/base';
import {SharedDisjointUint64Sets} from 'neuroglancer/shared_disjoint_sets';
import {SliceViewRenderLayer as SliceViewRenderLayerInterface, filterVisibleSources, SliceViewBase, TransformedSource, SliceViewChunkSpecification, forEachPlaneIntersectingVolumetricChunk, getNormalizedChunkLayout, SliceViewProjectionParameters} from 'neuroglancer/sliceview/base';
import {CHUNKED_GRAPH_LAYER_RPC_ID, ChunkedGraphChunkSource as ChunkedGraphChunkSourceInterface, ChunkedGraphChunkSpecification, RENDER_RATIO_LIMIT} from 'neuroglancer/sliceview/chunked_graph/base';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {vec3, vec3Key} from 'neuroglancer/util/geom';
import {Uint64} from 'neuroglancer/util/uint64';
import {registerSharedObject, RPC, SharedObjectCounterpart} from 'neuroglancer/worker_rpc';
import {WatchableValueInterface} from 'neuroglancer/trackable_value';

import * as vector from 'neuroglancer/util/vector';
import { SliceViewChunk, SliceViewChunkSourceBackend, SliceViewRenderLayerBackend } from '../backend';
import { getBasePriority, getPriorityTier } from 'neuroglancer/visibility_priority/backend';
import {isBaseSegmentId} from 'neuroglancer/datasource/graphene/base';

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

const Base = withChunkManager(SharedObjectCounterpart);

@registerSharedObject(CHUNKED_GRAPH_LAYER_RPC_ID)
export class ChunkedGraphLayer extends Base implements // based on SliceViewRenderLayerBackend
    SliceViewRenderLayerInterface, ChunkRenderLayerBackend {
  rpcId: number;
  renderScaleTarget: WatchableValueInterface<number>;
  localPosition: WatchableValueInterface<Float32Array>;

  graphurl: string;
  visibleSegments: Uint64Set;
  segmentEquivalences: SharedDisjointUint64Sets;

  numVisibleChunksNeeded: number;
  numVisibleChunksAvailable: number;
  numPrefetchChunksNeeded: number;
  numPrefetchChunksAvailable: number;
  chunkManagerGeneration: number;


  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.graphurl = options['url'];
    this.visibleSegments = <Uint64Set>rpc.get(options['visibleSegments']);
    this.segmentEquivalences = <SharedDisjointUint64Sets>rpc.get(options['segmentEquivalences']);
    
    
    this.renderScaleTarget = rpc.get(options.renderScaleTarget);
    this.localPosition = rpc.get(options.localPosition);

    // no longer needed?
    // this.registerDisposer(this.visibleSegments.changed.add(() => {
    //   this.chunkManager.scheduleUpdateChunkPriorities();
    // }));

    this.registerDisposer(this.chunkManager.recomputeChunkPriorities.add(() => {
      this.debouncedupdateDisplayState();
    }));

    this.numVisibleChunksNeeded = 0;
    this.numVisibleChunksAvailable = 0;
    this.numPrefetchChunksAvailable = 0;
    this.numPrefetchChunksNeeded = 0;
    this.chunkManagerGeneration = -1;
  }

  sources: ChunkedGraphChunkSource[] = [];

  filterVisibleSources(sliceView: SliceViewBase, sources: readonly TransformedSource[]):
      Iterable<TransformedSource> {
    // If the pixel nm size in the slice is bigger than the smallest dimension of the
    // highest resolution voxel size (e.g. 4nm if the highest res is 4x4x40nm) by
    // a certain ratio (right now semi-arbitarily set as a constant in chunked_graph/base.ts)
    // we do not request the ChunkedGraph for root -> supervoxel mappings, and
    // instead display a message to the user

    // using similar logic as in sliceview/base.ts filterVisibleSources
    const pixelSize = sliceView.projectionParameters.value.pixelSize * 1.1;
    const smallestVoxelSize = sources[0].effectiveVoxelSize;
    if (this.renderRatioLimit < pixelSize / Math.min(...smallestVoxelSize)) {
      sources = [];
    }

    // TODO filterVisibleSources isn't always called before the first updateDisplayState (when initially adding a graphene layer)
    const filteredSources = filterVisibleSources(sliceView, this, sources);
    this.sources = [];
    for (let source of filteredSources) {
      this.sources.push(source.source as ChunkedGraphChunkSource);
    }

    // return filteredSources;
    return filterVisibleSources(sliceView, this, sources); // SUPER HACKY
    // using this function so I can access ChunkedGraphChunkSource in forEachSelectedRootWithLeaves
    // have to run filterVisibleSources twice because otherwise the generator won't spit out results in the calling function
  }

  get url() {
    return this.graphurl;
  }

  // Used for the sliceview to set a limit on when to
  // make get_leaves to the ChunkedGraph
  get renderRatioLimit() {
    return RENDER_RATIO_LIMIT;
  }

  private debouncedupdateDisplayState = debounce(() => {
    this.updateDisplayState();
  }, 100);

  private forEachSelectedRootWithLeaves(
    callback: (rootObjectKey: string, leaves: Uint64[]) => void) {
      callback;

    for (const source of this.sources) {
      for (const chunk of source.chunks.values()) {
        if (chunk.state === ChunkState.SYSTEM_MEMORY_WORKER &&
            chunk.priorityTier < ChunkPriorityTier.RECENT) {
          if (this.visibleSegments.has(chunk.segment) && chunk.leaves.length) {
            callback(chunk.segment.toString(), chunk.leaves);
          }
        }
      }
    }
  }

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

const tempChunkPosition = vec3.create();
const tempCenter = vec3.create();
const tempChunkSize = vec3.create();

export const handleChunkedGraphLayer = (layer: ChunkedGraphLayer, sources: TransformedSource<SliceViewRenderLayerBackend, SliceViewChunkSourceBackend<SliceViewChunkSpecification<Uint32Array | Float32Array>, SliceViewChunk>>[],
    projectionParameters: SliceViewProjectionParameters,
    visibility: number) => {

  if (sources.length > 1) {
    console.error('we have more than 1 source!', sources);
  }
  const tsource = sources[0];

  const localCenter = tempCenter;
  const {centerDataPosition} = projectionParameters;

  const {chunkLayout} = tsource;
  chunkLayout.globalToLocalSpatial(localCenter, centerDataPosition);
  const {size, finiteRank} = chunkLayout;

  const chunkSize = tempChunkSize;

  vec3.copy(chunkSize, size);
  for (let i = finiteRank; i < 3; ++i) {
    chunkSize[i] = 0;
    localCenter[i] = 0;
  }

  const {chunkManager} = layer;

  const priorityTier = getPriorityTier(visibility);
  let basePriority = getBasePriority(visibility);

  const sourceBasePriority = basePriority; // since we only have 1 source

  forEachPlaneIntersectingVolumetricChunk(
    projectionParameters, tsource.renderLayer.localPosition.value, tsource,
    getNormalizedChunkLayout(projectionParameters, tsource.chunkLayout),
    positionInChunks => {
      vec3.multiply(tempChunkPosition, positionInChunks, chunkSize);
      let priority = -vec3.distance(localCenter, tempChunkPosition);
      const {curPositionInChunks} = tsource;
      const source = tsource.source as unknown as  ChunkedGraphChunkSource;

      for (const segment of layer.visibleSegments) {
        if (isBaseSegmentId(segment, 8)) return; // TODO this.source.info.nBitsPerLayer, also may need to look at highBitRepresentaiton
        let chunk = source.getChunk(curPositionInChunks, segment);
        chunkManager.requestChunk(chunk, priorityTier, sourceBasePriority + priority);
        ++layer.numVisibleChunksNeeded;
        if (chunk.state === ChunkState.GPU_MEMORY) {
          ++layer.numVisibleChunksAvailable;
        }
      }

        
      // curVisibleChunks.push(chunk);
      // Mark visible chunks to avoid duplicate work when prefetching.  Once we hit a
      // visible chunk, we don't continue prefetching in the same direction.
      // chunk.markGeneration = curMarkGeneration;
    });
}
