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

import { ChunkState, LayerChunkProgressInfo } from "#src/chunk_manager/base.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { Chunk, ChunkSource } from "#src/chunk_manager/frontend.js";
import type { HashMapUint64, HashSetUint64 } from "#src/gpu_hash/hash_table.js";
import { GPUHashTable, HashSetShaderManager } from "#src/gpu_hash/shader.js";
import type { LayerView, VisibleLayerInfo } from "#src/layer/index.js";
import type { PerspectivePanel } from "#src/perspective_view/panel.js";
import type { PerspectiveViewRenderContext } from "#src/perspective_view/render_layer.js";
import { PerspectiveViewRenderLayer } from "#src/perspective_view/render_layer.js";
import type {
  RenderLayer,
  ThreeDimensionalRenderLayerAttachmentState,
} from "#src/renderlayer.js";
import { update3dRenderLayerAttachment } from "#src/renderlayer.js";
import {
  SegmentColorShaderManager,
  SegmentStatedColorShaderManager,
} from "#src/segment_color.js";
import {
  forEachVisibleSegment,
  getObjectKey,
} from "#src/segmentation_display_state/base.js";
import type { SegmentationDisplayState3D } from "#src/segmentation_display_state/frontend.js";
import {
  forEachVisibleSegmentToDraw,
  registerRedrawWhenSegmentationDisplayState3DChanged,
  SegmentationLayerSharedObject,
} from "#src/segmentation_display_state/frontend.js";
import { type SkeletonNode } from "#src/skeleton/api.js";
import {
  SKELETON_LAYER_RPC_ID,
  type VertexAttributeInfo,
} from "#src/skeleton/base.js";
import { getSkeletonChunkNodes } from "#src/skeleton/skeleton_chunk_nodes.js";
import type { SkeletonNodeAccess } from "#src/skeleton/skeleton_navigator.js";
import {
  edgeColorPathsGlsl,
  nodeColorPathsGlsl,
} from "#src/skeleton/skeleton_shader_color.js";
import type { SliceViewPanel } from "#src/sliceview/panel.js";
import type { SliceViewPanelRenderContext } from "#src/sliceview/renderlayer.js";
import { SliceViewPanelRenderLayer } from "#src/sliceview/renderlayer.js";
import type { TrackableAlphaValue } from "#src/trackable_alpha.js";
import { TrackableBoolean } from "#src/trackable_boolean.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { TrackableValue, WatchableValue } from "#src/trackable_value.js";
import { Uint64Set } from "#src/uint64_set.js";
import { DataType } from "#src/util/data_type.js";
import { RefCounted } from "#src/util/disposable.js";
import { mat4, type vec4 } from "#src/util/geom.js";
import { verifyFinitePositiveFloat } from "#src/util/json.js";
import { NullarySignal } from "#src/util/signal.js";
import type { Trackable } from "#src/util/trackable.js";
import { CompoundTrackable } from "#src/util/trackable.js";
import { TrackableEnum } from "#src/util/trackable_enum.js";
import { GLBuffer } from "#src/webgl/buffer.js";
import {
  defineCircleShader,
  drawCircles,
  initializeCircleShader,
} from "#src/webgl/circles.js";
import { glsl_COLORMAPS } from "#src/webgl/colormaps.js";
import type { GL } from "#src/webgl/context.js";
import type { WatchableShaderError } from "#src/webgl/dynamic_shader.js";
import {
  makeTrackableFragmentMain,
  parameterizedEmitterDependentShaderGetter,
  shaderCodeWithLineDirective,
} from "#src/webgl/dynamic_shader.js";
import {
  defineLineShader,
  drawLines,
  initializeLineShader,
} from "#src/webgl/lines.js";
import type {
  ShaderBuilder,
  ShaderProgram,
  ShaderSamplerType,
} from "#src/webgl/shader.js";
import { glsl_string } from "#src/webgl/shader_lib.js";
import type { ShaderControlsBuilderState } from "#src/webgl/shader_ui_controls.js";
import {
  addControlsToBuilder,
  getFallbackBuilderState,
  parseShaderUiControls,
  setControlsInShader,
  ShaderControlState,
} from "#src/webgl/shader_ui_controls.js";
import {
  computeTextureFormat,
  getSamplerPrefixForDataType,
  OneDimensionalTextureAccessHelper,
  setOneDimensionalTextureData,
  TextureFormat,
} from "#src/webgl/texture_access.js";
import { defineVertexId, VertexIdHelper } from "#src/webgl/vertex_id.js";

export const DEFAULT_FRAGMENT_MAIN = `void main() {
  emitDefault();
}
`;
const tempMat4 = mat4.create();

export interface VertexAttributeRenderInfo extends VertexAttributeInfo {
  name: string;
  webglDataType: number;
  glslDataType: string;
}

const vertexAttributeSamplerSymbols: symbol[] = [];
const segmentIdSamplerSymbol = Symbol("SkeletonShader.segmentIdTextureUnit");

const vertexPositionTextureFormat = computeTextureFormat(
  new TextureFormat(),
  DataType.FLOAT32,
  3,
);

export interface SkeletonShaderParameters {
  dynamicSegmentAppearance: boolean;
  hasSegmentStatedColors: boolean;
  hasSegmentDefaultColor: boolean;
  hasProvisionalSegmentColors: boolean;
  hoverHighlight: boolean;
  spatialChunkCulling: boolean;
}

export interface SkeletonShaderContext {
  vertexAttributes: VertexAttributeRenderInfo[];
  gl: GL;
  fallbackShaderParameters: WatchableValue<ShaderControlsBuilderState>;
  displayState: SkeletonLayerDisplayState;
  skeletonShaderParameters: WatchableValueInterface<SkeletonShaderParameters>;
  provisionalSegmentIds?: Uint64Set;
}

export interface SkeletonGPUGeometry {
  vertexAttributeTextures: (WebGLTexture | null)[];
  segmentIdTexture?: WebGLTexture | null;
  indexBuffer: GLBuffer;
  numIndices: number;
  numVertices: number;
}

export interface PackedSkeletonGeometry {
  vertexAttributes: Uint8Array;
  indices: Uint32Array;
  numVertices: number;
  vertexAttributeOffsets: Uint32Array;
}

interface SkeletonGeometry {
  vertexMain: string;
  fragmentSetup: string;
}

