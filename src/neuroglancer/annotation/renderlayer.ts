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

import {AnnotationBase, AnnotationSerializer, AnnotationSource, annotationTypes, formatAnnotationPropertyValue, SerializedAnnotations} from 'neuroglancer/annotation';
import {AnnotationLayerState, OptionalSegmentationDisplayState} from 'neuroglancer/annotation/annotation_layer_state';
import {ANNOTATION_PERSPECTIVE_RENDER_LAYER_UPDATE_SOURCES_RPC_ID, ANNOTATION_RENDER_LAYER_RPC_ID, ANNOTATION_RENDER_LAYER_UPDATE_SEGMENTATION_RPC_ID, ANNOTATION_SPATIALLY_INDEXED_RENDER_LAYER_RPC_ID, forEachVisibleAnnotationChunk} from 'neuroglancer/annotation/base';
import {AnnotationGeometryChunkSource, AnnotationGeometryData, computeNumPickIds, MultiscaleAnnotationSource} from 'neuroglancer/annotation/frontend_source';
import {AnnotationRenderContext, AnnotationRenderHelper, getAnnotationTypeRenderHandler} from 'neuroglancer/annotation/type_handler';
import {ChunkState, LayerChunkProgressInfo} from 'neuroglancer/chunk_manager/base';
import {ChunkManager, ChunkRenderLayerFrontend} from 'neuroglancer/chunk_manager/frontend';
import {LayerView, MouseSelectionState, PickState, VisibleLayerInfo} from 'neuroglancer/layer';
import {DisplayDimensionRenderInfo} from 'neuroglancer/navigation_state';
import {PerspectivePanel} from 'neuroglancer/perspective_view/panel';
import {PerspectiveViewReadyRenderContext, PerspectiveViewRenderContext, PerspectiveViewRenderLayer} from 'neuroglancer/perspective_view/render_layer';
import {ChunkDisplayTransformParameters, ChunkTransformParameters, getChunkDisplayTransformParameters, getChunkPositionFromCombinedGlobalLocalPositions, getLayerDisplayDimensionMapping, RenderLayerTransformOrError} from 'neuroglancer/render_coordinate_transform';
import {RenderScaleHistogram} from 'neuroglancer/render_scale_statistics';
import {ThreeDimensionalReadyRenderContext, VisibilityTrackedRenderLayer} from 'neuroglancer/renderlayer';
import {forEachVisibleSegment, getObjectKey} from 'neuroglancer/segmentation_display_state/base';
import {sendVisibleSegmentsState} from 'neuroglancer/segmentation_display_state/frontend';
import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value';
import {SliceViewProjectionParameters} from 'neuroglancer/sliceview/base';
import {FrontendTransformedSource, getVolumetricTransformedSources, serializeAllTransformedSources} from 'neuroglancer/sliceview/frontend';
import {SliceViewPanelReadyRenderContext, SliceViewPanelRenderContext, SliceViewPanelRenderLayer, SliceViewRenderLayer} from 'neuroglancer/sliceview/renderlayer';
import {crossSectionBoxWireFrameShader, projectionViewBoxWireFrameShader} from 'neuroglancer/sliceview/wire_frame';
import {constantWatchableValue, makeCachedDerivedWatchableValue, NestedStateManager, registerNested, registerNestedSync, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {arraysEqual} from 'neuroglancer/util/array';
import {Borrowed, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {Endianness, ENDIANNESS} from 'neuroglancer/util/endian';
import {ValueOrError} from 'neuroglancer/util/error';
import {mat4} from 'neuroglancer/util/geom';
import {MessageList, MessageSeverity} from 'neuroglancer/util/message_list';
import {AnyConstructor, MixinConstructor} from 'neuroglancer/util/mixin';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';
import {withSharedVisibility} from 'neuroglancer/visibility_priority/frontend';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {ParameterizedContextDependentShaderGetter, parameterizedEmitterDependentShaderGetter} from 'neuroglancer/webgl/dynamic_shader';
import {ShaderBuilder, ShaderModule, ShaderProgram} from 'neuroglancer/webgl/shader';
import {registerSharedObjectOwner, SharedObject} from 'neuroglancer/worker_rpc';

const tempMat = mat4.create();

function segmentationFilter(segmentationStates: readonly OptionalSegmentationDisplayState[]|
                            undefined) {
  if (segmentationStates === undefined) return undefined;
  return (annotation: AnnotationBase) => {
    const {relatedSegments: relatedSegments} = annotation;
    if (relatedSegments === undefined) {
      return false;
    }
    for (let i = 0, count = relatedSegments.length; i < count; ++i) {
      const segmentationState = segmentationStates[i];
      if (segmentationState == null) continue;
      const {visibleSegments, segmentEquivalences} = segmentationState.segmentationGroupState.value;
      for (const segment of relatedSegments[i]) {
        if (visibleSegments.has(segmentEquivalences.get(segment))) {
          return true;
        }
      }
    }
    return false;
  };
}

function serializeAnnotationSet(
    annotationSet: AnnotationSource, filter?: (annotation: AnnotationBase) => boolean) {
  const serializer = new AnnotationSerializer(annotationSet.annotationPropertySerializers);
  for (const annotation of annotationSet) {
    if (filter === undefined || filter(annotation)) {
      serializer.add(annotation);
    }
  }
  return serializer.serialize();
}

@registerSharedObjectOwner(ANNOTATION_RENDER_LAYER_RPC_ID)
class AnnotationLayerSharedObject extends withSharedVisibility
(ChunkRenderLayerFrontend) {
  constructor(
      public chunkManager: Borrowed<ChunkManager>,
      public source: Borrowed<MultiscaleAnnotationSource>,
      public segmentationStates:
          WatchableValueInterface<OptionalSegmentationDisplayState[]|undefined>,
      chunkRenderLayer: LayerChunkProgressInfo) {
    super(chunkRenderLayer);

    this.initializeCounterpart(this.chunkManager.rpc!, {
      chunkManager: this.chunkManager.rpcId,
      source: source.rpcId,
      segmentationStates: this.serializeDisplayState(),
    });

    const update = () => {
      const msg: any = {id: this.rpcId, segmentationStates: this.serializeDisplayState()};
      this.rpc!.invoke(ANNOTATION_RENDER_LAYER_UPDATE_SEGMENTATION_RPC_ID, msg);
    };
    this.registerDisposer(segmentationStates.changed.add(update));
  }

  private serializeDisplayState() {
    const {value: segmentationStates} = this.segmentationStates;
    if (segmentationStates === undefined) return undefined;
    return segmentationStates.map(segmentationState => {
      if (segmentationState == null) return segmentationState;
      return sendVisibleSegmentsState(segmentationState.segmentationGroupState.value);
    });
  }
}

export class AnnotationLayer extends RefCounted {
  layerChunkProgressInfo = new LayerChunkProgressInfo();

  /**
   * Stores a serialized representation of the information needed to render the annotations.
   */
  buffer: Buffer|undefined;

  numPickIds: number = 0;

  /**
   * The value of this.state.annotationSet.changed.count when `buffer` was last updated.
   */
  private generation = -1;

  redrawNeeded = new NullarySignal();
  serializedAnnotations: SerializedAnnotations|undefined = undefined;

  get source() {
    return this.state.source;
  }
  get transform() {
    return this.state.transform;
  }
  get hoverState() {
    return this.state.displayState.hoverState;
  }

  private handleChangeAffectingBuffer = (() => {
    this.generation = -1;
    this.redrawNeeded.dispatch();
  });

  sharedObject: AnnotationLayerSharedObject|undefined;

  get visibility() {
    const {sharedObject} = this;
    if (sharedObject === undefined) {
      return undefined;
    }
    return sharedObject.visibility;
  }

  segmentationStates = this.registerDisposer(makeCachedDerivedWatchableValue(
      (_relationshipStates, _ignoreNullSegmentFilter) => {
        const {displayState, source} = this.state;
        const {relationshipStates} = displayState;
        return displayState.displayUnfiltered.value ?
            undefined :
            source.relationships.map(relationship => {
              const state = relationshipStates.get(relationship);
              return state.showMatches.value ? state.segmentationState.value : undefined;
            });
      },
      [this.state.displayState.relationshipStates, this.state.displayState.ignoreNullSegmentFilter],
      (a, b) => {
        if (a === undefined || b === undefined) {
          return a === b;
        }
        return arraysEqual(a, b);
      }));

  constructor(public chunkManager: ChunkManager, public state: Owned<AnnotationLayerState>) {
    super();
    this.registerDisposer(state);
    this.registerDisposer(this.source.changed.add(this.handleChangeAffectingBuffer));
    this.registerDisposer(registerNested((context, segmentationStates) => {
      this.handleChangeAffectingBuffer();
      if (segmentationStates === undefined) return;
      for (const segmentationState of segmentationStates) {
        if (segmentationState == null) continue;
        context.registerDisposer(registerNestedSync((context, group) => {
          context.registerDisposer(
              group.visibleSegments.changed.add(() => this.handleChangeAffectingBuffer()));
          context.registerDisposer(
              group.segmentEquivalences.changed.add(() => this.handleChangeAffectingBuffer()));
        }, segmentationState.segmentationGroupState));
      }
    }, this.segmentationStates));
    if (!(this.source instanceof AnnotationSource)) {
      this.sharedObject = this.registerDisposer(new AnnotationLayerSharedObject(
          chunkManager, this.source, this.segmentationStates, this.layerChunkProgressInfo));
    }
    const {displayState} = this.state;
    this.registerDisposer(displayState.color.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(displayState.shader.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(displayState.shaderControls.changed.add(this.redrawNeeded.dispatch));
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
        let {buffer} = this;
        if (buffer === undefined) {
          buffer = this.buffer = this.registerDisposer(new Buffer(this.chunkManager.gl));
        }
        this.generation = generation;
        const serializedAnnotations = this.serializedAnnotations =
            serializeAnnotationSet(source, segmentationFilter(this.segmentationStates.value));
        buffer.setData(this.serializedAnnotations.data);
        this.numPickIds = computeNumPickIds(serializedAnnotations);
      }
    }
  }
}

interface AnnotationGeometryDataInterface {
  serializedAnnotations: SerializedAnnotations;
  buffer: Buffer;
  numPickIds: number;
}

interface AnnotationChunkRenderParameters {
  chunkTransform: ChunkTransformParameters;
  chunkDisplayTransform: ChunkDisplayTransformParameters;
  renderSubspaceTransform: Float32Array;
  modelClipBounds: Float32Array;
}

interface AttachmentState {
  chunkTransform: ValueOrError<ChunkTransformParameters>;
  displayDimensionRenderInfo: DisplayDimensionRenderInfo;
  chunkRenderParameters: AnnotationChunkRenderParameters|undefined;
}

interface TransformedAnnotationSource extends
    FrontendTransformedSource<SliceViewRenderLayer, AnnotationGeometryChunkSource> {}

interface SpatiallyIndexedValidAttachmentState extends AttachmentState {
  sources?: NestedStateManager<TransformedAnnotationSource[][]>;
}

function getAnnotationProjectionParameters(chunkDisplayTransform: ChunkDisplayTransformParameters) {
  const {chunkTransform} = chunkDisplayTransform;
  const {unpaddedRank} = chunkTransform.modelTransform;
  const modelClipBounds = new Float32Array(unpaddedRank * 2);
  const renderSubspaceTransform = new Float32Array(unpaddedRank * 3);
  renderSubspaceTransform.fill(0);
  modelClipBounds.fill(1, unpaddedRank);
  const {numChunkDisplayDims, chunkDisplayDimensionIndices} = chunkDisplayTransform;
  for (let i = 0; i < numChunkDisplayDims; ++i) {
    const chunkDim = chunkDisplayDimensionIndices[i];
    modelClipBounds[unpaddedRank + chunkDim] = 0;
    renderSubspaceTransform[chunkDim * 3 + i] = 1;
  }
  return {modelClipBounds, renderSubspaceTransform};
}

function getChunkRenderParameters(
    chunkTransform: ValueOrError<ChunkTransformParameters>,
    displayDimensionRenderInfo: DisplayDimensionRenderInfo,
    messages: MessageList): AnnotationChunkRenderParameters|undefined {
  messages.clearMessages();
  const returnError = (message: string) => {
    messages.addMessage({severity: MessageSeverity.error, message});
    return undefined;
  };
  if (chunkTransform.error !== undefined) {
    return returnError(chunkTransform.error);
  }
  const layerRenderDimensionMapping = getLayerDisplayDimensionMapping(
      chunkTransform.modelTransform, displayDimensionRenderInfo.displayDimensionIndices);
  let chunkDisplayTransform: ChunkDisplayTransformParameters;
  try {
    chunkDisplayTransform =
        getChunkDisplayTransformParameters(chunkTransform, layerRenderDimensionMapping);
  } catch (e) {
    return returnError((e as Error).message);
  }
  const {modelClipBounds, renderSubspaceTransform} =
      getAnnotationProjectionParameters(chunkDisplayTransform);
  return {chunkTransform, chunkDisplayTransform, modelClipBounds, renderSubspaceTransform};
}


function AnnotationRenderLayer<TBase extends AnyConstructor<VisibilityTrackedRenderLayer>>(
    Base: TBase, renderHelperType: 'sliceViewRenderHelper'|'perspectiveViewRenderHelper') {
  class C extends(Base as AnyConstructor<VisibilityTrackedRenderLayer>) {
    curRank: number = -1;
    private renderHelpers: AnnotationRenderHelper[] = [];
    private tempChunkPosition: Float32Array;

    handleRankChanged() {
      const {rank} = this.base.source;
      if (rank === this.curRank) return;
      this.curRank = rank;
      this.tempChunkPosition = new Float32Array(rank);
      const {renderHelpers, gl} = this;
      for (const oldHelper of renderHelpers) {
        oldHelper.dispose();
      }
      const {properties} = this.base.source;
      const {displayState} = this.base.state;
      for (const annotationType of annotationTypes) {
        const handler = getAnnotationTypeRenderHandler(annotationType);
        const renderHelperConstructor = handler[renderHelperType];
        const helper = renderHelpers[annotationType] = new renderHelperConstructor(
            gl, annotationType, rank, properties, displayState.shaderControls,
            displayState.fallbackShaderControls, displayState.shaderError);
        helper.pickIdsPerInstance = handler.pickIdsPerInstance;
        helper.targetIsSliceView = renderHelperType === 'sliceViewRenderHelper';
      }
    }

    constructor(
        public base: Owned<AnnotationLayer>, public renderScaleHistogram: RenderScaleHistogram) {
      super();
      const baseVisibility = base.visibility;
      if (baseVisibility !== undefined) {
        this.registerDisposer(baseVisibility.add(this.visibility));
      }
      this.registerDisposer(this.renderScaleHistogram.visibility.add(this.visibility));
      this.registerDisposer(() => {
        for (const helper of this.renderHelpers) {
          helper.dispose();
        }
      });
      this.role = base.state.role;
      this.registerDisposer(base.redrawNeeded.add(this.redrawNeeded.dispatch));
      this.handleRankChanged();
      this.registerDisposer(this.base.state.displayState.shaderControls.histogramSpecifications
                                .producerVisibility.add(this.visibility));
    }

    attach(attachment: VisibleLayerInfo<LayerView, AttachmentState>) {
      super.attach(attachment);
      this.handleRankChanged();
      const {chunkTransform} = this;
      const displayDimensionRenderInfo = attachment.view.displayDimensionRenderInfo.value;
      attachment.state = {
        chunkTransform,
        displayDimensionRenderInfo,
        chunkRenderParameters: getChunkRenderParameters(
            chunkTransform, displayDimensionRenderInfo, attachment.messages),
      };
    }

    updateAttachmentState(attachment: VisibleLayerInfo<LayerView, AttachmentState>):
        AnnotationChunkRenderParameters|undefined {
      const state = attachment.state!;
      this.handleRankChanged();
      const {chunkTransform} = this;
      const displayDimensionRenderInfo = attachment.view.displayDimensionRenderInfo.value;
      if (state !== undefined && state.chunkTransform === chunkTransform &&
          state.displayDimensionRenderInfo === displayDimensionRenderInfo) {
        return state.chunkRenderParameters;
      }
      state.chunkTransform = chunkTransform;
      state.displayDimensionRenderInfo = displayDimensionRenderInfo;
      const chunkRenderParameters = state.chunkRenderParameters =
          getChunkRenderParameters(chunkTransform, displayDimensionRenderInfo, attachment.messages);
      return chunkRenderParameters;
    }

    get chunkTransform() {
      return this.base.state.chunkTransform.value;
    }

    updateModelClipBounds(
        renderContext: ThreeDimensionalReadyRenderContext, state: AnnotationChunkRenderParameters) {
      const {modelClipBounds} = state;
      const rank = this.curRank;
      const {chunkTransform} = state;
      getChunkPositionFromCombinedGlobalLocalPositions(
          modelClipBounds.subarray(0, rank), renderContext.projectionParameters.globalPosition,
          this.base.state.localPosition.value, chunkTransform.layerRank,
          chunkTransform.combinedGlobalLocalToChunkTransform);
    }

    get gl() {
      return this.base.chunkManager.gl;
    }

    drawGeometryChunkData(
        chunk: AnnotationGeometryData,
        renderContext: PerspectiveViewRenderContext|SliceViewPanelRenderContext,
        state: AnnotationChunkRenderParameters, drawFraction = 1) {
      if (!chunk.bufferValid) {
        let {buffer} = chunk;
        if (buffer === undefined) {
          buffer = chunk.buffer = new Buffer(this.gl);
        }
        const {serializedAnnotations} = chunk;
        buffer.setData(serializedAnnotations.data);
        chunk.numPickIds = computeNumPickIds(serializedAnnotations);
        chunk.bufferValid = true;
      }
      this.drawGeometry(
          chunk as AnnotationGeometryDataInterface, renderContext, state, drawFraction);
    }

    drawGeometry(
        chunk: AnnotationGeometryDataInterface,
        renderContext: PerspectiveViewRenderContext|SliceViewPanelRenderContext,
        state: AnnotationChunkRenderParameters, drawFraction: number = 1) {
      const {base} = this;
      const {chunkDisplayTransform} = state;
      const {serializedAnnotations} = chunk;
      const {typeToIdMaps, typeToOffset} = serializedAnnotations;
      let pickId = 0;
      if (renderContext.emitPickID) {
        pickId = renderContext.pickIDs.register(this, chunk.numPickIds, 0, 0, chunk);
      }
      const hoverValue = base.hoverState.value;
      const modelViewProjectionMatrix = mat4.multiply(
          tempMat, renderContext.projectionParameters.viewProjectionMat,
          chunkDisplayTransform.displaySubspaceModelMatrix);
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
        renderSubspaceModelMatrix: chunkDisplayTransform.displaySubspaceModelMatrix,
        renderSubspaceInvModelMatrix: chunkDisplayTransform.displaySubspaceInvModelMatrix,
        chunkDisplayTransform,
      };
      const computeHistograms =
          this.base.state.displayState.shaderControls.histogramSpecifications.visibleHistograms > 0;
      for (const annotationType of annotationTypes) {
        const idMap = typeToIdMaps[annotationType];
        let count = idMap.size;
        if (count > 0) {
          const handler = getAnnotationTypeRenderHandler(annotationType);
          let selectedIndex = 0xFFFFFFFF;
          if (hoverValue !== undefined) {
            const index = idMap.get(hoverValue.id);
            if (index !== undefined) {
              selectedIndex = index * handler.pickIdsPerInstance;
              // If we wanted to include the partIndex, we would add:
              // selectedIndex += hoverValue.partIndex;
            }
          }
          count = Math.round(count * drawFraction);
          context.count = count;
          context.bufferOffset = typeToOffset[annotationType];
          context.selectedIndex = selectedIndex;
          const renderHelper = this.renderHelpers[annotationType];
          renderHelper.draw(context);
          if (computeHistograms) {
            renderHelper.computeHistograms(context, renderContext.frameNumber);
            renderContext.bindFramebuffer();
          }
          context.basePickId += count * handler.pickIdsPerInstance;
        }
      }
    }

    updateMouseState(
        mouseState: MouseSelectionState, _pickedValue: Uint64, pickedOffset: number, data: any) {
      const chunk = data as AnnotationGeometryDataInterface;
      const {serializedAnnotations} = chunk;
      const {typeToIds, typeToOffset} = serializedAnnotations;
      const rank = this.curRank;
      const chunkTransform = this.chunkTransform;
      if (chunkTransform.error !== undefined) return;
      for (const annotationType of annotationTypes) {
        const ids = typeToIds[annotationType];
        const renderHandler = getAnnotationTypeRenderHandler(annotationType);
        const {pickIdsPerInstance} = renderHandler;
        if (pickedOffset < ids.length * pickIdsPerInstance) {
          const instanceIndex = Math.floor(pickedOffset / pickIdsPerInstance);
          const id = ids[instanceIndex];
          const partIndex = pickedOffset % pickIdsPerInstance;
          mouseState.pickedAnnotationId = id;
          mouseState.pickedAnnotationLayer = this.base.state;
          mouseState.pickedOffset = partIndex;
          mouseState.pickedAnnotationBuffer = serializedAnnotations.data.buffer;
          mouseState.pickedAnnotationType = annotationType;
          mouseState.pickedAnnotationBufferBaseOffset = serializedAnnotations.data.byteOffset +
            typeToOffset[annotationType];
          mouseState.pickedAnnotationIndex = instanceIndex;
          mouseState.pickedAnnotationCount = ids.length;
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
          const propertySerializer = this.base.source.annotationPropertySerializers[annotationType];
          renderHandler.snapPosition(
              chunkPosition, mouseState.pickedAnnotationBuffer,
              mouseState.pickedAnnotationBufferBaseOffset +
                  mouseState.pickedAnnotationIndex * propertySerializer.propertyGroupBytes[0],
              partIndex);
          const globalRank = globalToRenderLayerDimensions.length;
          for (let globalDim = 0; globalDim < globalRank; ++globalDim) {
            const layerDim = globalToRenderLayerDimensions[globalDim];
            if (layerDim === -1) continue;
            let sum = chunkToLayerTransform[(rank + 1) * rank + layerDim];
            for (let chunkDim = 0; chunkDim < rank; ++chunkDim) {
              sum += chunkPosition[chunkDim] *
                  chunkToLayerTransform[chunkDim * (layerRank + 1) + layerDim];
            }
            if (!Number.isFinite(sum)) {
              continue;
            }
            mousePosition[globalDim] = sum;
          }
          return;
        }
        pickedOffset -= ids.length * pickIdsPerInstance;
      }
    }

    transformPickedValue(pickState: PickState) {
      const {pickedAnnotationBuffer} = pickState;
      if (pickedAnnotationBuffer === undefined) return undefined;
      const {properties} = this.base.source;
      if (properties.length === 0) return undefined;
      const {
        pickedAnnotationBufferBaseOffset,
        pickedAnnotationType,
        pickedAnnotationIndex,
        pickedAnnotationCount
      } = pickState;
      const {annotationPropertySerializers} = this.base.source;
      // Check if there are any properties.
      const propertyValues = new Array(properties.length);
      annotationPropertySerializers[pickedAnnotationType!].deserialize(
          new DataView(pickedAnnotationBuffer), pickedAnnotationBufferBaseOffset!,
          pickedAnnotationIndex!, pickedAnnotationCount!,
          /*isLittleEndian=*/ Endianness.LITTLE === ENDIANNESS, propertyValues);
      return formatAnnotationPropertyValue(properties[0], propertyValues[0]);
    }
    isAnnotation = true;
  };
  return C as MixinConstructor<typeof C, TBase>;
}

type AnnotationRenderLayer = InstanceType<ReturnType<typeof AnnotationRenderLayer>>;

const NonSpatiallyIndexedAnnotationRenderLayer =
    <TBase extends {new (...args: any[]): AnnotationRenderLayer}>(Base: TBase) =>
        class C extends Base {
  layerChunkProgressInfo = this.base.layerChunkProgressInfo;
  draw(
      renderContext: PerspectiveViewRenderContext|SliceViewPanelRenderContext,
      attachment: VisibleLayerInfo<LayerView, AttachmentState>) {
    const chunkRenderParameters = this.updateAttachmentState(attachment);
    if (this.curRank === 0 || chunkRenderParameters === undefined) return;
    this.updateModelClipBounds(renderContext, chunkRenderParameters);
    const {source} = this.base;
    if (source instanceof AnnotationSource) {
      const {base} = this;
      base.updateBuffer();
      this.drawGeometry(
          base as AnnotationGeometryDataInterface, renderContext, chunkRenderParameters);
    } else {
      const {renderScaleHistogram} = this;
      renderScaleHistogram.begin(
          this.base.chunkManager.chunkQueueManager.frameNumberCounter.frameNumber);
      this.drawGeometryChunkData(source.temporary.data!, renderContext, chunkRenderParameters);
      const {value: segmentationStates} = this.base.segmentationStates;
      let presentChunks = 0;
      let notPresentChunks = 0;
      if (segmentationStates !== undefined) {
        for (let i = 0, count = segmentationStates.length; i < count; ++i) {
          const segmentationState = segmentationStates[i];
          if (segmentationState == null) continue;
          const chunks = source.segmentFilteredSources[i].chunks;
          forEachVisibleSegment(segmentationState.segmentationGroupState.value, objectId => {
            const key = getObjectKey(objectId);
            const chunk = chunks.get(key);
            if (chunk !== undefined && chunk.state === ChunkState.GPU_MEMORY) {
              const {data} = chunk;
              if (data === undefined) return;
              this.drawGeometryChunkData(data, renderContext, chunkRenderParameters);
              ++presentChunks;
            } else {
              ++notPresentChunks;
            }
          });
        }
      }
      renderScaleHistogram.add(
          Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, presentChunks, notPresentChunks);
    }
  }

  isReady() {
    const {base} = this;
    const {source} = base;
    if (!(source instanceof MultiscaleAnnotationSource)) {
      return true;
    }
    const {value: segmentationStates} = this.base.segmentationStates;
    if (segmentationStates === undefined) return true;
    for (let i = 0, count = segmentationStates.length; i < count; ++i) {
      const segmentationState = segmentationStates[i];
      if (segmentationState === null) return false;
      if (segmentationState === undefined) continue;
      const chunks = source.segmentFilteredSources[i].chunks;
      let missing = false;
      forEachVisibleSegment(segmentationState.segmentationGroupState.value, objectId => {
        const key = getObjectKey(objectId);
        if (!chunks.has(key)) {
          missing = true;
        }
      });
      if (missing) return false;
    }
    return true;
  }
};


const PerspectiveViewAnnotationLayerBase =
    AnnotationRenderLayer(PerspectiveViewRenderLayer, 'perspectiveViewRenderHelper');

export class PerspectiveViewAnnotationLayer extends NonSpatiallyIndexedAnnotationRenderLayer
(PerspectiveViewAnnotationLayerBase) {}

const SpatiallyIndexedAnnotationLayer = <TBase extends AnyConstructor<AnnotationRenderLayer>>(
    Base: TBase) => {
  class SpatiallyIndexedAnnotationLayer extends(Base as AnyConstructor<AnnotationRenderLayer>) {
    renderScaleTarget: WatchableValueInterface<number>;
    constructor(options: {
      annotationLayer: AnnotationLayer,
      renderScaleTarget: WatchableValueInterface<number>,
      renderScaleHistogram: RenderScaleHistogram,
    }) {
      super(options.annotationLayer, options.renderScaleHistogram);
      this.renderScaleTarget = options.renderScaleTarget;
      this.registerDisposer(this.renderScaleTarget.changed.add(this.redrawNeeded.dispatch));
      const sharedObject =
          this.registerDisposer(new ChunkRenderLayerFrontend(this.layerChunkProgressInfo));
      const rpc = this.base.chunkManager.rpc!;
      sharedObject.RPC_TYPE_ID = ANNOTATION_SPATIALLY_INDEXED_RENDER_LAYER_RPC_ID;
      sharedObject.initializeCounterpart(rpc, {
        chunkManager: this.base.chunkManager.rpcId,
        localPosition: this.registerDisposer(SharedWatchableValue.makeFromExisting(
                                                 rpc, this.base.state.localPosition))
                           .rpcId,
        renderScaleTarget: this.registerDisposer(SharedWatchableValue.makeFromExisting(
                                                     rpc, this.renderScaleTarget))
                               .rpcId,
      });
      this.backend = sharedObject;
    }

    backend: SharedObject;

    attach(attachment: VisibleLayerInfo<LayerView, SpatiallyIndexedValidAttachmentState>) {
      super.attach(attachment);
      attachment.state!.sources = attachment.registerDisposer(registerNested(
          (context: RefCounted, transform: RenderLayerTransformOrError,
           displayDimensionRenderInfo: DisplayDimensionRenderInfo) => {
            const transformedSources =
                getVolumetricTransformedSources(
                    displayDimensionRenderInfo, transform,
                    options =>
                        (this.base.state.source as MultiscaleAnnotationSource).getSources(options),
                    attachment.messages, this) as TransformedAnnotationSource[][];
            for (const scales of transformedSources) {
              for (const tsource of scales) {
                context.registerDisposer(tsource.source);
                Object.assign(
                    tsource, getAnnotationProjectionParameters(tsource.chunkDisplayTransform));
              }
            }
            attachment.view.flushBackendProjectionParameters();
            this.backend.rpc!.invoke(ANNOTATION_PERSPECTIVE_RENDER_LAYER_UPDATE_SOURCES_RPC_ID, {
              layer: this.backend.rpcId,
              view: attachment.view.rpcId,
              displayDimensionRenderInfo,
              sources: serializeAllTransformedSources(transformedSources),
            });
            this.redrawNeeded.dispatch();
            return transformedSources;
          },
          this.base.state.transform, attachment.view.displayDimensionRenderInfo));
    }

    wireFrameRenderHelper: typeof crossSectionBoxWireFrameShader =
        (this instanceof SliceViewPanelRenderLayer) ? crossSectionBoxWireFrameShader :
                                                      projectionViewBoxWireFrameShader;

    wireFrameShaderGetter: ParameterizedContextDependentShaderGetter<ShaderModule, undefined> =
        parameterizedEmitterDependentShaderGetter(this, this.gl, {
          memoizeKey: `annotation/wireFrameShader:${this instanceof SliceViewPanelRenderLayer}`,
          parameters: constantWatchableValue(undefined),
          defineShader:
              (builder: ShaderBuilder) => {
                this.wireFrameRenderHelper.defineShader(builder);
              },
        });

    draw(
        renderContext: PerspectiveViewRenderContext|SliceViewPanelRenderContext,
        attachment: VisibleLayerInfo<PerspectivePanel, SpatiallyIndexedValidAttachmentState>) {
      const chunkRenderParameters = this.updateAttachmentState(attachment);
      if (this.curRank === 0 || chunkRenderParameters === undefined) return;
      const transformedSources = attachment.state!.sources!.value;
      if (transformedSources.length === 0) return;
      this.updateModelClipBounds(renderContext, chunkRenderParameters);
      const {renderScaleHistogram} = this;
      renderScaleHistogram.begin(
          this.base.chunkManager.chunkQueueManager.frameNumberCounter.frameNumber);
      const {projectionParameters} = renderContext;
      let wireFrameShader: ShaderProgram|undefined;
      if (renderContext.wireFrame) {
        const {shader} = this.wireFrameShaderGetter(renderContext.emitter);
        if (shader === null) return;
        shader.bind();
        this.wireFrameRenderHelper.initialize(
            shader, projectionParameters as SliceViewProjectionParameters);
        wireFrameShader = shader;
      }
      forEachVisibleAnnotationChunk(
          projectionParameters, this.base.state.localPosition.value, this.renderScaleTarget.value,
          transformedSources[0], () => {},
          (tsource, index, drawFraction, physicalSpacing, pixelSpacing) => {
            index;
            const chunk = tsource.source.chunks.get(tsource.curPositionInChunks.join());
            let present: number;
            if (chunk === undefined || chunk.state !== ChunkState.GPU_MEMORY) {
              present = 0;
            } else {
              const {data} = chunk;
              if (data === undefined) {
                return;
              }
              if (wireFrameShader !== undefined) {
                this.wireFrameRenderHelper.draw(
                    wireFrameShader, tsource,
                    projectionParameters as SliceViewProjectionParameters);
              } else {
                this.drawGeometryChunkData(
                    data, renderContext, chunkRenderParameters, drawFraction);
              }
              present = 1;
            }
            renderScaleHistogram.add(physicalSpacing, pixelSpacing, present, 1 - present);
          });
    }

    isReady(
        renderContext: PerspectiveViewReadyRenderContext|SliceViewPanelReadyRenderContext,
        attachment: VisibleLayerInfo<PerspectivePanel, SpatiallyIndexedValidAttachmentState>) {
      const chunkRenderParameters = this.updateAttachmentState(attachment);
      if (this.curRank === 0 || chunkRenderParameters === undefined) return;
      const transformedSources = attachment.state!.sources!.value;
      if (transformedSources.length === 0) return;
      this.updateModelClipBounds(renderContext, chunkRenderParameters);
      const {projectionParameters} = renderContext;
      let present = true;
      forEachVisibleAnnotationChunk(
          projectionParameters, this.base.state.localPosition.value, this.renderScaleTarget.value,
          transformedSources[0], () => {},
          (tsource, index, drawFraction, physicalSpacing, pixelSpacing) => {
            index;
            drawFraction;
            physicalSpacing;
            pixelSpacing;
            const chunk = tsource.source.chunks.get(tsource.curPositionInChunks.join());
            if (chunk === undefined || chunk.state !== ChunkState.GPU_MEMORY) {
              present = false;
              return;
            }
          });
      return present;
    }
  };
  return SpatiallyIndexedAnnotationLayer as
      MixinConstructor<typeof SpatiallyIndexedAnnotationLayer, TBase>;
};

export const SpatiallyIndexedPerspectiveViewAnnotationLayer =
    SpatiallyIndexedAnnotationLayer(PerspectiveViewAnnotationLayerBase);

export const SpatiallyIndexedSliceViewAnnotationLayer = SpatiallyIndexedAnnotationLayer(
    AnnotationRenderLayer(SliceViewPanelRenderLayer, 'sliceViewRenderHelper'));

export const SliceViewAnnotationLayer = NonSpatiallyIndexedAnnotationRenderLayer(
    AnnotationRenderLayer(SliceViewPanelRenderLayer, 'sliceViewRenderHelper'));
