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

import { ChunkState } from "#src/chunk_manager/base.js";
import type {
  ChunkManager,
  ChunkRequesterState,
} from "#src/chunk_manager/frontend.js";
import { Chunk, ChunkSource } from "#src/chunk_manager/frontend.js";
import { applyRenderViewportToProjectionMatrix } from "#src/display_context.js";
import type { LayerManager } from "#src/layer/index.js";
import type {
  DisplayDimensionRenderInfo,
  NavigationState,
} from "#src/navigation_state.js";
import type { PerspectiveViewerState } from "#src/perspective_view/panel.js";
import { updateProjectionParametersFromInverseViewAndProjection } from "#src/projection_parameters.js";
import type {
  ChunkDisplayTransformParameters,
  ChunkTransformParameters,
  RenderLayerTransformOrError,
} from "#src/render_coordinate_transform.js";
import {
  getChunkDisplayTransformParameters,
  getChunkTransformParameters,
  getLayerDisplayDimensionMapping,
} from "#src/render_coordinate_transform.js";
import {
  DerivedProjectionParameters,
  SharedProjectionParameters,
} from "#src/renderlayer.js";
import type {
  SliceViewChunkSource as SliceViewChunkSourceInterface,
  SliceViewChunkSpecification,
  SliceViewSourceOptions,
  TransformedSource,
  VisibleLayerSources,
} from "#src/sliceview/base.js";
import {
  forEachPlaneIntersectingVolumetricChunk,
  getNormalizedChunkLayout,
  SLICEVIEW_ADD_VISIBLE_LAYER_RPC_ID,
  SLICEVIEW_REMOVE_VISIBLE_LAYER_RPC_ID,
  SLICEVIEW_REQUEST_CHUNK_RPC_ID,
  SLICEVIEW_RPC_ID,
  SliceViewBase,
  SliceViewProjectionParameters,
} from "#src/sliceview/base.js";
import { ChunkLayout } from "#src/sliceview/chunk_layout.js";
import type { SliceViewerState } from "#src/sliceview/panel.js";
import { SliceViewRenderLayer } from "#src/sliceview/renderlayer.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import type { Borrowed, Disposer, Owned } from "#src/util/disposable.js";
import { invokeDisposers, RefCounted } from "#src/util/disposable.js";
import type { vec4 } from "#src/util/geom.js";
import { kOneVec, kZeroVec4, mat4, vec3 } from "#src/util/geom.js";
import { MessageList, MessageSeverity } from "#src/util/message_list.js";
import { getObjectId } from "#src/util/object_id.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import { NullarySignal } from "#src/util/signal.js";
import { withSharedVisibility } from "#src/visibility_priority/frontend.js";
import type { GL } from "#src/webgl/context.js";
import type { ParameterizedContextDependentShaderGetter } from "#src/webgl/dynamic_shader.js";
import { parameterizedContextDependentShaderGetter } from "#src/webgl/dynamic_shader.js";
import type { HistogramSpecifications } from "#src/webgl/empirical_cdf.js";
import { TextureHistogramGenerator } from "#src/webgl/empirical_cdf.js";
import type { TextureBuffer } from "#src/webgl/offscreen.js";
import {
  DepthTextureBuffer,
  FramebufferConfiguration,
  makeTextureBuffers,
} from "#src/webgl/offscreen.js";
import type { ShaderBuilder, ShaderModule } from "#src/webgl/shader.js";
import { getSquareCornersBuffer } from "#src/webgl/square_corners_buffer.js";
import type { RPC } from "#src/worker_rpc.js";
import { registerSharedObjectOwner } from "#src/worker_rpc.js";
import { debounce } from "lodash-es";

export type GenericChunkKey = string;

class FrontendSliceViewBase extends SliceViewBase<
  SliceViewChunkSource,
  SliceViewRenderLayer,
  FrontendTransformedSource
> { }
const Base = withSharedVisibility(FrontendSliceViewBase);

export interface FrontendTransformedSource<
  RLayer extends SliceViewRenderLayer = SliceViewRenderLayer,
  Source extends SliceViewChunkSource = SliceViewChunkSource,
> extends TransformedSource<RLayer, Source> {
  chunkTransform: ChunkTransformParameters;
  chunkDisplayTransform: ChunkDisplayTransformParameters;
}