export class RenderHelper extends RefCounted {
  private textureAccessHelper = new OneDimensionalTextureAccessHelper(
    "vertexData",
  );
  private vertexIdHelper;
  private visibleSegmentsShaderManager = new HashSetShaderManager(
    "visibleSegments",
  );
  private excludedSegmentsShaderManager = new HashSetShaderManager(
    "excludedSegments",
  );
  private provisionalSegmentsShaderManager = new HashSetShaderManager(
    "provisionalSegments",
  );
  private segmentColorShaderManager = new SegmentColorShaderManager(
    "segmentColorHash",
  );
  private segmentStatedColorShaderManager = new SegmentStatedColorShaderManager(
    "segmentStatedColor",
  );
  private readonly clearedTextureUnits = new Set<number>();
  private emptySegmentSet = new Uint64Set();
  private gpuVisibleSegmentsHashTable: GPUHashTable<HashSetUint64>;
  private gpuTemporaryVisibleSegmentsHashTable: GPUHashTable<HashSetUint64>;
  private gpuEmptySegmentsHashTable: GPUHashTable<HashSetUint64>;
  private gpuProvisionalSegmentsHashTable: GPUHashTable<HashSetUint64>;
  private gpuSegmentStatedColorHashTable: GPUHashTable<HashMapUint64>;
  get vertexAttributes(): VertexAttributeRenderInfo[] {
    return this.base.vertexAttributes;
  }

  private defineCommonShader(
    builder: ShaderBuilder,
    shaderBuilderState: ShaderControlsBuilderState,
    skeletonParams: SkeletonShaderParameters,
  ): void {
    if (shaderBuilderState.parseResult.errors.length !== 0) {
      throw new Error("Invalid UI control specification");
    }
    defineVertexId(builder);
    builder.addUniform("highp vec4", "uColor");
    builder.addUniform("highp mat4", "uProjection");
    builder.addUniform("highp uint", "uPickID");
    builder.addVarying("highp uint", "vPickID", "flat");
    builder.addUniform("highp uint", "uPickInstanceStride");
    this.defineAttributeAccess(builder);
    // Live node drag: override a single vertex's position via a uniform instead
    // of re-uploading the position texture. `uOverrideVertexIndex` is -1 when no
    // node is being dragged (set in beginLayer), so this is a no-op fast path.
    builder.addUniform("highp int", "uOverrideVertexIndex");
    builder.addUniform("highp vec3", "uOverridePosition");
    builder.addVertexCode(`
highp vec3 applyNodePositionOverride(highp uint vertexIndex, highp vec3 position) {
  return (int(vertexIndex) == uOverrideVertexIndex) ? uOverridePosition : position;
}
`);
    if (skeletonParams.dynamicSegmentAppearance) {
      this.defineDynamicSegmentAppearance(builder, skeletonParams);
    }
    if (skeletonParams.spatialChunkCulling) {
      builder.addUniform("highp vec3", "uChunkOrigin");
      builder.addUniform("highp vec3", "uChunkBound");
      builder.addVarying("highp vec3", "vCullPos");
      builder.addFragmentCode(`
void spatialChunkCull() {
  if (any(lessThan(vCullPos, uChunkOrigin)) ||
      any(greaterThanEqual(vCullPos, uChunkBound))) discard;
}
`);
    }
  }

  private finalizeShaderBuilder(
    builder: ShaderBuilder,
    shaderBuilderState: ShaderControlsBuilderState,
    vertexMain: string,
    fragmentSetup = "",
  ): void {
    builder.addFragmentCode(glsl_COLORMAPS);
    const { vertexAttributes } = this;
    const numAttributes = vertexAttributes.length;
    for (let i = 1; i < numAttributes; ++i) {
      const info = vertexAttributes[i];
      builder.addVarying(`highp ${info.glslDataType}`, `vCustom${i}`);
      vertexMain += `vCustom${i} = readAttribute${i}(vertexIndex);\n`;
      builder.addFragmentCode(`#define ${info.name} vCustom${i}\n`);
      builder.addFragmentCode(`#define prop_${info.name}() vCustom${i}\n`);
    }
    builder.setVertexMain(vertexMain);
    addControlsToBuilder(shaderBuilderState, builder);
    builder.addFragmentCode(glsl_string);
    builder.addFragmentCode(`void userMain();\n`);
    builder.addFragmentCode(
      "#define main userMain\n" +
        shaderCodeWithLineDirective(shaderBuilderState.parseResult.code) +
        "\n#undef main\n",
    );
    builder.setFragmentMain(fragmentSetup + "userMain();");
  }

  edgeShaderGetter;
  nodeShaderGetter;

  get gl(): GL {
    return this.base.gl;
  }

