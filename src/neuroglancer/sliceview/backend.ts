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

import 'neuroglancer/render_layer_backend';

import {Chunk, ChunkConstructor, ChunkRenderLayerBackend, ChunkSource, getNextMarkGeneration, withChunkManager} from 'neuroglancer/chunk_manager/backend';
import {ChunkPriorityTier, ChunkState} from 'neuroglancer/chunk_manager/base';
import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value';
import {filterVisibleSources, forEachPlaneIntersectingVolumetricChunk, getNormalizedChunkLayout, MultiscaleVolumetricDataRenderLayer, SLICEVIEW_ADD_VISIBLE_LAYER_RPC_ID, SLICEVIEW_REMOVE_VISIBLE_LAYER_RPC_ID, SLICEVIEW_RENDERLAYER_RPC_ID, SLICEVIEW_REQUEST_CHUNK_RPC_ID, SLICEVIEW_RPC_ID, SliceViewBase, SliceViewChunkSource as SliceViewChunkSourceInterface, SliceViewChunkSpecification, SliceViewRenderLayer as SliceViewRenderLayerInterface, TransformedSource} from 'neuroglancer/sliceview/base';
import {ChunkLayout} from 'neuroglancer/sliceview/chunk_layout';
import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {CANCELED, CancellationToken} from 'neuroglancer/util/cancellation';
import {erf} from 'neuroglancer/util/erf';
import {vec3, vec3Key} from 'neuroglancer/util/geom';
import {VelocityEstimator} from 'neuroglancer/util/velocity_estimation';
import {getBasePriority, getPriorityTier, withSharedVisibility} from 'neuroglancer/visibility_priority/backend';
import {registerPromiseRPC, registerRPC, registerSharedObject, RPC, RPCPromise, SharedObjectCounterpart} from 'neuroglancer/worker_rpc';

export const BASE_PRIORITY = -1e12;
export const SCALE_PRIORITY_MULTIPLIER = 1e9;

// Temporary values used by SliceView.updateVisibleChunk
const tempChunkPosition = vec3.create();
const tempCenter = vec3.create();
const tempChunkSize = vec3.create();

class SliceViewCounterpartBase extends
    SliceViewBase<SliceViewChunkSourceBackend, SliceViewRenderLayerBackend> {
  constructor(rpc: RPC, options: any) {
    super(rpc.get(options.projectionParameters));
    this.initializeSharedObject(rpc, options['id']);
  }
}

function disposeTransformedSources(
    allSources: TransformedSource<SliceViewRenderLayerBackend, SliceViewChunkSourceBackend>[][]) {
  for (const scales of allSources) {
    for (const tsource of scales) {
      tsource.source.dispose();
    }
  }
}

