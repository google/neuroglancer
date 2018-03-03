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

import {AnnotationSource, annotationTypes} from 'neuroglancer/annotation';
import {AnnotationLayerState} from 'neuroglancer/annotation/annotation_layer_state';
import {ANNOTATION_PERSPECTIVE_RENDER_LAYER_RPC_ID} from 'neuroglancer/annotation/base';
import {AnnotationGeometryChunk, MultiscaleAnnotationSource} from 'neuroglancer/annotation/frontend_source';
import {AnnotationRenderContext, AnnotationRenderHelper, getAnnotationTypeRenderHandler} from 'neuroglancer/annotation/type_handler';
import {ChunkState} from 'neuroglancer/chunk_manager/base';
import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {MouseSelectionState, RenderLayer} from 'neuroglancer/layer';
import {PerspectiveViewRenderContext, PerspectiveViewRenderLayer} from 'neuroglancer/perspective_view/render_layer';
import {SliceViewPanelRenderLayer} from 'neuroglancer/sliceview/panel';
import {binarySearch} from 'neuroglancer/util/array';
import {Owned, RefCounted} from 'neuroglancer/util/disposable';
import {mat4} from 'neuroglancer/util/geom';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {SharedObject} from 'neuroglancer/worker_rpc';

const tempMat = mat4.create();

function serializeAnnotationSet(annotationSet: AnnotationSource) {
  const typeToIds: string[][] = [];
  for (const annotationType of annotationTypes) {
    typeToIds[annotationType] = [];
  }
  for (const annotation of annotationSet) {
    typeToIds[annotation.type].push(annotation.id);
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

  constructor(public chunkManager: ChunkManager, public state: Owned<AnnotationLayerState>) {
    super();
    this.registerDisposer(state);
    this.buffer = this.registerDisposer(new Buffer(chunkManager.gl));
    this.registerDisposer(this.source.changed.add(this.redrawNeeded.dispatch));
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
        const {data, typeToIds, typeToOffset, numPickIds} = serializeAnnotationSet(source);
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

function AnnotationRenderLayer<TBase extends {
  new (...args: any[]): RenderLayer &
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
      this.registerDisposer(base);
      this.registerDisposer(base.redrawNeeded.add(() => {
        this.redrawNeeded.dispatch();
      }));
      this.setReady(true);
    }
    get gl() {
      return this.base.chunkManager.gl;
    }


    drawChunk(chunk: AnnotationGeometryChunk, renderContext: PerspectiveViewRenderContext) {
      const {base} = this;
      if (!chunk.bufferValid) {
        let {buffer} = chunk;
        if (buffer === undefined) {
          buffer = chunk.buffer = new Buffer(this.gl);
        }
        buffer.setData(chunk.data!);
        chunk.bufferValid = true;
      }
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
        const {typeToIds, typeToOffset} = base;
        let pickId = 0;
        if (renderContext.emitPickID) {
          pickId = renderContext.pickIDs.register(this, base.numPickIds);
        }
        const hoverValue = base.hoverState.value;
        for (const annotationType of annotationTypes) {
          const ids = typeToIds[annotationType];
          if (ids.length > 0) {
            const count = ids.length;
            const handler = getAnnotationTypeRenderHandler(annotationType);
            let selectedIndex = 0xFFFFFFFF;
            if (hoverValue !== undefined) {
              const index = ids.indexOf(hoverValue.id);
              if (index !== -1) {
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
              buffer: base.buffer,
              bufferOffset: typeToOffset[annotationType],
              count,
              projectionMatrix:
                  mat4.multiply(tempMat, renderContext.dataToDevice, base.state.objectToGlobal),
            };
            this.renderHelpers[annotationType].draw(context);
            pickId += count * handler.pickIdsPerInstance;
          }
        }
      } else {
        this.drawChunk(source.temporary, renderContext);
        for (const alternatives of source.sources) {
          for (const geometrySource of alternatives) {
            for (const chunk of geometrySource.chunks.values()) {
              if (chunk.state !== ChunkState.GPU_MEMORY) {
                continue;
              }
              this.drawChunk(chunk, renderContext);
            }
          }
        }
      }
    }

    updateMouseState(
        mouseState: MouseSelectionState, _pickedValue: Uint64, pickedOffset: number, data: any) {
      const {source} = this.base;
      if (source instanceof AnnotationSource) {
        const {typeToIds} = this.base;
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
            handler.snapPosition(
                mouseState.position, this.base.state.objectToGlobal, this.base.data!.buffer,
                this.base.data!.byteOffset + this.base.typeToOffset[annotationType] +
                    instanceIndex * handler.bytes,
                partIndex);
            return;
          }
          pickedOffset -= ids.length * pickIdsPerInstance;
        }
      } else {
        const chunk: AnnotationGeometryChunk = data;
        if (chunk.data === undefined) {
          return;
        }
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
            handler.snapPosition(
                mouseState.position, this.base.state.objectToGlobal, chunk.data.buffer,
                chunk.data.byteOffset + typeToOffset[annotationType] +
                    instanceIndex * handler.bytes,
                partIndex);
            return;
          }
          pickedOffset -= ids.length * pickIdsPerInstance;
        }
      }
    }

    transformPickedValue(_pickedValue: Uint64, _pickedOffset: number) {
      return undefined;
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
      sharedObject.RPC_TYPE_ID = ANNOTATION_PERSPECTIVE_RENDER_LAYER_RPC_ID;
      sharedObject.initializeCounterpart(source.chunkManager.rpc!, {source: source.rpcId});
      return sharedObject;
    }
    return undefined;
  })();
  isReady() {
    const {source} = this.base;
    if (source instanceof MultiscaleAnnotationSource) {
      const geometrySource = source.sources[0][0];
      const chunk = geometrySource.chunks.get('0,0,0');
      if (chunk === undefined || chunk.state !== ChunkState.GPU_MEMORY) {
        return false;
      }
    }
    return true;
  }
}

export const SliceViewAnnotationLayer =
    AnnotationRenderLayer(AnnotationSliceViewRenderLayerBase, 'sliceViewRenderHelper');
