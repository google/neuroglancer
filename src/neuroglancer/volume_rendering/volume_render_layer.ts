/**
 * @license
 * Copyright 2020 Google Inc.
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
import {ChunkState} from 'neuroglancer/chunk_manager/base';
import {ChunkRenderLayerFrontend} from 'neuroglancer/chunk_manager/frontend';
import {CoordinateSpace} from 'neuroglancer/coordinate_transform';
import {VisibleLayerInfo} from 'neuroglancer/layer';
import {PerspectivePanel} from 'neuroglancer/perspective_view/panel'; import {PerspectiveViewReadyRenderContext, PerspectiveViewRenderContext, PerspectiveViewRenderLayer} from 'neuroglancer/perspective_view/render_layer'; import {RenderLayerTransformOrError} from 'neuroglancer/render_coordinate_transform'; import {RenderScaleHistogram} from 'neuroglancer/render_scale_statistics';
import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value';
import {getNormalizedChunkLayout} from 'neuroglancer/sliceview/base';
import {FrontendTransformedSource, getVolumetricTransformedSources, serializeAllTransformedSources} from 'neuroglancer/sliceview/frontend';
import {SliceViewRenderLayer} from 'neuroglancer/sliceview/renderlayer';
import {ChunkFormat, defineChunkDataShaderAccess, MultiscaleVolumeChunkSource, VolumeChunk, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {makeCachedDerivedWatchableValue, NestedStateManager, registerNested, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {getFrustrumPlanes, mat4, vec3} from 'neuroglancer/util/geom';
import {getObjectId} from 'neuroglancer/util/object_id';
import {forEachVisibleVolumeRenderingChunk, getVolumeRenderingNearFarBounds, VOLUME_RENDERING_RENDER_LAYER_RPC_ID, VOLUME_RENDERING_RENDER_LAYER_UPDATE_SOURCES_RPC_ID, volumeRenderingDepthSamples} from 'neuroglancer/volume_rendering/base';
import {glsl_COLOR_EMITTERS, glsl_VERTEX_SHADER} from 'src/neuroglancer/volume_rendering/glsl';
import {SHADER_FUNCTIONS, TrackableShaderModeValue, SHADER_MODES} from 'neuroglancer/volume_rendering/trackable_shader_mode';
import {drawBoxes, glsl_getBoxFaceVertexPosition} from 'neuroglancer/webgl/bounding_box';
import {glsl_COLORMAPS} from 'neuroglancer/webgl/colormaps';
import {ParameterizedContextDependentShaderGetter, parameterizedContextDependentShaderGetter, ParameterizedShaderGetterResult, shaderCodeWithLineDirective, WatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {ShaderModule, ShaderProgram} from 'neuroglancer/webgl/shader';
import {addControlsToBuilder, setControlsInShader, ShaderControlsBuilderState, ShaderControlState} from 'neuroglancer/webgl/shader_ui_controls';
import {defineVertexId, VertexIdHelper} from 'neuroglancer/webgl/vertex_id';

interface TransformedVolumeSource extends
    FrontendTransformedSource<SliceViewRenderLayer, VolumeChunkSource> {}

interface VolumeRenderingAttachmentState {
  sources: NestedStateManager<TransformedVolumeSource[][]>;
}

export interface VolumeRenderingRenderLayerOptions {
  multiscaleSource: MultiscaleVolumeChunkSource;
  transform: WatchableValueInterface<RenderLayerTransformOrError>;
  shaderError: WatchableShaderError;
  shaderControlState: ShaderControlState;
  channelCoordinateSpace: WatchableValueInterface<CoordinateSpace>;
  localPosition: WatchableValueInterface<Float32Array>;
  renderScaleTarget: WatchableValueInterface<number>;
  renderScaleHistogram: RenderScaleHistogram;
  shaderSelection: TrackableShaderModeValue;
}

const tempMat4 = mat4.create();
const tempVisibleVolumetricClippingPlanes = new Float32Array(24);

interface VolumeRenderingShaderParameters {
  numChannelDimensions: number;
  selectedShader: SHADER_MODES;
}

export class VolumeRenderingRenderLayer extends PerspectiveViewRenderLayer {
  multiscaleSource: MultiscaleVolumeChunkSource;
  transform: WatchableValueInterface<RenderLayerTransformOrError>;
  channelCoordinateSpace: WatchableValueInterface<CoordinateSpace>;
  localPosition: WatchableValueInterface<Float32Array>;
  shaderControlState: ShaderControlState;
  renderScaleTarget: WatchableValueInterface<number>;
  renderScaleHistogram: RenderScaleHistogram;
  shaderSelection: TrackableShaderModeValue;
  backend: ChunkRenderLayerFrontend;
  private vertexIdHelper: VertexIdHelper;

  private shaderGetter: ParameterizedContextDependentShaderGetter<
      {emitter: ShaderModule, chunkFormat: ChunkFormat}, ShaderControlsBuilderState, VolumeRenderingShaderParameters>;

  get gl() {
    return this.multiscaleSource.chunkManager.gl;
  }

  get isTransparent() {
    return true;
  }

  get isVolumeRendering() {
    return true;
  }

  constructor(options: VolumeRenderingRenderLayerOptions) {
    super();
    this.multiscaleSource = options.multiscaleSource;
    this.transform = options.transform;
    this.channelCoordinateSpace = options.channelCoordinateSpace;
    this.shaderControlState = options.shaderControlState;
    this.localPosition = options.localPosition;
    this.renderScaleTarget = options.renderScaleTarget;
    this.renderScaleHistogram = options.renderScaleHistogram;
    this.shaderSelection = options.shaderSelection;
    this.registerDisposer(this.renderScaleHistogram.visibility.add(this.visibility));
    const extraParameters = this.registerDisposer(
        makeCachedDerivedWatchableValue(
          (space: CoordinateSpace, selectedShader: SHADER_MODES) => ({numChannelDimensions: space.rank, selectedShader: selectedShader}), 
        [this.channelCoordinateSpace, this.shaderSelection]));

    this.shaderGetter = parameterizedContextDependentShaderGetter(this, this.gl, {
      memoizeKey: 'VolumeRenderingRenderLayer',
      parameters: options.shaderControlState.builderState,
      getContextKey: ({emitter, chunkFormat}) => `${getObjectId(emitter)}:${chunkFormat.shaderKey}`,
      shaderError: options.shaderError,
      // extraParameters: new AggregateWatchableValue(
        // refCounted => ({,
      extraParameters: extraParameters,
      defineShader: (builder, {emitter, chunkFormat}, shaderBuilderState, shaderParametersState) => {
        if (shaderBuilderState.parseResult.errors.length !== 0) {
          throw new Error('Invalid UI control specification');
        }
        defineVertexId(builder);
        builder.addFragmentCode(`
#define VOLUME_RENDERING true
`);

        emitter(builder);
        // Near limit in [0, 1] as fraction of full limit.
        builder.addUniform('highp float', 'uNearLimitFraction');
        // Far limit in [0, 1] as fraction of full limit.
        builder.addUniform('highp float', 'uFarLimitFraction');
        builder.addUniform('highp int', 'uMaxSteps');

        // Specifies translation of the current chunk.
        builder.addUniform('highp vec3', 'uTranslation');

        // Matrix by which computed vertices will be transformed.
        builder.addUniform('highp mat4', 'uModelViewProjectionMatrix');
        builder.addUniform('highp mat4', 'uInvModelViewProjectionMatrix');

        // Chunk size in voxels.
        builder.addUniform('highp vec3', 'uChunkDataSize');
        builder.addUniform('highp float', 'uChunkNumber');

        builder.addUniform('highp vec3', 'uLowerClipBound');
        builder.addUniform('highp vec3', 'uUpperClipBound');

        builder.addUniform('highp float', 'uBrightnessFactor');
        builder.addVarying('highp vec4', 'vNormalizedPosition');
        builder.addVertexCode(glsl_getBoxFaceVertexPosition);

        builder.setVertexMain(glsl_VERTEX_SHADER);
        builder.addFragmentCode(`
vec3 curChunkPosition;
vec4 outputColor;
float maxValue;
void userMain();
`);
        const numChannelDimensions = shaderParametersState.numChannelDimensions;
        defineChunkDataShaderAccess(builder, chunkFormat, numChannelDimensions, `curChunkPosition`);
        builder.addFragmentCode(glsl_COLOR_EMITTERS);
        const fragmentShader = SHADER_FUNCTIONS.get(shaderParametersState.selectedShader);
        if (fragmentShader === undefined) {
          throw new Error(`Invalid shader selection: ${shaderParametersState.selectedShader}}`);
        }
        builder.setFragmentMainFunction(fragmentShader);
        builder.addFragmentCode(glsl_COLORMAPS);
        addControlsToBuilder(shaderBuilderState, builder);
        builder.addFragmentCode(
            `\n#define main userMain\n` +
            shaderCodeWithLineDirective(shaderBuilderState.parseResult.code) + `\n#undef main\n`);
      },
    });
    this.vertexIdHelper = this.registerDisposer(VertexIdHelper.get(this.gl));

    this.registerDisposer(this.renderScaleTarget.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(this.shaderControlState.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(this.localPosition.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(this.transform.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(this.shaderSelection.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(
        this.shaderControlState.fragmentMain.changed.add(this.redrawNeeded.dispatch));
    const {chunkManager} = this.multiscaleSource;
    const sharedObject =
        this.registerDisposer(new ChunkRenderLayerFrontend(this.layerChunkProgressInfo));
    const rpc = chunkManager.rpc!;
    sharedObject.RPC_TYPE_ID = VOLUME_RENDERING_RENDER_LAYER_RPC_ID;
    sharedObject.initializeCounterpart(rpc, {
      chunkManager: chunkManager.rpcId,
      localPosition:
          this.registerDisposer(SharedWatchableValue.makeFromExisting(rpc, this.localPosition))
              .rpcId,
      renderScaleTarget:
          this.registerDisposer(SharedWatchableValue.makeFromExisting(rpc, this.renderScaleTarget))
              .rpcId,
    });
    this.backend = sharedObject;
  }

  get dataType() {
    return this.multiscaleSource.dataType;
  }

  attach(attachment: VisibleLayerInfo<PerspectivePanel, VolumeRenderingAttachmentState>) {
    super.attach(attachment);
    attachment.state = {
      sources: attachment.registerDisposer(registerNested(
          (context, transform, displayDimensionRenderInfo) => {
            const transformedSources =
                getVolumetricTransformedSources(
                    displayDimensionRenderInfo, transform,
                    options => this.multiscaleSource.getSources(options), attachment.messages,
                    this) as TransformedVolumeSource[][];
            for (const scales of transformedSources) {
              for (const tsource of scales) {
                context.registerDisposer(tsource.source);
              }
            }
            attachment.view.flushBackendProjectionParameters();
            this.backend.rpc!.invoke(VOLUME_RENDERING_RENDER_LAYER_UPDATE_SOURCES_RPC_ID, {
              layer: this.backend.rpcId,
              view: attachment.view.rpcId,
              sources: serializeAllTransformedSources(transformedSources),
            });
            this.redrawNeeded.dispatch();
            return transformedSources;
          },
          this.transform, attachment.view.displayDimensionRenderInfo)),
    };
  }

  get chunkManager() {
    return this.multiscaleSource.chunkManager;
  }

  draw(
      renderContext: PerspectiveViewRenderContext,
      attachment: VisibleLayerInfo<PerspectivePanel, VolumeRenderingAttachmentState>) {
    if (!renderContext.emitColor) return;
    const allSources = attachment.state!.sources.value;
    if (allSources.length === 0) return;
    let curPhysicalSpacing: number = 0;
    let curPixelSpacing: number = 0;
    let shader: ShaderProgram|null = null;
    let prevChunkFormat: ChunkFormat|undefined|null;
    let shaderResult: ParameterizedShaderGetterResult<ShaderControlsBuilderState, VolumeRenderingShaderParameters>;
    // Size of chunk (in voxels) in the "display" subspace of the chunk coordinate space.
    const chunkDataDisplaySize = vec3.create();

    const {gl} = this;
    this.vertexIdHelper.enable();

    const {renderScaleHistogram} = this;
    renderScaleHistogram.begin(this.chunkManager.chunkQueueManager.frameNumberCounter.frameNumber);

    const endShader = () => {
      if (shader === null) return;
      if (prevChunkFormat !== null) {
        prevChunkFormat!.endDrawing(gl, shader);
      }
      if (presentCount !== 0 || notPresentCount !== 0) {
        renderScaleHistogram.add(
            curPhysicalSpacing, curPixelSpacing, presentCount, notPresentCount);
      }
    };
    let newSource = true;

    const {projectionParameters} = renderContext;

    let chunks: Map<string, VolumeChunk>;
    let presentCount = 0, notPresentCount = 0;
    let chunkDataSize: Uint32Array|undefined;
    let chunkNumber = 1;

    const chunkRank = this.multiscaleSource.rank;
    const chunkPosition = vec3.create();

    gl.enable(WebGL2RenderingContext.CULL_FACE);
    gl.cullFace(WebGL2RenderingContext.FRONT);

    forEachVisibleVolumeRenderingChunk(
        renderContext.projectionParameters, this.localPosition.value, this.renderScaleTarget.value,
        allSources[0],
        (transformedSource, _, physicalSpacing, pixelSpacing) => {
          curPhysicalSpacing = physicalSpacing;
          curPixelSpacing = pixelSpacing;
          const chunkLayout =
              getNormalizedChunkLayout(projectionParameters, transformedSource.chunkLayout);
          const source = transformedSource.source as VolumeChunkSource;
          const {fixedPositionWithinChunk, chunkDisplayDimensionIndices} = transformedSource;
          for (const chunkDim of chunkDisplayDimensionIndices) {
            fixedPositionWithinChunk[chunkDim] = 0;
          }
          const chunkFormat = source.chunkFormat;
          if (chunkFormat !== prevChunkFormat) {
            prevChunkFormat = chunkFormat;
            endShader();
            shaderResult =
                this.shaderGetter({emitter: renderContext.emitter, chunkFormat: chunkFormat!});
            shader = shaderResult.shader;
            if (shader !== null) {
              shader.bind();
              if (chunkFormat !== null) {
                setControlsInShader(
                    gl, shader, this.shaderControlState,
                    shaderResult.parameters.parseResult.controls);
                chunkFormat.beginDrawing(gl, shader);
                chunkFormat.beginSource(gl, shader);
              }
            }
          }
          chunkDataSize = undefined;
          if (shader === null) return;
          chunks = source.chunks;
          chunkDataDisplaySize.fill(1);

          // Compute projection matrix that transforms chunk layout coordinates to device
          // coordinates.
          const modelViewProjection = mat4.multiply(
              tempMat4, projectionParameters.viewProjectionMat, chunkLayout.transform);
          gl.uniformMatrix4fv(
              shader.uniform('uModelViewProjectionMatrix'), false, modelViewProjection);
          const clippingPlanes = tempVisibleVolumetricClippingPlanes;
          getFrustrumPlanes(clippingPlanes, modelViewProjection);
          mat4.invert(modelViewProjection, modelViewProjection);
          gl.uniformMatrix4fv(
              shader.uniform('uInvModelViewProjectionMatrix'), false, modelViewProjection);
          const {near, far, adjustedNear, adjustedFar} = getVolumeRenderingNearFarBounds(
              clippingPlanes, transformedSource.lowerClipDisplayBound,
              transformedSource.upperClipDisplayBound);
          const step = (adjustedFar - adjustedNear) / (volumeRenderingDepthSamples - 1);
          const brightnessFactor = step / (far - near);
          gl.uniform1f(shader.uniform('uBrightnessFactor'), brightnessFactor);
          const nearLimitFraction = (adjustedNear - near) / (far - near);
          const farLimitFraction = (adjustedFar - near) / (far - near);
          gl.uniform1f(shader.uniform('uNearLimitFraction'), nearLimitFraction);
          gl.uniform1f(shader.uniform('uFarLimitFraction'), farLimitFraction);
          gl.uniform1i(shader.uniform('uMaxSteps'), volumeRenderingDepthSamples);
          gl.uniform3fv(shader.uniform('uLowerClipBound'), transformedSource.lowerClipDisplayBound);
          gl.uniform3fv(shader.uniform('uUpperClipBound'), transformedSource.upperClipDisplayBound);
        },
        transformedSource => {
          if (shader === null) return;
          const key = transformedSource.curPositionInChunks.join();
          const chunk = chunks.get(key);
          if (chunk !== undefined && chunk.state === ChunkState.GPU_MEMORY) {
            const originalChunkSize = transformedSource.chunkLayout.size;
            let newChunkDataSize = chunk.chunkDataSize;
            const {
              chunkDisplayDimensionIndices,
              fixedPositionWithinChunk,
              chunkTransform: {channelToChunkDimensionIndices}
            } = transformedSource;
            const {} = transformedSource;
            const normChunkNumber = chunkNumber / chunks.size;
            gl.uniform1f(shader.uniform('uChunkNumber'), normChunkNumber);
            ++chunkNumber;
            if (newChunkDataSize !== chunkDataSize) {
              chunkDataSize = newChunkDataSize;

              for (let i = 0; i < 3; ++i) {
                const chunkDim = chunkDisplayDimensionIndices[i];
                chunkDataDisplaySize[i] =
                    (chunkDim === -1 || chunkDim >= chunkRank) ? 1 : chunkDataSize[chunkDim];
              }
              gl.uniform3fv(shader.uniform('uChunkDataSize'), chunkDataDisplaySize);
            }
            const {chunkGridPosition} = chunk;
            for (let i = 0; i < 3; ++i) {
              const chunkDim = chunkDisplayDimensionIndices[i];
              chunkPosition[i] = (chunkDim === -1 || chunkDim >= chunkRank) ?
                  0 :
                  originalChunkSize[i] * chunkGridPosition[chunkDim];
            }
            if (prevChunkFormat != null) {
              prevChunkFormat.bindChunk(
                  gl, shader!, chunk, fixedPositionWithinChunk, chunkDisplayDimensionIndices,
                  channelToChunkDimensionIndices, newSource);
            }
            newSource = false;
            gl.uniform3fv(shader.uniform('uTranslation'), chunkPosition);
            drawBoxes(gl, 1, 1);
            ++presentCount;
          } else {
            ++notPresentCount;
          }
        });
    gl.disable(WebGL2RenderingContext.CULL_FACE);
    endShader();
    this.vertexIdHelper.disable();
  }

  isReady(
      renderContext: PerspectiveViewReadyRenderContext,
      attachment: VisibleLayerInfo<PerspectivePanel, VolumeRenderingAttachmentState>) {
    const allSources = attachment.state!.sources.value;
    if (allSources.length === 0) return true;
    let missing = false;
    forEachVisibleVolumeRenderingChunk(
        renderContext.projectionParameters, this.localPosition.value, this.renderScaleTarget.value,
        allSources[0], () => {}, tsource => {
          const chunk = tsource.source.chunks.get(tsource.curPositionInChunks.join());
          if (chunk === undefined || chunk.state !== ChunkState.GPU_MEMORY) {
            missing = true;
          }
        });
    return missing;
  }
}