interface FrontendVisibleLayerSources
  extends VisibleLayerSources<
    SliceViewRenderLayer,
    SliceViewChunkSource,
    FrontendTransformedSource
  > {
  transformGeneration: number;
  lastSeenGeneration: number;
  disposers: Disposer[];
  messages: MessageList;
}

function serializeTransformedSource(
  tsource: TransformedSource<SliceViewRenderLayer, SliceViewChunkSource>,
) {
  return {
    source: tsource.source.addCounterpartRef(),
    effectiveVoxelSize: tsource.effectiveVoxelSize,
    layerRank: tsource.layerRank,
    nonDisplayLowerClipBound: tsource.nonDisplayLowerClipBound,
    nonDisplayUpperClipBound: tsource.nonDisplayUpperClipBound,
    lowerClipBound: tsource.lowerClipBound,
    upperClipBound: tsource.upperClipBound,
    lowerClipDisplayBound: tsource.lowerClipDisplayBound,
    upperClipDisplayBound: tsource.upperClipDisplayBound,
    chunkDisplayDimensionIndices: tsource.chunkDisplayDimensionIndices,
    lowerChunkDisplayBound: tsource.lowerChunkDisplayBound,
    upperChunkDisplayBound: tsource.upperChunkDisplayBound,
    fixedLayerToChunkTransform: tsource.fixedLayerToChunkTransform,
    combinedGlobalLocalToChunkTransform:
      tsource.combinedGlobalLocalToChunkTransform,
    chunkLayout: tsource.chunkLayout.toObject(),
  };
}

export function serializeAllTransformedSources(
  allSources: TransformedSource<SliceViewRenderLayer, SliceViewChunkSource>[][],
) {
  return allSources.map((scales) => scales.map(serializeTransformedSource));
}

function disposeTransformedSources(
  layer: SliceViewRenderLayer,
  allSources: TransformedSource<SliceViewRenderLayer, SliceViewChunkSource>[][],
) {
  for (const scales of allSources) {
    for (const { source } of scales) {
      layer.removeSource(source);
      source.dispose();
    }
  }
}

@registerSharedObjectOwner(SLICEVIEW_RPC_ID)
export class SliceView extends Base {
  gl: GL;
  viewChanged = new NullarySignal();
  declare rpc: RPC;
  declare rpcId: number;

  renderingStale = true;

  visibleChunksStale = true;

  visibleLayerList = new Array<SliceViewRenderLayer>();

  declare visibleLayers: Map<SliceViewRenderLayer, FrontendVisibleLayerSources>;

  offscreenFramebuffer;
  histogramInputTextures: TextureBuffer[] = [];
  offscreenFramebuffersWithHistograms;

  get displayDimensionRenderInfo() {
    return this.navigationState.displayDimensionRenderInfo;
  }

  private histogramGenerator: TextureHistogramGenerator;

  computeHistograms(
    count: number,
    histogramSpecifications: HistogramSpecifications,
  ) {
    this.histogramGenerator.compute(
      count,
      this.offscreenFramebuffer.depthBuffer!.texture,
      this.histogramInputTextures,
      histogramSpecifications,
      this.chunkManager.chunkQueueManager.frameNumberCounter.frameNumber,
    );
  }

  declare projectionParameters: Owned<
    DerivedProjectionParameters<SliceViewProjectionParameters>
  >;

  sharedProjectionParameters: Owned<
    SharedProjectionParameters<SliceViewProjectionParameters>
  >;

  flushBackendProjectionParameters() {
    this.sharedProjectionParameters.flush();
  }