const SliceViewIntermediateBase = withSharedVisibility(withChunkManager(SliceViewCounterpartBase));
@registerSharedObject(SLICEVIEW_RPC_ID)
export class SliceViewBackend extends SliceViewIntermediateBase {
  velocityEstimator = new VelocityEstimator();
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.registerDisposer(this.chunkManager.recomputeChunkPriorities.add(() => {
      this.updateVisibleChunks();
    }));
    this.registerDisposer(this.projectionParameters.changed.add(() => {
      this.velocityEstimator.addSample(this.projectionParameters.value.globalPosition);
    }));
  }

  invalidateVisibleChunks() {
    super.invalidateVisibleChunks();
    this.chunkManager.scheduleUpdateChunkPriorities();
  }

  handleLayerChanged = (() => {
    this.chunkManager.scheduleUpdateChunkPriorities();
  });

  updateVisibleChunks() {
    const projectionParameters = this.projectionParameters.value;
    let chunkManager = this.chunkManager;
    const visibility = this.visibility.value;
    if (visibility === Number.NEGATIVE_INFINITY) {
      return;
    }
    this.updateVisibleSources();
    const {centerDataPosition} = projectionParameters;
    const priorityTier = getPriorityTier(visibility);
    let basePriority = getBasePriority(visibility);
    basePriority += BASE_PRIORITY;

    const localCenter = tempCenter;

    const chunkSize = tempChunkSize;

    const curVisibleChunks: SliceViewChunk[] = [];
    this.velocityEstimator.addSample(this.projectionParameters.value.globalPosition);
    for (const [layer, visibleLayerSources] of this.visibleLayers) {
      chunkManager.registerLayer(layer);
      const {visibleSources} = visibleLayerSources;
      for (let i = 0, numVisibleSources = visibleSources.length; i < numVisibleSources; ++i) {
        const tsource = visibleSources[i];
        const prefetchOffsets = chunkManager.queueManager.enablePrefetch.value ?
            getPrefetchChunkOffsets(this.velocityEstimator, tsource) :
            [];
        const {chunkLayout} = tsource;
        chunkLayout.globalToLocalSpatial(localCenter, centerDataPosition);
        const {size, finiteRank} = chunkLayout;
        vec3.copy(chunkSize, size);
        for (let i = finiteRank; i < 3; ++i) {
          chunkSize[i] = 0;
          localCenter[i] = 0;
        }
        const priorityIndex = i;
        const sourceBasePriority = basePriority + SCALE_PRIORITY_MULTIPLIER * priorityIndex;
        curVisibleChunks.length = 0;
        const curMarkGeneration = getNextMarkGeneration();
        forEachPlaneIntersectingVolumetricChunk(
            projectionParameters, tsource.renderLayer.localPosition.value, tsource,
            getNormalizedChunkLayout(projectionParameters, tsource.chunkLayout),
            positionInChunks => {
              vec3.multiply(tempChunkPosition, positionInChunks, chunkSize);
              let priority = -vec3.distance(localCenter, tempChunkPosition);
              const {curPositionInChunks} = tsource;
              let chunk = tsource.source.getChunk(curPositionInChunks);
              chunkManager.requestChunk(chunk, priorityTier, sourceBasePriority + priority);
              ++layer.numVisibleChunksNeeded;
              if (chunk.state === ChunkState.GPU_MEMORY) {
                ++layer.numVisibleChunksAvailable;
              }
              curVisibleChunks.push(chunk);
              // Mark visible chunks to avoid duplicate work when prefetching.  Once we hit a
              // visible chunk, we don't continue prefetching in the same direction.
              chunk.markGeneration = curMarkGeneration;
            });
        if (prefetchOffsets.length !== 0) {
          const {curPositionInChunks} = tsource;
          for (const visibleChunk of curVisibleChunks) {
            curPositionInChunks.set(visibleChunk.chunkGridPosition);
            for (let j = 0, length = prefetchOffsets.length; j < length;) {
              const chunkDim = prefetchOffsets[j];
              const minChunk = prefetchOffsets[j + 2];
              const maxChunk = prefetchOffsets[j + 3];
              const newPriority = prefetchOffsets[j + 4];
              const jumpOffset = prefetchOffsets[j + 5];
              const oldIndex = curPositionInChunks[chunkDim];
              const newIndex = oldIndex + prefetchOffsets[j + 1];
              if (newIndex < minChunk || newIndex > maxChunk) {
                j = jumpOffset;
                continue;
              }
              curPositionInChunks[chunkDim] = newIndex;
              const chunk = tsource.source.getChunk(curPositionInChunks);
              curPositionInChunks[chunkDim] = oldIndex;
              if (chunk.markGeneration === curMarkGeneration) {
                j = jumpOffset;
                continue;
              }
              if (!Number.isFinite(newPriority)) {
                debugger;
              }
              chunkManager.requestChunk(
                  chunk, ChunkPriorityTier.PREFETCH, sourceBasePriority + newPriority);
              ++layer.numPrefetchChunksNeeded;
              if (chunk.state === ChunkState.GPU_MEMORY) {
                ++layer.numPrefetchChunksAvailable;
              }
              j += PREFETCH_ENTRY_SIZE;
            }
          }
        }
      }
    }
  }

  removeVisibleLayer(layer: SliceViewRenderLayerBackend) {
    const {visibleLayers} = this;
    const layerInfo = visibleLayers.get(layer)!;
    visibleLayers.delete(layer);
    disposeTransformedSources(layerInfo.allSources);
    layer.renderScaleTarget.changed.remove(this.invalidateVisibleSources);
    layer.localPosition.changed.remove(this.handleLayerChanged);
    this.invalidateVisibleSources();
  }

  addVisibleLayer(
      layer: SliceViewRenderLayerBackend,
      allSources: TransformedSource<SliceViewRenderLayerBackend, SliceViewChunkSourceBackend>[][]) {
    const {displayDimensionRenderInfo} = this.projectionParameters.value;
    let layerInfo = this.visibleLayers.get(layer);
    if (layerInfo === undefined) {
      layerInfo = {
        allSources,
        visibleSources: [],
        displayDimensionRenderInfo: displayDimensionRenderInfo,
      };
      this.visibleLayers.set(layer, layerInfo);
      layer.renderScaleTarget.changed.add(() => this.invalidateVisibleSources());
      layer.localPosition.changed.add(this.handleLayerChanged);
    } else {
      disposeTransformedSources(layerInfo.allSources);
      layerInfo.allSources = allSources;
      layerInfo.visibleSources.length = 0;
      layerInfo.displayDimensionRenderInfo = displayDimensionRenderInfo;
    }
    this.invalidateVisibleSources();
  }

  disposed() {
    for (let layer of this.visibleLayers.keys()) {
      this.removeVisibleLayer(layer);
    }
    super.disposed();
  }

  invalidateVisibleSources() {
    super.invalidateVisibleSources();
    this.chunkManager.scheduleUpdateChunkPriorities();
  }
}

