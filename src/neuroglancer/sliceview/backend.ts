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

import {Chunk, ChunkSource, withChunkManager} from 'neuroglancer/chunk_manager/backend';
import {RenderLayer as RenderLayerInterface, SLICEVIEW_RPC_ID, SliceViewBase, SliceViewChunkSource as SliceViewChunkSourceInterface, SliceViewChunkSpecification} from 'neuroglancer/sliceview/base';
import {ChunkLayout} from 'neuroglancer/sliceview/chunk_layout';
import {vec3, vec3Key} from 'neuroglancer/util/geom';
import {NullarySignal} from 'neuroglancer/util/signal';
import {getBasePriority, getPriorityTier, withSharedVisibility} from 'neuroglancer/visibility_priority/backend';
import {registerRPC, registerSharedObject, RPC, SharedObjectCounterpart} from 'neuroglancer/worker_rpc';

const BASE_PRIORITY = -1e12;
const SCALE_PRIORITY_MULTIPLIER = 1e9;

// Temporary values used by SliceView.updateVisibleChunk
const tempChunkPosition = vec3.create();
const tempChunkDataSize = vec3.create();
const tempCenter = vec3.create();

class SliceViewCounterpartBase extends SliceViewBase {
  constructor(rpc: RPC, options: any) {
    super();
    this.initializeSharedObject(rpc, options['id']);
  }
}

const SliceViewIntermediateBase = withSharedVisibility(withChunkManager(SliceViewCounterpartBase));
@registerSharedObject(SLICEVIEW_RPC_ID)
export class SliceView extends SliceViewIntermediateBase {
  visibleLayers: Map<RenderLayer, SliceViewChunkSource[]>;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.registerDisposer(this.chunkManager.recomputeChunkPriorities.add(() => {
      this.updateVisibleChunks();
    }));
  }

  onViewportChanged() {
    this.chunkManager.scheduleUpdateChunkPriorities();
  }

  handleLayerChanged = (() => {
    if (this.hasValidViewport) {
      this.chunkManager.scheduleUpdateChunkPriorities();
    }
  });

  updateVisibleChunks() {
    const globalCenter = this.centerDataPosition;
    let chunkManager = this.chunkManager;
    const visibility = this.visibility.value;
    if (visibility === Number.NEGATIVE_INFINITY) {
      return;
    }

    const priorityTier = getPriorityTier(visibility);
    let basePriority = getBasePriority(visibility);
    basePriority += BASE_PRIORITY;

    const localCenter = tempCenter;

    let getLayoutObject = (chunkLayout: ChunkLayout) => {
      chunkLayout.globalToLocalSpatial(localCenter, globalCenter);
      return this.visibleChunkLayouts.get(chunkLayout);
    };

    function addChunk(
        chunkLayout: ChunkLayout, sources: Map<SliceViewChunkSource, number>,
        positionInChunks: vec3, visibleSources: SliceViewChunkSource[]) {
      vec3.multiply(tempChunkPosition, positionInChunks, chunkLayout.size);
      let priority = -vec3.distance(localCenter, tempChunkPosition);
      for (let source of visibleSources) {
        let priorityIndex = sources.get(source)!;
        let chunk = source.getChunk(positionInChunks);
        chunkManager.requestChunk(
            chunk, priorityTier,
            basePriority + priority + SCALE_PRIORITY_MULTIPLIER * priorityIndex);
      }
    }
    this.computeVisibleChunks(getLayoutObject, addChunk);
  }

  removeVisibleLayer(layer: RenderLayer) {
    this.visibleLayers.delete(layer);
    layer.layerChanged.remove(this.handleLayerChanged);
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
}

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
  layer.layerChanged.add(obj.handleLayerChanged);
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

export class SliceViewChunk extends Chunk {
  chunkGridPosition: vec3;
  source: SliceViewChunkSource|null = null;
  chunkDataSize: vec3|null;

  constructor() {
    super();
    this.chunkGridPosition = vec3.create();
  }

  initializeVolumeChunk(key: string, chunkGridPosition: vec3) {
    super.initialize(key);

    vec3.copy(this.chunkGridPosition, chunkGridPosition);

    this.chunkDataSize = null;
  }

  serialize(msg: any, transfers: any[]) {
    super.serialize(msg, transfers);
    let chunkDataSize = this.chunkDataSize;
    if (chunkDataSize !== this.source!.spec.chunkDataSize) {
      msg['chunkDataSize'] = chunkDataSize;
    }
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

export abstract class SliceViewChunkSource extends ChunkSource implements
    SliceViewChunkSourceInterface {
  spec: SliceViewChunkSpecification;
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
  }

  abstract getChunk(chunkGridPosition: vec3): SliceViewChunk

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
  computeChunkBounds(chunk: SliceViewChunk) {
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
}

export abstract class RenderLayer extends SharedObjectCounterpart implements RenderLayerInterface {
  rpcId: number;
  sources: SliceViewChunkSource[][];
  layerChanged = new NullarySignal();

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    let sources = this.sources = new Array<SliceViewChunkSource[]>();
    for (let alternativeIds of options['sources']) {
      let alternatives = new Array<SliceViewChunkSource>();
      sources.push(alternatives);
      for (let sourceId of alternativeIds) {
        let source: SliceViewChunkSource = rpc.get(sourceId);
        this.registerDisposer(source.addRef());
        alternatives.push(source);
      }
    }
  }
}

/**
 * Extends SliceViewChunkSource with a parameters member.
 *
 * Subclasses should be decorated with
 * src/neuroglancer/chunk_manager/backend.ts:registerChunkSource.
 */
export abstract class ParameterizedSliceViewChunkSource<Parameters> extends SliceViewChunkSource {
  parameters: Parameters;
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.parameters = options['parameters'];
  }
}
