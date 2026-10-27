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
  edgeColorGlsl,
  nodeColorGlsl,
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
  stripComments,
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

export interface SegmentAppearanceParameters {
  readonly hasSegmentStatedColors: boolean;
  readonly hasSegmentDefaultColor: boolean;
  readonly hasProvisionalSegmentColors: boolean;
  readonly hoverHighlight: boolean;
}

export interface SkeletonShaderParameters {
  // Undefined: one colour per draw, from `uColor`.
  readonly segmentAppearance: SegmentAppearanceParameters | undefined;
  readonly spatialChunkCulling: boolean;
}

export interface SkeletonShaderContext {
  vertexAttributes: VertexAttributeRenderInfo[];
  gl: GL;
  fallbackShaderParameters: WatchableValue<ShaderControlsBuilderState>;
  displayState: SkeletonLayerDisplayState;
  skeletonShaderParameters: WatchableValueInterface<SkeletonShaderParameters>;
  provisionalSegmentIds?: Uint64Set;
  excludedSegmentIds?: Uint64Set;
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

export interface SkeletonDrawOptions {
  readonly modelMatrix: mat4;
  readonly renderOptions: ViewSpecificSkeletonRenderingOptions;
}

export interface SkeletonDrawPass {
  setColor(color: vec4): void;
  // One pick ID for every edge and node of the skeleton.
  setPickId(pickId: number): void;
  // One pick ID per edge and per node, counted from the first.
  setElementPickIds(firstEdgePickId: number, firstNodePickId: number): void;
  setChunkBounds(origin: Float32Array, upperBound: Float32Array): void;
  setNodePositionOverride(
    override:
      | { readonly vertexIndex: number; readonly position: ArrayLike<number> }
      | undefined,
  ): void;
  draw(geometry: SkeletonGPUGeometry): void;
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
  private gpuExcludedSegmentsHashTable: GPUHashTable<HashSetUint64>;
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
    // Moves one dragged vertex without a new upload of the position texture.
    builder.addUniform("highp int", "uOverrideVertexIndex");
    builder.addUniform("highp vec3", "uOverridePosition");
    builder.addVertexCode(`
highp vec3 applyNodePositionOverride(highp uint vertexIndex, highp vec3 position) {
  return (int(vertexIndex) == uOverrideVertexIndex) ? uOverridePosition : position;
}
`);
    if (skeletonParams.segmentAppearance !== undefined) {
      this.defineSegmentAppearance(builder, skeletonParams.segmentAppearance);
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

  private readonly edgeShaderGetter;
  private readonly nodeShaderGetter;

  get gl(): GL {
    return this.base.gl;
  }

  private defineSegmentAppearance(
    builder: ShaderBuilder,
    segmentAppearance: SegmentAppearanceParameters,
  ) {
    this.visibleSegmentsShaderManager.defineShader(builder);
    this.excludedSegmentsShaderManager.defineShader(builder);
    this.segmentColorShaderManager.defineShader(builder);
    if (segmentAppearance.hasProvisionalSegmentColors) {
      this.provisionalSegmentsShaderManager.defineShader(builder);
    }
    if (segmentAppearance.hasSegmentStatedColors) {
      this.segmentStatedColorShaderManager.defineShader(builder);
    }
    builder.addUniform("highp float", "uVisibleAlpha");
    builder.addUniform("highp float", "uHiddenAlpha");
    builder.addUniform("highp float", "uSaturation");
    if (segmentAppearance.hasSegmentDefaultColor) {
      builder.addUniform("highp vec3", "uSegmentDefaultColor");
    }
    if (segmentAppearance.hoverHighlight) {
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

    const statedColorFragment = segmentAppearance.hasSegmentStatedColors
      ? `
  vec4 statedColor;
  if (${this.segmentStatedColorShaderManager.getFunctionName}(segmentId, statedColor)) {
    return statedColor.rgb;
  }`
      : "";

    const defaultColorFragment = segmentAppearance.hasSegmentDefaultColor
      ? "  return uSegmentDefaultColor;"
      : `  return ${this.segmentColorShaderManager.prefix}(segmentId);`;

    const hoverAdjustFragment = segmentAppearance.hoverHighlight
      ? `
  float isHovered = float(segmentId.value.x == uHoveredSegmentId.x &&
                          segmentId.value.y == uHoveredSegmentId.y);
  saturation += isHovered * (0.5 - step(0.5, saturation));`
      : "";

    const provisionalColorFragment =
      segmentAppearance.hasProvisionalSegmentColors
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

  private enableSegmentAppearance(
    shader: ShaderProgram,
    segmentAppearance: SegmentAppearanceParameters,
  ) {
    const { gl } = this;
    const { displayState } = this.base;
    const segmentationGroupState = displayState.segmentationGroupState.value;
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
      this.gpuExcludedSegmentsHashTable,
    );
    gl.uniform1f(
      shader.uniform("uVisibleAlpha"),
      displayState.objectAlpha.value,
    );
    gl.uniform1f(
      shader.uniform("uHiddenAlpha"),
      displayState.hiddenObjectAlpha.value,
    );
    const colorGroupState = displayState.segmentationColorGroupState.value;
    this.segmentColorShaderManager.enable(
      gl,
      shader,
      colorGroupState.segmentColorHash.value,
    );
    if (segmentAppearance.hasProvisionalSegmentColors) {
      this.provisionalSegmentsShaderManager.enable(
        gl,
        shader,
        this.gpuProvisionalSegmentsHashTable,
      );
    }
    if (segmentAppearance.hasSegmentDefaultColor) {
      const segmentDefaultColor = colorGroupState.segmentDefaultColor.value;
      if (segmentDefaultColor !== undefined) {
        gl.uniform3fv(
          shader.uniform("uSegmentDefaultColor"),
          segmentDefaultColor,
        );
      }
    }
    if (segmentAppearance.hasSegmentStatedColors) {
      this.segmentStatedColorShaderManager.enable(
        gl,
        shader,
        this.gpuSegmentStatedColorHashTable,
      );
    }
    gl.uniform1f(shader.uniform("uSaturation"), displayState.saturation.value);
    if (segmentAppearance.hoverHighlight) {
      const { segmentSelectionState } = displayState;
      const hoveredSegmentId = segmentSelectionState.hasSelectedSegment
        ? segmentSelectionState.selectedSegment
        : 0n;
      gl.uniform2ui(
        shader.uniform("uHoveredSegmentId"),
        Number(hoveredSegmentId & 0xffff_ffffn),
        Number((hoveredSegmentId >> 32n) & 0xffff_ffffn),
      );
    }
  }

  private disableSegmentAppearance(
    shader: ShaderProgram,
    segmentAppearance: SegmentAppearanceParameters,
  ) {
    const { gl } = this;
    this.visibleSegmentsShaderManager.disable(gl, shader);
    this.excludedSegmentsShaderManager.disable(gl, shader);
    if (segmentAppearance.hasProvisionalSegmentColors) {
      this.provisionalSegmentsShaderManager.disable(gl, shader);
    }
    if (segmentAppearance.hasSegmentStatedColors) {
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
    this.gpuExcludedSegmentsHashTable = this.registerDisposer(
      GPUHashTable.get(
        this.gl,
        (base.excludedSegmentIds ?? this.emptySegmentSet).hashTable,
      ),
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

  draw(
    renderContext: SliceViewPanelRenderContext | PerspectiveViewRenderContext,
    { modelMatrix, renderOptions }: SkeletonDrawOptions,
    callback: (pass: SkeletonDrawPass) => void,
  ): void {
    const edgeShaderResult = this.edgeShaderGetter(renderContext.emitter);
    const nodeShaderResult = this.nodeShaderGetter(renderContext.emitter);
    const edgeShader = edgeShaderResult.shader;
    const nodeShader = nodeShaderResult.shader;
    if (edgeShader === null || nodeShader === null) return;
    const { gl } = this;
    const { segmentAppearance } = edgeShaderResult.extraParameters;
    const { shaderControlState } =
      this.base.displayState.skeletonRenderingOptions;
    const lineWidth = renderOptions.lineWidth.value;
    const projection = mat4.multiply(
      tempMat4,
      renderContext.projectionParameters.viewProjectionMat,
      modelMatrix,
    );
    for (const [shader, { parameters }] of [
      [edgeShader, edgeShaderResult],
      [nodeShader, nodeShaderResult],
    ] as const) {
      shader.bind();
      gl.uniformMatrix4fv(shader.uniform("uProjection"), false, projection);
      // A uniform left at 0 would move vertex 0.
      gl.uniform1i(shader.uniform("uOverrideVertexIndex"), -1);
      gl.uniform1ui(shader.uniform("uPickInstanceStride"), 0);
      setControlsInShader(
        gl,
        shader,
        shaderControlState,
        parameters.parseResult,
      );
      if (segmentAppearance !== undefined) {
        this.enableSegmentAppearance(shader, segmentAppearance);
      }
    }
    edgeShader.bind();
    gl.uniform1f(edgeShader.uniform("uLineWidth"), lineWidth);
    nodeShader.bind();
    gl.uniform1f(
      nodeShader.uniform("uNodeDiameter"),
      getSkeletonNodeDiameter(renderOptions.mode.value, lineWidth),
    );
    this.vertexIdHelper.enable();
    callback(
      new ShaderPairDrawPass(
        gl,
        edgeShader,
        nodeShader,
        renderContext.projectionParameters,
        this.vertexAttributes.length,
        this.targetIsSliceView ? 1.0 : 0.0,
      ),
    );
    if (segmentAppearance !== undefined) {
      this.disableSegmentAppearance(edgeShader, segmentAppearance);
      this.disableSegmentAppearance(nodeShader, segmentAppearance);
    }
    this.unbindTextures(edgeShader, nodeShader);
    this.vertexIdHelper.disable();
  }

  private readSegmentIdGlsl(
    skeletonParams: SkeletonShaderParameters,
    indexExpression: string,
  ): string {
    if (skeletonParams.segmentAppearance === undefined) return "";
    return `vSegmentId = readSegmentId(${indexExpression}).value;\n`;
  }

  private defineEdgeShader(
    builder: ShaderBuilder,
    shaderBuilderState: ShaderControlsBuilderState,
    skeletonParams: SkeletonShaderParameters,
  ) {
    this.defineCommonShader(builder, shaderBuilderState, skeletonParams);
    const geometry = this.defineEdgeGeometry(builder, skeletonParams);
    builder.addFragmentCode(`
float getCrossSectionFade() {
  return ${this.getCrossSectionFadeFactor()};
}
`);
    builder.addFragmentCode(edgeColorGlsl(skeletonParams.segmentAppearance));
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
    const geometry = this.defineNodeGeometry(builder, skeletonParams);
    builder.addFragmentCode(nodeColorGlsl(skeletonParams.segmentAppearance));
    this.finalizeShaderBuilder(
      builder,
      shaderBuilderState,
      geometry.vertexMain,
      geometry.fragmentSetup,
    );
  }

  private defineEdgeGeometry(
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

  private defineNodeGeometry(
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

  private unbindTextures(edgeShader: ShaderProgram, nodeShader: ShaderProgram) {
    const { gl, clearedTextureUnits } = this;
    const numAttributes = this.vertexAttributes.length;
    clearedTextureUnits.clear();
    for (const shader of [edgeShader, nodeShader]) {
      const textureUnits = vertexAttributeSamplerSymbols
        .slice(0, numAttributes)
        .map((symbol) => shader.textureUnit(symbol));
      if (shader.textureUnits.has(segmentIdSamplerSymbol)) {
        textureUnits.push(shader.textureUnit(segmentIdSamplerSymbol));
      }
      for (const textureUnit of textureUnits) {
        const glTextureUnit = textureUnit + WebGL2RenderingContext.TEXTURE0;
        if (clearedTextureUnits.has(glTextureUnit)) continue;
        clearedTextureUnits.add(glTextureUnit);
        gl.activeTexture(glTextureUnit);
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
    }
  }
}

// Setters take effect at the next draw, so each draw binds each shader once.
class ShaderPairDrawPass implements SkeletonDrawPass {
  private readonly pendingUniforms: ((shader: ShaderProgram) => void)[] = [];

  constructor(
    private readonly gl: GL,
    private readonly edgeShader: ShaderProgram,
    private readonly nodeShader: ShaderProgram,
    private readonly projectionParameters: {
      readonly width: number;
      readonly height: number;
    },
    private readonly numVertexAttributes: number,
    private readonly featherWidthInPixels: number,
  ) {}

  private queueUniforms(setUniforms: (shader: ShaderProgram) => void) {
    this.pendingUniforms.push(setUniforms);
  }

  private bindWithPendingUniforms(shader: ShaderProgram) {
    shader.bind();
    for (const setUniforms of this.pendingUniforms) setUniforms(shader);
  }

  setColor(color: vec4) {
    this.queueUniforms((shader) =>
      this.gl.uniform4fv(shader.uniform("uColor"), color),
    );
  }

  setPickId(pickId: number) {
    this.queueUniforms((shader) => {
      this.gl.uniform1ui(shader.uniform("uPickID"), pickId);
      this.gl.uniform1ui(shader.uniform("uPickInstanceStride"), 0);
    });
  }

  setElementPickIds(firstEdgePickId: number, firstNodePickId: number) {
    this.queueUniforms((shader) => {
      this.gl.uniform1ui(
        shader.uniform("uPickID"),
        shader === this.edgeShader ? firstEdgePickId : firstNodePickId,
      );
      this.gl.uniform1ui(shader.uniform("uPickInstanceStride"), 1);
    });
  }

  setChunkBounds(origin: Float32Array, upperBound: Float32Array) {
    this.queueUniforms((shader) => {
      this.gl.uniform3fv(shader.uniform("uChunkOrigin"), origin);
      this.gl.uniform3fv(shader.uniform("uChunkBound"), upperBound);
    });
  }

  setNodePositionOverride(
    override:
      | { readonly vertexIndex: number; readonly position: ArrayLike<number> }
      | undefined,
  ) {
    this.queueUniforms((shader) => {
      this.gl.uniform1i(
        shader.uniform("uOverrideVertexIndex"),
        override?.vertexIndex ?? -1,
      );
      if (override !== undefined) {
        const { position } = override;
        this.gl.uniform3f(
          shader.uniform("uOverridePosition"),
          position[0],
          position[1],
          position[2],
        );
      }
    });
  }

  draw(geometry: SkeletonGPUGeometry) {
    const { gl, edgeShader, nodeShader, projectionParameters } = this;
    // Both shaders declare their samplers in the same order, so they share texture units.
    const { vertexAttributeTextures } = geometry;
    for (let i = 0; i < this.numVertexAttributes; ++i) {
      gl.activeTexture(
        WebGL2RenderingContext.TEXTURE0 +
          edgeShader.textureUnit(vertexAttributeSamplerSymbols[i]),
      );
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
        geometry.segmentIdTexture ?? null,
      );
    }

    this.bindWithPendingUniforms(edgeShader);
    const aVertexIndex = edgeShader.attribute("aVertexIndex");
    geometry.indexBuffer.bindToVertexAttribI(
      aVertexIndex,
      2,
      WebGL2RenderingContext.UNSIGNED_INT,
    );
    gl.vertexAttribDivisor(aVertexIndex, 1);
    initializeLineShader(
      edgeShader,
      projectionParameters,
      this.featherWidthInPixels,
    );
    drawLines(gl, 1, geometry.numIndices / 2);
    gl.vertexAttribDivisor(aVertexIndex, 0);
    gl.disableVertexAttribArray(aVertexIndex);

    // Nodes are drawn in line mode too, so that edges meet without gaps.
    this.bindWithPendingUniforms(nodeShader);
    this.pendingUniforms.length = 0;
    initializeCircleShader(nodeShader, projectionParameters, {
      featherWidthInPixels: this.featherWidthInPixels,
    });
    drawCircles(gl, 1, geometry.numVertices);
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

export interface ViewSpecificSkeletonRenderingOptions {
  mode: TrackableSkeletonRenderMode;
  lineWidth: TrackableSkeletonLineWidth;
}

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
  readonly skeletonShaderParameters =
    new WatchableValue<SkeletonShaderParameters>({
      segmentAppearance: undefined,
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
    const { displayState, source } = this;
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
    const skeletons = source.chunks;
    renderHelper.draw(renderContext, { modelMatrix, renderOptions }, (pass) => {
      forEachVisibleSegmentToDraw(
        displayState,
        layer,
        renderContext.emitColor,
        renderContext.emitPickID ? renderContext.pickIDs : undefined,
        (objectId, color, pickIndex) => {
          const skeleton = skeletons.get(getObjectKey(objectId));
          if (
            skeleton === undefined ||
            skeleton.state !== ChunkState.GPU_MEMORY
          ) {
            return;
          }
          if (color !== undefined) pass.setColor(color);
          if (pickIndex !== undefined) pass.setPickId(pickIndex);
          pass.draw(skeleton);
        },
      );
    });
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
    const { displayState } = this.base;
    return (
      displayState.objectAlpha.value < 1.0 ||
      stripComments(
        displayState.skeletonRenderingOptions.shader.value,
      ).includes("emitRGBA")
    );
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
