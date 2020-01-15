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

import debounce from 'lodash/debounce';
import {ChunkState} from 'neuroglancer/chunk_manager/base';
import {Chunk, ChunkManager, ChunkSource} from 'neuroglancer/chunk_manager/frontend';
import {LayerManager} from 'neuroglancer/layer';
import {DisplayDimensionRenderInfo, NavigationState} from 'neuroglancer/navigation_state';
import {updateProjectionParametersFromInverseViewAndProjection} from 'neuroglancer/projection_parameters';
import {ChunkDisplayTransformParameters, ChunkTransformParameters, getChunkDisplayTransformParameters, getChunkTransformParameters, getLayerDisplayDimensionMapping, RenderLayerTransformOrError} from 'neuroglancer/render_coordinate_transform';
import {DerivedProjectionParameters, SharedProjectionParameters} from 'neuroglancer/renderlayer';
import {forEachPlaneIntersectingVolumetricChunk, SLICEVIEW_ADD_VISIBLE_LAYER_RPC_ID, SLICEVIEW_REMOVE_VISIBLE_LAYER_RPC_ID, SLICEVIEW_RPC_ID, SliceViewBase, SliceViewChunkSource as SliceViewChunkSourceInterface, SliceViewChunkSpecification, SliceViewProjectionParameters, SliceViewSourceOptions, TransformedSource, VisibleLayerSources} from 'neuroglancer/sliceview/base';
import {ChunkLayout} from 'neuroglancer/sliceview/chunk_layout';
import {SliceViewRenderLayer} from 'neuroglancer/sliceview/renderlayer';
import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {Borrowed, Disposer, invokeDisposers, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {kOneVec, mat4, vec3, vec4} from 'neuroglancer/util/geom';
import {MessageList, MessageSeverity} from 'neuroglancer/util/message_list';
import {getObjectId} from 'neuroglancer/util/object_id';
import {NullarySignal} from 'neuroglancer/util/signal';
import {withSharedVisibility} from 'neuroglancer/visibility_priority/frontend';
import {GL} from 'neuroglancer/webgl/context';
import {FramebufferConfiguration, makeTextureBuffers, StencilBuffer} from 'neuroglancer/webgl/offscreen';
import {ShaderBuilder, ShaderModule, ShaderProgram} from 'neuroglancer/webgl/shader';
import {getSquareCornersBuffer} from 'neuroglancer/webgl/square_corners_buffer';
import {registerSharedObjectOwner, RPC} from 'neuroglancer/worker_rpc';

export type GenericChunkKey = string;

class FrontendSliceViewBase extends
    SliceViewBase<SliceViewChunkSource, SliceViewRenderLayer, FrontendTransformedSource> {}
const Base = withSharedVisibility(FrontendSliceViewBase);

export interface FrontendTransformedSource<
    RLayer extends SliceViewRenderLayer = SliceViewRenderLayer, Source extends
        SliceViewChunkSource = SliceViewChunkSource> extends TransformedSource<RLayer, Source> {
  chunkTransform: ChunkTransformParameters;
  chunkDisplayTransform: ChunkDisplayTransformParameters;
}

interface FrontendVisibleLayerSources extends
    VisibleLayerSources<SliceViewRenderLayer, SliceViewChunkSource, FrontendTransformedSource> {
  transformGeneration: number;
  lastSeenGeneration: number;
  disposers: Disposer[];
  messages: MessageList;
}

function serializeTransformedSource(
    tsource: TransformedSource<SliceViewRenderLayer, SliceViewChunkSource>) {
  return {
    source: tsource.source.addCounterpartRef(),
    effectiveVoxelSize: tsource.effectiveVoxelSize,
    layerRank: tsource.layerRank,
    nonDisplayLowerClipBound: tsource.nonDisplayLowerClipBound,
    nonDisplayUpperClipBound: tsource.nonDisplayUpperClipBound,
    lowerClipDisplayBound: tsource.lowerClipDisplayBound,
    upperClipDisplayBound: tsource.upperClipDisplayBound,
    chunkDisplayDimensionIndices: tsource.chunkDisplayDimensionIndices,
    lowerChunkDisplayBound: tsource.lowerChunkDisplayBound,
    upperChunkDisplayBound: tsource.upperChunkDisplayBound,
    fixedLayerToChunkTransform: tsource.fixedLayerToChunkTransform,
    chunkLayout: tsource.chunkLayout.toObject(),
  };
}

export function serializeAllTransformedSources(
    allSources: TransformedSource<SliceViewRenderLayer, SliceViewChunkSource>[][]) {
  return allSources.map(scales => scales.map(serializeTransformedSource));
}

function disposeTransformedSources(
    layer: SliceViewRenderLayer,
    allSources: TransformedSource<SliceViewRenderLayer, SliceViewChunkSource>[][]) {
  for (const scales of allSources) {
    for (const {source} of scales) {
      layer.removeSource(source);
      source.dispose();
    }
  }
}


@registerSharedObjectOwner(SLICEVIEW_RPC_ID)
export class SliceView extends Base {
  gl = this.chunkManager.gl;
  viewChanged = new NullarySignal();

  renderingStale = true;

  visibleChunksStale = true;

  visibleLayerList = new Array<SliceViewRenderLayer>();

  visibleLayers: Map<SliceViewRenderLayer, FrontendVisibleLayerSources>;

  offscreenFramebuffer = this.registerDisposer(new FramebufferConfiguration(
      this.gl,
      {colorBuffers: makeTextureBuffers(this.gl, 1), depthBuffer: new StencilBuffer(this.gl)}));

  projectionParameters: Owned<DerivedProjectionParameters<SliceViewProjectionParameters>>;

  sharedProjectionParameters: Owned<SharedProjectionParameters<SliceViewProjectionParameters>>;

  flushBackendProjectionParameters() {
    this.sharedProjectionParameters.flush();
  }

  constructor(
      public chunkManager: ChunkManager, public layerManager: LayerManager,
      public navigationState: Owned<NavigationState>,
      public wireFrame: WatchableValueInterface<boolean>) {
    super(new DerivedProjectionParameters({
      parametersConstructor: SliceViewProjectionParameters,
      navigationState,
      update: (out, navigationState) => {
        const {invViewMatrix, centerDataPosition} = out;
        navigationState.toMat4(invViewMatrix);
        let {globalPosition} = out;
        const {canonicalVoxelFactors, voxelPhysicalScales} = out.displayDimensionRenderInfo;
        const newGlobalPosition = navigationState.position.value;
        const rank = newGlobalPosition.length;
        if (globalPosition.length !== rank) {
          out.globalPosition = globalPosition = new Float32Array(rank);
        }
        globalPosition.set(newGlobalPosition);
        for (let i = 0; i < 3; ++i) {
          centerDataPosition[i] = invViewMatrix[12 + i];
        }
        const {
          width,
          height,
          projectionMat,
          viewportNormalInGlobalCoordinates,
          viewportNormalInCanonicalCoordinates
        } = out;
        const {relativeDepthRange} = navigationState;
        mat4.ortho(
            projectionMat, -width / 2, width / 2, height / 2, -height / 2, -relativeDepthRange,
            relativeDepthRange);
        updateProjectionParametersFromInverseViewAndProjection(out);
        const {viewMatrix} = out;
        for (let i = 0; i < 3; ++i) {
          const x = viewportNormalInGlobalCoordinates[i] = viewMatrix[i * 4 + 2];
          viewportNormalInCanonicalCoordinates[i] = x / canonicalVoxelFactors[i];
        }
        vec3.normalize(viewportNormalInGlobalCoordinates, viewportNormalInGlobalCoordinates);
        vec3.normalize(viewportNormalInCanonicalCoordinates, viewportNormalInCanonicalCoordinates);

        let newPixelSize = 0;
        for (let i = 0; i < 3; ++i) {
          const s = voxelPhysicalScales[i];
          const x = invViewMatrix[i];
          newPixelSize += (s * x) ** 2;
        }
        newPixelSize = Math.sqrt(newPixelSize);
        out.pixelSize = newPixelSize;
      },
    }));
    this.registerDisposer(navigationState);
    this.registerDisposer(this.projectionParameters);
    this.registerDisposer(this.projectionParameters.changed.add((oldValue, newValue) => {
      if (oldValue.displayDimensionRenderInfo !== newValue.displayDimensionRenderInfo) {
        this.updateVisibleLayers();
      }
    }));
    const rpc = this.chunkManager.rpc!;
    const sharedProjectionParameters = this.sharedProjectionParameters =
        this.registerDisposer(new SharedProjectionParameters(rpc, this.projectionParameters));
    this.initializeCounterpart(rpc, {
      chunkManager: chunkManager.rpcId,
      projectionParameters: sharedProjectionParameters.rpcId,
    });
    this.registerDisposer(layerManager.layersChanged.add(() => {
      this.updateVisibleLayers();
    }));

    this.wireFrame.changed.add(this.viewChanged.dispatch);

    this.viewChanged.add(() => {
      this.renderingStale = true;
    });
    this.registerDisposer(
        chunkManager.chunkQueueManager.visibleChunksChanged.add(this.viewChanged.dispatch));
    this.updateVisibleLayers();
  }

  forEachVisibleChunk(tsource: FrontendTransformedSource, callback: (key: string) => void) {
    forEachPlaneIntersectingVolumetricChunk(
        this.projectionParameters.value, tsource.renderLayer.localPosition.value, tsource, () => {
          callback(tsource.curPositionInChunks.join());
        });
  }

  isReady() {
    if (!this.navigationState.valid) {
      return false;
    }
    this.updateVisibleLayers.flush();
    this.updateVisibleSources();
    let numValidChunks = 0;
    let totalChunks = 0;
    for (const {visibleSources} of this.visibleLayers.values()) {
      for (const tsource of visibleSources) {
        const {source} = tsource;
        const {chunks} = source;
        this.forEachVisibleChunk(tsource, key => {
          const chunk = chunks.get(key);
          ++totalChunks;
          if (chunk && chunk.state === ChunkState.GPU_MEMORY) {
            ++numValidChunks;
          }
        });
      }
    }
    return numValidChunks === totalChunks;
  }

  private updateVisibleLayers = this.registerCancellable(debounce(() => {
    this.updateVisibleLayersNow();
  }, 0));

  invalidateVisibleSources() {
    super.invalidateVisibleSources();
    this.viewChanged.dispatch();
  }

  private bindVisibleRenderLayer(renderLayer: SliceViewRenderLayer, disposers: Disposer[]) {
    disposers.push(renderLayer.localPosition.changed.add(() => this.invalidateVisibleChunks()));
    disposers.push(renderLayer.redrawNeeded.add(this.viewChanged.dispatch));
    disposers.push(renderLayer.transform.changed.add(this.updateVisibleLayers));
    disposers.push(
        renderLayer.renderScaleTarget.changed.add(() => this.invalidateVisibleSources()));
    const {renderScaleHistogram} = renderLayer;
    if (renderScaleHistogram !== undefined) {
      disposers.push(renderScaleHistogram.visibility.add(this.visibility));
    }
  }

  private updateVisibleLayersNow() {
    if (this.wasDisposed) {
      return false;
    }
    if (!this.navigationState.valid) return false;
    // Used to determine which layers are no longer visible.
    const curUpdateGeneration = Date.now();
    const {visibleLayers, visibleLayerList} = this;
    const {displayDimensionRenderInfo} = this.projectionParameters.value;
    let rpc = this.rpc!;
    let rpcMessage: any = {'id': this.rpcId};
    let changed = false;
    visibleLayerList.length = 0;
    for (let renderLayer of this.layerManager.readyRenderLayers()) {
      if (renderLayer instanceof SliceViewRenderLayer) {
        visibleLayerList.push(renderLayer);
        let layerInfo = visibleLayers.get(renderLayer);
        if (layerInfo === undefined) {
          const disposers: Disposer[] = [];
          const messages = new MessageList();
          layerInfo = {
            messages,
            allSources: this.getTransformedSources(renderLayer, messages),
            transformGeneration: renderLayer.transform.changed.count,
            visibleSources: [],
            disposers,
            lastSeenGeneration: curUpdateGeneration,
            displayDimensionRenderInfo,
          };
          disposers.push(renderLayer.messages.addChild(layerInfo.messages));
          visibleLayers.set(renderLayer.addRef(), layerInfo);
          this.bindVisibleRenderLayer(renderLayer, disposers);
        } else {
          layerInfo.lastSeenGeneration = curUpdateGeneration;
          const curTransformGeneration = renderLayer.transform.changed.count;
          if (layerInfo.transformGeneration === curTransformGeneration &&
              layerInfo.displayDimensionRenderInfo === displayDimensionRenderInfo) {
            continue;
          }
          const allSources = layerInfo.allSources;
          layerInfo.allSources = this.getTransformedSources(renderLayer, layerInfo.messages);
          disposeTransformedSources(renderLayer, allSources);
          layerInfo.visibleSources.length = 0;
          layerInfo.displayDimensionRenderInfo = displayDimensionRenderInfo;
          layerInfo.transformGeneration = curTransformGeneration;
        }
        rpcMessage['layerId'] = renderLayer.rpcId;
        rpcMessage['sources'] = serializeAllTransformedSources(layerInfo.allSources);
        this.flushBackendProjectionParameters();
        rpc.invoke(SLICEVIEW_ADD_VISIBLE_LAYER_RPC_ID, rpcMessage);
        changed = true;
      }
    }
    for (const [renderLayer, layerInfo] of visibleLayers) {
      if (layerInfo.lastSeenGeneration === curUpdateGeneration) continue;
      rpcMessage['layerId'] = renderLayer.rpcId;
      rpc.invoke(SLICEVIEW_REMOVE_VISIBLE_LAYER_RPC_ID, rpcMessage);
      visibleLayers.delete(renderLayer);
      disposeTransformedSources(renderLayer, layerInfo.allSources);
      invokeDisposers(layerInfo.disposers);
      renderLayer.dispose();
      changed = true;
    }
    if (changed) {
      this.visibleSourcesStale = true;
    }
    // Unconditionally call viewChanged, because layers may have been reordered even if the set of
    // sources is the same.
    this.viewChanged.dispatch();
    return changed;
  }

  invalidateVisibleChunks() {
    super.invalidateVisibleChunks();
    this.viewChanged.dispatch();
  }

  get valid() {
    return this.navigationState.valid;
  }

  updateRendering() {
    const projectionParameters = this.projectionParameters.value;
    const {width, height} = projectionParameters;
    if (!this.renderingStale || !this.valid || width === 0 || height === 0) {
      return;
    }
    this.renderingStale = false;
    this.updateVisibleLayers.flush();
    this.updateVisibleSources();

    let {gl, offscreenFramebuffer} = this;

    offscreenFramebuffer.bind(width!, height!);
    gl.disable(gl.SCISSOR_TEST);

    // we have viewportToData
    // we need: matrix that maps input x to the output x axis, scaled by

    gl.clearStencil(0);
    gl.clearColor(0, 0, 0, 0);
    gl.colorMask(true, true, true, true);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.STENCIL_TEST);
    gl.disable(gl.DEPTH_TEST);
    gl.stencilOpSeparate(
        /*face=*/ gl.FRONT_AND_BACK, /*sfail=*/ gl.KEEP, /*dpfail=*/ gl.KEEP,
        /*dppass=*/ gl.REPLACE);

    let renderLayerNum = 0;
    const renderContext = {sliceView: this, projectionParameters, wireFrame: this.wireFrame.value};
    for (let renderLayer of this.visibleLayerList) {
      gl.clear(gl.STENCIL_BUFFER_BIT);
      gl.stencilFuncSeparate(
          /*face=*/ gl.FRONT_AND_BACK,
          /*func=*/ gl.GREATER,
          /*ref=*/ 1,
          /*mask=*/ 1);

      renderLayer.setGLBlendMode(gl, renderLayerNum);
      renderLayer.draw(renderContext);
      ++renderLayerNum;
    }
    gl.disable(gl.BLEND);
    gl.disable(gl.STENCIL_TEST);
    offscreenFramebuffer.unbind();
  }

  disposed() {
    for (const [renderLayer, layerInfo] of this.visibleLayers) {
      disposeTransformedSources(renderLayer, layerInfo.allSources);
      invokeDisposers(layerInfo.disposers);
      renderLayer.dispose();
    }
    this.visibleLayers.clear();
    this.visibleLayerList.length = 0;
  }

  getTransformedSources(layer: SliceViewRenderLayer, messages: MessageList):
      FrontendTransformedSource[][] {
    const transformedSources = getVolumetricTransformedSources(
        this.projectionParameters.value.displayDimensionRenderInfo, layer.transform.value,
        options => layer.getSources(options), messages, layer);
    for (const scales of transformedSources) {
      for (const tsource of scales) {
        layer.addSource(tsource.source, tsource.chunkTransform);
      }
    }
    return transformedSources;
  }
}