  constructor(
    public chunkManager: ChunkManager,
    public layerManager: LayerManager,
    public navigationState: Owned<NavigationState>,
    public wireFrame: WatchableValueInterface<boolean>,
  ) {
    super(
      new DerivedProjectionParameters({
        parametersConstructor: SliceViewProjectionParameters,
        navigationState,
        update: (out, navigationState) => {
          const { invViewMatrix, centerDataPosition } = out;
          navigationState.toMat4(invViewMatrix);
          const { canonicalVoxelFactors, voxelPhysicalScales } =
            out.displayDimensionRenderInfo;
          for (let i = 0; i < 3; ++i) {
            centerDataPosition[i] = invViewMatrix[12 + i];
          }
          const {
            logicalWidth,
            logicalHeight,
            projectionMat,
            viewportNormalInGlobalCoordinates,
            viewportNormalInCanonicalCoordinates,
          } = out;
          const { relativeDepthRange } = navigationState;
          mat4.ortho(
            projectionMat,
            -logicalWidth / 2,
            logicalWidth / 2,
            logicalHeight / 2,
            -logicalHeight / 2,
            -relativeDepthRange,
            relativeDepthRange,
          );
          applyRenderViewportToProjectionMatrix(out, projectionMat);
          updateProjectionParametersFromInverseViewAndProjection(out);
          const { viewMatrix } = out;
          for (let i = 0; i < 3; ++i) {
            const x = (viewportNormalInGlobalCoordinates[i] =
              viewMatrix[i * 4 + 2]);
            viewportNormalInCanonicalCoordinates[i] =
              x / canonicalVoxelFactors[i];
          }
          vec3.normalize(
            viewportNormalInGlobalCoordinates,
            viewportNormalInGlobalCoordinates,
          );
          vec3.normalize(
            viewportNormalInCanonicalCoordinates,
            viewportNormalInCanonicalCoordinates,
          );

          let newPixelSize = 0;
          for (let i = 0; i < 3; ++i) {
            const s = voxelPhysicalScales[i];
            const x = invViewMatrix[i];
            newPixelSize += (s * x) ** 2;
          }
          newPixelSize = Math.sqrt(newPixelSize);
          out.pixelSize = newPixelSize;
        },
      }),
    );
    this.gl = chunkManager.gl;

    this.offscreenFramebuffer = this.registerDisposer(
      new FramebufferConfiguration(this.gl, {
        colorBuffers: makeTextureBuffers(this.gl, 1),
        depthBuffer: new DepthTextureBuffer(this.gl),
      }),
    );
    this.offscreenFramebuffersWithHistograms = [this.offscreenFramebuffer];
    this.histogramGenerator = TextureHistogramGenerator.get(this.gl);

    this.registerDisposer(navigationState);
    this.registerDisposer(this.projectionParameters);
    this.registerDisposer(
      this.projectionParameters.changed.add((oldValue, newValue) => {
        if (
          oldValue.displayDimensionRenderInfo !==
          newValue.displayDimensionRenderInfo
        ) {
          this.updateVisibleLayers();
        }
      }),
    );
    const rpc = this.chunkManager.rpc!;
    const sharedProjectionParameters = (this.sharedProjectionParameters =
      this.registerDisposer(
        new SharedProjectionParameters(rpc, this.projectionParameters),
      ));
    this.initializeCounterpart(rpc, {
      chunkManager: chunkManager.rpcId,
      projectionParameters: sharedProjectionParameters.rpcId,
    });
    this.registerDisposer(
      layerManager.layersChanged.add(() => {
        this.updateVisibleLayers();
      }),
    );

    this.wireFrame.changed.add(this.viewChanged.dispatch);

    this.viewChanged.add(() => {
      this.renderingStale = true;
    });
    this.registerDisposer(
      chunkManager.chunkQueueManager.visibleChunksChanged.add(
        this.viewChanged.dispatch,
      ),
    );
    this.updateVisibleLayers();
  }

  forEachVisibleChunk(
    tsource: FrontendTransformedSource,
    chunkLayout: ChunkLayout,
    callback: (key: string) => void,
  ) {
    forEachPlaneIntersectingVolumetricChunk(
      this.projectionParameters.value,
      tsource.renderLayer.localPosition.value,
      tsource,
      chunkLayout,
      () => {
        callback(tsource.curPositionInChunks.join());
      },
    );
  }