  private defineDynamicSegmentAppearance(
    builder: ShaderBuilder,
    params: SkeletonShaderParameters,
  ) {
    this.visibleSegmentsShaderManager.defineShader(builder);
    this.excludedSegmentsShaderManager.defineShader(builder);
    this.segmentColorShaderManager.defineShader(builder);
    if (params.hasProvisionalSegmentColors) {
      this.provisionalSegmentsShaderManager.defineShader(builder);
    }
    if (params.hasSegmentStatedColors) {
      this.segmentStatedColorShaderManager.defineShader(builder);
    }
    builder.addUniform("highp float", "uVisibleAlpha");
    builder.addUniform("highp float", "uHiddenAlpha");
    builder.addUniform("highp float", "uSaturation");
    if (params.hasSegmentDefaultColor) {
      builder.addUniform("highp vec3", "uSegmentDefaultColor");
    }
    if (params.hoverHighlight) {
      builder.addUniform("highp uvec2", "uHoveredSegmentId");
    }
    builder.addTextureSampler(
      "usampler2D",
      "uSegmentIdSampler",
      segmentIdSamplerSymbol,
    );
    builder.addVertexCode(
      this.textureAccessHelper.getAccessor(
        "readSegmentId",
        "uSegmentIdSampler",
        DataType.UINT64,
        1,
      ),
    );
    builder.addVarying("highp uvec2", "vSegmentId", "flat");

    const statedColorFragment = params.hasSegmentStatedColors
      ? `
  vec4 statedColor;
  if (${this.segmentStatedColorShaderManager.getFunctionName}(segmentId, statedColor)) {
    return statedColor.rgb;
  }`
      : "";

    const defaultColorFragment = params.hasSegmentDefaultColor
      ? "  return uSegmentDefaultColor;"
      : `  return ${this.segmentColorShaderManager.prefix}(segmentId);`;

    const hoverAdjustFragment = params.hoverHighlight
      ? `
  float isHovered = float(segmentId.value.x == uHoveredSegmentId.x &&
                          segmentId.value.y == uHoveredSegmentId.y);
  saturation += isHovered * (0.5 - step(0.5, saturation));`
      : "";

    const provisionalColorFragment = params.hasProvisionalSegmentColors
      ? `
  if (${this.provisionalSegmentsShaderManager.hasFunctionName}(segmentId)) {
    return vec3(1.0, 0.0, 0.0);
  }`
      : "";

    builder.addFragmentCode(`
vec3 getSegmentBaseColor(uint64_t segmentId) {
${statedColorFragment}
${defaultColorFragment}
}
vec3 getSegmentLookupColor(uint64_t segmentId) {
${provisionalColorFragment}
  vec3 baseColor = getSegmentBaseColor(segmentId);
  float saturation = uSaturation;
${hoverAdjustFragment}
  return mix(vec3(1.0, 1.0, 1.0), baseColor, saturation);
}
float getSegmentLookupAlpha(uint64_t segmentId) {
  if (${this.excludedSegmentsShaderManager.hasFunctionName}(segmentId)) {
    return 0.0;
  }
  bool isVisible = ${this.visibleSegmentsShaderManager.hasFunctionName}(segmentId);
  return isVisible ? uVisibleAlpha : uHiddenAlpha;
}
vec4 getSegmentAppearance(uint64_t segmentId) {
  return vec4(getSegmentLookupColor(segmentId), getSegmentLookupAlpha(segmentId));
}
`);
  }

  maybeEnableDynamicSegmentAppearance(
    gl: GL,
    shader: ShaderProgram,
    skeletonParams: SkeletonShaderParameters,
    excludedGPUTable?: GPUHashTable<HashSetUint64>,
  ) {
    if (!skeletonParams.dynamicSegmentAppearance) return;
    const segmentationGroupState =
      this.base.displayState.segmentationGroupState.value;
    this.visibleSegmentsShaderManager.enable(
      gl,
      shader,
      segmentationGroupState.useTemporaryVisibleSegments.value
        ? this.gpuTemporaryVisibleSegmentsHashTable
        : this.gpuVisibleSegmentsHashTable,
    );
    this.excludedSegmentsShaderManager.enable(
      gl,
      shader,
      excludedGPUTable ?? this.gpuEmptySegmentsHashTable,
    );
    gl.uniform1f(
      shader.uniform("uVisibleAlpha"),
      this.base.displayState.objectAlpha.value,
    );
    gl.uniform1f(
      shader.uniform("uHiddenAlpha"),
      this.base.displayState.hiddenObjectAlpha.value,
    );

    const colorGroupState =
      this.base.displayState.segmentationColorGroupState.value;
    this.segmentColorShaderManager.enable(
      gl,
      shader,
      colorGroupState.segmentColorHash.value,
    );

    if (skeletonParams.hasProvisionalSegmentColors) {
      this.provisionalSegmentsShaderManager.enable(
        gl,
        shader,
        this.gpuProvisionalSegmentsHashTable,
      );
    }

    if (skeletonParams?.hasSegmentDefaultColor) {
      const segmentDefaultColor = colorGroupState.segmentDefaultColor.value;
      if (segmentDefaultColor !== undefined) {
        gl.uniform3fv(
          shader.uniform("uSegmentDefaultColor"),
          segmentDefaultColor,
        );
      }
    }

    if (skeletonParams?.hasSegmentStatedColors) {
      this.segmentStatedColorShaderManager.enable(
        gl,
        shader,
        this.gpuSegmentStatedColorHashTable,
      );
    }

    const { saturation, segmentSelectionState } = this.base.displayState;
    gl.uniform1f(shader.uniform("uSaturation"), saturation.value);
    if (skeletonParams.hoverHighlight) {
      const seg = segmentSelectionState.hasSelectedSegment
        ? segmentSelectionState.selectedSegment
        : 0n;
      gl.uniform2ui(
        shader.uniform("uHoveredSegmentId"),
        Number(seg & 0xffff_ffffn),
        Number((seg >> 32n) & 0xffff_ffffn),
      );
    }
  }

  maybeDisableDynamicSegmentAppearance(
    gl: GL,
    shader: ShaderProgram,
    skeletonParams: SkeletonShaderParameters | undefined,
  ) {
    if (!skeletonParams?.dynamicSegmentAppearance) return;
    this.visibleSegmentsShaderManager.disable(gl, shader);
    this.excludedSegmentsShaderManager.disable(gl, shader);
    if (skeletonParams.hasProvisionalSegmentColors) {
      this.provisionalSegmentsShaderManager.disable(gl, shader);
    }
    if (skeletonParams?.hasSegmentStatedColors) {
      this.segmentStatedColorShaderManager.disable(gl, shader);
    }
  }

