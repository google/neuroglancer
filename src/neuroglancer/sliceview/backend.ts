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

import {Chunk, ChunkManager, ChunkSource} from 'neuroglancer/chunk_manager/backend';
import {ChunkPriorityTier} from 'neuroglancer/chunk_manager/base';
import {RenderLayer as RenderLayerInterface, SLICEVIEW_RENDERLAYER_RPC_ID, SLICEVIEW_RPC_ID, SliceViewBase, VolumeChunkSource as VolumeChunkSourceInterface, VolumeChunkSpecification} from 'neuroglancer/sliceview/base';
import {ChunkLayout} from 'neuroglancer/sliceview/chunk_layout';
import {vec3, vec3Key} from 'neuroglancer/util/geom';
import {registerRPC, registerSharedObject, RPC, SharedObjectCounterpart} from 'neuroglancer/worker_rpc';
import {Signal} from 'signals';

const BASE_PRIORITY = -1e12;
const SCALE_PRIORITY_MULTIPLIER = 1e9;

// Temporary values used by SliceView.updateVisibleChunk and VolumeChunkSource.computeChunkPosition.
const tempChunkPosition = vec3.create();
const tempChunkDataSize = vec3.create();
const tempCenter = vec3.create();

@registerSharedObject(SLICEVIEW_RPC_ID)
export class SliceView extends SliceViewBase {
  chunkManager: ChunkManager;

  visibleLayers: Map<RenderLayer, VolumeChunkSource[]>;

  constructor(rpc: RPC, options: any) {
    super();
    this.initializeSharedObject(rpc, options['id']);
    this.chunkManager =
        this.registerDisposer((<ChunkManager>rpc.get(options['chunkManager'])).addRef());
    this.registerSignalBinding(
        this.chunkManager.recomputeChunkPriorities.add(this.updateVisibleChunks, this));
  }

  onViewportChanged() { this.chunkManager.scheduleUpdateChunkPriorities(); }

  handleLayerChanged() {
    if (this.hasValidViewport) {
      this.chunkManager.scheduleUpdateChunkPriorities();
    }
  }

  updateVisibleChunks() {
    const globalCenter = this.centerDataPosition;
    let chunkManager = this.chunkManager;

    const localCenter = tempCenter;

    let getLayoutObject = (chunkLayout: ChunkLayout) => {
      chunkLayout.globalToLocalSpatial(localCenter, globalCenter);
      return this.visibleChunkLayouts.get(chunkLayout);
    };

    function addChunk(
        chunkLayout: ChunkLayout, sources: Map<VolumeChunkSource, number>, positionInChunks: vec3,
        visibleSources: VolumeChunkSource[]) {
      vec3.multiply(tempChunkPosition, positionInChunks, chunkLayout.size);
      let priority = -vec3.distance(localCenter, tempChunkPosition);
      for (let source of visibleSources) {
        let priorityIndex = sources.get(source);
        let chunk = source.getChunk(positionInChunks);
        chunkManager.requestChunk(
            chunk, ChunkPriorityTier.VISIBLE, BASE_PRIORITY + priority + SCALE_PRIORITY_MULTIPLIER * priorityIndex);
      }
    }
    this.computeVisibleChunks(getLayoutObject, addChunk);
  }

  removeVisibleLayer(layer: RenderLayer) {
    this.visibleLayers.delete(layer);
    layer.layerChanged.remove(this.handleLayerChanged, this);
    this.visibleSourcesStale = true;
    if (this.hasValidViewport) {
      this.chunkManager.scheduleUpdateChunkPriorities();
    }
  }

  disposed() {
    for (let layer of this.visibleLayers.keys()) {
      this.removeVisibleLayer(layer);
    }
    super.disposed();
  }
};

registerRPC('SliceView.updateView', function(x) {
  let obj = this.get(x.id);
  if (x.width) {
    obj.setViewportSize(x.width, x.height);
  }
  if (x.viewportToData) {
    obj.setViewportToDataMatrix(x.viewportToData);
  }
});
registerRPC('SliceView.addVisibleLayer', function(x) {
  let obj = <SliceView>this.get(x['id']);
  let layer = <RenderLayer>this.get(x['layerId']);
  obj.visibleLayers.set(layer, []);
  layer.layerChanged.add(obj.handleLayerChanged, obj);
  obj.visibleSourcesStale = true;
  if (obj.hasValidViewport) {
    obj.chunkManager.scheduleUpdateChunkPriorities();
  }
});
registerRPC('SliceView.removeVisibleLayer', function(x) {
  let obj = <SliceView>this.get(x['id']);
  let layer = <RenderLayer>this.get(x['layerId']);
  obj.removeVisibleLayer(layer);
});

