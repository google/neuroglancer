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

import {Chunk, ChunkConstructor, ChunkSource, withChunkManager} from 'neuroglancer/chunk_manager/backend';
import {CoordinateTransform} from 'neuroglancer/coordinate_transform';
import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value';
import {RenderLayer as RenderLayerInterface, SLICEVIEW_ADD_VISIBLE_LAYER_RPC_ID, SLICEVIEW_REMOVE_VISIBLE_LAYER_RPC_ID, SLICEVIEW_RENDERLAYER_RPC_ID, SLICEVIEW_RENDERLAYER_UPDATE_TRANSFORM_RPC_ID, SLICEVIEW_RPC_ID, SLICEVIEW_UPDATE_VIEW_RPC_ID, SliceViewBase, SliceViewChunkSource as SliceViewChunkSourceInterface, SliceViewChunkSpecification, TransformedSource} from 'neuroglancer/sliceview/base';
import {ChunkLayout} from 'neuroglancer/sliceview/chunk_layout';
import {mat4, vec3, vec3Key} from 'neuroglancer/util/geom';
import {NullarySignal} from 'neuroglancer/util/signal';
import {getBasePriority, getPriorityTier, withSharedVisibility} from 'neuroglancer/visibility_priority/backend';
import {registerRPC, registerSharedObject, RPC, SharedObjectCounterpart} from 'neuroglancer/worker_rpc';

const BASE_PRIORITY = -1e12;
const SCALE_PRIORITY_MULTIPLIER = 1e9;

// Temporary values used by SliceView.updateVisibleChunk
const tempChunkPosition = vec3.create();
const tempCenter = vec3.create();

class SliceViewCounterpartBase extends SliceViewBase<SliceViewChunkSource, RenderLayer> {
  constructor(rpc: RPC, options: any) {
    super();
    this.initializeSharedObject(rpc, options['id']);
  }
}

const SliceViewIntermediateBase = withSharedVisibility(withChunkManager(SliceViewCounterpartBase));
@registerSharedObject(SLICEVIEW_RPC_ID)
export class SliceView extends SliceViewIntermediateBase {
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
    layer.transform.changed.remove(this.invalidateVisibleSources);
    layer.renderScaleTarget.changed.remove(this.invalidateVisibleSources);
    this.invalidateVisibleSources();
  }

  addVisibleLayer(layer: RenderLayer) {
    this.visibleLayers.set(layer, []);
    layer.layerChanged.add(this.handleLayerChanged);
    layer.transform.changed.add(this.invalidateVisibleSources);
    layer.renderScaleTarget.changed.add(this.invalidateVisibleSources);
    this.invalidateVisibleSources();
  }

  disposed() {
    for (let layer of this.visibleLayers.keys()) {
      this.removeVisibleLayer(layer);
    }
    super.disposed();
  }

  private invalidateVisibleSources = (() => {
    this.visibleSourcesStale = true;
    if (this.hasValidViewport) {
      this.chunkManager.scheduleUpdateChunkPriorities();
    }
  });
}

registerRPC(SLICEVIEW_UPDATE_VIEW_RPC_ID, function(x) {
  let obj = this.get(x.id);
  if (x.width) {
    obj.setViewportSize(x.width, x.height);
  }
  if (x.viewportToData) {
    obj.setViewportToDataMatrix(x.viewportToData);
  }
});
registerRPC(SLICEVIEW_ADD_VISIBLE_LAYER_RPC_ID, function(x) {
  let obj = <SliceView>this.get(x['id']);
  let layer = <RenderLayer>this.get(x['layerId']);
  obj.addVisibleLayer(layer);
});
registerRPC(SLICEVIEW_REMOVE_VISIBLE_LAYER_RPC_ID, function(x) {
  let obj = <SliceView>this.get(x['id']);
  let layer = <RenderLayer>this.get(x['layerId']);
  obj.removeVisibleLayer(layer);
});

export class SliceViewChunk extends Chunk {
  chunkGridPosition: vec3;
  source: SliceViewChunkSource|null = null;

  constructor() {
    super();
    this.chunkGridPosition = vec3.create();
  }

  initializeVolumeChunk(key: string, chunkGridPosition: vec3) {
    super.initialize(key);
    vec3.copy(this.chunkGridPosition, chunkGridPosition);
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

export interface SliceViewChunkSource {
  // TODO(jbms): Move this declaration to the class definition below and declare abstract once
  // TypeScript supports mixins with abstact classes.
  getChunk(chunkGridPosition: vec3): SliceViewChunk;

  chunkConstructor: ChunkConstructor<SliceViewChunk>;
}

export class SliceViewChunkSource extends ChunkSource implements SliceViewChunkSourceInterface {
  spec: SliceViewChunkSpecification;
  chunks: Map<string, SliceViewChunk>;
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
  }

  getChunk(chunkGridPosition: vec3) {
    let key = vec3Key(chunkGridPosition);
    let chunk = this.chunks.get(key);
    if (chunk === undefined) {
      chunk = this.getNewChunk_(this.chunkConstructor);
      chunk.initializeVolumeChunk(key, chunkGridPosition);
      this.addChunk(chunk);
    }
    return chunk;
  }
}

@registerSharedObject(SLICEVIEW_RENDERLAYER_RPC_ID)
export class RenderLayer extends SharedObjectCounterpart implements
    RenderLayerInterface<SliceViewChunkSource> {
  rpcId: number;
  sources: SliceViewChunkSource[][];
  layerChanged = new NullarySignal();
  transform = new CoordinateTransform();
  transformedSources: TransformedSource<SliceViewChunkSource>[][];
  transformedSourcesGeneration = -1;
  renderScaleTarget: SharedWatchableValue<number>;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.renderScaleTarget = rpc.get(options.renderScaleTarget);
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
    mat4.copy(this.transform.transform, options['transform']);
    this.transform.changed.add(this.layerChanged.dispatch);
  }
}
registerRPC(SLICEVIEW_RENDERLAYER_UPDATE_TRANSFORM_RPC_ID, function(x) {
  const layer = <RenderLayer>this.get(x['id']);
  const newValue: mat4 = x['value'];
  const oldValue = layer.transform.transform;
  if (!mat4.equals(newValue, oldValue)) {
    mat4.copy(oldValue, newValue);
    layer.transform.changed.dispatch();
  }
});