  constructor(
    public base: SkeletonShaderContext,
    public targetIsSliceView: boolean,
  ) {
    super();
    this.vertexIdHelper = this.registerDisposer(VertexIdHelper.get(this.gl));

    const segmentationGroupState =
      base.displayState.segmentationGroupState.value;
    const colorGroupState = base.displayState.segmentationColorGroupState.value;

    this.gpuVisibleSegmentsHashTable = this.registerDisposer(
      GPUHashTable.get(
        this.gl,
        segmentationGroupState.visibleSegments.hashTable,
      ),
    );
    this.gpuTemporaryVisibleSegmentsHashTable = this.registerDisposer(
      GPUHashTable.get(
        this.gl,
        segmentationGroupState.temporaryVisibleSegments.hashTable,
      ),
    );
    this.gpuEmptySegmentsHashTable = this.registerDisposer(
      GPUHashTable.get(this.gl, this.emptySegmentSet.hashTable),
    );
    this.gpuProvisionalSegmentsHashTable = this.registerDisposer(
      GPUHashTable.get(
        this.gl,
        (base.provisionalSegmentIds ?? this.emptySegmentSet).hashTable,
      ),
    );
    this.gpuSegmentStatedColorHashTable = this.registerDisposer(
      GPUHashTable.get(this.gl, colorGroupState.segmentStatedColors.hashTable),
    );

    this.edgeShaderGetter = parameterizedEmitterDependentShaderGetter(
      this,
      this.gl,
      {
        memoizeKey: {
          type: "skeleton/SkeletonShaderManager/edge",
          vertexAttributes: this.vertexAttributes,
        },
        fallbackParameters: this.base.fallbackShaderParameters,
        parameters:
          this.base.displayState.skeletonRenderingOptions.shaderControlState
            .builderState,
        extraParameters: this.base.skeletonShaderParameters,
        shaderError: this.base.displayState.shaderError,
        defineShader: (builder, shaderBuilderState, skeletonParams) =>
          this.defineEdgeShader(builder, shaderBuilderState, skeletonParams),
      },
    );

    this.nodeShaderGetter = parameterizedEmitterDependentShaderGetter(
      this,
      this.gl,
      {
        memoizeKey: {
          type: "skeleton/SkeletonShaderManager/node",
          vertexAttributes: this.vertexAttributes,
        },
        fallbackParameters: this.base.fallbackShaderParameters,
        parameters:
          this.base.displayState.skeletonRenderingOptions.shaderControlState
            .builderState,
        extraParameters: this.base.skeletonShaderParameters,
        shaderError: this.base.displayState.shaderError,
        defineShader: (builder, shaderBuilderState, skeletonParams) =>
          this.defineNodeShader(builder, shaderBuilderState, skeletonParams),
      },
    );
  }

  private readSegmentIdGlsl(
    skeletonParams: SkeletonShaderParameters,
    indexExpression: string,
  ): string {
    if (!skeletonParams.dynamicSegmentAppearance) return "";
    return `vSegmentId = readSegmentId(${indexExpression}).value;\n`;
  }

  private defineEdgeShader(
    builder: ShaderBuilder,
    shaderBuilderState: ShaderControlsBuilderState,
    skeletonParams: SkeletonShaderParameters,
  ) {
    this.defineCommonShader(builder, shaderBuilderState, skeletonParams);
    const geometry = this.defineEdgeLineBillboard(builder, skeletonParams);
    const path = skeletonParams.dynamicSegmentAppearance ? "dynamic" : "legacy";
    builder.addFragmentCode(`
float getCrossSectionFade() {
  return ${this.getCrossSectionFadeFactor()};
}
`);
    builder.addFragmentCode(edgeColorPathsGlsl(path));
    this.finalizeShaderBuilder(
      builder,
      shaderBuilderState,
      geometry.vertexMain,
      geometry.fragmentSetup,
    );
  }

  private defineNodeShader(
    builder: ShaderBuilder,
    shaderBuilderState: ShaderControlsBuilderState,
    skeletonParams: SkeletonShaderParameters,
  ) {
    this.defineCommonShader(builder, shaderBuilderState, skeletonParams);
    const geometry = this.defineNodeCircleBillboard(builder, skeletonParams);
    const path = skeletonParams.dynamicSegmentAppearance ? "dynamic" : "legacy";
    builder.addFragmentCode(nodeColorPathsGlsl(path));
    this.finalizeShaderBuilder(
      builder,
      shaderBuilderState,
      geometry.vertexMain,
      geometry.fragmentSetup,
    );
  }

  private defineEdgeLineBillboard(
    builder: ShaderBuilder,
    skeletonParams: SkeletonShaderParameters,
  ): SkeletonGeometry {
    defineLineShader(builder);
    builder.addAttribute("highp uvec2", "aVertexIndex");
    builder.addUniform("highp float", "uLineWidth");
    let vertexMain = `
highp uint pickOffset = uint(gl_InstanceID) * uPickInstanceStride;
vPickID = uPickID + pickOffset;
highp vec3 vertexA = applyNodePositionOverride(aVertexIndex.x, readAttribute0(aVertexIndex.x));
highp vec3 vertexB = applyNodePositionOverride(aVertexIndex.y, readAttribute0(aVertexIndex.y));
emitLine(uProjection, vertexA, vertexB, uLineWidth);
highp uint lineEndpointIndex = getLineEndpointIndex();
highp uint vertexIndex = aVertexIndex.x * (1u - lineEndpointIndex) + aVertexIndex.y * lineEndpointIndex;
`;
    let fragmentSetup = "";
    if (skeletonParams.spatialChunkCulling) {
      vertexMain += `vCullPos = mix(vertexA, vertexB, float(lineEndpointIndex));\n`;
      fragmentSetup = `spatialChunkCull();\n`;
    }
    vertexMain += this.readSegmentIdGlsl(skeletonParams, "aVertexIndex.x");
    return { vertexMain, fragmentSetup };
  }

  private defineNodeCircleBillboard(
    builder: ShaderBuilder,
    skeletonParams: SkeletonShaderParameters,
  ): SkeletonGeometry {
    defineCircleShader(builder, /*crossSectionFade=*/ this.targetIsSliceView);
    builder.addUniform("highp float", "uNodeDiameter");
    let vertexMain = `
highp uint vertexIndex = uint(gl_InstanceID);
highp uint pickOffset = vertexIndex * uPickInstanceStride;
vPickID = uPickID + pickOffset;
highp vec3 vertexPosition = applyNodePositionOverride(vertexIndex, readAttribute0(vertexIndex));
`;
    let fragmentSetup = "";
    if (skeletonParams.spatialChunkCulling) {
      vertexMain += `vCullPos = vertexPosition;\n`;
      fragmentSetup = `spatialChunkCull();\n`;
    }
    vertexMain += this.readSegmentIdGlsl(skeletonParams, "vertexIndex");
    vertexMain += `emitCircle(uProjection * vec4(vertexPosition, 1.0), uNodeDiameter, 0.0);\n`;
    return { vertexMain, fragmentSetup };
  }

  defineAttributeAccess(builder: ShaderBuilder) {
    const { textureAccessHelper } = this;
    textureAccessHelper.defineShader(builder);
    const numAttributes = this.vertexAttributes.length;
    for (let j = vertexAttributeSamplerSymbols.length; j < numAttributes; ++j) {
      vertexAttributeSamplerSymbols[j] = Symbol(
        `SkeletonShader.vertexAttributeTextureUnit${j}`,
      );
    }
    this.vertexAttributes.forEach((info, i) => {
      builder.addTextureSampler(
        `${getSamplerPrefixForDataType(
          info.dataType,
        )}sampler2D` as ShaderSamplerType,
        `uVertexAttributeSampler${i}`,
        vertexAttributeSamplerSymbols[i],
      );
      builder.addVertexCode(
        textureAccessHelper.getAccessor(
          `readAttribute${i}`,
          `uVertexAttributeSampler${i}`,
          info.dataType,
          info.numComponents,
        ),
      );
    });
  }