export interface SliceViewChunkSourceOptions<Spec extends SliceViewChunkSpecification =
                                                              SliceViewChunkSpecification> {
  spec: Spec;
}

export abstract class SliceViewChunkSource<
    Spec extends SliceViewChunkSpecification = SliceViewChunkSpecification,
                 ChunkType extends SliceViewChunk = SliceViewChunk> extends ChunkSource implements
    SliceViewChunkSourceInterface {
  chunks: Map<string, ChunkType>;

  OPTIONS: SliceViewChunkSourceOptions<Spec>;

  spec: Spec;

  constructor(chunkManager: ChunkManager, options: SliceViewChunkSourceOptions<Spec>) {
    super(chunkManager, options);
    this.spec = options.spec;
  }

  static encodeSpec(spec: SliceViewChunkSpecification) {
    return {
      chunkDataSize: Array.from(spec.chunkDataSize),
      lowerVoxelBound: Array.from(spec.lowerVoxelBound),
      upperVoxelBound: Array.from(spec.upperVoxelBound),
    };
  }

  static encodeOptions(options: SliceViewChunkSourceOptions): any {
    const encoding = super.encodeOptions(options);
    encoding.spec = this.encodeSpec(options.spec);
    return encoding;
  }

  initializeCounterpart(rpc: RPC, options: any) {
    options['spec'] = this.spec;
    super.initializeCounterpart(rpc, options);
  }
}