  isReady() {
    if (!this.navigationState.valid) {
      return false;
    }
    this.updateVisibleLayers.flush();
    this.updateVisibleSources();
    let numValidChunks = 0;
    let totalChunks = 0;
    for (const { visibleSources } of this.visibleLayers.values()) {
      for (const tsource of visibleSources) {
        const chunkLayout = getNormalizedChunkLayout(
          this.projectionParameters.value,
          tsource.chunkLayout,
        );
        const { source } = tsource;
        const { chunks } = source;
        this.forEachVisibleChunk(tsource, chunkLayout, (key) => {
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

  private updateVisibleLayers = this.registerCancellable(
    debounce(() => {
      this.updateVisibleLayersNow();
    }, 0),
  );

  invalidateVisibleSources() {
    super.invalidateVisibleSources();
    this.viewChanged.dispatch();
  }

  private bindVisibleRenderLayer(
    renderLayer: SliceViewRenderLayer,
    disposers: Disposer[],
  ) {
    disposers.push(
      renderLayer.localPosition.changed.add(() =>
        this.invalidateVisibleChunks(),
      ),
    );
    disposers.push(renderLayer.redrawNeeded.add(this.viewChanged.dispatch));
    disposers.push(renderLayer.transform.changed.add(this.updateVisibleLayers));
    disposers.push(
      renderLayer.renderScaleTarget.changed.add(() =>
        this.invalidateVisibleSources(),
      ),
    );
    const { renderScaleHistogram } = renderLayer;
    if (renderScaleHistogram !== undefined) {
      disposers.push(renderScaleHistogram.visibility.add(this.visibility));
    }
    disposers.push(
      renderLayer.dataHistogramSpecifications.producerVisibility.add(
        this.visibility,
      ),
    );
  }

  private updateVisibleLayersNow() {
    if (this.wasDisposed) {
      return false;
    }
    if (!this.navigationState.valid) return false;
    // Used to determine which layers are no longer visible.
    const curUpdateGeneration = Date.now();
    const { visibleLayers, visibleLayerList } = this;
    const { displayDimensionRenderInfo } = this.projectionParameters.value;
    const rpc = this.rpc!;
    let changed = false;
    visibleLayerList.length = 0;
    for (const renderLayer of this.layerManager.readyRenderLayers()) {
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
          if (
            layerInfo.transformGeneration === curTransformGeneration &&
            layerInfo.displayDimensionRenderInfo === displayDimensionRenderInfo
          ) {
            continue;
          }
          const allSources = layerInfo.allSources;
          layerInfo.allSources = this.getTransformedSources(
            renderLayer,
            layerInfo.messages,
          );
          disposeTransformedSources(renderLayer, allSources);
          layerInfo.visibleSources.length = 0;
          layerInfo.displayDimensionRenderInfo = displayDimensionRenderInfo;
          layerInfo.transformGeneration = curTransformGeneration;
        }
        this.flushBackendProjectionParameters();
        rpc.invoke(SLICEVIEW_ADD_VISIBLE_LAYER_RPC_ID, {
          id: this.rpcId,
          layerId: renderLayer.rpcId,
          sources: serializeAllTransformedSources(layerInfo.allSources),
          displayDimensionRenderInfo: displayDimensionRenderInfo,
        });
        changed = true;
      }
    }
    for (const [renderLayer, layerInfo] of visibleLayers) {
      if (layerInfo.lastSeenGeneration === curUpdateGeneration) continue;
      rpc.invoke(SLICEVIEW_REMOVE_VISIBLE_LAYER_RPC_ID, {
        id: this.rpcId,
        layerId: renderLayer.rpcId,
      });
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

  private getOffscreenFramebufferWithHistograms(count: number) {
    const { offscreenFramebuffersWithHistograms } = this;
    let framebuffer = offscreenFramebuffersWithHistograms[count];
    if (framebuffer === undefined) {
      const { gl, histogramInputTextures, offscreenFramebuffer } = this;
      if (histogramInputTextures.length < count) {
        histogramInputTextures.push(
          ...makeTextureBuffers(
            gl,
            count - histogramInputTextures.length,
            WebGL2RenderingContext.R8,
            WebGL2RenderingContext.RED,
          ),
        );
      }
      const colorBuffers = [offscreenFramebuffer.colorBuffers[0].addRef()];
      for (let i = 0; i < count; ++i) {
        colorBuffers.push(histogramInputTextures[i].addRef());
      }
      framebuffer = this.registerDisposer(
        new FramebufferConfiguration(gl, {
          colorBuffers,
          depthBuffer: offscreenFramebuffer.depthBuffer!.addRef(),
        }),
      );
      offscreenFramebuffersWithHistograms[count] = framebuffer;
    }
    return framebuffer;
  }

  updateRendering() {
    const projectionParameters = this.projectionParameters.value;
    const { width, height } = projectionParameters;
    if (!this.renderingStale || !this.valid || width === 0 || height === 0) {
      return;
    }
    this.renderingStale = false;
    this.updateVisibleLayers.flush();
    this.updateVisibleSources();

    const { gl, offscreenFramebuffer } = this;

    offscreenFramebuffer.bind(width, height);
    gl.disable(gl.SCISSOR_TEST);

    gl.clearColor(0, 0, 0, 0);
    gl.colorMask(true, true, true, true);
    gl.clear(WebGL2RenderingContext.COLOR_BUFFER_BIT);
    let renderLayerNum = 0;
    const wireFrame = this.wireFrame.value;
    const renderContext = { sliceView: this, projectionParameters, wireFrame };
    for (const renderLayer of this.visibleLayerList) {
      const histogramCount = wireFrame
        ? 0
        : renderLayer.getDataHistogramCount();
      const framebuffer =
        this.getOffscreenFramebufferWithHistograms(histogramCount);
      framebuffer.bind(width, height);
      for (let i = 0; i < histogramCount; ++i) {
        gl.clearBufferfv(WebGL2RenderingContext.COLOR, 1 + i, kZeroVec4);
      }
      gl.enable(WebGL2RenderingContext.DEPTH_TEST);
      gl.depthFunc(WebGL2RenderingContext.LESS);
      gl.clearDepth(1);
      gl.clear(WebGL2RenderingContext.DEPTH_BUFFER_BIT);
      renderLayer.setGLBlendMode(gl, renderLayerNum);
      renderLayer.draw(renderContext);
      ++renderLayerNum;
    }
    gl.disable(WebGL2RenderingContext.BLEND);
    gl.disable(WebGL2RenderingContext.DEPTH_TEST);
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

  getTransformedSources(
    layer: SliceViewRenderLayer,
    messages: MessageList,
  ): FrontendTransformedSource[][] {
    const transformedSources = getVolumetricTransformedSources(
      this.projectionParameters.value.displayDimensionRenderInfo,
      layer.transform.value,
      (options) => layer.getSources(options),
      messages,
      layer,
    );
    for (const scales of transformedSources) {
      for (const tsource of scales) {
        layer.addSource(tsource.source, tsource.chunkTransform);
      }
    }
    return transformedSources;
  }
}

export interface SliceViewChunkSourceOptions<
  Spec extends SliceViewChunkSpecification = SliceViewChunkSpecification,
> {
  spec: Spec;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export abstract class SliceViewChunkSource<
  Spec extends SliceViewChunkSpecification = SliceViewChunkSpecification,
  ChunkType extends SliceViewChunk = SliceViewChunk,
>
  extends ChunkSource
  implements SliceViewChunkSourceInterface {
  declare chunks: Map<string, ChunkType>;

  declare OPTIONS: SliceViewChunkSourceOptions<Spec>;

  spec: Spec;

  constructor(
    chunkManager: ChunkManager,
    options: SliceViewChunkSourceOptions<Spec>,
  ) {
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
    const encoding = ChunkSource.encodeOptions(options);
    encoding.spec = SliceViewChunkSource.encodeSpec(options.spec);
    return encoding;
  }

  initializeCounterpart(rpc: RPC, options: any) {
    options.spec = this.spec;
    super.initializeCounterpart(rpc, options);
  }

  // Requests a chunk by its grid position, and returns the result of `transform(chunk)`, where
  // `transform` is guaranteed to be called while the chunk is present in system memory.
  //
  // The `transform` function is used in place of simply returning the chunk, because it is not
  // possible to guarantee that the chunk remains in system memory by the time the promise resolves.
  async fetchChunk<T>(
    chunkGridPosition: Float32Array,
    transform: (chunk: Chunk) => T,
    progressOptions: Partial<ProgressOptions>,
  ): Promise<T> {
    const key = chunkGridPosition.join();
    const existingChunk = this.chunks.get(key);
    if (
      existingChunk !== undefined &&
      existingChunk.state <= ChunkState.SYSTEM_MEMORY
    ) {
      return transform(existingChunk);
    }
    this.addRef();
    let { chunkRequesters } = this;
    if (chunkRequesters === undefined) {
      chunkRequesters = this.chunkRequesters = new Map();
    }
    let requester: ChunkRequesterState;
    let entry = chunkRequesters!.get(key);
    if (entry === undefined) {
      entry = [];
      chunkRequesters!.set(key, entry);
    }
    const promise = new Promise<T>((resolve) => {
      requester = (chunk) => resolve(transform(chunk));
      entry!.push(requester);
    });
    try {
      await this.rpc!.promiseInvoke(
        SLICEVIEW_REQUEST_CHUNK_RPC_ID,
        { source: this.rpcId, chunkGridPosition },
        progressOptions,
      );
      return await promise;
    } finally {
      const entryIndex = entry.indexOf(requester!);
      entry.splice(entryIndex, 1);
      if (entry.length === 0) {
        chunkRequesters!.delete(key);
      }
      if (chunkRequesters.size === 0) {
        this.chunkRequesters = undefined;
      }
      this.dispose();
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface SliceViewChunkSource {
  // TODO(jbms): Move this declaration to the class definition above and declare abstract once
  // TypeScript supports mixins with abstact classes.
  getChunk(x: any): any;
}

export class SliceViewChunk extends Chunk {
  chunkGridPosition: vec3;
  declare source: SliceViewChunkSource;

  constructor(source: SliceViewChunkSource, x: any) {
    super(source);
    this.chunkGridPosition = x.chunkGridPosition;
    this.state = ChunkState.SYSTEM_MEMORY;
  }
}

/**
 * Helper for rendering a SliceView that has been pre-rendered to a texture.
 */
export class SliceViewRenderHelper extends RefCounted {
  private copyVertexPositionsBuffer;

  private textureCoordinateAdjustment = new Float32Array(4);
  private shaderGetter: ParameterizedContextDependentShaderGetter<
    { emitter: ShaderModule; isProjection: boolean },
    boolean
  >;

  defineShader(
    builder: ShaderBuilder,
    hideTransparent: boolean,
    isProjection: boolean,
    emitter: ShaderModule,
  ) {
    builder.addVarying("vec2", "vTexCoord");
    builder.addUniform("sampler2D", "uSampler");
    builder.addInitializer((shader) => {
      this.gl.uniform1i(shader.uniform("uSampler"), 0);
    });
    builder.addUniform("vec4", "uColorFactor");
    builder.addUniform("vec4", "uBackgroundColor");
    builder.addUniform("mat4", "uProjectionMatrix");
    builder.addUniform("vec4", "uTextureCoordinateAdjustment");
    builder.require(emitter);
    const glsl_fragmentMainStart = `
vec4 sampledColor = texture(uSampler, vTexCoord);
if (sampledColor.a == 0.0) {`;
    let glsl_fragmentMainEnd: string;
    if (hideTransparent && isProjection) {
      glsl_fragmentMainEnd = `
  discard;
}
else {
  emit(sampledColor * uColorFactor, 0u);
}
`;
    } else {
      glsl_fragmentMainEnd = `
  sampledColor = uBackgroundColor;
}
emit(sampledColor * uColorFactor, 0u);
`;
    }
    builder.setFragmentMain(`${glsl_fragmentMainStart}${glsl_fragmentMainEnd}`);
    builder.addAttribute("vec4", "aVertexPosition");
    builder.setVertexMain(`
vTexCoord = uTextureCoordinateAdjustment.xy + 0.5 * (aVertexPosition.xy + 1.0) * uTextureCoordinateAdjustment.zw;
gl_Position = uProjectionMatrix * aVertexPosition;
`);
  }

  constructor(
    public gl: GL,
    private emitter: ShaderModule,
    private viewer: SliceViewerState | PerspectiveViewerState,
    private isProjection: boolean,
  ) {
    super();

    this.copyVertexPositionsBuffer = getSquareCornersBuffer(this.gl);
    this.shaderGetter = parameterizedContextDependentShaderGetter(
      this,
      this.gl,
      {
        memoizeKey: "sliceview/SliceViewRenderHelper",
        parameters: this.viewer.hideCrossSectionBackground3D,
        getContextKey: ({ emitter, isProjection }) =>
          `${getObjectId(emitter)}${isProjection}`,
        defineShader: (builder, context, hideTransparent) => {
          this.defineShader(
            builder,
            hideTransparent,
            context.isProjection,
            context.emitter,
          );
        },
      },
    );
  }

  draw(
    texture: WebGLTexture | null,
    projectionMatrix: mat4,
    colorFactor: vec4,
    backgroundColor: vec4,
    xStart: number,
    yStart: number,
    xEnd: number,
    yEnd: number,
  ) {
    const { gl, textureCoordinateAdjustment } = this;
    textureCoordinateAdjustment[0] = xStart;
    textureCoordinateAdjustment[1] = yStart;
    textureCoordinateAdjustment[2] = xEnd - xStart;
    textureCoordinateAdjustment[3] = yEnd - yStart;
    const shaderResult = this.shaderGetter({
      emitter: this.emitter,
      isProjection: this.isProjection,
    });
    const shader = shaderResult.shader;
    if (shader === null) {
      throw new Error("Shader compilation failed in SliceViewRenderHelper.");
    }
    shader.bind();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.disable(WebGL2RenderingContext.BLEND);
    gl.uniformMatrix4fv(
      shader.uniform("uProjectionMatrix"),
      false,
      projectionMatrix,
    );
    gl.uniform4fv(shader.uniform("uColorFactor"), colorFactor);
    gl.uniform4fv(shader.uniform("uBackgroundColor"), backgroundColor);
    gl.uniform4fv(
      shader.uniform("uTextureCoordinateAdjustment"),
      textureCoordinateAdjustment,
    );

    const aVertexPosition = shader.attribute("aVertexPosition");
    this.copyVertexPositionsBuffer.bindToVertexAttrib(
      aVertexPosition,
      /*components=*/ 2,
    );

    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);

    gl.disableVertexAttribArray(aVertexPosition);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  static get(
    gl: GL,
    emitter: ShaderModule,
    viewer: SliceViewerState | PerspectiveViewerState,
    isProjection: boolean,
  ) {
    return gl.memoize.get(
      `sliceview/SliceViewRenderHelper:${getObjectId(emitter)}`,
      () => new SliceViewRenderHelper(gl, emitter, viewer, isProjection),
    );
  }
}

export interface SliceViewSingleResolutionSource<
  Source extends SliceViewChunkSource = SliceViewChunkSource,
> {
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
  SourceOptions extends SliceViewSourceOptions = SliceViewSourceOptions,
> {
  abstract get rank(): number;

  /**
   * @return Chunk sources for each scale, ordered by increasing minVoxelSize.  Outer array indexes
   * over alternative chunk orientations.  The inner array indexes over scale.
   *
   * Every chunk source must have rank equal to `this.rank`.
   */
  abstract getSources(
    options: SourceOptions,
  ): SliceViewSingleResolutionSource<Source>[][];

  constructor(public chunkManager: Borrowed<ChunkManager>) { }
}

export function getVolumetricTransformedSources(
  displayDimensionRenderInfo: DisplayDimensionRenderInfo,
  transform: RenderLayerTransformOrError,
  getSources: (
    options: SliceViewSourceOptions,
  ) => SliceViewSingleResolutionSource<SliceViewChunkSource>[][],
  messages: MessageList,
  layer: any,
): FrontendTransformedSource[][] {
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
  const { displayDimensionIndices, displayRank, canonicalVoxelFactors } =
    displayDimensionRenderInfo;
  const layerDisplayDimensionMapping = getLayerDisplayDimensionMapping(
    transform,
    displayDimensionIndices,
  );

  const { displayToLayerDimensionIndices } = layerDisplayDimensionMapping;
  const multiscaleToViewTransform = new Float32Array(displayRank * chunkRank);
  const { modelToRenderLayerTransform } = transform;
  for (let displayDim = 0; displayDim < displayRank; ++displayDim) {
    const layerDim = displayToLayerDimensionIndices[displayDim];
    if (layerDim === -1) continue;
    const factor = canonicalVoxelFactors[displayDim];
    for (let chunkDim = 0; chunkDim < chunkRank; ++chunkDim) {
      multiscaleToViewTransform[displayRank * chunkDim + displayDim] =
        modelToRenderLayerTransform[(layerRank + 1) * chunkDim + layerDim] *
        factor;
    }
  }
  const allSources = getSources({
    displayRank: displayRank,
    multiscaleToViewTransform: multiscaleToViewTransform,
    modelChannelDimensionIndices: transform.channelToRenderLayerDimensions,
  });
  const { voxelPhysicalScales: globalScales } = displayDimensionRenderInfo;
  try {
    const getTransformedSource = (
      singleResolutionSource: SliceViewSingleResolutionSource,
    ): FrontendTransformedSource => {
      const { chunkSource: source } = singleResolutionSource;
      const { spec } = source;
      const {
        lowerClipBound = spec.lowerVoxelBound,
        upperClipBound = spec.upperVoxelBound,
      } = singleResolutionSource;
      const chunkTransform = getChunkTransformParameters(
        transform,
        singleResolutionSource.chunkToMultiscaleTransform,
      );
      const { chunkDataSize } = spec;
      const { channelToChunkDimensionIndices } = chunkTransform;
      const nonDisplayLowerClipBound = new Float32Array(chunkRank);
      const nonDisplayUpperClipBound = new Float32Array(chunkRank);
      nonDisplayLowerClipBound.set(lowerClipBound);
      nonDisplayUpperClipBound.set(upperClipBound);
      const channelRank = channelToChunkDimensionIndices.length;
      const { channelSpaceShape } = transform;
      for (let channelDim = 0; channelDim < channelRank; ++channelDim) {
        const chunkDim = channelToChunkDimensionIndices[channelDim];
        if (chunkDim === -1) continue;
        const size = channelSpaceShape[channelDim];
        if (chunkDataSize[chunkDim] !== size) {
          throw new Error(
            "Channel dimension " +
            transform.layerDimensionNames[
            transform.channelToRenderLayerDimensions[channelDim]
            ] +
            ` has extent ${size} but corresponding chunk dimension has extent ` +
            `${chunkDataSize[chunkDim]}`,
          );
        }
        nonDisplayLowerClipBound[chunkDim] = Number.NEGATIVE_INFINITY;
        nonDisplayUpperClipBound[chunkDim] = Number.POSITIVE_INFINITY;
      }
      const chunkDisplayTransform = getChunkDisplayTransformParameters(
        chunkTransform,
        layerDisplayDimensionMapping,
      );
      // Compute `chunkDisplaySize`, and `{lower,upper}ChunkDisplayBound`.
      const lowerChunkDisplayBound = vec3.create();
      const upperChunkDisplayBound = vec3.create();
      const lowerClipDisplayBound = vec3.create();
      const upperClipDisplayBound = vec3.create();
      // Size of chunk in "display" coordinate space.
      const chunkDisplaySize = vec3.create();
      const { numChunkDisplayDims, chunkDisplayDimensionIndices } =
        chunkDisplayTransform;
      const {
        combinedGlobalLocalToChunkTransform,
        layerRank,
        combinedGlobalLocalRank,
      } = chunkTransform;
      const fixedLayerToChunkTransform = new Float32Array(
        combinedGlobalLocalToChunkTransform,
      );
      for (
        let chunkDisplayDimIndex = 0;
        chunkDisplayDimIndex < numChunkDisplayDims;
        ++chunkDisplayDimIndex
      ) {
        const chunkDim = chunkDisplayDimensionIndices[chunkDisplayDimIndex];
        for (let i = 0; i <= combinedGlobalLocalRank; ++i) {
          fixedLayerToChunkTransform[chunkDim + i * layerRank] = 0;
        }
        if (chunkDim < chunkRank) {
          chunkDisplaySize[chunkDisplayDimIndex] = spec.chunkDataSize[chunkDim];
          lowerChunkDisplayBound[chunkDisplayDimIndex] =
            spec.lowerChunkBound[chunkDim];
          upperChunkDisplayBound[chunkDisplayDimIndex] =
            spec.upperChunkBound[chunkDim];
          lowerClipDisplayBound[chunkDisplayDimIndex] =
            lowerClipBound[chunkDim];
          upperClipDisplayBound[chunkDisplayDimIndex] =
            upperClipBound[chunkDim];
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
        chunkDisplaySize,
        chunkDisplayTransform.displaySubspaceModelMatrix,
        numChunkDisplayDims,
      );
      // This is an approximation of the voxel size (exact only for permutation/scaling
      // transforms).  It would be better to model the voxel as an ellipsiod and find the
      // lengths of the axes.
      const effectiveVoxelSize = chunkLayout.localSpatialVectorToGlobal(
        vec3.create(),
        /*baseVoxelSize=*/ kOneVec,
      );
      for (let i = 0; i < displayRank; ++i) {
        effectiveVoxelSize[i] = Math.abs(
          effectiveVoxelSize[i] * globalScales[i],
        );
      }
      effectiveVoxelSize.fill(1, displayRank);
      return {
        layerRank,
        lowerClipBound,
        upperClipBound,
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
        combinedGlobalLocalToChunkTransform:
          chunkTransform.combinedGlobalLocalToChunkTransform,
        fixedPositionWithinChunk: new Uint32Array(chunkRank),
        chunkTransform,
        chunkDisplayTransform,
      };
    };
    return allSources.map((scales) =>
      scales.map((s) => getTransformedSource(s)),
    );
  } catch (e) {
    // Ensure references are released in the case of an exception.
    for (const scales of allSources) {
      for (const { chunkSource: source } of scales) {
        source.dispose();
      }
    }
    const { globalDimensionNames } = displayDimensionRenderInfo;
    const dimensionDesc = Array.from(
      displayDimensionRenderInfo.displayDimensionIndices.filter(
        (i) => i !== -1,
      ),
      (i) => globalDimensionNames[i],
    ).join(",\u00a0");
    const message = `Cannot render (${dimensionDesc}) cross section: ${e.message}`;
    return returnError(message);
  }
}