  getCrossSectionFadeFactor() {
    if (this.targetIsSliceView) {
      return "(clamp(1.0 - 2.0 * abs(0.5 - gl_FragCoord.z), 0.0, 1.0))";
    }
    return "(1.0)";
  }

  beginLayer(
    gl: GL,
    shader: ShaderProgram,
    renderContext: SliceViewPanelRenderContext | PerspectiveViewRenderContext,
    modelMatrix: mat4,
  ) {
    const { viewProjectionMat } = renderContext.projectionParameters;
    const mat = mat4.multiply(tempMat4, viewProjectionMat, modelMatrix);
    gl.uniformMatrix4fv(shader.uniform("uProjection"), false, mat);
    // Default: no live-drag position override. Must be set for every pass —
    // including the shared browse pass — since a uniform left at its 0 default
    // would wrongly override vertex 0. The overlay pass sets a real value below.
    gl.uniform1i(shader.uniform("uOverrideVertexIndex"), -1);
    this.vertexIdHelper.enable();
  }

  setColor(gl: GL, shader: ShaderProgram, color: vec4) {
    gl.uniform4fv(shader.uniform("uColor"), color);
  }

  // Overrides a single vertex's position (a live node drag) without touching the
  // position texture. `vertexIndex < 0` disables the override.
  setNodePositionOverride(
    gl: GL,
    shader: ShaderProgram,
    vertexIndex: number,
    position: ArrayLike<number>,
  ) {
    gl.uniform1i(shader.uniform("uOverrideVertexIndex"), vertexIndex);
    if (vertexIndex >= 0) {
      gl.uniform3f(
        shader.uniform("uOverridePosition"),
        Number(position[0] ?? 0),
        Number(position[1] ?? 0),
        Number(position[2] ?? 0),
      );
    }
  }

  setPickID(gl: GL, shader: ShaderProgram, pickID: number) {
    gl.uniform1ui(shader.uniform("uPickID"), pickID);
  }

  setPickInstanceStride(gl: GL, shader: ShaderProgram, stride: number) {
    gl.uniform1ui(shader.uniform("uPickInstanceStride"), stride);
  }

  setChunkBounds(
    gl: GL,
    shader: ShaderProgram,
    origin: Float32Array,
    upperBound: Float32Array,
  ) {
    gl.uniform3fv(shader.uniform("uChunkOrigin"), origin);
    gl.uniform3fv(shader.uniform("uChunkBound"), upperBound);
  }

  setLineWidth(gl: GL, shader: ShaderProgram, lineWidth: number) {
    gl.uniform1f(shader.uniform("uLineWidth"), lineWidth);
  }

  setNodeDiameter(gl: GL, shader: ShaderProgram, pointDiameter: number) {
    gl.uniform1f(shader.uniform("uNodeDiameter"), pointDiameter);
  }

  drawSkeletons(
    gl: GL,
    edgeShader: ShaderProgram,
    nodeShader: ShaderProgram,
    skeletonGpuGeometry: SkeletonGPUGeometry,
    projectionParameters: { width: number; height: number },
  ) {
    // Bind vertex attribute textures to be used across edge and node shaders
    // The edge shader and node shader share the same texture unit for each attribute
    // so we only bind once. However, if this ever changes, we
    // instead must bind for the edge shader, draw, then bind for node shader
    const { vertexAttributes } = this;
    const { vertexAttributeTextures } = skeletonGpuGeometry;
    const numAttributes = vertexAttributes.length;
    for (let i = 0; i < numAttributes; ++i) {
      const textureUnit =
        WebGL2RenderingContext.TEXTURE0 +
        edgeShader.textureUnit(vertexAttributeSamplerSymbols[i]);
      gl.activeTexture(textureUnit);
      gl.bindTexture(
        WebGL2RenderingContext.TEXTURE_2D,
        vertexAttributeTextures[i],
      );
    }
    if (edgeShader.textureUnits.has(segmentIdSamplerSymbol)) {
      gl.activeTexture(
        WebGL2RenderingContext.TEXTURE0 +
          edgeShader.textureUnit(segmentIdSamplerSymbol),
      );
      gl.bindTexture(
        WebGL2RenderingContext.TEXTURE_2D,
        skeletonGpuGeometry.segmentIdTexture ?? null,
      );
    }

    {
      edgeShader.bind();
      const aVertexIndex = edgeShader.attribute("aVertexIndex");
      skeletonGpuGeometry.indexBuffer.bindToVertexAttribI(
        aVertexIndex,
        2,
        WebGL2RenderingContext.UNSIGNED_INT,
      );
      gl.vertexAttribDivisor(aVertexIndex, 1);
      initializeLineShader(
        edgeShader,
        projectionParameters,
        this.targetIsSliceView ? 1.0 : 0.0,
      );
      drawLines(gl, 1, skeletonGpuGeometry.numIndices / 2);
      gl.vertexAttribDivisor(aVertexIndex, 0);
      gl.disableVertexAttribArray(aVertexIndex);
    }

    // Draw nodes - this is performed also in line render mode
    // so that there are no visible gaps between the edges
    // as the point size is set to the line width.
    {
      nodeShader.bind();
      initializeCircleShader(nodeShader, projectionParameters, {
        featherWidthInPixels: this.targetIsSliceView ? 1.0 : 0.0,
      });
      drawCircles(nodeShader.gl, 1, skeletonGpuGeometry.numVertices);
    }
  }