export interface SliceViewChunkSource {
  // TODO(jbms): Move this declaration to the class definition above and declare abstract once
  // TypeScript supports mixins with abstact classes.
  getChunk(x: any): any;
}

export class SliceViewChunk extends Chunk {
  chunkGridPosition: vec3;
  source: SliceViewChunkSource;

  constructor(source: SliceViewChunkSource, x: any) {
    super(source);
    this.chunkGridPosition = x['chunkGridPosition'];
    this.state = ChunkState.SYSTEM_MEMORY;
  }
}

/**
 * Helper for rendering a SliceView that has been pre-rendered to a texture.
 */
export class SliceViewRenderHelper extends RefCounted {
  private copyVertexPositionsBuffer = getSquareCornersBuffer(this.gl);
  private shader: ShaderProgram;

  private textureCoordinateAdjustment = new Float32Array(4);

  constructor(public gl: GL, emitter: ShaderModule) {
    super();
    let builder = new ShaderBuilder(gl);
    builder.addVarying('vec2', 'vTexCoord');
    builder.addUniform('sampler2D', 'uSampler');
    builder.addInitializer(shader => {
      gl.uniform1i(shader.uniform('uSampler'), 0);
    });
    builder.addUniform('vec4', 'uColorFactor');
    builder.addUniform('vec4', 'uBackgroundColor');
    builder.addUniform('mat4', 'uProjectionMatrix');
    builder.addUniform('vec4', 'uTextureCoordinateAdjustment');
    builder.require(emitter);
    builder.setFragmentMain(`
vec4 sampledColor = texture(uSampler, vTexCoord);
if (sampledColor.a == 0.0) {
  sampledColor = uBackgroundColor;
}
emit(sampledColor * uColorFactor, 0u);
`);
    builder.addAttribute('vec4', 'aVertexPosition');
    builder.setVertexMain(`
vTexCoord = uTextureCoordinateAdjustment.xy + 0.5 * (aVertexPosition.xy + 1.0) * uTextureCoordinateAdjustment.zw;
gl_Position = uProjectionMatrix * aVertexPosition;
`);
    this.shader = this.registerDisposer(builder.build());
  }

