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
  isProjectionMode,
  trackableShaderModeValue,
<<<<<<< HEAD
=======
  VolumeRenderingModes,
>>>>>>> 0aacf094 (Ichnaea working code on top of v2.40.1)
} from "#src/volume_rendering/trackable_volume_rendering_mode.js";
import {
  drawBoxes,
  glsl_getBoxFaceVertexPosition,
} from "#src/webgl/bounding_box.js";
import type { GLBuffer } from "#src/webgl/buffer.js";
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
const HISTOGRAM_SAMPLES_PER_INSTANCE = 256;

// Number of points to sample in computing the histogram.  Increasing this increases the precision
// of the histogram but also slows down rendering.
const NUM_HISTOGRAM_SAMPLES = 2 ** 14;
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

interface StoredChunkDataForMultipass {
  chunk: VolumeChunk;
  fixedPositionWithinChunk: Uint32Array;
  chunkDisplayDimensionIndices: number[];
  channelToChunkDimensionIndices: readonly number[];
  chunkFormat: ChunkFormat | null | undefined;
}

interface ShaderSetupUniforms {
  uNearLimitFraction: number;
  uFarLimitFraction: number;
  uMaxSteps: number;
  uBrightnessFactor: number;
  uGain: number;
  uPickId: number;
  uLowerClipBound: vec3;
  uUpperClipBound: vec3;
  uModelViewProjectionMatrix: mat4;
  uInvModelViewProjectionMatrix: mat4;
}

/**
 * Represents the uniform variables used by the shader for each chunk in the volume rendering layer.
 */
interface PerChunkShaderUniforms {
  uTranslation: vec3;
  uChunkDataSize: vec3;
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
<<<<<<< HEAD
  highestResolutionLoadedVoxelSize: Float32Array | undefined;
=======
>>>>>>> 0aacf094 (Ichnaea working code on top of v2.40.1)
  private modeOverride: TrackableVolumeRenderingModeValue;
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

