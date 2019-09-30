/**
 * @license
 * Copyright 2018 Google Inc.
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

import 'neuroglancer/annotation/bounding_box';
import 'neuroglancer/annotation/line';
import 'neuroglancer/annotation/point';
import 'neuroglancer/annotation/ellipsoid';

import {AnnotationBase, AnnotationSource, annotationTypes} from 'neuroglancer/annotation';
import {AnnotationLayerState} from 'neuroglancer/annotation/annotation_layer_state';
import {ANNOTATION_PERSPECTIVE_RENDER_LAYER_RPC_ID, ANNOTATION_RENDER_LAYER_RPC_ID, ANNOTATION_RENDER_LAYER_UPDATE_SEGMENTATION_RPC_ID} from 'neuroglancer/annotation/base';
import {AnnotationGeometryData, MultiscaleAnnotationSource} from 'neuroglancer/annotation/frontend_source';
import {AnnotationRenderContext, AnnotationRenderHelper, getAnnotationTypeRenderHandler} from 'neuroglancer/annotation/type_handler';
import {ChunkState} from 'neuroglancer/chunk_manager/base';
import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {MouseSelectionState, VisibilityTrackedRenderLayer} from 'neuroglancer/layer';
import {PerspectiveViewRenderContext, PerspectiveViewRenderLayer} from 'neuroglancer/perspective_view/render_layer';
import {forEachVisibleSegment, getObjectKey} from 'neuroglancer/segmentation_display_state/base';
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value';
import {SliceViewPanelRenderLayer} from 'neuroglancer/sliceview/panel';
import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {binarySearch} from 'neuroglancer/util/array';
import {Borrowed, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {mat4} from 'neuroglancer/util/geom';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';
import {withSharedVisibility} from 'neuroglancer/visibility_priority/frontend';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {registerSharedObjectOwner, SharedObject} from 'neuroglancer/worker_rpc';

const tempMat = mat4.create();

function segmentationFilter(segmentationState: SegmentationDisplayState|undefined|null) {
  if (segmentationState == null) {
    return () => false;
  }
  const {visibleSegments, segmentEquivalences} = segmentationState;
  return (annotation: AnnotationBase) => {
    const {segments} = annotation;
    if (segments === undefined) {
      return false;
    }
    for (const segment of segments) {
      if (visibleSegments.has(segmentEquivalences.get(segment))) {
        return true;
      }
    }
    return false;
  };
}

function serializeAnnotationSet(
    annotationSet: AnnotationSource, filter?: (annotation: AnnotationBase) => boolean) {
  const typeToIds: string[][] = [];
  for (const annotationType of annotationTypes) {
    typeToIds[annotationType] = [];
  }
  for (const annotation of annotationSet) {
    if (filter === undefined || filter(annotation)) {
      typeToIds[annotation.type].push(annotation.id);
    }
  }
  let totalBytes = 0;
  let numPickIds = 0;
  const typeToOffset: number[] = [];
  for (const annotationType of annotationTypes) {
    typeToOffset[annotationType] = totalBytes;
    const count = typeToIds[annotationType].length;
    const handler = getAnnotationTypeRenderHandler(annotationType);
    totalBytes += count * handler.bytes;
    numPickIds += handler.pickIdsPerInstance * count;
  }
  const data = new ArrayBuffer(totalBytes);
  for (const annotationType of annotationTypes) {
    const ids = typeToIds[annotationType];
    const handler = getAnnotationTypeRenderHandler(annotationType);
    const serializer = handler.serializer(data, typeToOffset[annotationType], ids.length);
    ids.forEach((id, index) => serializer(annotationSet.get(id)!, index));
  }
  return {typeToIds, typeToOffset, data, numPickIds};
}

@registerSharedObjectOwner(ANNOTATION_RENDER_LAYER_RPC_ID)
class AnnotationLayerSharedObject extends withSharedVisibility(SharedObject) {
  constructor(
      public chunkManager: Borrowed<ChunkManager>,
      public source: Borrowed<MultiscaleAnnotationSource>,
      public state: WatchableValueInterface<SegmentationDisplayState|undefined|null>,
      public filterBySegmentation: WatchableValueInterface<boolean>) {
    super();

    this.initializeCounterpart(this.chunkManager.rpc!, {
      chunkManager: this.chunkManager.rpcId,
      source: source.rpcId,
      segmentationState: this.serializeDisplayState(),
    });

    const update = () => {
      const msg: any = {id: this.rpcId, segmentationState: this.serializeDisplayState()};
      this.rpc!.invoke(ANNOTATION_RENDER_LAYER_UPDATE_SEGMENTATION_RPC_ID, msg);
    };

    this.registerDisposer(state.changed.add(update));
    this.registerDisposer(filterBySegmentation.changed.add(update));
  }

  private serializeDisplayState() {
    const state = this.state.value;
    if (state == null) {
      return state;
    }
    if (!this.filterBySegmentation.value) {
      return null;
    }
    return {
      segmentEquivalences: state.segmentEquivalences.rpcId,
      visibleSegments: state.visibleSegments.rpcId
    };
  }
}

export class AnnotationLayer extends RefCounted {
  /**
   * Stores a serialized representation of the information needed to render the annotations.
   */
  buffer: Buffer;

  /**
   * The value of this.state.annotationSet.changed.count when `buffer` was last updated.
   */
  private generation = -1;

  redrawNeeded = new NullarySignal();
  typeToIds: string[][];
  typeToOffset: number[];
  numPickIds: number;
  data: Uint8Array|undefined;

  get source() {
    return this.state.source;
  }
  get transform() {
    return this.state.transform;
  }
  get hoverState() {
    return this.state.hoverState;
  }

  private segmentationState: SegmentationDisplayState|undefined|null;

  private handleChangeAffectingBuffer = (() => {
    this.generation = -1;
    this.redrawNeeded.dispatch();
  });

  private unregisterSegmentationState() {
    const {segmentationState} = this;
    if (segmentationState != null) {
      segmentationState.visibleSegments.changed.remove(this.handleSegmentationChanged);
      segmentationState.segmentEquivalences.changed.remove(this.handleSegmentationChanged);
      this.segmentationState = undefined;
    }
  }

  private handleSegmentationChanged = (() => {
    if (this.state.filterBySegmentation.value) {
      this.handleChangeAffectingBuffer();
    }
  });

  sharedObject: AnnotationLayerSharedObject|undefined;

  get visibility() {
    const {sharedObject} = this;
    if (sharedObject === undefined) {
      return undefined;
    }
    return sharedObject.visibility;
  }

  constructor(public chunkManager: ChunkManager, public state: Owned<AnnotationLayerState>) {
    super();
    this.registerDisposer(state);
    this.buffer = this.registerDisposer(new Buffer(chunkManager.gl));
    this.registerDisposer(this.source.changed.add(this.handleChangeAffectingBuffer));
    this.registerDisposer(state.filterBySegmentation.changed.add(this.handleChangeAffectingBuffer));
    this.registerDisposer(() => this.unregisterSegmentationState());
    this.registerDisposer(state.segmentationState.changed.add(() => {
      const segmentationState = state.segmentationState.value;
      if (segmentationState !== this.segmentationState) {
        this.unregisterSegmentationState();
        if (segmentationState != null) {
          segmentationState.visibleSegments.changed.add(this.handleSegmentationChanged);
          segmentationState.segmentEquivalences.changed.add(this.handleSegmentationChanged);
        }
        this.segmentationState = segmentationState;
        this.handleSegmentationChanged();
      }
    }));
    if (!(this.source instanceof AnnotationSource)) {
      this.sharedObject = this.registerDisposer(new AnnotationLayerSharedObject(
          chunkManager, this.source, state.segmentationState, state.filterBySegmentation));
    }
    this.registerDisposer(this.state.color.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(this.state.fillOpacity.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(this.hoverState.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(this.transform.changed.add(this.redrawNeeded.dispatch));
  }

  get gl() {
    return this.chunkManager.gl;
  }

  updateBuffer() {
    const {source} = this;
    if (source instanceof AnnotationSource) {
      const generation = source.changed.count;
      if (this.generation !== generation) {
        this.generation = generation;
        const {data, typeToIds, typeToOffset, numPickIds} = serializeAnnotationSet(
            source,
            this.state.filterBySegmentation.value ? segmentationFilter(this.segmentationState) :
                                                    undefined);
        this.data = new Uint8Array(data);
        this.buffer.setData(this.data);
        this.typeToIds = typeToIds;
        this.typeToOffset = typeToOffset;
        this.numPickIds = numPickIds;
      }
    }
  }
}

class AnnotationPerspectiveRenderLayerBase extends PerspectiveViewRenderLayer {
  constructor(public base: Owned<AnnotationLayer>) {
    super();
  }
}

class AnnotationSliceViewRenderLayerBase extends SliceViewPanelRenderLayer {
  constructor(public base: Owned<AnnotationLayer>) {
    super();
  }
}

interface AnnotationGeometryDataInterface {
  data: Uint8Array|undefined;
  buffer: Buffer|undefined;
  numPickIds: number|undefined;
  typeToIds: string[][]|undefined;
  typeToOffset: number[]|undefined;
}

function AnnotationRenderLayer<TBase extends {
  new (...args: any[]): VisibilityTrackedRenderLayer &
  {
    base: AnnotationLayer
  }
}>(Base: TBase, renderHelperType: 'sliceViewRenderHelper'|'perspectiveViewRenderHelper') {
  class C extends Base {
    base: AnnotationLayer;
    private renderHelpers: AnnotationRenderHelper[] = [];
    constructor(...args: any[]) {
      super(...args);
      const base = this.registerDisposer(this.base);
      const baseVisibility = base.visibility;
      if (baseVisibility !== undefined) {
        this.registerDisposer(baseVisibility.add(this.visibility));
      }
      this.role = base.state.role;
      const {renderHelpers, gl} = this;
      for (const annotationType of annotationTypes) {
        const handler = getAnnotationTypeRenderHandler(annotationType);
        const renderHelperConstructor = handler[renderHelperType];
        const helper = renderHelpers[annotationType] =
            this.registerDisposer(new renderHelperConstructor(gl));
        helper.pickIdsPerInstance = handler.pickIdsPerInstance;
        helper.targetIsSliceView = renderHelperType === 'sliceViewRenderHelper';
      }
      this.registerDisposer(base.redrawNeeded.add(() => {
        this.redrawNeeded.dispatch();
      }));
      this.setReady(true);
    }

    get gl() {
      return this.base.chunkManager.gl;
    }

    drawGeometryChunkData(
        chunk: AnnotationGeometryData, renderContext: PerspectiveViewRenderContext) {
      if (!chunk.bufferValid) {
        let {buffer} = chunk;
        if (buffer === undefined) {
          buffer = chunk.buffer = new Buffer(this.gl);
        }
        buffer.setData(chunk.data!);
        chunk.bufferValid = true;
      }
      this.drawGeometry(chunk, renderContext);
    }

    drawGeometry(
        chunk: AnnotationGeometryDataInterface, renderContext: PerspectiveViewRenderContext) {
      const {base} = this;
      const typeToIds = chunk.typeToIds!;
      const typeToOffset = chunk.typeToOffset!;
      let pickId = 0;
      if (renderContext.emitPickID) {
        pickId = renderContext.pickIDs.register(this, chunk.numPickIds, 0, 0, chunk);
      }
      const hoverValue = base.hoverState.value;
      const projectionMatrix =
          mat4.multiply(tempMat, renderContext.dataToDevice, base.state.objectToGlobal);
      for (const annotationType of annotationTypes) {
        const ids = typeToIds[annotationType];
        if (ids.length > 0) {
          const count = ids.length;
          const handler = getAnnotationTypeRenderHandler(annotationType);
          let selectedIndex = 0xFFFFFFFF;
          if (hoverValue !== undefined) {
            const index = binarySearch(ids, hoverValue.id, (a, b) => a < b ? -1 : a === b ? 0 : 1);
            if (index >= 0) {
              selectedIndex = index * handler.pickIdsPerInstance;
              // If we wanted to include the partIndex, we would add:
              // selectedIndex += hoverValue.partIndex;
            }
          }
          const context: AnnotationRenderContext = {
            annotationLayer: base,
            renderContext,
            selectedIndex,
            basePickId: pickId,
            buffer: chunk.buffer!,
            bufferOffset: typeToOffset[annotationType],
            count,
            projectionMatrix,
          };
          this.renderHelpers[annotationType].draw(context);
          pickId += count * handler.pickIdsPerInstance;
        }
      }
    }

    draw(renderContext: PerspectiveViewRenderContext) {
      const {source} = this.base;
      if (source instanceof AnnotationSource) {
        const {base} = this;
        base.updateBuffer();
        this.drawGeometry(base, renderContext);
      } else {
        this.drawGeometryChunkData(source.temporary.data!, renderContext);
        if (this.base.state.filterBySegmentation.value) {
          const segmentationState = this.base.state.segmentationState.value;
          if (segmentationState == null) {
            return;
          }
          const chunks = source.segmentFilteredSource.chunks;
          forEachVisibleSegment(segmentationState, objectId => {
            const key = getObjectKey(objectId);
            const chunk = chunks.get(key);
            if (chunk !== undefined) {
              this.drawGeometryChunkData(chunk.data!, renderContext);
            }
          });
        } else {
          for (const alternatives of source.sources) {
            for (const geometrySource of alternatives) {
              for (const chunk of geometrySource.chunks.values()) {
                if (chunk.state !== ChunkState.GPU_MEMORY) {
                  continue;
                }
                this.drawGeometryChunkData(chunk.data!, renderContext);
              }
            }
          }
        }
      }
    }

    updateMouseState(
        mouseState: MouseSelectionState, _pickedValue: Uint64, pickedOffset: number, data: any) {
      const chunk = <AnnotationGeometryDataInterface>data;
      const typeToIds = chunk.typeToIds!;
      const typeToOffset = chunk.typeToOffset!;
      for (const annotationType of annotationTypes) {
        const ids = typeToIds[annotationType];
        const handler = getAnnotationTypeRenderHandler(annotationType);
        const {pickIdsPerInstance} = handler;
        if (pickedOffset < ids.length * pickIdsPerInstance) {
          const instanceIndex = Math.floor(pickedOffset / pickIdsPerInstance);
          const id = ids[instanceIndex];
          const partIndex = pickedOffset % pickIdsPerInstance;
          mouseState.pickedAnnotationId = id;
          mouseState.pickedAnnotationLayer = this.base.state;
          mouseState.pickedOffset = partIndex;
          mouseState.pickedAnnotationBuffer = chunk.data!.buffer;
          mouseState.pickedAnnotationBufferOffset = chunk.data!.byteOffset + typeToOffset[annotationType] + instanceIndex * handler.bytes;
          handler.snapPosition(
              mouseState.position, this.base.state.objectToGlobal, mouseState.pickedAnnotationBuffer,
              mouseState.pickedAnnotationBufferOffset,
              partIndex);
          return;
        }
        pickedOffset -= ids.length * pickIdsPerInstance;
      }
    }

    transformPickedValue(_pickedValue: Uint64, _pickedOffset: number) {
      return undefined;
    }

    isReady() {
      const {base} = this;
      const {source} = base;
      if (!(source instanceof MultiscaleAnnotationSource)) {
        return true;
      }
      if (!base.state.filterBySegmentation.value) {
        return true;
      }

      const segmentationState = this.base.state.segmentationState.value;
      if (segmentationState === undefined) {
        // We are still waiting to attach segmentation.
        return false;
      }
      if (segmentationState === null) {
        return true;
      }
      const chunks = source.segmentFilteredSource.chunks;
      let missing = false;
      forEachVisibleSegment(segmentationState, objectId => {
        const key = getObjectKey(objectId);
        if (!chunks.has(key)) {
          missing = true;
        }
      });
      return !missing;
    }

    isAnnotation = true;
  }
  return C;
}

const PerspectiveViewAnnotationLayerBase =
    AnnotationRenderLayer(AnnotationPerspectiveRenderLayerBase, 'perspectiveViewRenderHelper');
export class PerspectiveViewAnnotationLayer extends PerspectiveViewAnnotationLayerBase {
  backend = (() => {
    const {source} = this.base;
    if (source instanceof MultiscaleAnnotationSource) {
      const sharedObject = this.registerDisposer(new SharedObject());
      const rpc = source.chunkManager.rpc!;
      sharedObject.RPC_TYPE_ID = ANNOTATION_PERSPECTIVE_RENDER_LAYER_RPC_ID;
      sharedObject.initializeCounterpart(rpc, {
        source: source.rpcId,
        filterBySegmentation: this.registerDisposer(SharedWatchableValue.makeFromExisting(
                                                        rpc, this.base.state.filterBySegmentation))
                                  .rpcId
      });
      return sharedObject;
    }
    return undefined;
  })();
  isReady() {
    if (!super.isReady()) {
      return false;
    }
    const {base} = this;
    const {source} = base;
    if (source instanceof MultiscaleAnnotationSource) {
      if (!base.state.filterBySegmentation.value) {
        const geometrySource = source.sources[0][0];
        const chunk = geometrySource.chunks.get('0,0,0');
        if (chunk === undefined || chunk.state !== ChunkState.GPU_MEMORY) {
          return false;
        }
      }
    }
    return true;
  }
}

export const SliceViewAnnotationLayer =
    AnnotationRenderLayer(AnnotationSliceViewRenderLayerBase, 'sliceViewRenderHelper');