  draw(
      texture: WebGLTexture|null, projectionMatrix: mat4, colorFactor: vec4, backgroundColor: vec4,
      xStart: number, yStart: number, xEnd: number, yEnd: number) {
    let {gl, shader, textureCoordinateAdjustment} = this;
    textureCoordinateAdjustment[0] = xStart;
    textureCoordinateAdjustment[1] = yStart;
    textureCoordinateAdjustment[2] = xEnd - xStart;
    textureCoordinateAdjustment[3] = yEnd - yStart;
    shader.bind();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniformMatrix4fv(shader.uniform('uProjectionMatrix'), false, projectionMatrix);
    gl.uniform4fv(shader.uniform('uColorFactor'), colorFactor);
    gl.uniform4fv(shader.uniform('uBackgroundColor'), backgroundColor);
    gl.uniform4fv(shader.uniform('uTextureCoordinateAdjustment'), textureCoordinateAdjustment);

    let aVertexPosition = shader.attribute('aVertexPosition');
    this.copyVertexPositionsBuffer.bindToVertexAttrib(aVertexPosition, /*components=*/ 2);

    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);

    gl.disableVertexAttribArray(aVertexPosition);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  static get(gl: GL, emitter: ShaderModule) {
    return gl.memoize.get(
        `sliceview/SliceViewRenderHelper:${getObjectId(emitter)}`,
        () => new SliceViewRenderHelper(gl, emitter));
  }
}