export class VolumeChunk extends Chunk {
  chunkGridPosition: vec3;
  source: VolumeChunkSource|null = null;
  chunkDataSize: vec3|null;
  data: ArrayBufferView|null;
  constructor() {
    super();
    this.chunkGridPosition = vec3.create();
  }

  initializeVolumeChunk(key: string, chunkGridPosition: vec3) {
    super.initialize(key);

    let source = this.source;

    /**
     * Grid position within chunk layout (coordinates are in units of chunks).
     */
    vec3.copy(this.chunkGridPosition, chunkGridPosition);
    this.systemMemoryBytes = source!.spec.chunkBytes;
    this.gpuMemoryBytes = source!.spec.chunkBytes;

    this.chunkDataSize = null;
    this.data = null;
  }

  serialize(msg: any, transfers: any[]) {
    super.serialize(msg, transfers);
    let data = msg['data'] = this.data!;
    let chunkDataSize = this.chunkDataSize;
    if (chunkDataSize !== this.source!.spec.chunkDataSize) {
      msg['chunkDataSize'] = chunkDataSize;
    }
    msg['chunkGridPosition'] = this.chunkGridPosition;
    transfers.push(data.buffer);
    this.data = null;
    // console.log(`Serializing chunk ${this.source.rpcId}:${this.key} with
    // chunkDataSize = ${this.chunkDataSize}`);
  }

  downloadSucceeded() {
    this.systemMemoryBytes = this.gpuMemoryBytes = this.data!.byteLength;
    super.downloadSucceeded();
  }

  freeSystemMemory() { this.data = null; }
  toString() { return this.source!.toString() + ':' + vec3Key(this.chunkGridPosition); }
};

export class VolumeChunkSource extends ChunkSource implements VolumeChunkSourceInterface {
  spec: VolumeChunkSpecification;
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.spec = VolumeChunkSpecification.fromObject(options['spec']);
  }

  getChunk(chunkGridPosition: vec3) {
    let key = vec3Key(chunkGridPosition);
    let chunk = <VolumeChunk>this.chunks.get(key);
    if (chunk === undefined) {
      chunk = this.getNewChunk_(VolumeChunk);
      chunk.initializeVolumeChunk(key, chunkGridPosition);
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
  computeChunkBounds(chunk: VolumeChunk) {
    let {spec} = this;
    let {upperVoxelBound} = spec;

    let origChunkDataSize = spec.chunkDataSize;
    let newChunkDataSize = tempChunkDataSize;

    // Chunk start position in voxel coordinates.
    let chunkPosition =
        vec3.multiply(tempChunkPosition, chunk.chunkGridPosition, origChunkDataSize);

    // Specifies whether the chunk only partially fits within the data bounds.
    let partial = false;
    for (let i = 0; i < 3; ++i) {
      let upper = Math.min(upperVoxelBound[i], chunkPosition[i] + origChunkDataSize[i]);
      let size = newChunkDataSize[i] = upper - chunkPosition[i];
      if (size !== origChunkDataSize[i]) {
        partial = true;
      }
    }

    vec3.add(chunkPosition, chunkPosition, this.spec.baseVoxelOffset);

    if (partial) {
      chunk.chunkDataSize = vec3.clone(newChunkDataSize);
    } else {
      chunk.chunkDataSize = origChunkDataSize;
    }

    return chunkPosition;
  }
};

@registerSharedObject(SLICEVIEW_RENDERLAYER_RPC_ID)
export class RenderLayer extends SharedObjectCounterpart implements RenderLayerInterface {
  rpcId: number;
  sources: VolumeChunkSource[][];
  layerChanged = new Signal();

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    let sources = this.sources = new Array<VolumeChunkSource[]>();
    for (let alternativeIds of options['sources']) {
      let alternatives = new Array<VolumeChunkSource>();
      sources.push(alternatives);
      for (let sourceId of alternativeIds) {
        let source: VolumeChunkSource = rpc.get(sourceId);
        this.registerDisposer(source.addRef());
        alternatives.push(source);
      }
    }
  }
};

/**
 * Extends VolumeChunkSource with a parameters member.
 *
 * Subclasses should be decorated with
 * src/neuroglancer/chunk_manager/backend.ts:registerChunkSource.
 */
export class ParameterizedVolumeChunkSource<Parameters> extends VolumeChunkSource {
  parameters: Parameters;
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.parameters = options['parameters'];
  }
};