  endLayer(gl: GL, ...shaders: Array<ShaderProgram | null>) {
    const { vertexAttributes, clearedTextureUnits } = this;
    const numAttributes = vertexAttributes.length;
    clearedTextureUnits.clear();
    for (const shader of shaders) {
      if (shader === null) continue;
      const textureUnits = vertexAttributeSamplerSymbols
        .slice(0, numAttributes)
        .map((symbol) => shader.textureUnit(symbol));
      if (shader.textureUnits.has(segmentIdSamplerSymbol)) {
        textureUnits.push(shader.textureUnit(segmentIdSamplerSymbol));
      }
      for (const textureUnit of textureUnits) {
        const curTextureUnit = textureUnit + WebGL2RenderingContext.TEXTURE0;
        if (clearedTextureUnits.has(curTextureUnit)) continue;
        clearedTextureUnits.add(curTextureUnit);
        gl.activeTexture(curTextureUnit);
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
    }
    this.vertexIdHelper.disable();
  }
}

export enum SkeletonRenderMode {
  LINES = 0,
  LINES_AND_POINTS = 1,
}
export class TrackableSkeletonRenderMode extends TrackableEnum<SkeletonRenderMode> {
  constructor(
    value: SkeletonRenderMode,
    defaultValue: SkeletonRenderMode = value,
  ) {
    super(SkeletonRenderMode, value, defaultValue);
  }
}

export class TrackableSkeletonLineWidth extends TrackableValue<number> {
  constructor(value: number, defaultValue: number = value) {
    super(value, verifyFinitePositiveFloat, defaultValue);
  }
}

export function getSkeletonNodeDiameter(
  renderMode: SkeletonRenderMode,
  lineWidth: number,
) {
  if (renderMode === SkeletonRenderMode.LINES_AND_POINTS) {
    return Math.max(5, lineWidth * 2);
  }
  return lineWidth;
}

// A selected/hovered node highlight or pending-intent marker to draw as a DOM

export interface ViewSpecificSkeletonRenderingOptions {
  mode: TrackableSkeletonRenderMode;
  lineWidth: TrackableSkeletonLineWidth;
}

// TODO (SKM): think this could likely extend compound trackable instead
export class SkeletonRenderingOptions implements Trackable {
  private compound = new CompoundTrackable();
  get changed() {
    return this.compound.changed;
  }

  shader = makeTrackableFragmentMain(DEFAULT_FRAGMENT_MAIN);
  shaderControlState = new ShaderControlState(this.shader);
  hideInactiveShaderControls = new TrackableBoolean(false);
  params2d: ViewSpecificSkeletonRenderingOptions = {
    mode: new TrackableSkeletonRenderMode(SkeletonRenderMode.LINES_AND_POINTS),
    lineWidth: new TrackableSkeletonLineWidth(2),
  };
  params3d: ViewSpecificSkeletonRenderingOptions = {
    mode: new TrackableSkeletonRenderMode(SkeletonRenderMode.LINES),
    lineWidth: new TrackableSkeletonLineWidth(1),
  };

  constructor() {
    const { compound } = this;
    compound.add("shader", this.shader);
    compound.add("shaderControls", this.shaderControlState);
    compound.add("hideInactiveShaderControls", this.hideInactiveShaderControls);
    compound.add("mode2d", this.params2d.mode);
    compound.add("lineWidth2d", this.params2d.lineWidth);
    compound.add("mode3d", this.params3d.mode);
    compound.add("lineWidth3d", this.params3d.lineWidth);
  }

  reset() {
    this.compound.reset();
  }

  restoreState(obj: any) {
    if (obj === undefined) return;
    this.compound.restoreState(obj);
  }

