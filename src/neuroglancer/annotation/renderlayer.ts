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

import {AnnotationBase, AnnotationSource, annotationTypes, getAnnotationTypeHandler} from 'neuroglancer/annotation';
import {AnnotationLayerState} from 'neuroglancer/annotation/annotation_layer_state';
import {ANNOTATION_PERSPECTIVE_RENDER_LAYER_RPC_ID, ANNOTATION_RENDER_LAYER_RPC_ID, ANNOTATION_RENDER_LAYER_UPDATE_SEGMENTATION_RPC_ID} from 'neuroglancer/annotation/base';
import {AnnotationGeometryData, MultiscaleAnnotationSource} from 'neuroglancer/annotation/frontend_source';
import {AnnotationRenderContext, AnnotationRenderHelper, getAnnotationTypeRenderHandler} from 'neuroglancer/annotation/type_handler';
import {ChunkState} from 'neuroglancer/chunk_manager/base';
import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {MouseSelectionState, VisibleLayerInfo} from 'neuroglancer/layer';
import {DisplayDimensions} from 'neuroglancer/navigation_state';
import {PerspectiveViewRenderContext, PerspectiveViewRenderLayer} from 'neuroglancer/perspective_view/render_layer';
import {ChunkDisplayTransformParameters, ChunkTransformParameters, getChunkPositionFromCombinedGlobalLocalPositions, getChunkDisplayTransformParameters, getLayerDisplayDimensionMapping} from 'neuroglancer/render_coordinate_transform';
import {ThreeDimensionalRenderContext, VisibilityTrackedRenderLayer} from 'neuroglancer/renderlayer';
import {forEachVisibleSegment, getObjectKey} from 'neuroglancer/segmentation_display_state/base';
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value';
import {SliceViewPanelRenderLayer} from 'neuroglancer/sliceview/renderlayer';
import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {binarySearch} from 'neuroglancer/util/array';
import {Borrowed, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {ValueOrError} from 'neuroglancer/util/error';
import {mat4} from 'neuroglancer/util/geom';
import {MessageSeverity} from 'neuroglancer/util/message_list';
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
  const {rank} = annotationSet;
  const typeToOffset: number[] = [];
  for (const annotationType of annotationTypes) {
    typeToOffset[annotationType] = totalBytes;
    const count = typeToIds[annotationType].length;
    const renderHandler = getAnnotationTypeRenderHandler(annotationType);
    const handler = getAnnotationTypeHandler(annotationType);
    totalBytes += count * handler.serializedBytes(rank);
    numPickIds += renderHandler.pickIdsPerInstance * count;
  }
  const data = new ArrayBuffer(totalBytes);
  for (const annotationType of annotationTypes) {
    const ids = typeToIds[annotationType];
    const handler = getAnnotationTypeHandler(annotationType);
    const serializer = handler.serializer(data, typeToOffset[annotationType], ids.length, rank);
    ids.forEach((id, index) => serializer(annotationSet.get(id)!, index));
  }
  return {typeToIds, typeToOffset, data, numPickIds};
}