export function deserializeTransformedSources<
    Source extends SliceViewChunkSourceBackend, RLayer extends MultiscaleVolumetricDataRenderLayer>(
    rpc: RPC, serializedSources: any[][], layer: any) {
  const sources = serializedSources.map(
      scales => scales.map((serializedSource): TransformedSource<RLayer, Source> => {
        const source = rpc.getRef<Source>(serializedSource.source);
        const chunkLayout = serializedSource.chunkLayout;
        const {rank} = source.spec;
        const tsource: TransformedSource<RLayer, Source> = {
          renderLayer: layer,
          source,
          chunkLayout: ChunkLayout.fromObject(chunkLayout),
          layerRank: serializedSource.layerRank,
          nonDisplayLowerClipBound: serializedSource.nonDisplayLowerClipBound,
          nonDisplayUpperClipBound: serializedSource.nonDisplayUpperClipBound,
          lowerClipBound: serializedSource.lowerClipBound,
          upperClipBound: serializedSource.upperClipBound,
          lowerClipDisplayBound: serializedSource.lowerClipDisplayBound,
          upperClipDisplayBound: serializedSource.upperClipDisplayBound,
          lowerChunkDisplayBound: serializedSource.lowerChunkDisplayBound,
          upperChunkDisplayBound: serializedSource.upperChunkDisplayBound,
          effectiveVoxelSize: serializedSource.effectiveVoxelSize,
          chunkDisplayDimensionIndices: serializedSource.chunkDisplayDimensionIndices,
          fixedLayerToChunkTransform: serializedSource.fixedLayerToChunkTransform,
          combinedGlobalLocalToChunkTransform: serializedSource.combinedGlobalLocalToChunkTransform,
          curPositionInChunks: new Float32Array(rank),
          fixedPositionWithinChunk: new Uint32Array(rank),
        };
        return tsource;
      }));
  return sources;
}
registerRPC(SLICEVIEW_ADD_VISIBLE_LAYER_RPC_ID, function(x) {
  const obj = <SliceViewBackend>this.get(x['id']);
  const layer = <SliceViewRenderLayerBackend>this.get(x['layerId']);
  const sources =
      deserializeTransformedSources<SliceViewChunkSourceBackend, SliceViewRenderLayerBackend>(
          this, x.sources, layer);
  obj.addVisibleLayer(layer, sources);
});
registerRPC(SLICEVIEW_REMOVE_VISIBLE_LAYER_RPC_ID, function(x) {
  let obj = <SliceViewBackend>this.get(x['id']);
  let layer = <SliceViewRenderLayerBackend>this.get(x['layerId']);
  obj.removeVisibleLayer(layer);
});

export class SliceViewChunk extends Chunk {
  chunkGridPosition: Float32Array;
  source: SliceViewChunkSourceBackend|null = null;

  constructor() {
    super();
  }

  initializeVolumeChunk(key: string, chunkGridPosition: Float32Array) {
    super.initialize(key);
    this.chunkGridPosition = Float32Array.from(chunkGridPosition);
  }

  serialize(msg: any, transfers: any[]) {
    super.serialize(msg, transfers);
    msg['chunkGridPosition'] = this.chunkGridPosition;
  }

  downloadSucceeded() {
    super.downloadSucceeded();
  }