  toJSON(): any {
    const obj = this.compound.toJSON();
    for (const v of Object.values(obj)) {
      if (v !== undefined) return obj;
    }
    return undefined;
  }
}

export interface SkeletonLayerDisplayState extends SegmentationDisplayState3D {
  hiddenObjectAlpha: TrackableAlphaValue;
  shaderError: WatchableShaderError;
  skeletonRenderingOptions: SkeletonRenderingOptions;
}

export class SkeletonLayer
  extends RefCounted
  implements SkeletonShaderContext, SkeletonNodeAccess
{
  layerChunkProgressInfo = new LayerChunkProgressInfo();
  redrawNeeded = new NullarySignal();
  private sharedObject: SegmentationLayerSharedObject;
  private readonly chunkNodes = new WeakMap<
    SkeletonChunk,
    readonly SkeletonNode[]
  >();
  vertexAttributes: VertexAttributeRenderInfo[];
  // Non-spatial skeletons iterate segments individually and pass color/alpha via
  // uniforms (getObjectColor), so the dynamic per-vertex segment appearance path
  // is not needed. Stated colors and default color are likewise handled upstream
  // before the draw call, not looked up in the shader.
  readonly skeletonShaderParameters =
    new WatchableValue<SkeletonShaderParameters>({
      dynamicSegmentAppearance: false,
      hasSegmentStatedColors: false,
      hasSegmentDefaultColor: false,
      hasProvisionalSegmentColors: false,
      hoverHighlight: false,
      spatialChunkCulling: false,
    });
  fallbackShaderParameters = new WatchableValue(
    getFallbackBuilderState(parseShaderUiControls(DEFAULT_FRAGMENT_MAIN)),
  );

  get visibility() {
    return this.sharedObject.visibility;
  }

  constructor(
    public chunkManager: ChunkManager,
    public source: SkeletonSource,
    public displayState: SkeletonLayerDisplayState,
  ) {
    super();

    registerRedrawWhenSegmentationDisplayState3DChanged(displayState, this);
    this.displayState.shaderError.value = undefined;
    const { skeletonRenderingOptions: renderingOptions } = displayState;
    this.registerDisposer(
      renderingOptions.shader.changed.add(() => {
        this.displayState.shaderError.value = undefined;
        this.redrawNeeded.dispatch();
      }),
    );
    const sharedObject = (this.sharedObject = this.registerDisposer(
      new SegmentationLayerSharedObject(
        chunkManager,
        displayState,
        this.layerChunkProgressInfo,
      ),
    ));
    sharedObject.RPC_TYPE_ID = SKELETON_LAYER_RPC_ID;
    sharedObject.initializeCounterpartWithChunkManager({
      source: source.addCounterpartRef(),
    });

    const vertexAttributes = (this.vertexAttributes = [
      vertexPositionAttribute,
    ]);

    for (const [name, info] of source.vertexAttributes) {
      vertexAttributes.push({
        name,
        dataType: info.dataType,
        numComponents: info.numComponents,
        webglDataType: getWebglDataType(info.dataType),
        glslDataType:
          info.numComponents > 1 ? `vec${info.numComponents}` : "float",
      });
    }
  }

  get gl() {
    return this.chunkManager.chunkQueueManager.gl;
  }

  readonly hasPickableNodes = false;

  get nodesChanged() {
    return this.source.chunksChanged;
  }

  getSegmentNodes(segmentId: bigint): readonly SkeletonNode[] | undefined {
    const chunk = this.source.chunks.get(getObjectKey(segmentId));
    if (chunk === undefined) return undefined;
    let nodes = this.chunkNodes.get(chunk);
    if (nodes === undefined) {
      nodes = getSkeletonChunkNodes(segmentId, chunk);
      this.chunkNodes.set(chunk, nodes);
    }
    return nodes;
  }

  readonly parentsInferred = true;

  draw(
    renderContext: SliceViewPanelRenderContext | PerspectiveViewRenderContext,
    layer: RenderLayer,
    renderHelper: RenderHelper,
    renderOptions: ViewSpecificSkeletonRenderingOptions,
    attachment: VisibleLayerInfo<
      LayerView,
      ThreeDimensionalRenderLayerAttachmentState
    >,
  ) {
    const lineWidth = renderOptions.lineWidth.value;
    const { gl, displayState, source } = this;
    if (displayState.objectAlpha.value <= 0.0) {
      // Skip drawing.
      return;
    }
    const modelMatrix = update3dRenderLayerAttachment(
      displayState.transform.value,
      renderContext.projectionParameters.displayDimensionRenderInfo,
      attachment,
    );
    if (modelMatrix === undefined) return;
    const pointDiameter = getSkeletonNodeDiameter(
      renderOptions.mode.value,
      lineWidth,
    );

    const edgeShaderResult = renderHelper.edgeShaderGetter(
      renderContext.emitter,
    );
    const nodeShaderResult = renderHelper.nodeShaderGetter(
      renderContext.emitter,
    );
    const { shader: edgeShader, parameters: edgeShaderParameters } =
      edgeShaderResult;
    const { shader: nodeShader, parameters: nodeShaderParameters } =
      nodeShaderResult;
    if (edgeShader === null || nodeShader === null) {
      // Shader error, skip drawing.
      return;
    }

    const { shaderControlState } = this.displayState.skeletonRenderingOptions;

    edgeShader.bind();
    renderHelper.beginLayer(gl, edgeShader, renderContext, modelMatrix);
    renderHelper.setPickInstanceStride(gl, edgeShader, 0);
    setControlsInShader(
      gl,
      edgeShader,
      shaderControlState,
      edgeShaderParameters.parseResult,
    );
    renderHelper.setLineWidth(gl, edgeShader, lineWidth!);

    nodeShader.bind();
    renderHelper.beginLayer(gl, nodeShader, renderContext, modelMatrix);
    renderHelper.setNodeDiameter(gl, nodeShader, pointDiameter);
    renderHelper.setPickInstanceStride(gl, nodeShader, 0);
    setControlsInShader(
      gl,
      nodeShader,
      shaderControlState,
      nodeShaderParameters.parseResult,
    );

    const skeletons = source.chunks;
    forEachVisibleSegmentToDraw(
      displayState,
      layer,
      renderContext.emitColor,
      renderContext.emitPickID ? renderContext.pickIDs : undefined,
      (objectId, color, pickIndex) => {
        const key = getObjectKey(objectId);
        const skeleton = skeletons.get(key);
        if (
          skeleton === undefined ||
          skeleton.state !== ChunkState.GPU_MEMORY
        ) {
          return;
        }
        edgeShader.bind();
        if (color !== undefined) {
          renderHelper.setColor(gl, edgeShader, color);
        }
        if (pickIndex !== undefined) {
          renderHelper.setPickID(gl, edgeShader, pickIndex);
        }
        nodeShader.bind();
        if (color !== undefined) {
          renderHelper.setColor(gl, nodeShader, color);
        }
        if (pickIndex !== undefined) {
          renderHelper.setPickID(gl, nodeShader, pickIndex);
        }
        renderHelper.drawSkeletons(
          gl,
          edgeShader,
          nodeShader,
          skeleton,
          renderContext.projectionParameters,
        );
      },
    );
    renderHelper.endLayer(gl, edgeShader, nodeShader);
  }

  isReady() {
    const { source, displayState } = this;
    if (displayState.objectAlpha.value <= 0.0) {
      // Skip drawing.
      return true;
    }

    const skeletons = source.chunks;

    let ready = true;

    forEachVisibleSegment(
      displayState.segmentationGroupState.value,
      (objectId) => {
        const key = getObjectKey(objectId);
        const skeleton = skeletons.get(key);
        if (
          skeleton === undefined ||
          skeleton.state !== ChunkState.GPU_MEMORY
        ) {
          ready = false;
          return;
        }
      },
    );
    return ready;
  }
}

export class PerspectiveViewSkeletonLayer extends PerspectiveViewRenderLayer {
  private renderHelper: RenderHelper;
  private renderOptions: ViewSpecificSkeletonRenderingOptions;
  constructor(public base: SkeletonLayer) {
    super();
    this.renderHelper = this.registerDisposer(new RenderHelper(base, false));
    this.renderOptions = base.displayState.skeletonRenderingOptions.params3d;

    this.layerChunkProgressInfo = base.layerChunkProgressInfo;
    this.registerDisposer(base);
    this.registerDisposer(base.redrawNeeded.add(this.redrawNeeded.dispatch));
    const { renderOptions } = this;
    this.registerDisposer(
      renderOptions.mode.changed.add(this.redrawNeeded.dispatch),
    );
    this.registerDisposer(
      renderOptions.lineWidth.changed.add(this.redrawNeeded.dispatch),
    );
    this.registerDisposer(base.visibility.add(this.visibility));
  }
  get gl() {
    return this.base.gl;
  }

  get isTransparent() {
    return this.base.displayState.objectAlpha.value < 1.0;
  }

  draw(
    renderContext: PerspectiveViewRenderContext,
    attachment: VisibleLayerInfo<
      PerspectivePanel,
      ThreeDimensionalRenderLayerAttachmentState
    >,
  ) {
    if (!renderContext.emitColor && renderContext.alreadyEmittedPickID) {
      // No need for a separate pick ID pass.
      return;
    }
    this.base.draw(
      renderContext,
      this,
      this.renderHelper,
      this.renderOptions,
      attachment,
    );
  }