@registerSharedObjectOwner(ANNOTATION_RENDER_LAYER_RPC_ID)
class AnnotationLayerSharedObject extends withSharedVisibility
(SharedObject) {
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
    return this.state.displayState.hoverState;
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
    if (this.state.displayState.filterBySegmentation.value) {
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
    this.registerDisposer(
        state.displayState.filterBySegmentation.changed.add(this.handleChangeAffectingBuffer));
    this.registerDisposer(() => this.unregisterSegmentationState());
    this.registerDisposer(state.displayState.segmentationState.changed.add(() => {
      const segmentationState = state.displayState.segmentationState.value;
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
          chunkManager, this.source, state.displayState.segmentationState,
          state.displayState.filterBySegmentation));
    }
    this.registerDisposer(this.state.displayState.color.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(
        this.state.displayState.fillOpacity.changed.add(this.redrawNeeded.dispatch));
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
            this.state.displayState.filterBySegmentation.value ?
                segmentationFilter(this.segmentationState) :
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

interface AttachmentStateBase {
  chunkTransform: ValueOrError<ChunkTransformParameters>;
  displayDimensions: DisplayDimensions;
  valid: boolean;
}

interface ValidAttachmentState extends AttachmentStateBase {
  valid: true;
  chunkTransform: ChunkTransformParameters;
  chunkRenderTransform: ChunkDisplayTransformParameters;
  renderSubspaceTransform: Float32Array;
  modelClipBounds: Float32Array;
}

type AttachmentState = AttachmentStateBase|ValidAttachmentState;

function AnnotationRenderLayer<TBase extends {
  new (...args: any[]): VisibilityTrackedRenderLayer &
  {
    base: AnnotationLayer
  }
}>(Base: TBase, renderHelperType: 'sliceViewRenderHelper'|'perspectiveViewRenderHelper') {
  class C extends Base {
    base: AnnotationLayer;
    private curRank: number = -1;
    private renderHelpers: AnnotationRenderHelper[] = [];
    private tempChunkPosition: Float32Array;

    private handleRankChanged() {
      const {rank} = this.base.source;
      if (rank === this.curRank) return;
      this.curRank = rank;
      this.tempChunkPosition = new Float32Array(rank);
      const {renderHelpers, gl} = this;
      for (const oldHelper of renderHelpers) {
        oldHelper.dispose();
      }
      for (const annotationType of annotationTypes) {
        const handler = getAnnotationTypeRenderHandler(annotationType);
        const renderHelperConstructor = handler[renderHelperType];
        const helper = renderHelpers[annotationType] = new renderHelperConstructor(gl, rank);
        helper.pickIdsPerInstance = handler.pickIdsPerInstance;
        helper.targetIsSliceView = renderHelperType === 'sliceViewRenderHelper';
      }
    }

    constructor(...args: any[]) {
      super(...args);
      const base = this.registerDisposer(this.base);
      const baseVisibility = base.visibility;
      if (baseVisibility !== undefined) {
        this.registerDisposer(baseVisibility.add(this.visibility));
      }
      this.registerDisposer(() => {
        for (const helper of this.renderHelpers) {
          helper.dispose();
        }
      });
      this.role = base.state.role;
      this.registerDisposer(base.redrawNeeded.add(this.redrawNeeded.dispatch));
      this.handleRankChanged();
    }

    get chunkTransform() {
      return this.base.state.chunkTransform.value;
    }

    private updateAttachmentState(
        attachment: VisibleLayerInfo<AttachmentState>,
        displayDimensions: DisplayDimensions): boolean {
      this.handleRankChanged();
      let {state} = attachment;
      const {chunkTransform} = this;
      if (state !== undefined && state.chunkTransform === chunkTransform &&
          state.displayDimensions === displayDimensions) {
        return state.valid;
      }
      attachment.messages.clearMessages();
      const returnError = (message: string) => {
        attachment.messages.addMessage({severity: MessageSeverity.error, message});
        attachment.state = {chunkTransform, displayDimensions, valid: false};
        return false;
      };
      if (chunkTransform.error !== undefined) {
        return returnError(chunkTransform.error);
      }
      const {unpaddedRank} = chunkTransform.modelTransform;
      const modelClipBounds = new Float32Array(unpaddedRank * 2);
      const renderSubspaceTransform = new Float32Array(unpaddedRank * 3);
      const layerRenderDimensionMapping = getLayerDisplayDimensionMapping(
          chunkTransform.modelTransform, displayDimensions.dimensionIndices);
      let chunkRenderTransform: ChunkDisplayTransformParameters;
      try {
        chunkRenderTransform =
            getChunkDisplayTransformParameters(chunkTransform, layerRenderDimensionMapping);
      } catch (e) {
        return returnError((e as Error).message);
      }
      renderSubspaceTransform.fill(0);
      modelClipBounds.fill(1, unpaddedRank);
      const {numChunkDisplayDims, chunkDisplayDimensionIndices} = chunkRenderTransform;
      for (let i = 0; i < numChunkDisplayDims; ++i) {
        const chunkDim = chunkDisplayDimensionIndices[i];
        modelClipBounds[unpaddedRank + chunkDim] = 0;
        renderSubspaceTransform[chunkDim * 3 + i] = 1;
      }
      attachment.state = {
        chunkTransform,
        displayDimensions,
        valid: true,
        modelClipBounds,
        renderSubspaceTransform,
        chunkRenderTransform
      };
      return true;
    }

    private updateModelClipBounds(
        renderContext: ThreeDimensionalRenderContext, state: ValidAttachmentState) {
      const {modelClipBounds} = state;
      const rank = this.curRank;
      const {chunkTransform} = state;
      getChunkPositionFromCombinedGlobalLocalPositions(
          modelClipBounds.subarray(0, rank), renderContext.globalPosition,
          this.base.state.localPosition.value, chunkTransform.layerRank,
          chunkTransform.combinedGlobalLocalToChunkTransform);
    }

    get gl() {
      return this.base.chunkManager.gl;
    }

    drawGeometryChunkData(
        chunk: AnnotationGeometryData, renderContext: PerspectiveViewRenderContext,
        state: ValidAttachmentState) {
      if (!chunk.bufferValid) {
        let {buffer} = chunk;
        if (buffer === undefined) {
          buffer = chunk.buffer = new Buffer(this.gl);
        }
        buffer.setData(chunk.data!);
        chunk.bufferValid = true;
      }
      this.drawGeometry(chunk, renderContext, state);
    }

    drawGeometry(
        chunk: AnnotationGeometryDataInterface, renderContext: PerspectiveViewRenderContext,
        state: ValidAttachmentState) {
      const {base} = this;
      const {chunkRenderTransform} = state;
      const typeToIds = chunk.typeToIds!;
      const typeToOffset = chunk.typeToOffset!;
      let pickId = 0;
      if (renderContext.emitPickID) {
        pickId = renderContext.pickIDs.register(this, chunk.numPickIds, 0, 0, chunk);
      }
      const hoverValue = base.hoverState.value;
      const modelViewProjectionMatrix = mat4.multiply(
          tempMat, renderContext.viewProjectionMat, chunkRenderTransform.displaySubspaceModelMatrix);
      const context: AnnotationRenderContext = {
        annotationLayer: base,
        renderContext,
        selectedIndex: 0,
        basePickId: pickId,
        buffer: chunk.buffer!,
        bufferOffset: 0,
        count: 0,
        modelViewProjectionMatrix,
        modelClipBounds: state.modelClipBounds,
        subspaceMatrix: state.renderSubspaceTransform,
        renderSubspaceModelMatrix: chunkRenderTransform.displaySubspaceModelMatrix,
        renderSubspaceInvModelMatrix: chunkRenderTransform.displaySubspaceInvModelMatrix,
      };

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
          context.count = count;
          context.bufferOffset = typeToOffset[annotationType];
          context.selectedIndex = selectedIndex;
          this.renderHelpers[annotationType].draw(context);
          context.basePickId += count * handler.pickIdsPerInstance;
        }
      }
    }

    draw(
        renderContext: PerspectiveViewRenderContext,
        attachment: VisibleLayerInfo<AttachmentState>) {
      if (!this.updateAttachmentState(attachment, renderContext.displayDimensions)) return;
      if (this.curRank === 0) return;
      const state = attachment.state as ValidAttachmentState;
      this.updateModelClipBounds(renderContext, state);
      const {source} = this.base;
      if (source instanceof AnnotationSource) {
        const {base} = this;
        base.updateBuffer();
        this.drawGeometry(base, renderContext, state);
      } else {
        this.drawGeometryChunkData(source.temporary.data!, renderContext, state);
        if (this.base.state.displayState.filterBySegmentation.value) {
          const segmentationState = this.base.state.displayState.segmentationState.value;
          if (segmentationState == null) {
            return;
          }
          const chunks = source.segmentFilteredSource.chunks;
          forEachVisibleSegment(segmentationState, objectId => {
            const key = getObjectKey(objectId);
            const chunk = chunks.get(key);
            if (chunk !== undefined) {
              this.drawGeometryChunkData(chunk.data!, renderContext, state);
            }
          });
        } else {
          for (const alternatives of source.sources) {
            for (const {chunkSource: geometrySource} of alternatives) {
              for (const chunk of geometrySource.chunks.values()) {
                if (chunk.state !== ChunkState.GPU_MEMORY) {
                  continue;
                }
                this.drawGeometryChunkData(chunk.data!, renderContext, state);
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
      const rank = this.curRank;
      const chunkTransform = this.chunkTransform;
      if (chunkTransform.error !== undefined) return;
      for (const annotationType of annotationTypes) {
        const ids = typeToIds[annotationType];
        const renderHandler = getAnnotationTypeRenderHandler(annotationType);
        const handler = getAnnotationTypeHandler(annotationType);
        const {pickIdsPerInstance} = renderHandler;
        if (pickedOffset < ids.length * pickIdsPerInstance) {
          const instanceIndex = Math.floor(pickedOffset / pickIdsPerInstance);
          const id = ids[instanceIndex];
          const partIndex = pickedOffset % pickIdsPerInstance;
          mouseState.pickedAnnotationId = id;
          mouseState.pickedAnnotationLayer = this.base.state;
          mouseState.pickedOffset = partIndex;
          mouseState.pickedAnnotationBuffer = chunk.data!.buffer;
          mouseState.pickedAnnotationBufferOffset = chunk.data!.byteOffset +
              typeToOffset[annotationType] + instanceIndex * handler.serializedBytes(rank);
          const chunkPosition = this.tempChunkPosition;
          const {chunkToLayerTransform, combinedGlobalLocalToChunkTransform, layerRank} =
              chunkTransform;
          const {globalToRenderLayerDimensions} = chunkTransform.modelTransform;
          const {position: mousePosition} = mouseState;
          if (!getChunkPositionFromCombinedGlobalLocalPositions(
                  chunkPosition, mousePosition, this.base.state.localPosition.value, layerRank,
                  combinedGlobalLocalToChunkTransform)) {
            return;
          }
          renderHandler.snapPosition(
              chunkPosition, mouseState.pickedAnnotationBuffer,
              mouseState.pickedAnnotationBufferOffset, partIndex);
          const globalRank = globalToRenderLayerDimensions.length;
          for (let globalDim = 0; globalDim < globalRank; ++globalDim) {
            const layerDim = globalToRenderLayerDimensions[globalDim];
            if (layerDim === -1) continue;
            let sum = chunkToLayerTransform[(rank + 1) * rank + layerDim];
            for (let chunkDim = 0; chunkDim < rank; ++chunkDim) {
              sum +=
                  chunkPosition[chunkDim] * chunkToLayerTransform[chunkDim * (layerRank + 1) + layerDim];
            }
            mousePosition[globalDim] = sum;
          }
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
      if (!base.state.displayState.filterBySegmentation.value) {
        return true;
      }

      const segmentationState = this.base.state.displayState.segmentationState.value;
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
        filterBySegmentation:
            this.registerDisposer(SharedWatchableValue.makeFromExisting(
                                      rpc, this.base.state.displayState.filterBySegmentation))
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
      if (!base.state.displayState.filterBySegmentation.value) {
        const geometrySource = source.sources[0][0];
        const chunk = geometrySource.chunkSource.chunks.get('0,0,0');
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
