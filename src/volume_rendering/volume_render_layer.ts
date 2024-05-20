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

import { ChunkState } from "#src/chunk_manager/base.js";
import { ChunkRenderLayerFrontend } from "#src/chunk_manager/frontend.js";
import type { CoordinateSpace } from "#src/coordinate_transform.js";
import type { VisibleLayerInfo } from "#src/layer/index.js";
import type { PerspectivePanel } from "#src/perspective_view/panel.js";
import type {
  PerspectiveViewReadyRenderContext,
  PerspectiveViewRenderContext,
} from "#src/perspective_view/render_layer.js";
import { PerspectiveViewRenderLayer } from "#src/perspective_view/render_layer.js";
import type { RenderLayerTransformOrError } from "#src/render_coordinate_transform.js";
import type { RenderScaleHistogram } from "#src/render_scale_statistics.js";
import {
  numRenderScaleHistogramBins,
  renderScaleHistogramBinSize,
} from "#src/render_scale_statistics.js";
import { SharedWatchableValue } from "#src/shared_watchable_value.js";
import { getNormalizedChunkLayout } from "#src/sliceview/base.js";
import type { FrontendTransformedSource } from "#src/sliceview/frontend.js";
import {
  getVolumetricTransformedSources,
  serializeAllTransformedSources,
} from "#src/sliceview/frontend.js";
import type { SliceViewRenderLayer } from "#src/sliceview/renderlayer.js";
import type {
  ChunkFormat,
  MultiscaleVolumeChunkSource,
  VolumeChunk,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import { defineChunkDataShaderAccess } from "#src/sliceview/volume/frontend.js";
import type {
  NestedStateManager,
  WatchableValueInterface,
} from "#src/trackable_value.js";
import {
  makeCachedDerivedWatchableValue,
  registerNested,
} from "#src/trackable_value.js";
import type { RefCountedValue } from "#src/util/disposable.js";
import { getFrustrumPlanes, mat4, vec3 } from "#src/util/geom.js";
import { clampToInterval } from "#src/util/lerp.js";
import { getObjectId } from "#src/util/object_id.js";
import type { HistogramInformation } from "#src/volume_rendering/base.js";
import {
  forEachVisibleVolumeRenderingChunk,
  getVolumeRenderingNearFarBounds,
  VOLUME_RENDERING_RENDER_LAYER_RPC_ID,
  VOLUME_RENDERING_RENDER_LAYER_UPDATE_SOURCES_RPC_ID,
} from "#src/volume_rendering/base.js";
import type { TrackableVolumeRenderingModeValue } from "#src/volume_rendering/trackable_volume_rendering_mode.js";
import {
  VolumeRenderingModes,
  isProjectionMode,
} from "#src/volume_rendering/trackable_volume_rendering_mode.js";
import {
  drawBoxes,
  glsl_getBoxFaceVertexPosition,
} from "#src/webgl/bounding_box.js";
import type { Buffer } from "#src/webgl/buffer.js";
import { getMemoizedBuffer } from "#src/webgl/buffer.js";
import { glsl_COLORMAPS } from "#src/webgl/colormaps.js";
import type {
  ParameterizedContextDependentShaderGetter,
  ParameterizedShaderGetterResult,
  WatchableShaderError,
} from "#src/webgl/dynamic_shader.js";
import {
  parameterizedContextDependentShaderGetter,
  shaderCodeWithLineDirective,
} from "#src/webgl/dynamic_shader.js";
import type {
  HistogramChannelSpecification,
  HistogramSpecifications,
} from "#src/webgl/empirical_cdf.js";
import {
  defineInvlerpShaderFunction,
  enableLerpShaderFunction,
} from "#src/webgl/lerp.js";
import type { ShaderModule, ShaderProgram } from "#src/webgl/shader.js";
import { getShaderType, glsl_simpleFloatHash } from "#src/webgl/shader_lib.js";
import type {
  ShaderControlsBuilderState,
  ShaderControlState,
} from "#src/webgl/shader_ui_controls.js";
import {
  addControlsToBuilder,
  setControlsInShader,
} from "#src/webgl/shader_ui_controls.js";
import { defineVertexId, VertexIdHelper } from "#src/webgl/vertex_id.js";

export const VOLUME_RENDERING_DEPTH_SAMPLES_DEFAULT_VALUE = 64;
const VOLUME_RENDERING_DEPTH_SAMPLES_LOG_SCALE_ORIGIN = 1;
const VOLUME_RENDERING_RESOLUTION_INDICATOR_BAR_HEIGHT = 10;
const HISTOGRAM_SAMPLES_PER_INSTANCE = 512;

// Number of points to sample in computing the histogram.  Increasing this increases the precision
// of the histogram but also slows down rendering.
const NUM_HISTOGRAM_SAMPLES = 4096;
const DEBUG_HISTOGRAMS = false;

const depthSamplerTextureUnit = Symbol("depthSamplerTextureUnit");

export const glsl_emitRGBAVolumeRendering = `
void emitRGBA(vec4 rgba) {
  float correctedAlpha = clamp(rgba.a * uBrightnessFactor * uGain, 0.0, 1.0);
  float weightedAlpha = correctedAlpha * computeOITWeight(correctedAlpha, depthAtRayPosition);
  outputColor += vec4(rgba.rgb * weightedAlpha, weightedAlpha);
  revealage *= 1.0 - correctedAlpha;
}
`;

type TransformedVolumeSource = FrontendTransformedSource<
  SliceViewRenderLayer,
  VolumeChunkSource
>;

interface VolumeRenderingAttachmentState {
  sources: NestedStateManager<TransformedVolumeSource[][]>;
}

export interface VolumeRenderingRenderLayerOptions {
  gain: WatchableValueInterface<number>;
  multiscaleSource: MultiscaleVolumeChunkSource;
  transform: WatchableValueInterface<RenderLayerTransformOrError>;
  shaderError: WatchableShaderError;
  shaderControlState: ShaderControlState;
  channelCoordinateSpace: WatchableValueInterface<CoordinateSpace>;
  localPosition: WatchableValueInterface<Float32Array>;
  depthSamplesTarget: WatchableValueInterface<number>;
  chunkResolutionHistogram: RenderScaleHistogram;
  mode: TrackableVolumeRenderingModeValue;
}

interface VolumeRenderingShaderParameters {
  numChannelDimensions: number;
  mode: VolumeRenderingModes;
}

const tempMat4 = mat4.create();
const tempVisibleVolumetricClippingPlanes = new Float32Array(24);

export function getVolumeRenderingDepthSamplesBoundsLogScale(): [
  number,
  number,
] {
  const logScaleMax = Math.round(
    VOLUME_RENDERING_DEPTH_SAMPLES_LOG_SCALE_ORIGIN +
      numRenderScaleHistogramBins * renderScaleHistogramBinSize,
  );
  return [VOLUME_RENDERING_DEPTH_SAMPLES_LOG_SCALE_ORIGIN, logScaleMax];
}

function clampAndRoundResolutionTargetValue(value: number) {
  const logScaleDepthSamplesBounds =
    getVolumeRenderingDepthSamplesBoundsLogScale();
  const depthSamplesBounds: [number, number] = [
    2 ** logScaleDepthSamplesBounds[0],
    2 ** logScaleDepthSamplesBounds[1] - 1,
  ];
  return clampToInterval(depthSamplesBounds, Math.round(value)) as number;
}

export class VolumeRenderingRenderLayer extends PerspectiveViewRenderLayer {
  gain: WatchableValueInterface<number>;
  multiscaleSource: MultiscaleVolumeChunkSource;
  transform: WatchableValueInterface<RenderLayerTransformOrError>;
  channelCoordinateSpace: WatchableValueInterface<CoordinateSpace>;
  localPosition: WatchableValueInterface<Float32Array>;
  shaderControlState: ShaderControlState;
  depthSamplesTarget: WatchableValueInterface<number>;
  chunkResolutionHistogram: RenderScaleHistogram;
  mode: TrackableVolumeRenderingModeValue;
  backend: ChunkRenderLayerFrontend;
  private vertexIdHelper: VertexIdHelper;
  private dataHistogramSpecifications: HistogramSpecifications;

  private shaderGetter: ParameterizedContextDependentShaderGetter<
    { emitter: ShaderModule; chunkFormat: ChunkFormat; wireFrame: boolean },
    ShaderControlsBuilderState,
    VolumeRenderingShaderParameters
  >;

  private histogramShaderGetter: ParameterizedContextDependentShaderGetter<
    { chunkFormat: ChunkFormat },
    ShaderControlsBuilderState,
    VolumeRenderingShaderParameters
  >;

  get gl() {
    return this.multiscaleSource.chunkManager.gl;
  }

  get isTransparent() {
    return true;
  }

  get isVolumeRendering() {
    return true;
  }

  getDataHistogramCount() {
    return this.dataHistogramSpecifications.visibleHistograms;
  }

  private histogramIndexBuffer: RefCountedValue<Buffer>;

  constructor(options: VolumeRenderingRenderLayerOptions) {
    super();
    this.gain = options.gain;
    this.multiscaleSource = options.multiscaleSource;
    this.transform = options.transform;
    this.channelCoordinateSpace = options.channelCoordinateSpace;
    this.shaderControlState = options.shaderControlState;
    this.localPosition = options.localPosition;
    this.depthSamplesTarget = options.depthSamplesTarget;
    this.chunkResolutionHistogram = options.chunkResolutionHistogram;
    this.mode = options.mode;
    this.dataHistogramSpecifications =
      this.shaderControlState.histogramSpecifications;
    this.histogramIndexBuffer = this.registerDisposer(
      getMemoizedBuffer(
        this.gl,
        WebGL2RenderingContext.ARRAY_BUFFER,
        () => new Uint8Array(HISTOGRAM_SAMPLES_PER_INSTANCE),
      ),
    );
    this.registerDisposer(
      this.chunkResolutionHistogram.visibility.add(this.visibility),
    );
    this.registerDisposer(
      this.dataHistogramSpecifications.producerVisibility.add(this.visibility),
    );
    const extraParameters = this.registerDisposer(
      makeCachedDerivedWatchableValue(
        (
          space: CoordinateSpace,
          mode: VolumeRenderingModes,
          dataHistogramChannelSpecifications: HistogramChannelSpecification[],
        ) => ({
          numChannelDimensions: space.rank,
          mode,
          dataHistogramChannelSpecifications,
        }),
        [
          this.channelCoordinateSpace,
          this.mode,
          this.dataHistogramSpecifications.channels,
        ],
      ),
    );
    this.shaderGetter = parameterizedContextDependentShaderGetter(
      this,
      this.gl,
      {
        memoizeKey: "VolumeRenderingRenderLayer",
        parameters: options.shaderControlState.builderState,
        getContextKey: ({ emitter, chunkFormat, wireFrame }) =>
          `${getObjectId(emitter)}:${chunkFormat.shaderKey}:${wireFrame}`,
        shaderError: options.shaderError,
        extraParameters: extraParameters,
        defineShader: (
          builder,
          { emitter, chunkFormat, wireFrame },
          shaderBuilderState,
          shaderParametersState,
        ) => {
          if (shaderBuilderState.parseResult.errors.length !== 0) {
            throw new Error("Invalid UI control specification");
          }
          defineVertexId(builder);
          builder.addFragmentCode(`
#define VOLUME_RENDERING true
`);
          let glsl_rgbaEmit = glsl_emitRGBAVolumeRendering;
          let glsl_finalEmit = `
  emitAccumAndRevealage(outputColor, 1.0 - revealage, 0u);
`;
          let glsl_emitIntensity = `
void emitIntensity(float value) {
}
`;
          let glsl_handleMaxProjectionUpdate = ``;
          if (isProjectionMode(shaderParametersState.mode)) {
            const glsl_intensityConversion =
              shaderParametersState.mode === VolumeRenderingModes.MIN
                ? `1.0 - value`
                : `value`;
            builder.addFragmentCode(`
float savedDepth = 0.0;
float savedIntensity = 0.0;
vec4 newColor = vec4(0.0);
`);
            glsl_emitIntensity = `
float convertIntensity(float value) {
  return clamp(${glsl_intensityConversion}, 0.0, 1.0);
}
void emitIntensity(float value) {
  defaultMaxProjectionIntensity = value;
}
float getIntensity() {
  return convertIntensity(defaultMaxProjectionIntensity);
}
`;
            glsl_rgbaEmit = `
void emitRGBA(vec4 rgba) {
  float alpha = clamp(rgba.a, 0.0, 1.0);
  newColor = vec4(rgba.rgb * alpha, alpha);
}
`;
            glsl_finalEmit = `
  gl_FragDepth = savedIntensity;
`;
            glsl_handleMaxProjectionUpdate = `
  float newIntensity = getIntensity();
  bool intensityChanged = newIntensity > savedIntensity;
  savedIntensity = intensityChanged ? newIntensity : savedIntensity; 
  savedDepth = intensityChanged ? depthAtRayPosition : savedDepth;
  outputColor = intensityChanged ? newColor : outputColor;
  emit(outputColor, savedDepth, savedIntensity);
  defaultMaxProjectionIntensity = 0.0;
`;
          }
          emitter(builder);
          // Near limit in [0, 1] as fraction of full limit.
          builder.addUniform("highp float", "uNearLimitFraction");
          // Far limit in [0, 1] as fraction of full limit.
          builder.addUniform("highp float", "uFarLimitFraction");
          builder.addUniform("highp int", "uMaxSteps");

          // Specifies translation of the current chunk.
          builder.addUniform("highp vec3", "uTranslation");

          // Matrix by which computed vertices will be transformed.
          builder.addUniform("highp mat4", "uModelViewProjectionMatrix");
          builder.addUniform("highp mat4", "uInvModelViewProjectionMatrix");

          // Chunk size in voxels.
          builder.addUniform("highp vec3", "uChunkDataSize");
          builder.addUniform("highp float", "uChunkNumber");

          builder.addUniform("highp vec3", "uLowerClipBound");
          builder.addUniform("highp vec3", "uUpperClipBound");

          builder.addUniform("highp float", "uBrightnessFactor");
          builder.addUniform("highp float", "uGain");
          builder.addVarying("highp vec4", "vNormalizedPosition");
          builder.addTextureSampler(
            "sampler2D",
            "uDepthSampler",
            depthSamplerTextureUnit,
          );
          builder.addVertexCode(glsl_getBoxFaceVertexPosition);

          builder.setVertexMain(`
vec3 boxVertex = getBoxFaceVertexPosition(gl_VertexID);
vec3 position = max(uLowerClipBound, min(uUpperClipBound, uTranslation + boxVertex * uChunkDataSize));
vNormalizedPosition = gl_Position = uModelViewProjectionMatrix * vec4(position, 1.0);
gl_Position.z = 0.0;
`);
          builder.addFragmentCode(`
vec3 curChunkPosition;
float depthAtRayPosition;
vec4 outputColor;
float revealage;
void userMain();
`);
          defineChunkDataShaderAccess(
            builder,
            chunkFormat,
            shaderParametersState.numChannelDimensions,
            "curChunkPosition",
          );
          builder.addFragmentCode([
            glsl_emitIntensity,
            glsl_rgbaEmit,
            `
void emitRGB(vec3 rgb) {
  emitRGBA(vec4(rgb, 1.0));
}
void emitGrayscale(float value) {
  emitRGBA(vec4(value, value, value, value));
}
void emitTransparent() {
  emitIntensity(0.0);
  emitRGBA(vec4(0.0, 0.0, 0.0, 0.0));
}
float computeDepthFromClipSpace(vec4 clipSpacePosition) {
  float NDCDepthCoord = clipSpacePosition.z / clipSpacePosition.w;
  return (NDCDepthCoord + 1.0) * 0.5;
}
vec2 computeUVFromClipSpace(vec4 clipSpacePosition) {
  vec2 NDCPosition = clipSpacePosition.xy / clipSpacePosition.w;
  return (NDCPosition + 1.0) * 0.5;
}
`,
          ]);
          if (wireFrame) {
            let glsl_emitWireframe = `
  emit(outputColor, 0u);
`;
            if (isProjectionMode(shaderParametersState.mode)) {
              glsl_emitWireframe = `
  emit(outputColor, 1.0, uChunkNumber);
            `;
            }
            builder.setFragmentMainFunction(`
void main() {
  outputColor = vec4(uChunkNumber, uChunkNumber, uChunkNumber, 1.0);
  emitIntensity(uChunkNumber);
  ${glsl_emitWireframe}
}
`);
          } else {
            builder.setFragmentMainFunction(`
void main() {
  vec2 normalizedPosition = vNormalizedPosition.xy / vNormalizedPosition.w;
  vec4 nearPointH = uInvModelViewProjectionMatrix * vec4(normalizedPosition, -1.0, 1.0);
  vec4 farPointH = uInvModelViewProjectionMatrix * vec4(normalizedPosition, 1.0, 1.0);
  vec3 nearPoint = nearPointH.xyz / nearPointH.w;
  vec3 farPoint = farPointH.xyz / farPointH.w;
  vec3 rayVector = farPoint - nearPoint;
  vec3 boxStart = max(uLowerClipBound, uTranslation);
  vec3 boxEnd = min(boxStart + uChunkDataSize, uUpperClipBound);
  float intersectStart = uNearLimitFraction;
  float intersectEnd = uFarLimitFraction;
  for (int i = 0; i < 3; ++i) {
    float startPt = nearPoint[i];
    float endPt = farPoint[i];
    float boxLower = boxStart[i];
    float boxUpper = boxEnd[i];
    float r = rayVector[i];
    float startFraction;
    float endFraction;
    if (startPt >= boxLower && startPt <= boxUpper) {
      startFraction = 0.0;
    } else {
      startFraction = min((boxLower - startPt) / r, (boxUpper - startPt) / r);
    }
    if (endPt >= boxLower && endPt <= boxUpper) {
      endFraction = 1.0;
    } else {
      endFraction = max((boxLower - startPt) / r, (boxUpper - startPt) / r);
    }
    intersectStart = max(intersectStart, startFraction);
    intersectEnd = min(intersectEnd, endFraction);
  }
  float stepSize = (uFarLimitFraction - uNearLimitFraction) / float(uMaxSteps - 1);
  int startStep = int(floor((intersectStart - uNearLimitFraction) / stepSize));
  int endStep = min(uMaxSteps, int(floor((intersectEnd - uNearLimitFraction) / stepSize)) + 1);
  outputColor = vec4(0, 0, 0, 0);
  revealage = 1.0;
  for (int rayStep = startStep; rayStep < endStep; ++rayStep) {
    vec3 position = mix(nearPoint, farPoint, uNearLimitFraction + float(rayStep) * stepSize);
    vec4 clipSpacePosition = uModelViewProjectionMatrix * vec4(position, 1.0);
    depthAtRayPosition = computeDepthFromClipSpace(clipSpacePosition);
    vec2 uv = computeUVFromClipSpace(clipSpacePosition);
    float depthInBuffer = texture(uDepthSampler, uv).r;
    bool rayPositionBehindOpaqueObject = (1.0 - depthAtRayPosition) < depthInBuffer;
    if (rayPositionBehindOpaqueObject) {
      break;
    }
    curChunkPosition = position - uTranslation;
    userMain();
    ${glsl_handleMaxProjectionUpdate}
  }
  ${glsl_finalEmit}
}
`);
          }
          builder.addFragmentCode(glsl_COLORMAPS);
          addControlsToBuilder(shaderBuilderState, builder);
          builder.addFragmentCode(
            "\n#define main userMain\n" +
              shaderCodeWithLineDirective(shaderBuilderState.parseResult.code) +
              "\n#undef main\n",
          );
        },
      },
    );
    this.histogramShaderGetter = parameterizedContextDependentShaderGetter(
      this,
      this.gl,
      {
        memoizeKey: "VolumeRenderingRenderLayerHistogram",
        parameters: options.shaderControlState.builderState,
        getContextKey: ({ chunkFormat }) => `${chunkFormat.shaderKey}`,
        shaderError: options.shaderError,
        extraParameters: extraParameters,
        defineShader: (
          builder,
          { chunkFormat },
          shaderBuilderState,
          shaderParametersState,
        ) => {
          shaderBuilderState;
          builder.addOutputBuffer("vec4", "outputValue", null);
          builder.addUniform("highp vec3", "uChunkDataSize");
          builder.addUniform("highp int", "uHistogramIndex");
          builder.addAttribute("float", "aInput1");
          builder.addVertexCode(`
vec3 chunkSamplePosition;
          `);
          const numChannelDimensions =
            shaderParametersState.numChannelDimensions;
          chunkFormat.defineShader(builder, numChannelDimensions, true);
          const { dataType } = chunkFormat;
          let dataAccessChannelParams = "";
          let dataAccessChannelArgs = "";
          if (numChannelDimensions === 0) {
            dataAccessChannelParams += "highp int ignoredChannelIndex";
          } else {
            for (
              let channelDim = 0;
              channelDim < numChannelDimensions;
              ++channelDim
            ) {
              if (channelDim !== 0) dataAccessChannelParams += ", ";
              dataAccessChannelParams += `highp int channelIndex${channelDim}`;
              dataAccessChannelArgs += `, channelIndex${channelDim}`;
            }
          }
          const dataAccessCode = `
${getShaderType(dataType)} getDataValue(${dataAccessChannelParams}) {
  highp ivec3 p = ivec3(max(vec3(0.0, 0.0, 0.0), min(floor(chunkSamplePosition), uChunkDataSize - 1.0)));
  return getDataValueAt(p${dataAccessChannelArgs});
}`;
          builder.addVertexCode(dataAccessCode);
          if (numChannelDimensions <= 1) {
            builder.addVertexCode(`
${getShaderType(dataType)} getDataValue() { return getDataValue(0); }
`);
          }
          const dataHistogramChannelSpecifications =
            shaderParametersState.dataHistogramChannelSpecifications;
          const numHistograms = dataHistogramChannelSpecifications.length;
          let histogramFetchCode = `
float x;
switch (uHistogramIndex) {`;
          for (let i = 0; i < numHistograms; ++i) {
            const { channel } = dataHistogramChannelSpecifications[i];
            const getDataValueExpr = `getDataValue(${channel.join(",")})`;
            const invlerpName = `invlerpForHistogram${i}`;
            builder.addVertexCode(
              defineInvlerpShaderFunction(
                builder,
                invlerpName,
                dataType,
                false,
              ),
            );
            builder.addVertexCode(`
float getHistogramValue${i}() {
  return invlerpForHistogram${i}(${getDataValueExpr});
}
`);
            histogramFetchCode += `
case ${i}:
  x = getHistogramValue${i}();
  break;
`;
          }
          histogramFetchCode += `
}
`;
          builder.addVertexCode(glsl_simpleFloatHash);
          builder.setVertexMain(`
vec3 rand3 = vec3(simpleFloatHash(vec2(aInput1 + float(gl_VertexID), float(gl_InstanceID))),
              simpleFloatHash(vec2(aInput1 + float(gl_VertexID) + 10.0, 5.0 + float(gl_InstanceID))),
              simpleFloatHash(vec2(aInput1 + float(gl_VertexID) + 20.0, 15.0 + float(gl_InstanceID)))
            );
chunkSamplePosition = rand3 * (uChunkDataSize - 1.0);
${histogramFetchCode}
if (x == 0.0) {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
else {
  if (x < 0.0) x = 0.0;
  else if (x > 1.0) x = 1.0;
  else x = (1.0 + x * 253.0) / 255.0;
  gl_Position = vec4(2.0 * (x * 255.0 + 0.5) / 256.0 - 1.0, 0.0, 0.0, 1.0);
}
gl_PointSize = 1.0;
          `);
          builder.setFragmentMain(`
outputValue = vec4(1.0, 1.0, 1.0, 1.0);
          `);
        },
      },
    );

    this.vertexIdHelper = this.registerDisposer(VertexIdHelper.get(this.gl));

    this.registerDisposer(
      this.depthSamplesTarget.changed.add(this.redrawNeeded.dispatch),
    );
    this.registerDisposer(this.gain.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(
      this.shaderControlState.changed.add(this.redrawNeeded.dispatch),
    );
    this.registerDisposer(
      this.localPosition.changed.add(this.redrawNeeded.dispatch),
    );
    this.registerDisposer(
      this.transform.changed.add(this.redrawNeeded.dispatch),
    );
    this.registerDisposer(this.mode.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(
      this.shaderControlState.fragmentMain.changed.add(
        this.redrawNeeded.dispatch,
      ),
    );
    const { chunkManager } = this.multiscaleSource;
    const sharedObject = this.registerDisposer(
      new ChunkRenderLayerFrontend(this.layerChunkProgressInfo),
    );
    const rpc = chunkManager.rpc!;
    sharedObject.RPC_TYPE_ID = VOLUME_RENDERING_RENDER_LAYER_RPC_ID;
    sharedObject.initializeCounterpart(rpc, {
      chunkManager: chunkManager.rpcId,
      localPosition: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(rpc, this.localPosition),
      ).rpcId,
      renderScaleTarget: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(rpc, this.depthSamplesTarget),
      ).rpcId,
    });
    this.backend = sharedObject;
  }

  get dataType() {
    return this.multiscaleSource.dataType;
  }

  attach(
    attachment: VisibleLayerInfo<
      PerspectivePanel,
      VolumeRenderingAttachmentState
    >,
  ) {
    super.attach(attachment);
    attachment.state = {
      sources: attachment.registerDisposer(
        registerNested(
          (context, transform, displayDimensionRenderInfo) => {
            const transformedSources = getVolumetricTransformedSources(
              displayDimensionRenderInfo,
              transform,
              (options) => this.multiscaleSource.getSources(options),
              attachment.messages,
              this,
            ) as TransformedVolumeSource[][];
            for (const scales of transformedSources) {
              for (const tsource of scales) {
                context.registerDisposer(tsource.source);
              }
            }
            attachment.view.flushBackendProjectionParameters();
            this.backend.rpc!.invoke(
              VOLUME_RENDERING_RENDER_LAYER_UPDATE_SOURCES_RPC_ID,
              {
                layer: this.backend.rpcId,
                view: attachment.view.rpcId,
                sources: serializeAllTransformedSources(transformedSources),
              },
            );
            this.redrawNeeded.dispatch();
            return transformedSources;
          },
          this.transform,
          attachment.view.displayDimensionRenderInfo,
        ),
      ),
    };
  }

  get chunkManager() {
    return this.multiscaleSource.chunkManager;
  }

  draw(
    renderContext: PerspectiveViewRenderContext,
    attachment: VisibleLayerInfo<
      PerspectivePanel,
      VolumeRenderingAttachmentState
    >,
  ) {
    if (!renderContext.emitColor) return;
    const allSources = attachment.state!.sources.value;
    if (allSources.length === 0) return;
    let curPhysicalSpacing = 0;
    let curOptimalSamples = 0;
    let curHistogramInformation: HistogramInformation = {
      spatialScales: new Map(),
      activeIndex: 0,
    };
    let shader: ShaderProgram | null = null;
    let histogramShader: ShaderProgram | null = null;
    let prevChunkFormat: ChunkFormat | undefined | null;
    let shaderResult: ParameterizedShaderGetterResult<
      ShaderControlsBuilderState,
      VolumeRenderingShaderParameters
    >;
    let histogramShaderResult: ParameterizedShaderGetterResult<
      ShaderControlsBuilderState,
      VolumeRenderingShaderParameters
    >;
    // Size of chunk (in voxels) in the "display" subspace of the chunk coordinate space.
    const chunkDataDisplaySize = vec3.create();

    const { gl } = this;
    this.vertexIdHelper.enable();

    const { chunkResolutionHistogram: renderScaleHistogram } = this;
    renderScaleHistogram.begin(
      this.chunkManager.chunkQueueManager.frameNumberCounter.frameNumber,
    );

    const restoreFrameBuffer = () => {
      if (isProjectionMode(this.mode.value)) {
        gl.disable(WebGL2RenderingContext.BLEND);
        if (renderContext.bindMaxProjectionBuffer !== undefined) {
          renderContext.bindMaxProjectionBuffer();
        } else {
          throw new Error(
            "bindMaxProjectionBuffer is undefined in VolumeRenderingRenderLayer",
          );
        }
      } else {
        renderContext.bindFramebuffer();
      }
    };

    const endShader = () => {
      if (shader === null) return;
      if (prevChunkFormat !== null) {
        prevChunkFormat!.endDrawing(gl, shader);
        if (histogramShader !== null) {
          prevChunkFormat!.endDrawing(gl, histogramShader);
        }
      }
      const depthTextureUnit = shader.textureUnit(depthSamplerTextureUnit);
      gl.activeTexture(WebGL2RenderingContext.TEXTURE0 + depthTextureUnit);
      gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, null);
      if (presentCount !== 0 || notPresentCount !== 0) {
        let index = curHistogramInformation.spatialScales.size - 1;
        const alreadyStoredSamples = new Set<number>([
          clampAndRoundResolutionTargetValue(curOptimalSamples),
        ]);
        curHistogramInformation.spatialScales.forEach(
          (optimalSamples, physicalSpacing) => {
            const roundedSamples =
              clampAndRoundResolutionTargetValue(optimalSamples);
            if (
              index !== curHistogramInformation.activeIndex &&
              !alreadyStoredSamples.has(roundedSamples)
            ) {
              renderScaleHistogram.add(
                physicalSpacing,
                optimalSamples,
                0,
                VOLUME_RENDERING_RESOLUTION_INDICATOR_BAR_HEIGHT,
                true,
              );
              alreadyStoredSamples.add(roundedSamples);
            }
            index--;
          },
        );
        renderScaleHistogram.add(
          curPhysicalSpacing,
          curOptimalSamples,
          presentCount,
          notPresentCount,
        );
      }
    };
    let newSource = true;

    const { projectionParameters } = renderContext;

    let chunks: Map<string, VolumeChunk>;
    let presentCount = 0;
    let notPresentCount = 0;
    let chunkDataSize: Uint32Array | undefined;
    let chunkNumber = 1;

    const chunkRank = this.multiscaleSource.rank;
    const chunkPosition = vec3.create();

    const needToDrawHistogram =
      this.getDataHistogramCount() > 0 &&
      !renderContext.wireFrame &&
      !renderContext.sliceViewsPresent;

    gl.enable(WebGL2RenderingContext.CULL_FACE);
    gl.cullFace(WebGL2RenderingContext.FRONT);

    if (needToDrawHistogram) {
      const outputBuffers =
        this.dataHistogramSpecifications.getFramebuffers(gl);
      const count = this.getDataHistogramCount();
      for (let i = 0; i < count; ++i) {
        outputBuffers[i].bind(256, 1);
        gl.clearColor(0.0, 0.0, 0.0, 1.0);
        gl.clear(WebGL2RenderingContext.COLOR_BUFFER_BIT);
      }
      restoreFrameBuffer();
    }

    forEachVisibleVolumeRenderingChunk(
      renderContext.projectionParameters,
      this.localPosition.value,
      this.depthSamplesTarget.value,
      allSources[0],
      (
        transformedSource,
        ignored1,
        physicalSpacing,
        optimalSamples,
        ignored2,
        histogramInformation,
      ) => {
        ignored1;
        ignored2;
        curPhysicalSpacing = physicalSpacing;
        curOptimalSamples = optimalSamples;
        curHistogramInformation = histogramInformation;
        const chunkLayout = getNormalizedChunkLayout(
          projectionParameters,
          transformedSource.chunkLayout,
        );
        const source = transformedSource.source as VolumeChunkSource;
        const { fixedPositionWithinChunk, chunkDisplayDimensionIndices } =
          transformedSource;
        for (const chunkDim of chunkDisplayDimensionIndices) {
          fixedPositionWithinChunk[chunkDim] = 0;
        }
        const chunkFormat = source.chunkFormat;
        if (chunkFormat !== prevChunkFormat) {
          prevChunkFormat = chunkFormat;
          endShader();
          shaderResult = this.shaderGetter({
            emitter: renderContext.emitter,
            chunkFormat: chunkFormat!,
            wireFrame: renderContext.wireFrame,
          });
          shader = shaderResult.shader;
          if (needToDrawHistogram) {
            histogramShaderResult = this.histogramShaderGetter({
              chunkFormat: chunkFormat!,
            });
            histogramShader = histogramShaderResult.shader;
          }
          if (shader !== null) {
            shader.bind();
            if (chunkFormat !== null) {
              setControlsInShader(
                gl,
                shader,
                this.shaderControlState,
                shaderResult.parameters.parseResult.controls,
              );
              if (
                renderContext.depthBufferTexture !== undefined &&
                renderContext.depthBufferTexture !== null
              ) {
                const depthTextureUnit = shader.textureUnit(
                  depthSamplerTextureUnit,
                );
                gl.activeTexture(
                  WebGL2RenderingContext.TEXTURE0 + depthTextureUnit,
                );
                gl.bindTexture(
                  WebGL2RenderingContext.TEXTURE_2D,
                  renderContext.depthBufferTexture,
                );
              } else {
                throw new Error(
                  "Depth buffer texture ID for volume rendering is undefined or null",
                );
              }
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
          tempMat4,
          projectionParameters.viewProjectionMat,
          chunkLayout.transform,
        );
        gl.uniformMatrix4fv(
          shader.uniform("uModelViewProjectionMatrix"),
          false,
          modelViewProjection,
        );
        const clippingPlanes = tempVisibleVolumetricClippingPlanes;
        getFrustrumPlanes(clippingPlanes, modelViewProjection);
        mat4.invert(modelViewProjection, modelViewProjection);
        gl.uniformMatrix4fv(
          shader.uniform("uInvModelViewProjectionMatrix"),
          false,
          modelViewProjection,
        );
        const { near, far, adjustedNear, adjustedFar } =
          getVolumeRenderingNearFarBounds(
            clippingPlanes,
            transformedSource.lowerClipDisplayBound,
            transformedSource.upperClipDisplayBound,
          );
        const optimalSampleRate = optimalSamples;
        const actualSampleRate = this.depthSamplesTarget.value;
        const brightnessFactor = optimalSampleRate / actualSampleRate;
        gl.uniform1f(shader.uniform("uBrightnessFactor"), brightnessFactor);
        const nearLimitFraction = (adjustedNear - near) / (far - near);
        const farLimitFraction = (adjustedFar - near) / (far - near);
        gl.uniform1f(shader.uniform("uNearLimitFraction"), nearLimitFraction);
        gl.uniform1f(shader.uniform("uFarLimitFraction"), farLimitFraction);
        gl.uniform1f(shader.uniform("uGain"), Math.exp(this.gain.value));
        gl.uniform1i(
          shader.uniform("uMaxSteps"),
          this.depthSamplesTarget.value,
        );
        gl.uniform3fv(
          shader.uniform("uLowerClipBound"),
          transformedSource.lowerClipDisplayBound,
        );
        gl.uniform3fv(
          shader.uniform("uUpperClipBound"),
          transformedSource.upperClipDisplayBound,
        );
      },
      (transformedSource) => {
        if (shader === null) return;
        const key = transformedSource.curPositionInChunks.join();
        const chunk = chunks.get(key);
        if (chunk !== undefined && chunk.state === ChunkState.GPU_MEMORY) {
          const originalChunkSize = transformedSource.chunkLayout.size;
          const newChunkDataSize = chunk.chunkDataSize;
          const {
            chunkDisplayDimensionIndices,
            fixedPositionWithinChunk,
            chunkTransform: { channelToChunkDimensionIndices },
          } = transformedSource;
          if (renderContext.wireFrame) {
            const normChunkNumber = chunkNumber / chunks.size;
            gl.uniform1f(shader.uniform("uChunkNumber"), normChunkNumber);
            ++chunkNumber;
          }
          if (newChunkDataSize !== chunkDataSize) {
            chunkDataSize = newChunkDataSize;

            for (let i = 0; i < 3; ++i) {
              const chunkDim = chunkDisplayDimensionIndices[i];
              chunkDataDisplaySize[i] =
                chunkDim === -1 || chunkDim >= chunkRank
                  ? 1
                  : chunkDataSize[chunkDim];
            }
            gl.uniform3fv(
              shader.uniform("uChunkDataSize"),
              chunkDataDisplaySize,
            );
          }
          const { chunkGridPosition } = chunk;
          for (let i = 0; i < 3; ++i) {
            const chunkDim = chunkDisplayDimensionIndices[i];
            chunkPosition[i] =
              chunkDim === -1 || chunkDim >= chunkRank
                ? 0
                : originalChunkSize[i] * chunkGridPosition[chunkDim];
          }
          if (prevChunkFormat != null) {
            prevChunkFormat.bindChunk(
              gl,
              shader!,
              chunk,
              fixedPositionWithinChunk,
              chunkDisplayDimensionIndices,
              channelToChunkDimensionIndices,
              newSource,
            );
          }
          gl.uniform3fv(shader.uniform("uTranslation"), chunkPosition);
          drawBoxes(gl, 1, 1);

          // Draw histograms if needed
          if (histogramShader !== null && needToDrawHistogram) {
            // Setup the state for drawing histograms
            histogramShader.bind();
            const chunkFormat = transformedSource.source.chunkFormat;
            const onlyActivateTexture = !newSource;
            chunkFormat.beginDrawing(gl, histogramShader, onlyActivateTexture);
            chunkFormat.beginSource(gl, histogramShader);
            if (prevChunkFormat != null) {
              prevChunkFormat.bindChunk(
                gl,
                histogramShader,
                chunk,
                fixedPositionWithinChunk,
                chunkDisplayDimensionIndices,
                channelToChunkDimensionIndices,
                newSource,
              );
            }
            gl.uniform3fv(
              histogramShader.uniform("uChunkDataSize"),
              chunkDataDisplaySize,
            );
            gl.disable(WebGL2RenderingContext.DEPTH_TEST);
            gl.enable(WebGL2RenderingContext.BLEND);
            this.histogramIndexBuffer.value.bindToVertexAttrib(
              histogramShader.attribute("aInput1"),
              1,
              WebGL2RenderingContext.UNSIGNED_BYTE,
              /*normalized=*/ true,
            );
            const { dataType, dataHistogramSpecifications } = this;
            const count = this.getDataHistogramCount();
            const outputFramebuffers =
              dataHistogramSpecifications.getFramebuffers(gl);
            const bounds = this.dataHistogramSpecifications.bounds.value;

            // Draw each histogram
            for (let i = 0; i < count; ++i) {
              outputFramebuffers[i].bind(256, 1);
              enableLerpShaderFunction(
                histogramShader,
                `invlerpForHistogram${i}`,
                dataType,
                bounds[i],
              );
              gl.uniform1i(histogramShader.uniform("uHistogramIndex"), i);
              gl.drawArraysInstanced(
                WebGL2RenderingContext.POINTS,
                0,
                HISTOGRAM_SAMPLES_PER_INSTANCE,
                NUM_HISTOGRAM_SAMPLES / HISTOGRAM_SAMPLES_PER_INSTANCE,
              );
            }

            // Reset the state back to regular drawing mode
            gl.enable(WebGL2RenderingContext.DEPTH_TEST);
            restoreFrameBuffer();
            shader.bind();
            this.vertexIdHelper.enable();
            chunkFormat.beginDrawing(
              gl,
              shader,
              true /* onlyActivateTexture */,
            );
            chunkFormat.beginSource(gl, shader);
          }
          newSource = false;
          ++presentCount;
        } else {
          ++notPresentCount;
        }
      },
    );
    gl.disable(WebGL2RenderingContext.CULL_FACE);
    endShader();
    this.vertexIdHelper.disable();
    if (needToDrawHistogram && DEBUG_HISTOGRAMS) {
      const outputBuffers =
        this.dataHistogramSpecifications.getFramebuffers(gl);
      outputBuffers[0].bind(256, 1);
      const tempBuffer = new Float32Array(256 * 4);
      gl.readPixels(
        0,
        0,
        256,
        1,
        WebGL2RenderingContext.RGBA,
        WebGL2RenderingContext.FLOAT,
        tempBuffer,
      );
      const tempBuffer2 = new Float32Array(256);
      for (let j = 0; j < 256; ++j) {
        tempBuffer2[j] = tempBuffer[j * 4];
      }
      console.log("histogram", tempBuffer2.join(" "));
      restoreFrameBuffer();
    }
  }

  isReady(
    renderContext: PerspectiveViewReadyRenderContext,
    attachment: VisibleLayerInfo<
      PerspectivePanel,
      VolumeRenderingAttachmentState
    >,
  ) {
    const allSources = attachment.state!.sources.value;
    if (allSources.length === 0) return true;
    let missing = false;
    forEachVisibleVolumeRenderingChunk(
      renderContext.projectionParameters,
      this.localPosition.value,
      this.depthSamplesTarget.value,
      allSources[0],
      () => {},
      (tsource) => {
        const chunk = tsource.source.chunks.get(
          tsource.curPositionInChunks.join(),
        );
        if (chunk === undefined || chunk.state !== ChunkState.GPU_MEMORY) {
          missing = true;
        }
      },
    );
    return !missing;
  }
}