export interface SliceViewSingleResolutionSource<Source extends SliceViewChunkSource =
                                                                    SliceViewChunkSource> {
  chunkSource: Source;

  /**
   * (rank + 1)*(rank + 1) homogeneous transformation matrix from the "chunk" coordinate space to
   * the MultiscaleSliceViewChunkSource space.
   */
  chunkToMultiscaleTransform: Float32Array;

  /**
   * Lower clipping bound in voxels within the "chunk" coordinate space.  If not specified, defaults
   * to `chunkSource.spec.lowerVoxelBound`.  Non-integer values are supported.
   *
   * Both lowerClipBound and upperClipBound are applied during rendering but do not affect which
   * chunks/voxels are actually retrieved.  That is determined by lowerVoxelBound and
   * upperVoxelBound of `chunkSource.spec`.
   */
  lowerClipBound?: Float32Array;

  /**
   * Upper clipping bound in voxels within the "chunk" coordinate space.  If not specified, defaults
   * to `chunkSource.spec.upperVoxelBound`.
   */
  upperClipBound?: Float32Array;
}

export abstract class MultiscaleSliceViewChunkSource<
    Source extends SliceViewChunkSource = SliceViewChunkSource,
                   SourceOptions extends SliceViewSourceOptions = SliceViewSourceOptions> {
  abstract get rank(): number;

  /**
   * @return Chunk sources for each scale, ordered by increasing minVoxelSize.  Outer array indexes
   * over alternative chunk orientations.  The inner array indexes over scale.
   *
   * Every chunk source must have rank equal to `this.rank`.
   */
  abstract getSources(options: SourceOptions): SliceViewSingleResolutionSource<Source>[][];

  constructor(public chunkManager: Borrowed<ChunkManager>) {}
}