  private histogramIndexBuffer: RefCountedValue<GLBuffer>;

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
    this.modeOverride = trackableShaderModeValue();
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
          modeOverride: VolumeRenderingModes,
          dataHistogramChannelSpecifications: HistogramChannelSpecification[],
        ) => ({
          numChannelDimensions: space.rank,
          mode: modeOverride === VolumeRenderingModes.OFF ? mode : modeOverride,
          dataHistogramChannelSpecifications,
        }),
        [
          this.channelCoordinateSpace,
          this.mode,
          this.modeOverride,
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
float userEmittedIntensity = -100.0;
`);
            glsl_emitIntensity = `
float convertIntensity(float value) {
  return clamp(${glsl_intensityConversion}, 0.0, 1.0);
}
void emitIntensity(float value) {
  userEmittedIntensity = value;
}
float getIntensity() {
  float intensity = userEmittedIntensity > -100.0 ? userEmittedIntensity : defaultMaxProjectionIntensity;
  return convertIntensity(intensity);
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
  emit(outputColor, savedDepth, savedIntensity, uPickId);
  defaultMaxProjectionIntensity = 0.0;
  userEmittedIntensity = -100.0;
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
          builder.addUniform("highp uint", "uPickId");
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
uniform sampler3D uBrushTexture;
uniform bool uBrushEnabled;

vec3 curChunkPosition;
float depthAtRayPosition;
vec4 outputColor;
float revealage;
void userMain();

float getBrushValue(vec3 position) {
  if (!uBrushEnabled) return -1.0;
  vec3 texCoord = position / uChunkDataSize;
  return texture(uBrushTexture, texCoord).r;
}

void userMain();
`);

          // Before defineChunkDataShaderAccess is called (around line 501)
          builder.addFragmentCode(`
  float getDataValue(vec3 position) {
    float brushValue = getBrushValue(position);
    if (brushValue >= 0.0) {
      return brushValue;
    }
  }   
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
  emit(outputColor, 1.0, uChunkNumber, uPickId);
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
          chunkFormat.defineShader(
            builder,
            numChannelDimensions,
            true /*inVertexShader*/,
          );
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
                false /*clamp*/,
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
    break;`;
          }
          histogramFetchCode += `
  }
`;
          builder.addVertexCode(glsl_simpleFloatHash);
          builder.setVertexMain(`
  vec3 rand3val = vec3(
    simpleFloatHash(vec2(aInput1 + float(gl_VertexID), float(gl_InstanceID))),
    simpleFloatHash(vec2(aInput1 + float(gl_VertexID) + 10.0, 5.0 + float(gl_InstanceID))),
    simpleFloatHash(vec2(aInput1 + float(gl_VertexID) + 20.0, 15.0 + float(gl_InstanceID))));
  chunkSamplePosition = rand3val * (uChunkDataSize - 1.0);
${histogramFetchCode}
  if (x < 0.0) x = 0.0;
  else if (x > 1.0) x = 1.0;
  else x = (1.0 + x * 253.0) / 255.0;
  gl_Position = vec4(2.0 * (x * 255.0 + 0.5) / 256.0 - 1.0, 0.0, 0.0, 1.0);
  gl_PointSize = 1.0;`);
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
                displayDimensionRenderInfo,
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
    console.log("drawing");
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
    let prevChunkFormat: ChunkFormat | undefined | null;
    let shaderResult: ParameterizedShaderGetterResult<
      ShaderControlsBuilderState,
      VolumeRenderingShaderParameters
    >;
    // Size of chunk (in voxels) in the "display" subspace of the chunk coordinate space.
    const chunkDataDisplaySize = vec3.create();

    const { gl } = this;
    this.vertexIdHelper.enable();
    this.modeOverride.value = VolumeRenderingModes.OFF;

    const { chunkResolutionHistogram: renderScaleHistogram } = this;
    renderScaleHistogram.begin(
      this.chunkManager.chunkQueueManager.frameNumberCounter.frameNumber,
    );

    const restoreDrawingBuffersAndState = () => {
      const performedSecondPassForPicking =
        !isProjectionMode(this.mode.value) &&
        !renderContext.isContinuousCameraMotionInProgress;
      // If the layer is in projection mode or the second pass for picking has been performed,
      // the max projection state is needed
      // the max projection buffer is not bound, because it is immediately read back
      // in the perspective panel to update the max projection picking buffer
      if (isProjectionMode(this.mode.value) || performedSecondPassForPicking) {
        gl.depthMask(true);
        gl.disable(WebGL2RenderingContext.BLEND);
        gl.depthFunc(WebGL2RenderingContext.GREATER);
      } else {
        // Otherwise, the regular OIT buffer is needed along with the state
        gl.depthMask(false);
        gl.enable(WebGL2RenderingContext.BLEND);
        gl.depthFunc(WebGL2RenderingContext.LESS);
        renderContext.bindVolumeRenderingBuffer!();
      }
    };

    const endShader = () => {
      if (shader === null) return;
      shader.unbindTransferFunctionTextures();
      if (prevChunkFormat !== null) {
        prevChunkFormat!.endDrawing(gl, shader);
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
      !renderContext.sliceViewsPresent &&
      (!renderContext.isContinuousCameraMotionInProgress ||
        renderContext.force3DHistogramForAutoRange);
    const needPickingPass =
      !isProjectionMode(this.mode.value) &&
      !renderContext.isContinuousCameraMotionInProgress &&
      !renderContext.wireFrame;
    const hasPicking = isProjectionMode(this.mode.value) || needPickingPass;

    const pickId = hasPicking ? renderContext.pickIDs.register(this) : 0;
    const chunkInfoForMultipass: StoredChunkDataForMultipass[] = [];
    const shaderUniformsForSecondPass: PerChunkShaderUniforms[] = [];
    let shaderSetupUniforms: ShaderSetupUniforms | undefined;

    gl.enable(WebGL2RenderingContext.CULL_FACE);
    gl.cullFace(WebGL2RenderingContext.FRONT);

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
        this.highestResolutionLoadedVoxelSize =
          transformedSource.effectiveVoxelSize;
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
          if (shader !== null) {
            shader.bind();
            if (chunkFormat !== null) {
              setControlsInShader(
                gl,
                shader,
                this.shaderControlState,
                shaderResult.parameters.parseResult.controls,
              );
              this.bindDepthBufferTexture(renderContext, shader);
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
        const clippingPlanes = tempVisibleVolumetricClippingPlanes;
        getFrustrumPlanes(clippingPlanes, modelViewProjection);
        const inverseModelViewProjection = mat4.create();
        mat4.invert(inverseModelViewProjection, modelViewProjection);
        const { near, far, adjustedNear, adjustedFar } =
          getVolumeRenderingNearFarBounds(
            clippingPlanes,
            transformedSource.lowerClipDisplayBound,
            transformedSource.upperClipDisplayBound,
          );
        const optimalSampleRate = optimalSamples;
        const actualSampleRate = this.depthSamplesTarget.value;
        const brightnessFactor = optimalSampleRate / actualSampleRate;
        const nearLimitFraction = (adjustedNear - near) / (far - near);
        const farLimitFraction = (adjustedFar - near) / (far - near);
        shaderSetupUniforms = {
          uNearLimitFraction: nearLimitFraction,
          uFarLimitFraction: farLimitFraction,
          uMaxSteps: this.depthSamplesTarget.value,
          uBrightnessFactor: brightnessFactor,
          uGain: Math.exp(this.gain.value),
          uPickId: pickId,
          uLowerClipBound: transformedSource.lowerClipDisplayBound,
          uUpperClipBound: transformedSource.upperClipDisplayBound,
          uModelViewProjectionMatrix: modelViewProjection,
          uInvModelViewProjectionMatrix: inverseModelViewProjection,
        };
        this.setShaderUniforms(shader, shaderSetupUniforms);
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
          gl.uniform3fv(shader.uniform("uTranslation"), chunkPosition);
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
          // Save information for possible repasses through the data
          if (needToDrawHistogram || needPickingPass) {
            chunkInfoForMultipass.push({
              chunk,
              fixedPositionWithinChunk,
              chunkDisplayDimensionIndices,
              channelToChunkDimensionIndices,
              chunkFormat: prevChunkFormat,
            });
            const copiedDisplaySize = vec3.create();
            const copiedPosition = vec3.create();
            vec3.copy(copiedDisplaySize, chunkDataDisplaySize);
            vec3.copy(copiedPosition, chunkPosition);
            shaderUniformsForSecondPass.push({
              uChunkDataSize: copiedDisplaySize,
              uTranslation: copiedPosition,
            });
          }
          drawBoxes(gl, 1, 1);

          newSource = false;
          ++presentCount;
        } else {
          ++notPresentCount;
        }
      },
    );
    endShader();

    shader = null;
    prevChunkFormat = null;
    if (needPickingPass) {
      gl.enable(WebGL2RenderingContext.DEPTH_TEST);
      gl.depthMask(true);
      gl.disable(WebGL2RenderingContext.BLEND);
      gl.depthFunc(WebGL2RenderingContext.GREATER);
      renderContext.emitter = renderContext.maxProjectionEmit!;
      renderContext.bindMaxProjectionBuffer!();
      this.modeOverride.value = VolumeRenderingModes.MAX;

      const endPickingPassShader = () => {
        if (shader === null) return;
        shader.unbindTransferFunctionTextures();
        if (prevChunkFormat !== null) {
          prevChunkFormat!.endDrawing(gl, shader);
        }
      };

      newSource = true;
      for (let j = 0; j < presentCount; ++j) {
        const chunkInfo = chunkInfoForMultipass[j];
        const uniforms = shaderUniformsForSecondPass[j];
        const chunkFormat = chunkInfo.chunkFormat;
        if (chunkFormat !== prevChunkFormat) {
          prevChunkFormat = chunkFormat;
          endPickingPassShader();
          shaderResult = this.shaderGetter({
            emitter: renderContext.emitter,
            chunkFormat: chunkFormat!,
            wireFrame: renderContext.wireFrame,
          });
          shader = shaderResult.shader;
          if (shader !== null && shaderSetupUniforms !== undefined) {
            shader.bind();
            if (chunkFormat !== null && chunkFormat !== undefined) {
              setControlsInShader(
                gl,
                shader,
                this.shaderControlState,
                shaderResult.parameters.parseResult.controls,
              );
              this.bindDepthBufferTexture(renderContext, shader);
              this.setShaderUniforms(shader, shaderSetupUniforms);
              chunkFormat.beginDrawing(gl, shader);
              chunkFormat.beginSource(gl, shader);
            }
          }
        }
        if (shader === null) break;
        if (chunkFormat != null) {
          chunkFormat.bindChunk(
            gl,
            shader,
            chunkInfo.chunk,
            chunkInfo.fixedPositionWithinChunk,
            chunkInfo.chunkDisplayDimensionIndices,
            chunkInfo.channelToChunkDimensionIndices,
            newSource,
          );
        }
        gl.uniform3fv(shader.uniform("uTranslation"), uniforms.uTranslation);
        gl.uniform3fv(
          shader.uniform("uChunkDataSize"),
          uniforms.uChunkDataSize,
        );
        drawBoxes(gl, 1, 1);
        newSource = false;
      }
      this.modeOverride.value = VolumeRenderingModes.OFF;
    }
    this.vertexIdHelper.disable();
    gl.disable(WebGL2RenderingContext.CULL_FACE);

    if (needToDrawHistogram) {
      let histogramShader: ShaderProgram | null = null;
      let histogramShaderResult: ParameterizedShaderGetterResult<
        ShaderControlsBuilderState,
        VolumeRenderingShaderParameters
      >;
      const endHistogramShader = () => {
        if (histogramShader === null) return;
        histogramShader.unbindTransferFunctionTextures();
        if (prevChunkFormat !== null) {
          prevChunkFormat!.endDrawing(gl, histogramShader);
        }
      };
      const determineNumHistogramInstances = (
        chunkDataSize: vec3,
        totalChunkVolume: number,
      ) => {
        const chunkVolume = chunkDataSize.reduce((a, b) => a * b, 1);
        const desiredChunkSamples =
          NUM_HISTOGRAM_SAMPLES * (chunkVolume / totalChunkVolume);
        const maxSamplesInChunk = chunkVolume / 2.0;
        const clampedSamples = Math.min(maxSamplesInChunk, desiredChunkSamples);
        return Math.max(
          Math.round(clampedSamples / HISTOGRAM_SAMPLES_PER_INSTANCE),
          1,
        );
      };

      prevChunkFormat = null;
      const { dataType, dataHistogramSpecifications } = this;
      const histogramFramebuffers =
        dataHistogramSpecifications.getFramebuffers(gl);
      const numHistograms = this.getDataHistogramCount();
      for (let i = 0; i < numHistograms; ++i) {
        histogramFramebuffers[i].bind(256, 1);
        gl.clearColor(0.0, 0.0, 0.0, 1.0);
        gl.clear(WebGL2RenderingContext.COLOR_BUFFER_BIT);
      }
      const bounds = this.dataHistogramSpecifications.bounds.value;
      // Blending on to accumulate histograms.
      gl.enable(WebGL2RenderingContext.BLEND);
      gl.disable(WebGL2RenderingContext.DEPTH_TEST);

      const totalChunkVolume = shaderUniformsForSecondPass.reduce(
        (sum, uniforms) => {
          const chunkVolume = uniforms.uChunkDataSize.reduce(
            (a, b) => a * b,
            1,
          );
          return sum + chunkVolume;
        },
        0,
      );

      for (let j = 0; j < presentCount; ++j) {
        newSource = true;
        const chunkInfo = chunkInfoForMultipass[j];
        const uniforms = shaderUniformsForSecondPass[j];
        const chunkFormat = chunkInfo.chunkFormat;
        if (chunkFormat !== prevChunkFormat) {
          prevChunkFormat = chunkFormat;
          endHistogramShader();
          histogramShaderResult = this.histogramShaderGetter({
            chunkFormat: chunkFormat!,
          });
          histogramShader = histogramShaderResult.shader;
          if (histogramShader !== null) {
            if (chunkFormat !== null && chunkFormat !== undefined) {
              chunkFormat.beginDrawing(gl, histogramShader);
              chunkFormat.beginSource(gl, histogramShader);
            }
            histogramShader.bind();
          } else {
            break;
          }
        }
        if (histogramShader === null) break;
        gl.uniform3fv(
          histogramShader.uniform("uChunkDataSize"),
          uniforms.uChunkDataSize,
        );
        if (prevChunkFormat != null) {
          prevChunkFormat.bindChunk(
            gl,
            histogramShader,
            chunkInfo.chunk,
            chunkInfo.fixedPositionWithinChunk,
            chunkInfo.chunkDisplayDimensionIndices,
            chunkInfo.channelToChunkDimensionIndices,
            newSource,
          );
        }
        this.histogramIndexBuffer.value.bindToVertexAttrib(
          histogramShader.attribute("aInput1"),
          1,
          WebGL2RenderingContext.UNSIGNED_BYTE,
          /*normalized=*/ true,
        );

        // Draw each histogram
        const numInstances = determineNumHistogramInstances(
          uniforms.uChunkDataSize,
          totalChunkVolume,
        );
        for (let i = 0; i < numHistograms; ++i) {
          histogramFramebuffers[i].bind(256, 1);
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
            numInstances,
          );
        }
        newSource = false;
      }

      if (needToDrawHistogram && DEBUG_HISTOGRAMS) {
        const histogramFrameBuffers =
          this.dataHistogramSpecifications.getFramebuffers(gl);
        for (let i = 0; i < numHistograms; ++i) {
          histogramFrameBuffers[i].bind(256, 1);
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
          console.log(`histogram${i}`, tempBuffer2.join(" "));
        }
      }
      endHistogramShader();
    }
    if (needPickingPass || needToDrawHistogram) {
      restoreDrawingBuffersAndState();
    }
  }

  private bindDepthBufferTexture(
    renderContext: PerspectiveViewRenderContext,
    shader: ShaderProgram,
  ) {
    const { gl } = this;
    if (
      renderContext.depthBufferTexture !== undefined &&
      renderContext.depthBufferTexture !== null
    ) {
      const depthTextureUnit = shader.textureUnit(depthSamplerTextureUnit);
      gl.activeTexture(WebGL2RenderingContext.TEXTURE0 + depthTextureUnit);
      gl.bindTexture(
        WebGL2RenderingContext.TEXTURE_2D,
        renderContext.depthBufferTexture,
      );
    } else {
      throw new Error(
        "Depth buffer texture ID for volume rendering is undefined or null",
      );
    }
  }

  private setShaderUniforms(
    shader: ShaderProgram,
    uniforms: ShaderSetupUniforms,
  ) {
    const { gl } = this;
    gl.uniformMatrix4fv(
      shader.uniform("uModelViewProjectionMatrix"),
      false,
      uniforms.uModelViewProjectionMatrix,
    );
    gl.uniformMatrix4fv(
      shader.uniform("uInvModelViewProjectionMatrix"),
      false,
      uniforms.uInvModelViewProjectionMatrix,
    );
    gl.uniform1f(
      shader.uniform("uNearLimitFraction"),
      uniforms.uNearLimitFraction,
    );
    gl.uniform1f(
      shader.uniform("uFarLimitFraction"),
      uniforms.uFarLimitFraction,
    );
    gl.uniform1f(shader.uniform("uGain"), uniforms.uGain);
    gl.uniform1ui(shader.uniform("uPickId"), uniforms.uPickId);
    gl.uniform1i(shader.uniform("uMaxSteps"), uniforms.uMaxSteps);
    gl.uniform3fv(shader.uniform("uLowerClipBound"), uniforms.uLowerClipBound);
    gl.uniform3fv(shader.uniform("uUpperClipBound"), uniforms.uUpperClipBound);
    gl.uniform1f(
      shader.uniform("uBrightnessFactor"),
      uniforms.uBrightnessFactor,
    );
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