  isReady() {
    return this.base.isReady();
  }
}

export class SliceViewPanelSkeletonLayer extends SliceViewPanelRenderLayer {
  private renderHelper: RenderHelper;
  private renderOptions: ViewSpecificSkeletonRenderingOptions;
  constructor(public base: SkeletonLayer) {
    super();
    this.renderHelper = this.registerDisposer(new RenderHelper(base, true));
    this.renderOptions = base.displayState.skeletonRenderingOptions.params2d;
    this.layerChunkProgressInfo = base.layerChunkProgressInfo;
    this.registerDisposer(base);
    const { renderOptions } = this;
    this.registerDisposer(
      renderOptions.mode.changed.add(this.redrawNeeded.dispatch),
    );
    this.registerDisposer(
      renderOptions.lineWidth.changed.add(this.redrawNeeded.dispatch),
    );
    this.registerDisposer(base.redrawNeeded.add(this.redrawNeeded.dispatch));
    this.registerDisposer(base.visibility.add(this.visibility));
  }
  get gl() {
    return this.base.gl;
  }

  draw(
    renderContext: SliceViewPanelRenderContext,
    attachment: VisibleLayerInfo<
      SliceViewPanel,
      ThreeDimensionalRenderLayerAttachmentState
    >,
  ) {
    this.base.draw(
      renderContext,
      this,
      this.renderHelper,
      this.renderOptions,
      attachment,
    );
  }

  isReady() {
    return this.base.isReady();
  }
}

function getWebglDataType(dataType: DataType) {
  switch (dataType) {
    case DataType.FLOAT32:
      return WebGL2RenderingContext.FLOAT;
    default:
      throw new Error(
        `Data type not supported by WebGL: ${DataType[dataType]}`,
      );
  }
}

export const vertexPositionAttribute: VertexAttributeRenderInfo = {
  dataType: DataType.FLOAT32,
  numComponents: 3,
  name: "",
  webglDataType: WebGL2RenderingContext.FLOAT,
  glslDataType: "vec3",
};

export interface SkeletonChunkBase extends SkeletonGPUGeometry {
  vertexAttributes: Uint8Array;
  vertexAttributeOffsets: Uint32Array;
  indices: Uint32Array;
  source: { attributeTextureFormats: TextureFormat[] };
}

// Used by both SkeletonChunk and SpatiallyIndexedSkeletonChunk.
export function uploadSkeletonChunkToGPU(gl: GL, chunk: SkeletonChunkBase) {
  const { attributeTextureFormats } = chunk.source;
  const { vertexAttributes, vertexAttributeOffsets } = chunk;
  const vertexAttributeTextures: (WebGLTexture | null)[] =
    (chunk.vertexAttributeTextures = []);
  for (
    let i = 0, numAttributes = vertexAttributeOffsets.length;
    i < numAttributes;
    ++i
  ) {
    const texture = gl.createTexture();
    gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, texture);
    setOneDimensionalTextureData(
      gl,
      attributeTextureFormats[i],
      vertexAttributes.subarray(
        vertexAttributeOffsets[i],
        i + 1 !== numAttributes
          ? vertexAttributeOffsets[i + 1]
          : vertexAttributes.length,
      ),
    );
    vertexAttributeTextures[i] = texture;
  }
  gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, null);
  chunk.indexBuffer = GLBuffer.fromData(
    gl,
    chunk.indices,
    WebGL2RenderingContext.ARRAY_BUFFER,
    WebGL2RenderingContext.STATIC_DRAW,
  );
}

export function freeSkeletonChunkGPUMemory(gl: GL, chunk: SkeletonChunkBase) {
  chunk.indexBuffer.dispose();
  const { vertexAttributeTextures } = chunk;
  for (let i = 0, length = vertexAttributeTextures.length; i < length; ++i) {
    gl.deleteTexture(vertexAttributeTextures[i]);
  }
  vertexAttributeTextures.length = 0;
}

export class SkeletonChunk extends Chunk implements SkeletonChunkBase {
  declare source: SkeletonSource;
  vertexAttributes: Uint8Array;
  indices: Uint32Array;
  indexBuffer!: GLBuffer;
  numIndices: number;
  numVertices: number;
  vertexAttributeOffsets: Uint32Array;
  vertexAttributeTextures: (WebGLTexture | null)[] = [];

  constructor(source: SkeletonSource, x: PackedSkeletonGeometry) {
    super(source);
    this.vertexAttributes = x.vertexAttributes;
    const indices = (this.indices = x.indices);
    this.numVertices = x.numVertices;
    this.vertexAttributeOffsets = x.vertexAttributeOffsets;
    this.numIndices = indices.length;
  }

  copyToGPU(gl: GL) {
    super.copyToGPU(gl);
    uploadSkeletonChunkToGPU(gl, this);
  }

  freeGPUMemory(gl: GL) {
    super.freeGPUMemory(gl);
    freeSkeletonChunkGPUMemory(gl, this);
  }
}

const emptyVertexAttributes = new Map<string, VertexAttributeInfo>();

function getAttributeTextureFormats(
  vertexAttributes: Map<string, VertexAttributeInfo>,
): TextureFormat[] {
  const attributeTextureFormats: TextureFormat[] = [
    vertexPositionTextureFormat,
  ];
  for (const info of vertexAttributes.values()) {
    attributeTextureFormats.push(
      computeTextureFormat(
        new TextureFormat(),
        info.dataType,
        info.numComponents,
      ),
    );
  }
  return attributeTextureFormats;
}

export class SkeletonSource extends ChunkSource {
  private attributeTextureFormats_?: TextureFormat[];

  get attributeTextureFormats() {
    let attributeTextureFormats = this.attributeTextureFormats_;
    if (attributeTextureFormats === undefined) {
      attributeTextureFormats = this.attributeTextureFormats_ =
        getAttributeTextureFormats(this.vertexAttributes);
    }
    return attributeTextureFormats;
  }

  declare chunks: Map<string, SkeletonChunk>;
  readonly chunksChanged = new NullarySignal();

  getChunk(x: PackedSkeletonGeometry) {
    return new SkeletonChunk(this, x);
  }

  addChunk(key: string, chunk: SkeletonChunk) {
    super.addChunk(key, chunk);
    this.chunksChanged.dispatch();
  }

  deleteChunk(key: string) {
    super.deleteChunk(key);
    this.chunksChanged.dispatch();
  }

  get vertexAttributes(): Map<string, VertexAttributeInfo> {
    return emptyVertexAttributes;
  }
}