export function getVolumetricTransformedSources(
    displayDimensionRenderInfo: DisplayDimensionRenderInfo, transform: RenderLayerTransformOrError,
    getSources: (options: SliceViewSourceOptions) =>
        SliceViewSingleResolutionSource<SliceViewChunkSource>[][],
    messages: MessageList, layer: any): FrontendTransformedSource[][] {
  messages.clearMessages();
  const returnError = (message: string) => {
    messages.addMessage({
      severity: MessageSeverity.error,
      message,
    });
    return [];
  };
  if (transform.error !== undefined) {
    return returnError(transform.error);
  }
  const layerRank = transform.rank;
  const chunkRank = transform.unpaddedRank;
  const {displayDimensionIndices, displayRank, canonicalVoxelFactors} = displayDimensionRenderInfo;
  const layerDisplayDimensionMapping =
      getLayerDisplayDimensionMapping(transform, displayDimensionIndices);

  const {layerDisplayDimensionIndices} = layerDisplayDimensionMapping;
  const multiscaleToViewTransform = new Float32Array(displayRank * chunkRank);
  const {modelToRenderLayerTransform} = transform;
  for (let displayDim = 0; displayDim < displayRank; ++displayDim) {
    const layerDim = layerDisplayDimensionIndices[displayDim];
    if (layerDim === -1) continue;
    const factor = canonicalVoxelFactors[displayDim];
    for (let chunkDim = 0; chunkDim < chunkRank; ++chunkDim) {
      multiscaleToViewTransform[displayRank * chunkDim + displayDim] =
          modelToRenderLayerTransform[(layerRank + 1) * chunkDim + layerDim] * factor;
    }
  }
  const allSources = getSources({
    displayRank: displayRank,
    multiscaleToViewTransform: multiscaleToViewTransform,
    modelChannelDimensionIndices: transform.channelToRenderLayerDimensions,
  });
  const {voxelPhysicalScales: globalScales} = displayDimensionRenderInfo;
  try {
    const getTransformedSource =
        (singleResolutionSource: SliceViewSingleResolutionSource): FrontendTransformedSource => {
          const {chunkSource: source} = singleResolutionSource;
          const {spec} = source;
          const {lowerClipBound = spec.lowerVoxelBound, upperClipBound = spec.upperVoxelBound} =
              singleResolutionSource;
          const chunkTransform = getChunkTransformParameters(
              transform, singleResolutionSource.chunkToMultiscaleTransform);
          const {chunkDataSize} = spec;
          const {chunkChannelDimensionIndices} = chunkTransform;
          const nonDisplayLowerClipBound = new Float32Array(chunkRank);
          const nonDisplayUpperClipBound = new Float32Array(chunkRank);
          nonDisplayLowerClipBound.set(lowerClipBound);
          nonDisplayUpperClipBound.set(upperClipBound);
          const channelRank = chunkChannelDimensionIndices.length;
          const {channelDimensionBounds} = transform;
          for (let channelDim = 0; channelDim < channelRank; ++channelDim) {
            const chunkDim = chunkChannelDimensionIndices[channelDim];
            if (chunkDim === -1) continue;
            const lower = channelDimensionBounds.lowerBounds[channelDim];
            const upper = channelDimensionBounds.upperBounds[channelDim];
            if (chunkDataSize[chunkDim] !== upper || 0 !== lower) {
              throw new Error(
                  `Channel dimension ` +
                  transform
                      .layerDimensionNames[transform.channelToRenderLayerDimensions[channelDim]] +
                  ` has range [${lower}, ${upper}) but corresponding chunk dimension has range ` +
                  `[0, ${chunkDataSize[chunkDim]})`);
            }
            nonDisplayLowerClipBound[chunkDim] = Number.NEGATIVE_INFINITY;
            nonDisplayUpperClipBound[chunkDim] = Number.POSITIVE_INFINITY;
          }
          const chunkDisplayTransform =
              getChunkDisplayTransformParameters(chunkTransform, layerDisplayDimensionMapping);
          // Compute `chunkDisplaySize`, and `{lower,upper}ChunkDisplayBound`.
          const lowerChunkDisplayBound = vec3.create();
          const upperChunkDisplayBound = vec3.create();
          const lowerClipDisplayBound = vec3.create();
          const upperClipDisplayBound = vec3.create();
          // Size of chunk in "display" coordinate space.
          const chunkDisplaySize = vec3.create();
          const {numChunkDisplayDims, chunkDisplayDimensionIndices} = chunkDisplayTransform;
          const {combinedGlobalLocalToChunkTransform, layerRank, combinedGlobalLocalRank} =
              chunkTransform;
          const fixedLayerToChunkTransform = new Float32Array(combinedGlobalLocalToChunkTransform);
          for (let chunkDisplayDimIndex = 0; chunkDisplayDimIndex < numChunkDisplayDims;
               ++chunkDisplayDimIndex) {
            const chunkDim = chunkDisplayDimensionIndices[chunkDisplayDimIndex];
            for (let i = 0; i <= combinedGlobalLocalRank; ++i) {
              fixedLayerToChunkTransform[chunkDim + i * layerRank] = 0;
            }
            if (chunkDim < chunkRank) {
              chunkDisplaySize[chunkDisplayDimIndex] = spec.chunkDataSize[chunkDim];
              lowerChunkDisplayBound[chunkDisplayDimIndex] = spec.lowerChunkBound[chunkDim];
              upperChunkDisplayBound[chunkDisplayDimIndex] = spec.upperChunkBound[chunkDim];
              lowerClipDisplayBound[chunkDisplayDimIndex] = lowerClipBound[chunkDim];
              upperClipDisplayBound[chunkDisplayDimIndex] = upperClipBound[chunkDim];
              nonDisplayLowerClipBound[chunkDim] = Number.NEGATIVE_INFINITY;
              nonDisplayUpperClipBound[chunkDim] = Number.POSITIVE_INFINITY;
            } else {
              chunkDisplaySize[chunkDisplayDimIndex] = 1;
              lowerChunkDisplayBound[chunkDisplayDimIndex] = 0;
              upperChunkDisplayBound[chunkDisplayDimIndex] = 1;
              lowerClipDisplayBound[chunkDisplayDimIndex] = 0;
              upperClipDisplayBound[chunkDisplayDimIndex] = 1;
            }
          }
          chunkDisplaySize.fill(1, numChunkDisplayDims);
          lowerChunkDisplayBound.fill(0, numChunkDisplayDims);
          upperChunkDisplayBound.fill(1, numChunkDisplayDims);
          lowerClipDisplayBound.fill(0, numChunkDisplayDims);
          upperClipDisplayBound.fill(1, numChunkDisplayDims);
          const chunkLayout = new ChunkLayout(
              chunkDisplaySize, chunkDisplayTransform.displaySubspaceModelMatrix,
              numChunkDisplayDims);
          // This is an approximation of the voxel size (exact only for permutation/scaling
          // transforms).  It would be better to model the voxel as an ellipsiod and find the
          // lengths of the axes.
          const effectiveVoxelSize =
              chunkLayout.localSpatialVectorToGlobal(vec3.create(), /*baseVoxelSize=*/ kOneVec);
          for (let i = 0; i < displayRank; ++i) {
            effectiveVoxelSize[i] *= globalScales[i];
          }
          effectiveVoxelSize.fill(1, displayRank);
          return {
            layerRank,
            nonDisplayLowerClipBound,
            nonDisplayUpperClipBound,
            renderLayer: layer,
            source,
            lowerChunkDisplayBound,
            upperChunkDisplayBound,
            lowerClipDisplayBound,
            upperClipDisplayBound,
            effectiveVoxelSize,
            chunkLayout,
            chunkDisplayDimensionIndices,
            fixedLayerToChunkTransform,
            curPositionInChunks: new Float32Array(chunkRank),
            fixedPositionWithinChunk: new Uint32Array(chunkRank),
            chunkTransform,
            chunkDisplayTransform,
          };
        };
    return allSources.map(scales => scales.map(s => getTransformedSource(s)));
  } catch (e) {
    // Ensure references are released in the case of an exception.
    for (const scales of allSources) {
      for (const {chunkSource: source} of scales) {
        source.dispose();
      }
    }
    const {globalDimensionNames} = displayDimensionRenderInfo;
    const dimensionDesc =
        Array
            .from(
                displayDimensionRenderInfo.displayDimensionIndices.filter(i => i !== -1),
                i => globalDimensionNames[i])
            .join(',\u00a0');
    const message = `Cannot render (${dimensionDesc}) cross section: ${e.message}`;
    return returnError(message);
  }
}