  freeSystemMemory() {}

  toString() {
    return this.source!.toString() + ':' + vec3Key(this.chunkGridPosition);
  }
}

export interface SliceViewChunkSourceBackend<
    Spec extends SliceViewChunkSpecification = SliceViewChunkSpecification,
                 ChunkType extends SliceViewChunk = SliceViewChunk> {
  // TODO(jbms): Move this declaration to the class definition below and declare abstract once
  // TypeScript supports mixins with abstact classes.
  getChunk(chunkGridPosition: vec3): ChunkType;

  chunkConstructor: ChunkConstructor<SliceViewChunk>;
}

export class SliceViewChunkSourceBackend<
    Spec extends SliceViewChunkSpecification = SliceViewChunkSpecification,
                 ChunkType extends SliceViewChunk = SliceViewChunk> extends ChunkSource implements
    SliceViewChunkSourceInterface {
  spec: Spec;
  chunks: Map<string, ChunkType>;
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.spec = options.spec;
  }

  getChunk(chunkGridPosition: Float32Array) {
    const key = chunkGridPosition.join();
    let chunk = this.chunks.get(key);
    if (chunk === undefined) {
      chunk = this.getNewChunk_(this.chunkConstructor) as ChunkType;
      chunk.initializeVolumeChunk(key, chunkGridPosition);
      this.addChunk(chunk);
    }
    return chunk;
  }
}

@registerSharedObject(SLICEVIEW_RENDERLAYER_RPC_ID)
export class SliceViewRenderLayerBackend extends SharedObjectCounterpart implements
    SliceViewRenderLayerInterface, ChunkRenderLayerBackend {
  rpcId: number;
  renderScaleTarget: SharedWatchableValue<number>;
  localPosition: WatchableValueInterface<Float32Array>;

  numVisibleChunksNeeded: number;
  numVisibleChunksAvailable: number;
  numPrefetchChunksNeeded: number;
  numPrefetchChunksAvailable: number;
  chunkManagerGeneration: number;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.renderScaleTarget = rpc.get(options.renderScaleTarget);
    this.localPosition = rpc.get(options.localPosition);
    this.numVisibleChunksNeeded = 0;
    this.numVisibleChunksAvailable = 0;
    this.numPrefetchChunksAvailable = 0;
    this.numPrefetchChunksNeeded = 0;
    this.chunkManagerGeneration = -1;
  }

  filterVisibleSources(sliceView: SliceViewBase, sources: readonly TransformedSource[]):
      Iterable<TransformedSource> {
    return filterVisibleSources(sliceView, this, sources);
  }
}

const PREFETCH_MS = 2000;
const MAX_PREFETCH_VELOCITY = 0.1;  // voxels per millisecond
const MAX_SINGLE_DIRECTION_PREFETCH_CHUNKS =
    32;  // Maximum number of chunks to prefetch in a single direction.

// If the probability under the model of needing a chunk within `PREFETCH_MS` is less than this
// probability, skip prefetching it.
const PREFETCH_PROBABILITY_CUTOFF = 0.05;

const PREFETCH_ENTRY_SIZE = 6;

function getPrefetchChunkOffsets(
    velocityEstimator: VelocityEstimator, tsource: TransformedSource): number[] {
  const offsets: number[] = [];
  const globalRank = velocityEstimator.rank;
  const {combinedGlobalLocalToChunkTransform, layerRank} = tsource;

  const {rank: chunkRank, chunkDataSize} = tsource.source.spec;
  const {mean: meanVec, variance: varianceVec} = velocityEstimator;
  for (let chunkDim = 0; chunkDim < chunkRank; ++chunkDim) {
    const isDisplayDimension = tsource.chunkDisplayDimensionIndices.includes(chunkDim);
    let mean = 0;
    let variance = 0;
    for (let globalDim = 0; globalDim < globalRank; ++globalDim) {
      const meanValue = meanVec[globalDim];
      const varianceValue = varianceVec[globalDim];
      const coeff = combinedGlobalLocalToChunkTransform[globalDim * layerRank + chunkDim];
      mean += coeff * meanValue;
      variance += coeff * coeff * varianceValue;
    }
    if (mean > MAX_PREFETCH_VELOCITY) {
      continue;
    }
    const chunkSize = chunkDataSize[chunkDim];
    const initialFraction =
        isDisplayDimension ? 0 : tsource.fixedPositionWithinChunk[chunkDim] / chunkSize;
    const adjustedMean = mean / chunkSize * PREFETCH_MS;
    let adjustedStddevTimesSqrt2 = Math.sqrt(2 * variance) / chunkSize * PREFETCH_MS;
    if (Math.abs(adjustedMean) < 1e-3 && adjustedStddevTimesSqrt2 < 1e-3) {
      continue;
    }
    adjustedStddevTimesSqrt2 = Math.max(1e-6, adjustedStddevTimesSqrt2);
    const cdf = (x: number) => 0.5 * (1 + erf((x - adjustedMean) / adjustedStddevTimesSqrt2));

    const curChunk = tsource.curPositionInChunks[chunkDim];
    const minChunk = Math.floor(tsource.lowerClipBound[chunkDim] / chunkSize);
    const maxChunk = Math.ceil(tsource.upperClipBound[chunkDim] / chunkSize) - 1;
    let groupStart = offsets.length;
    for (let i = 1; i <= MAX_SINGLE_DIRECTION_PREFETCH_CHUNKS; ++i) {
      if (!isDisplayDimension && curChunk + i > maxChunk) break;
      const probability = 1 - cdf(i - initialFraction);
      // Probability that chunk `curChunk + i` will be needed within `PREFETCH_MS`.
      if (probability < PREFETCH_PROBABILITY_CUTOFF) break;
      offsets.push(chunkDim, i, minChunk, maxChunk, probability, 0);
    }
    let newGroupStart = offsets.length;
    for (let i = groupStart, end = offsets.length; i < end; i += PREFETCH_ENTRY_SIZE) {
      offsets[i + PREFETCH_ENTRY_SIZE - 1] = newGroupStart;
    }
    groupStart = newGroupStart;

    for (let i = 1; i <= MAX_SINGLE_DIRECTION_PREFETCH_CHUNKS; ++i) {
      if (!isDisplayDimension && curChunk - i < minChunk) break;
      const probability = cdf(-i + 1 - initialFraction);
      // Probability that chunk `curChunk - i` will be needed within `PREFETCH_MS`.
      if (probability < PREFETCH_PROBABILITY_CUTOFF) break;
      offsets.push(chunkDim, -i, minChunk, maxChunk, probability, 0);
    }
    newGroupStart = offsets.length;
    for (let i = groupStart, end = offsets.length; i < end; i += PREFETCH_ENTRY_SIZE) {
      offsets[i + PREFETCH_ENTRY_SIZE - 1] = newGroupStart;
    }
  }
  return offsets;
}

registerPromiseRPC(
    SLICEVIEW_REQUEST_CHUNK_RPC_ID,
    async function(
        x: {this: RPC, source: number, chunkGridPosition: Float32Array},
        cancellationToken: CancellationToken): RPCPromise<void> {
      const source = this.get(x.source) as SliceViewChunkSourceBackend;
      const {chunkManager} = source;
      const chunk = source.getChunk(x.chunkGridPosition);
      const key = chunk.key!;
      if (chunk.state <= ChunkState.SYSTEM_MEMORY) {
        // Already available on frontend.
        return {value: undefined};
      }
      const disposeRecompute = chunkManager.recomputeChunkPriorities.add(() => {
        chunkManager.requestChunk(
            chunk, ChunkPriorityTier.VISIBLE, Number.POSITIVE_INFINITY, ChunkState.SYSTEM_MEMORY);
      });
      chunkManager.scheduleUpdateChunkPriorities();
      let listener: (chunk: Chunk) => void;
      const promise = new Promise<void>((resolve, reject) => {
        listener = chunk => {
          if (chunk.state === ChunkState.FAILED) {
            reject(chunk.error);
            return;
          }
          if (chunk.state <= ChunkState.SYSTEM_MEMORY) {
            resolve();
          }
        };
      });
      source.registerChunkListener(key, listener!);
      const cancelPromise = new Promise((_resolve, reject) => {
        cancellationToken.add(() => {
          reject(CANCELED);
        });
      });
      try {
        await Promise.race([promise, cancelPromise]);
        return {value: undefined};
      } finally {
        source.unregisterChunkListener(key, listener!);
        disposeRecompute();
        chunkManager.scheduleUpdateChunkPriorities();
      }
    });
