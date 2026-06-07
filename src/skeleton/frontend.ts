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
import {
  Chunk,
  ChunkRenderLayerFrontend,
  ChunkSource,
} from "#src/chunk_manager/frontend.js";
import { hashCombine } from "#src/gpu_hash/hash_function.js";
import type { HashMapUint64, HashSetUint64 } from "#src/gpu_hash/hash_table.js";
import { GPUHashTable, HashSetShaderManager } from "#src/gpu_hash/shader.js";
import type {
  LayerView,
  MouseSelectionState,
  PickState,
  VisibleLayerInfo,
} from "#src/layer/index.js";
import type { PerspectivePanel } from "#src/perspective_view/panel.js";
import type {
  PerspectiveViewReadyRenderContext,
  PerspectiveViewRenderContext,
} from "#src/perspective_view/render_layer.js";
import { PerspectiveViewRenderLayer } from "#src/perspective_view/render_layer.js";
import type { ProjectionParameters } from "#src/projection_parameters.js";
import type {
  ChunkTransformParameters,
  RenderLayerTransform,
} from "#src/render_coordinate_transform.js";
import { getChunkTransformParameters } from "#src/render_coordinate_transform.js";
import type { RenderScaleHistogram } from "#src/render_scale_statistics.js";
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
  getVisibleSegments,
  getObjectKey,
} from "#src/segmentation_display_state/base.js";
import type { SegmentationDisplayState3D } from "#src/segmentation_display_state/frontend.js";
import {
  forEachVisibleSegmentToDraw,
  registerRedrawWhenSegmentationDisplayState3DChanged,
  SegmentationLayerSharedObject,
} from "#src/segmentation_display_state/frontend.js";
import { SharedWatchableValue } from "#src/shared_watchable_value.js";
import type {
  SpatiallyIndexedSkeletonNode,
  SpatialSkeletonSourceState,
} from "#src/skeleton/api.js";
import type { VertexAttributeInfo } from "#src/skeleton/base.js";
import {
  SKELETON_LAYER_RPC_ID,
  SPATIALLY_INDEXED_SKELETON_RENDER_LAYER_RPC_ID,
  SPATIALLY_INDEXED_SKELETON_RENDER_LAYER_UPDATE_SOURCES_RPC_ID,
} from "#src/skeleton/base.js";
import {
  buildSpatiallyIndexedSkeletonOverlayGeometry,
  type SpatiallyIndexedSkeletonOverlayGeometry,
} from "#src/skeleton/segment_overlay.js";
import {
  DEFAULT_MAX_RETAINED_OVERLAY_SEGMENTS,
  mergeSpatiallyIndexedSkeletonOverlaySegmentIds,
  retainSpatiallyIndexedSkeletonOverlaySegment,
} from "#src/skeleton/segment_overlay.js";
import {
  getSpatiallyIndexedSkeletonGridIndex,
  getSpatiallyIndexedSkeletonSourceView,
  selectSpatiallyIndexedSkeletonEntriesForView,
  type SpatiallyIndexedSkeletonView,
} from "#src/skeleton/source_selection.js";
import {
  forEachVisibleVolumetricChunk,
  type SliceViewChunkSpecification,
  type SliceViewSourceOptions,
  type TransformedSource,
} from "#src/sliceview/base.js";
import type { ChunkLayout } from "#src/sliceview/chunk_layout.js";
import type { SliceViewSingleResolutionSource } from "#src/sliceview/frontend.js";
import {
  getVolumetricTransformedSources,
  serializeAllTransformedSources,
  SliceViewChunk,
  SliceViewChunkSource,
  MultiscaleSliceViewChunkSource,
} from "#src/sliceview/frontend.js";
import type { SliceViewPanel } from "#src/sliceview/panel.js";
import type {
  SliceViewPanelRenderContext,
  SliceViewPanelReadyRenderContext,
} from "#src/sliceview/renderlayer.js";
import { SliceViewPanelRenderLayer } from "#src/sliceview/renderlayer.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import {
  makeCachedLazyDerivedWatchableValue,
  TrackableValue,
  WatchableValue,
  registerNested,
} from "#src/trackable_value.js";
import { Uint64Set } from "#src/uint64_set.js";
import { gatherUpdate } from "#src/util/array.js";
import { hsvToRgb } from "#src/util/colorspace.js";
import { DataType } from "#src/util/data_type.js";
import { RefCounted } from "#src/util/disposable.js";
import type { ValueOrError } from "#src/util/error.js";
import { makeValueOrError, valueOrThrow } from "#src/util/error.js";
import { kOneVec4, mat4, vec3, type vec4 } from "#src/util/geom.js";
import { verifyFinitePositiveFloat } from "#src/util/json.js";
import * as matrix from "#src/util/matrix.js";
import { getObjectId } from "#src/util/object_id.js";
import { NullarySignal } from "#src/util/signal.js";
import type { Trackable } from "#src/util/trackable.js";
import { CompoundTrackable } from "#src/util/trackable.js";
import { TrackableEnum } from "#src/util/trackable_enum.js";
import {
  drawBoxEdges,
  glsl_getBoxEdgeVertexPosition,
} from "#src/webgl/bounding_box.js";
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
  ShaderModule,
  ShaderProgram,
  ShaderSamplerType,
} from "#src/webgl/shader.js";
import { ShaderBuilder } from "#src/webgl/shader.js";
import {
  dataTypeShaderDefinition,
  getShaderType,
} from "#src/webgl/shader_lib.js";
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
  updateOneDimensionalTextureElement,
} from "#src/webgl/texture_access.js";
import { defineVertexId, VertexIdHelper } from "#src/webgl/vertex_id.js";
import type { RPC } from "#src/worker_rpc.js";

const DEBUG_SPATIAL_SKELETON_OVERLAY = false;
const DEBUG_EXCLUDED_SEGMENTS = false;
const DEBUG_SPATIAL_SKELETON_CHUNKS = false;
// Used for debugging chunks via a different color for each chunk
const tempChunkKeyToColorMap = new Map<string, Float32Array>();

const tempMat4 = mat4.create();
const OVERLAY_SELECTED_FLOAT_ZERO = new Float32Array([0]);
const OVERLAY_SELECTED_FLOAT_ONE = new Float32Array([1]);
const DEFAULT_FRAGMENT_MAIN = `void main() {
  emitDefault();
}
`;

const SELECTED_NODE_OUTLINE_COLOR_RGB = "1.0, 0.95, 0.35";
const SELECTED_NODE_OUTLINE_MIN_WIDTH_2D = "1.75";
const SELECTED_NODE_OUTLINE_MAX_WIDTH_2D = "3.0";
const SELECTED_NODE_OUTLINE_MIN_WIDTH_3D = "1.5";
const SELECTED_NODE_OUTLINE_MAX_WIDTH_3D = "2.5";

interface VertexAttributeRenderInfo extends VertexAttributeInfo {
  name: string;
  webglDataType: number;
  glslDataType: string;
}

const vertexAttributeSamplerSymbols: symbol[] = [];

const vertexPositionTextureFormat = computeTextureFormat(
  new TextureFormat(),
  DataType.FLOAT32,
  3,
);

interface VisibleChunk {
  chunk: SpatiallyIndexedSkeletonChunk;
  chunkLayout: ChunkLayout;
}

interface SkeletonShaderParameters {
  dynamicSegmentAppearance: boolean;
  hasSegmentStatedColors: boolean;
  hasSegmentDefaultColor: boolean;
  hoverHighlight: boolean;
  spatialChunkCulling: boolean;
}

interface SkeletonShaderContext {
  vertexAttributes: VertexAttributeRenderInfo[];
  gl: GL;
  fallbackShaderParameters: WatchableValue<ShaderControlsBuilderState>;
  displayState: SkeletonLayerDisplayState;
  skeletonShaderParameters: WatchableValueInterface<SkeletonShaderParameters>;
  segmentColorAttributeIndex?: number;
}

interface SkeletonGPUGeometry {
  vertexAttributeTextures: (WebGLTexture | null)[];
  indexBuffer: GLBuffer;
  numIndices: number;
  numVertices: number;
  pickNodeIds?: Int32Array;
  pickNodePositions?: Float32Array;
  pickSegmentIds?: Uint32Array;
  pickEdgeSegmentIds?: Uint32Array;
}

interface PackedSkeletonGeometry {
  vertexAttributes: Uint8Array;
  indices: Uint32Array;
  numVertices: number;
  vertexAttributeOffsets: Uint32Array;
  nodeIds?: Int32Array;
  nodeSourceStates?: Array<SpatialSkeletonSourceState | undefined>;
}

type SpatiallyIndexedSkeletonPickData =
  | {
      kind: "node";
      nodeIds: Int32Array;
      nodePositions: Float32Array;
      segmentIds: Uint32Array;
    }
  | {
      kind: "edge";
      segmentIds: Uint32Array;
    }
  | {
      kind: "segment-node";
      chunk: SpatiallyIndexedSkeletonChunk;
    }
  | {
      kind: "segment-edge";
      chunk: SpatiallyIndexedSkeletonChunk;
    };

class RenderHelper extends RefCounted {
  private textureAccessHelper = new OneDimensionalTextureAccessHelper(
    "vertexData",
  );
  private vertexIdHelper;
  private segmentAttributeIndex: number | undefined;
  private segmentColorAttributeIndex: number | undefined;
  private selectedNodeAttributeIndex: number | undefined;
  private visibleSegmentsShaderManager = new HashSetShaderManager(
    "visibleSegments",
  );
  private excludedSegmentsShaderManager = new HashSetShaderManager(
    "excludedSegments",
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

  // TODO (SKM): segmentAttribute is UINT32 but segments can be UINT64.
  // Change segmentAttribute.dataType to DataType.UINT64, update vSegmentValue
  // from `highp uint` (flat) to `highp uvec2` (flat), update
  // getSegmentAppearanceId to take uvec2 directly, and getSegmentAppearance
  // signature accordingly. Also pull segmentAttribute and selectedNodeAttribute
  // out of vertexAttributes entirely (they are internal, not user-defined).
  private finalizeShaderBuilder(
    builder: ShaderBuilder,
    shaderBuilderState: ShaderControlsBuilderState,
    skeletonParams: SkeletonShaderParameters,
    vertexMain: string,
  ): void {
    builder.addFragmentCode(glsl_COLORMAPS);
    const { vertexAttributes } = this;
    const numAttributes = vertexAttributes.length;
    if (
      skeletonParams.dynamicSegmentAppearance &&
      this.segmentAttributeIndex !== undefined
    ) {
      const segInfo = vertexAttributes[this.segmentAttributeIndex];
      builder.addFragmentCode(dataTypeShaderDefinition[segInfo.dataType]);
      builder.addFragmentCode(
        `#define ${segInfo.name} ${segInfo.glslDataType}(vSegmentValue)\n`,
      );
      builder.addFragmentCode(
        `#define prop_${segInfo.name}() ${segInfo.glslDataType}(vSegmentValue)\n`,
      );
    }
    for (let i = 1; i < numAttributes; ++i) {
      if (
        i === this.segmentAttributeIndex ||
        i === this.selectedNodeAttributeIndex
      ) {
        continue;
      }
      const info = vertexAttributes[i];
      builder.addVarying(`highp ${info.glslDataType}`, `vCustom${i}`);
      vertexMain += `vCustom${i} = readAttribute${i}(vertexIndex);\n`;
      builder.addFragmentCode(`#define ${info.name} vCustom${i}\n`);
      builder.addFragmentCode(`#define prop_${info.name}() vCustom${i}\n`);
    }
    builder.setVertexMain(vertexMain);
    addControlsToBuilder(shaderBuilderState, builder);
    builder.addFragmentCode(`void userMain();\n`);
    builder.addFragmentCode(
      "#define main userMain\n" +
        shaderCodeWithLineDirective(shaderBuilderState.parseResult.code) +
        "\n#undef main\n",
    );
    builder.setFragmentMain(
      skeletonParams.spatialChunkCulling
        ? "spatialChunkCull();\nuserMain();"
        : "userMain();",
    );
  }

  private getSegmentColorExpression() {
    const index = this.segmentColorAttributeIndex;
    if (index === undefined) {
      return "uColor";
    }
    return `vCustom${index}`;
  }

  /**
   * Emit the vertex-stage assignment of the `uvec2 vSegmentValue` (the full
   * uint64 segment id) from the segment attribute.  A 1-component uint32
   * attribute (CATMAID) is zero-extended into the high half; a 2-component
   * (zarr-vectors `[lo, hi]`) attribute fills both halves.  Caller must have
   * verified `this.segmentAttributeIndex !== undefined`.
   */
  private segmentValueAssignment(vertexIndexExpr: string): string {
    const i = this.segmentAttributeIndex!;
    const read = `readAttribute${i}(${vertexIndexExpr})`;
    // A UINT64 attribute (zarr-vectors full uint64) reads as a `uint64_t`
    // whose `.value` is the uvec2; a uint32 attribute (CATMAID) reads as a
    // `uint32_t` → `toRaw(...)` gives a `uint`, zero-extended into the high
    // half.
    const rhs =
      this.vertexAttributes[i].dataType === DataType.UINT64
        ? `${read}.value`
        : `uvec2(toRaw(${read}), 0u)`;
    return `vSegmentValue = ${rhs};\n`;
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
    let colorExpression = `return ${this.segmentColorShaderManager.prefix}(segmentId);`;
    let alphaExpression = `return isVisible ? uVisibleAlpha : uHiddenAlpha;`;
    let excludedSegmentAlpha = "0.0";

    if (DEBUG_EXCLUDED_SEGMENTS) {
      colorExpression = `
        if (${this.excludedSegmentsShaderManager.hasFunctionName}(segmentId)) {
          return vec3(0.0, 0.0, 1.0);
        }
        ${colorExpression}
      `;
      if (!DEBUG_SPATIAL_SKELETON_OVERLAY) alphaExpression = `return 0.0;`;
      excludedSegmentAlpha = "1.0";
    }

    this.visibleSegmentsShaderManager.defineShader(builder);
    this.excludedSegmentsShaderManager.defineShader(builder);
    this.segmentColorShaderManager.defineShader(builder);
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
    // Full uint64 segment id as a uvec2 [lo, hi].  A 1-component uint32
    // segment attribute (CATMAID) is zero-extended into this at the vertex
    // stage; a 2-component (zarr-vectors) attribute fills both halves.
    builder.addVarying("highp uvec2", "vSegmentValue", "flat");

    const statedColorFragment = params.hasSegmentStatedColors
      ? `
  vec4 statedColor;
  if (${this.segmentStatedColorShaderManager.getFunctionName}(segmentId, statedColor)) {
    return statedColor.rgb;
  }`
      : "";

    const defaultColorFragment = params.hasSegmentDefaultColor
      ? "  return uSegmentDefaultColor;"
      : `  ${colorExpression}`;

    const hoverAdjustFragment = params.hoverHighlight
      ? `
  if (segmentId.value.x == uHoveredSegmentId.x &&
      segmentId.value.y == uHoveredSegmentId.y) {
    if (saturation > 0.5) { saturation -= 0.5; }
    else { saturation += 0.5; }
  }`
      : "";

    builder.addFragmentCode(`
uint64_t getSegmentAppearanceId(highp uvec2 segmentValue) {
  return uint64_t(segmentValue);
}
vec3 getSegmentBaseColor(uint64_t segmentId) {
${statedColorFragment}
${defaultColorFragment}
}
vec3 getSegmentLookupColor(uint64_t segmentId) {
  vec3 baseColor = getSegmentBaseColor(segmentId);
  float saturation = uSaturation;
${hoverAdjustFragment}
  return mix(vec3(1.0, 1.0, 1.0), baseColor, saturation);
}
float getSegmentLookupAlpha(uint64_t segmentId) {
  if (${this.excludedSegmentsShaderManager.hasFunctionName}(segmentId)) {
    return ${excludedSegmentAlpha};
  }
  bool isVisible = ${this.visibleSegmentsShaderManager.hasFunctionName}(segmentId);
  ${alphaExpression}
}
vec4 getSegmentAppearance(highp uvec2 segmentValue) {
  uint64_t segmentId = getSegmentAppearanceId(segmentValue);
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

    if (skeletonParams?.hasSegmentDefaultColor) {
      const segmentDefaultColor = colorGroupState.segmentDefaultColor.value;
      if (segmentDefaultColor !== undefined) {
        gl.uniform3fv(
          shader.uniform("uSegmentDefaultColor"),
          segmentDefaultColor,
        );
      }
      if (DEBUG_SPATIAL_SKELETON_OVERLAY && excludedGPUTable === undefined) {
        gl.uniform3f(shader.uniform("uSegmentDefaultColor"), 1.0, 0.0, 0.0);
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
    const { maxTextureImageUnits } = this.gl;
    if (this.vertexAttributes.length > maxTextureImageUnits) {
      console.warn(
        `Skeleton has ${this.vertexAttributes.length} vertex attributes but device only supports ${maxTextureImageUnits} shader texture units`,
      );
    }
    const segmentAttrIndex = this.vertexAttributes.findIndex(
      (x) => x.name === segmentAttribute.name,
    );
    this.segmentAttributeIndex =
      segmentAttrIndex >= 0 ? segmentAttrIndex : undefined;
    this.segmentColorAttributeIndex = base.segmentColorAttributeIndex;
    const selectedNodeAttrIndex = this.vertexAttributes.findIndex(
      (x) => x.name === selectedNodeAttribute.name,
    );
    this.selectedNodeAttributeIndex =
      selectedNodeAttrIndex >= 0 ? selectedNodeAttrIndex : undefined;

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
        defineShader: (
          builder: ShaderBuilder,
          shaderBuilderState: ShaderControlsBuilderState,
          skeletonParams: SkeletonShaderParameters,
        ) => {
          this.defineCommonShader(builder, shaderBuilderState, skeletonParams);
          defineLineShader(builder);
          builder.addAttribute("highp uvec2", "aVertexIndex");
          builder.addUniform("highp float", "uLineWidth");
          let vertexMain = `
highp uint pickOffset = uint(gl_InstanceID) * uPickInstanceStride;
vPickID = uPickID + pickOffset;
highp vec3 vertexA = readAttribute0(aVertexIndex.x);
highp vec3 vertexB = readAttribute0(aVertexIndex.y);
emitLine(uProjection, vertexA, vertexB, uLineWidth);
highp uint lineEndpointIndex = getLineEndpointIndex();
highp uint vertexIndex = aVertexIndex.x * (1u - lineEndpointIndex) + aVertexIndex.y * lineEndpointIndex;
`;
          if (skeletonParams.spatialChunkCulling) {
            vertexMain += `vCullPos = mix(vertexA, vertexB, float(lineEndpointIndex));\n`;
          }
          if (
            skeletonParams.dynamicSegmentAppearance &&
            this.segmentAttributeIndex !== undefined
          ) {
            vertexMain += this.segmentValueAssignment("aVertexIndex.x");
          }

          const segmentColorExpression = this.getSegmentColorExpression();
          const segmentAlphaExpression =
            this.segmentColorAttributeIndex === undefined
              ? "uColor.a"
              : `${segmentColorExpression}.a`;
          if (skeletonParams.dynamicSegmentAppearance) {
            // Dynamic path (spatial skeletons): per-segment color, visibility,
            // saturation and hover highlight all resolved in the shader via
            // getSegmentAppearance(). uColor is unused in this path.
            builder.addFragmentCode(`
vec4 segmentColor() {
  return getSegmentAppearance(vSegmentValue);
}
void emitRGB(vec3 color) {
  vec4 baseColor = segmentColor();
  highp float alpha = baseColor.a * getLineAlpha() * ${this.getCrossSectionFadeFactor()};
  if (alpha <= 0.0) discard;
  ${this.emitColorStatement("color", "alpha")}
}
void emitDefault() {
  vec4 baseColor = segmentColor();
  highp float alpha = baseColor.a * getLineAlpha() * ${this.getCrossSectionFadeFactor()};
  if (alpha <= 0.0) discard;
  ${this.emitColorStatement("baseColor.rgb", "alpha")}
}
`);
          } else if (this.segmentColorAttributeIndex === undefined) {
            // Legacy path (non-spatial skeletons): one skeleton drawn per call;
            // uColor is set per-skeleton by the CPU via getObjectColor(), which
            // already incorporates saturation and hover highlighting.
            builder.addFragmentCode(`
vec4 segmentColor() {
  return ${segmentColorExpression};
}
void emitRGB(vec3 color) {
  emit(vec4(color * uColor.a, uColor.a * getLineAlpha() * ${this.getCrossSectionFadeFactor()}), vPickID);
}
void emitDefault() {
  emit(vec4(uColor.rgb, uColor.a * getLineAlpha() * ${this.getCrossSectionFadeFactor()}), vPickID);
}
`);
          } else {
            // Per-vertex color attribute path: color comes from a per-vertex
            // attribute; alpha is taken from uColor.
            builder.addFragmentCode(`
vec4 segmentColor() {
  return ${segmentColorExpression};
}
void emitRGB(vec3 color) {
  highp float alpha = ${segmentAlphaExpression} * getLineAlpha() * ${this.getCrossSectionFadeFactor()};
  ${this.emitColorStatement("color", "alpha")}
}
void emitDefault() {
  vec4 baseColor = segmentColor();
  highp float alpha = baseColor.a * getLineAlpha() * ${this.getCrossSectionFadeFactor()};
  ${this.emitColorStatement("baseColor.rgb", "alpha")}
}
`);
          }
          this.finalizeShaderBuilder(
            builder,
            shaderBuilderState,
            skeletonParams,
            vertexMain,
          );
        },
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
        defineShader: (
          builder: ShaderBuilder,
          shaderBuilderState: ShaderControlsBuilderState,
          skeletonParams: SkeletonShaderParameters,
        ) => {
          this.defineCommonShader(builder, shaderBuilderState, skeletonParams);
          defineCircleShader(
            builder,
            /*crossSectionFade=*/ this.targetIsSliceView,
          );
          builder.addUniform("highp float", "uNodeDiameter");
          let selectedOutlineWidthExpression = "0.0";
          if (this.selectedNodeAttributeIndex !== undefined) {
            builder.addVarying("highp float", "vSelectedNode", "flat");
            const selectedOutlineMinWidth = this.targetIsSliceView
              ? SELECTED_NODE_OUTLINE_MIN_WIDTH_2D
              : SELECTED_NODE_OUTLINE_MIN_WIDTH_3D;
            const selectedOutlineMaxWidth = this.targetIsSliceView
              ? SELECTED_NODE_OUTLINE_MAX_WIDTH_2D
              : SELECTED_NODE_OUTLINE_MAX_WIDTH_3D;
            selectedOutlineWidthExpression = `((vSelectedNode > 0.5) ? clamp(0.25 * uNodeDiameter, ${selectedOutlineMinWidth}, ${selectedOutlineMaxWidth}) : 0.0)`;
          }
          let vertexMain = `
highp uint vertexIndex = uint(gl_InstanceID);
highp uint pickOffset = vertexIndex * uPickInstanceStride;
vPickID = uPickID + pickOffset;
highp vec3 vertexPosition = readAttribute0(vertexIndex);
`;
          if (skeletonParams.spatialChunkCulling) {
            vertexMain += `vCullPos = vertexPosition;\n`;
          }
          if (this.selectedNodeAttributeIndex !== undefined) {
            vertexMain += `vSelectedNode = readAttribute${this.selectedNodeAttributeIndex}(vertexIndex);\n`;
          }
          if (
            skeletonParams.dynamicSegmentAppearance &&
            this.segmentAttributeIndex !== undefined
          ) {
            vertexMain += this.segmentValueAssignment("vertexIndex");
          }
          vertexMain += `
emitCircle(
  uProjection * vec4(vertexPosition, 1.0),
  uNodeDiameter,
  ${selectedOutlineWidthExpression}
);
`;
          const segmentColorExpression = this.getSegmentColorExpression();
          if (
            skeletonParams.dynamicSegmentAppearance &&
            this.segmentAttributeIndex !== undefined
          ) {
            // Dynamic path (spatial skeletons): per-segment color, visibility,
            // saturation and hover highlight all resolved in the shader via
            // getSegmentAppearance(). uColor is unused in this path.
            const segmentExpression = `vSegmentValue`;
            const selectedNodeExpression =
              this.selectedNodeAttributeIndex === undefined
                ? undefined
                : "vSelectedNode";
            const borderColorExpression =
              selectedNodeExpression === undefined
                ? "renderColor"
                : `((${selectedNodeExpression} > 0.5) ? vec4(${SELECTED_NODE_OUTLINE_COLOR_RGB}, renderColor.a) : renderColor)`;
            builder.addFragmentCode(`
vec4 segmentColor() {
  return getSegmentAppearance(${segmentExpression});
}
void emitRGBA(vec4 color) {
  vec4 baseColor = segmentColor();
  highp float alpha = color.a * baseColor.a;
  if (alpha <= 0.0) discard;
  vec4 renderColor = vec4(color.rgb, alpha);
  vec4 borderColor = ${borderColorExpression};
  vec4 circleColor = getCircleColor(renderColor, borderColor);
  ${this.emitColorStatement("circleColor.rgb", "circleColor.a")}
}
void emitRGB(vec3 color) {
  emitRGBA(vec4(color, 1.0));
}
void emitDefault() {
  emitRGBA(vec4(segmentColor().rgb, 1.0));
}
`);
          } else if (this.segmentColorAttributeIndex === undefined) {
            // Legacy path (non-spatial skeletons): one skeleton drawn per call;
            // uColor is set per-skeleton by the CPU via getObjectColor(), which
            // already incorporates saturation and hover highlighting.
            builder.addFragmentCode(`
vec4 segmentColor() {
  return ${segmentColorExpression};
}
void emitRGBA(vec4 color) {
  vec4 borderColor = color;
  emit(getCircleColor(color, borderColor), vPickID);
}
void emitRGB(vec3 color) {
  emitRGBA(vec4(color, 1.0));
}
void emitDefault() {
  emitRGBA(uColor);
}
`);
          } else {
            // Per-vertex color attribute path: color comes from a per-vertex
            // attribute; alpha is taken from the attribute's alpha component.
            const selectedNodeExpression =
              this.selectedNodeAttributeIndex === undefined
                ? undefined
                : "vSelectedNode";
            const borderColorExpression =
              selectedNodeExpression === undefined
                ? "renderColor"
                : `((${selectedNodeExpression} > 0.5) ? vec4(${SELECTED_NODE_OUTLINE_COLOR_RGB}, renderColor.a) : renderColor)`;
            builder.addFragmentCode(`
vec4 segmentColor() {
  return ${segmentColorExpression};
}
void emitRGBA(vec4 color) {
  vec4 renderColor = color;
  vec4 borderColor = ${borderColorExpression};
  vec4 circleColor = getCircleColor(renderColor, borderColor);
  ${this.emitColorStatement("circleColor.rgb", "circleColor.a")}
}
void emitRGB(vec3 color) {
  emitRGBA(vec4(color, 1.0));
}
void emitDefault() {
  emitRGBA(segmentColor());
}
`);
          }
          this.finalizeShaderBuilder(
            builder,
            shaderBuilderState,
            skeletonParams,
            vertexMain,
          );
        },
      },
    );
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

  // GLSL statement emitting an (rgb, alpha) color with the alpha convention the
  // target expects: the 2D slice view blends with straight alpha
  // (`SRC_ALPHA, ONE_MINUS_SRC_ALPHA`), while the perspective OIT path requires
  // premultiplied color. Emitting premultiplied into the slice view's straight
  // blend would multiply rgb by alpha twice, darkening (rather than fading)
  // colors as the cross-section fade lowers alpha.
  private emitColorStatement(rgb: string, alpha: string): string {
    return this.targetIsSliceView
      ? `emit(vec4(${rgb}, ${alpha}), vPickID);`
      : `emit(vec4((${rgb}) * (${alpha}), ${alpha}), vPickID);`;
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
    this.vertexIdHelper.enable();
  }

  setColor(gl: GL, shader: ShaderProgram, color: vec4) {
    gl.uniform4fv(shader.uniform("uColor"), color);
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

  drawSkeletons(
    gl: GL,
    edgeShader: ShaderProgram,
    nodeShader: ShaderProgram | null,
    skeletonGpuGeometry: SkeletonGPUGeometry,
    projectionParameters: { width: number; height: number },
    renderMode: SkeletonRenderMode = SkeletonRenderMode.LINES_AND_POINTS,
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

    // Draw edges
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

    // Draw node dots only in "lines and points" mode — in "lines" mode
    // the user wants line segments only.
    if (nodeShader !== null && renderMode !== SkeletonRenderMode.LINES) {
      nodeShader.bind();
      initializeCircleShader(nodeShader, projectionParameters, {
        featherWidthInPixels: this.targetIsSliceView ? 1.0 : 0.0,
      });
      drawCircles(nodeShader.gl, 2, skeletonGpuGeometry.numVertices);
    }
  }

  endLayer(gl: GL, ...shaders: Array<ShaderProgram | null>) {
    const { vertexAttributes, clearedTextureUnits } = this;
    const numAttributes = vertexAttributes.length;
    clearedTextureUnits.clear();
    for (const shader of shaders) {
      if (shader === null) continue;
      for (let i = 0; i < numAttributes; ++i) {
        const curTextureUnit =
          shader.textureUnit(vertexAttributeSamplerSymbols[i]) +
          WebGL2RenderingContext.TEXTURE0;
        if (clearedTextureUnits.has(curTextureUnit)) continue;
        clearedTextureUnits.add(curTextureUnit);
        gl.activeTexture(curTextureUnit);
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
    }
    this.vertexIdHelper.disable();
  }
}

// Draws the spatial bounds of each chunk as a box overlay, for debugging.
// One shader is compiled per emitter so the emitter can inject the correct
// output-buffer declarations and `emit(color, pickID)` function.
class ChunkWireframeHelper extends RefCounted {
  private shaderCache = new Map<ShaderModule, ShaderProgram>();

  constructor(private gl: GL) {
    super();
  }

  disposed() {
    for (const shader of this.shaderCache.values()) {
      shader.dispose();
    }
    this.shaderCache.clear();
    super.disposed();
  }

  getShader(emitter: ShaderModule): ShaderProgram {
    let shader = this.shaderCache.get(emitter);
    if (shader === undefined) {
      const builder = new ShaderBuilder(this.gl);
      builder.require(emitter);
      builder.addUniform("highp mat4", "uChunkToClip");
      builder.addUniform("highp vec3", "uTranslation");
      builder.addUniform("highp vec3", "uChunkDataSize");
      builder.addVertexCode(glsl_getBoxEdgeVertexPosition);
      builder.setVertexMain(`
vec3 boxVertex = getBoxEdgeVertexPosition(gl_VertexID);
gl_Position = uChunkToClip * vec4(uTranslation + boxVertex * uChunkDataSize, 1.0);
`);
      builder.setFragmentMain(`emit(vec4(1.0, 1.0, 1.0, 1.0), 0u);`);
      shader = builder.build();
      this.shaderCache.set(emitter, shader);
    }
    return shader;
  }

  setChunkUniforms(
    gl: GL,
    shader: ShaderProgram,
    chunkLayout: ChunkLayout,
    chunkGridPosition: Float32Array,
  ) {
    const { size } = chunkLayout;
    gl.uniform3f(
      shader.uniform("uTranslation"),
      chunkGridPosition[0] * size[0],
      chunkGridPosition[1] * size[1],
      chunkGridPosition[2] * size[2],
    );
    gl.uniform3fv(shader.uniform("uChunkDataSize"), size);
  }

  static get(gl: GL) {
    return gl.memoize.get(
      "skeleton/ChunkWireframeHelper",
      () => new ChunkWireframeHelper(gl),
    );
  }
}

export enum SkeletonRenderMode {
  LINES = 0,
  LINES_AND_POINTS = 1,
}

export function setSpatialSkeletonModesToLinesAndPoints(layer: {
  displayState: { skeletonRenderingOptions: SkeletonRenderingOptions };
}) {
  layer.displayState.skeletonRenderingOptions.params2d.mode.value =
    SkeletonRenderMode.LINES_AND_POINTS;
  layer.displayState.skeletonRenderingOptions.params3d.mode.value =
    SkeletonRenderMode.LINES_AND_POINTS;
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

function getSkeletonNodeDiameter(
  renderMode: SkeletonRenderMode,
  lineWidth: number,
) {
  if (renderMode === SkeletonRenderMode.LINES_AND_POINTS) {
    return Math.max(5, lineWidth * 2);
  }
  return lineWidth;
}

function setMouseStatePositionFromSpatialSkeletonNode(
  mouseState: MouseSelectionState,
  nodePosition: Float32Array,
  transform: RenderLayerTransform,
) {
  const rank = transform.rank;
  const modelPosition = new Float32Array(rank);
  for (let i = 0; i < Math.min(nodePosition.length, rank); ++i) {
    const v = nodePosition[i];
    if (!Number.isFinite(v)) return;
    modelPosition[i] = v;
  }
  const layerPosition = new Float32Array(rank);
  matrix.transformPoint(
    layerPosition,
    transform.modelToRenderLayerTransform,
    rank + 1,
    modelPosition,
    rank,
  );
  gatherUpdate(
    mouseState.position,
    layerPosition,
    transform.globalToRenderLayerDimensions,
  );
}

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
  shaderError: WatchableShaderError;
  skeletonRenderingOptions: SkeletonRenderingOptions;
}

export class SkeletonLayer extends RefCounted implements SkeletonShaderContext {
  layerChunkProgressInfo = new LayerChunkProgressInfo();
  redrawNeeded = new NullarySignal();
  private sharedObject: SegmentationLayerSharedObject;
  vertexAttributes: VertexAttributeRenderInfo[];
  segmentColorAttributeIndex: number | undefined = undefined;
  // Non-spatial skeletons iterate segments individually and pass color/alpha via
  // uniforms (getObjectColor), so the dynamic per-vertex segment appearance path
  // is not needed. Stated colors and default color are likewise handled upstream
  // before the draw call, not looked up in the shader.
  readonly skeletonShaderParameters =
    new WatchableValue<SkeletonShaderParameters>({
      dynamicSegmentAppearance: false,
      hasSegmentStatedColors: false,
      hasSegmentDefaultColor: false,
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
        glslDataType: getShaderType(info.dataType, info.numComponents),
      });
    }
  }

  get gl() {
    return this.chunkManager.chunkQueueManager.gl;
  }

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
      edgeShaderParameters.parseResult.controls,
    );
    gl.uniform1f(edgeShader.uniform("uLineWidth"), lineWidth!);

    nodeShader.bind();
    renderHelper.beginLayer(gl, nodeShader, renderContext, modelMatrix);
    gl.uniform1f(nodeShader.uniform("uNodeDiameter"), pointDiameter);
    renderHelper.setPickInstanceStride(gl, nodeShader, 0);
    setControlsInShader(
      gl,
      nodeShader,
      shaderControlState,
      nodeShaderParameters.parseResult.controls,
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
        if (color !== undefined) {
          edgeShader.bind();
          renderHelper.setColor(gl, edgeShader, color);
          nodeShader.bind();
          renderHelper.setColor(gl, nodeShader, color);
        }
        if (pickIndex !== undefined) {
          edgeShader.bind();
          renderHelper.setPickID(gl, edgeShader, pickIndex);
          nodeShader.bind();
          renderHelper.setPickID(gl, nodeShader, pickIndex);
        }
        renderHelper.drawSkeletons(
          gl,
          edgeShader,
          nodeShader,
          skeleton,
          renderContext.projectionParameters,
          renderOptions.mode.value,
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
    case DataType.INT32:
      return WebGL2RenderingContext.INT;
    case DataType.UINT32:
      return WebGL2RenderingContext.UNSIGNED_INT;
    default:
      throw new Error(
        `Data type not supported by WebGL: ${DataType[dataType]}`,
      );
  }
}

const vertexPositionAttribute: VertexAttributeRenderInfo = {
  dataType: DataType.FLOAT32,
  numComponents: 3,
  name: "",
  webglDataType: WebGL2RenderingContext.FLOAT,
  glslDataType: "vec3",
};

const segmentAttribute: VertexAttributeRenderInfo = {
  dataType: DataType.UINT32,
  numComponents: 1,
  name: "segment",
  webglDataType: WebGL2RenderingContext.UNSIGNED_INT,
  glslDataType: getShaderType(DataType.UINT32, 1),
};

const selectedNodeAttribute: VertexAttributeRenderInfo = {
  dataType: DataType.FLOAT32,
  numComponents: 1,
  name: "selectedNodeAttr",
  webglDataType: WebGL2RenderingContext.FLOAT,
  glslDataType: "float",
};

interface SkeletonChunkBase extends SkeletonGPUGeometry {
  vertexAttributes: Uint8Array;
  vertexAttributeOffsets: Uint32Array;
  indices: Uint32Array;
  source: { attributeTextureFormats: TextureFormat[] };
}

// Used by both SkeletonChunk and SpatiallyIndexedSkeletonChunk.
function uploadSkeletonChunkToGPU(gl: GL, chunk: SkeletonChunkBase) {
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

function freeSkeletonChunkGPUMemory(gl: GL, chunk: SkeletonChunkBase) {
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

export class SpatiallyIndexedSkeletonChunk
  extends SliceViewChunk
  implements SkeletonChunkBase
{
  declare source: SpatiallyIndexedSkeletonSource;
  vertexAttributes: Uint8Array;
  indices: Uint32Array;
  indexBuffer!: GLBuffer;
  numIndices: number;
  numVertices: number;
  vertexAttributeOffsets: Uint32Array;
  vertexAttributeTextures: (WebGLTexture | null)[] = [];
  nodeIds: Int32Array;
  nodeSourceStates: Array<SpatialSkeletonSourceState | undefined> = [];

  constructor(
    source: SpatiallyIndexedSkeletonSource,
    chunkData: PackedSkeletonGeometry,
  ) {
    super(source, chunkData);
    this.vertexAttributes = chunkData.vertexAttributes;
    const indices = (this.indices = chunkData.indices);
    this.numVertices = chunkData.numVertices;
    this.numIndices = indices.length;
    this.vertexAttributeOffsets = chunkData.vertexAttributeOffsets;
    this.nodeIds = chunkData.nodeIds ?? new Int32Array(0);
    const nodeSourceStates = chunkData.nodeSourceStates;
    this.nodeSourceStates = Array.isArray(nodeSourceStates)
      ? nodeSourceStates
      : [];
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

export interface SpatiallyIndexedSkeletonChunkSpecification
  extends SliceViewChunkSpecification {
  chunkLayout: ChunkLayout;
}

type SpatiallyIndexedSkeletonChunkListener = (
  key: string,
  chunk: SpatiallyIndexedSkeletonChunk,
) => void;

const spatiallyIndexedSkeletonTextureAttributeSpecs = Object.freeze([
  { name: "position", dataType: DataType.FLOAT32, numComponents: 3 },
  { name: "segment", dataType: DataType.UINT32, numComponents: 1 },
]);

export class SpatiallyIndexedSkeletonSource extends SliceViewChunkSource<
  SpatiallyIndexedSkeletonChunkSpecification,
  SpatiallyIndexedSkeletonChunk
> {
  vertexAttributes: VertexAttributeRenderInfo[];
  private attributeTextureFormats_?: TextureFormat[];
  private chunkListeners = new Set<SpatiallyIndexedSkeletonChunkListener>();

  constructor(chunkManager: ChunkManager, options: any) {
    super(chunkManager, options);
    this.vertexAttributes = [vertexPositionAttribute, segmentAttribute];
  }

  get attributeTextureFormats() {
    let attributeTextureFormats = this.attributeTextureFormats_;
    if (attributeTextureFormats === undefined) {
      attributeTextureFormats = this.attributeTextureFormats_ =
        spatiallyIndexedSkeletonTextureAttributeSpecs.map(
          ({ dataType, numComponents }) =>
            computeTextureFormat(new TextureFormat(), dataType, numComponents),
        );
    }
    return attributeTextureFormats;
  }

  static encodeSpec(spec: SpatiallyIndexedSkeletonChunkSpecification) {
    const base = SliceViewChunkSource.encodeSpec(spec);
    return { ...base, chunkLayout: spec.chunkLayout.toObject() };
  }

  addChunkListener(listener: SpatiallyIndexedSkeletonChunkListener) {
    this.chunkListeners.add(listener);
    return () => this.chunkListeners.delete(listener);
  }

  addChunk(key: string, chunk: SpatiallyIndexedSkeletonChunk) {
    super.addChunk(key, chunk);
    for (const listener of this.chunkListeners) {
      listener(key, chunk);
    }
  }

  getChunk(chunkData: PackedSkeletonGeometry) {
    return new SpatiallyIndexedSkeletonChunk(this, chunkData);
  }
}

// Options are provided by the SliceView framework for scale selection,
// but spatial skeleton sources expose all grid levels unconditionally.
// TODO (SKM): validate if this is an ok deviation from the SliceView
export const SPATIAL_SKELETON_SOURCE_OPTIONS: SliceViewSourceOptions = {
  displayRank: 0,
  multiscaleToViewTransform: new Float32Array(0),
  modelChannelDimensionIndices: [],
};

export function getSpatialSkeletonCellKeyPrefix(
  position: ArrayLike<number>,
  chunkDataSize: ArrayLike<number>,
) {
  const cell = new Array<number>(3);
  for (let i = 0; i < 3; ++i) {
    const coordinate = Number(position[i]);
    const chunkSize = Number(chunkDataSize[i]);
    if (
      !Number.isFinite(coordinate) ||
      !Number.isFinite(chunkSize) ||
      chunkSize <= 0
    ) {
      return undefined;
    }
    cell[i] = Math.floor(coordinate / chunkSize);
  }
  return `${cell[0]},${cell[1]},${cell[2]}:`;
}

export abstract class MultiscaleSpatiallyIndexedSkeletonSource extends MultiscaleSliceViewChunkSource<SpatiallyIndexedSkeletonSource> {
  /**
   * When `true`, the segmentation layer enables
   * `autoSpatialSkeletonGridLevel{3d,2d}` on attach: the render layer
   * will overwrite `spatialSkeletonGridResolutionTarget*` every frame
   * from the camera projection.  Default `false` preserves the
   * existing manual-slider UX for sources that haven't opted in
   * (CATMAID).  Subclasses (e.g. zarr-vectors) override to `true`.
   */
  get prefersAutoSpatialSkeletonGridLevel(): boolean {
    return false;
  }

  getPerspectiveSources(): SliceViewSingleResolutionSource<SpatiallyIndexedSkeletonSource>[] {
    const sources = this.getSources(SPATIAL_SKELETON_SOURCE_OPTIONS);
    const flattened: SliceViewSingleResolutionSource<SpatiallyIndexedSkeletonSource>[] =
      [];
    for (const scale of sources) {
      if (scale.length > 0) {
        flattened.push(scale[0]);
      }
    }
    return flattened;
  }

  getSliceViewPanelSources(): SliceViewSingleResolutionSource<SpatiallyIndexedSkeletonSource>[] {
    return this.getPerspectiveSources();
  }

  getSpatialSkeletonGridSizes():
    | { x: number; y: number; z: number }[]
    | undefined {
    return undefined;
  }
}

type SpatiallyIndexedSkeletonSourceEntry =
  SliceViewSingleResolutionSource<SpatiallyIndexedSkeletonSource>;

// TODO (SKM): is all of this really optional?
interface SpatiallyIndexedSkeletonLayerOptions {
  gridLevel?: WatchableValueInterface<number>;
  lod?: WatchableValueInterface<number>;
  gridLevel2d?: WatchableValueInterface<number>;
  lod2d?: WatchableValueInterface<number>;
  sources2d?: SpatiallyIndexedSkeletonSourceEntry[];
  selectedNodeId?: WatchableValueInterface<number | undefined>;
  pendingNodePositionVersion?: WatchableValueInterface<number>;
  getPendingNodePosition?: (nodeId: number) => ArrayLike<number> | undefined;
  getCachedNode?: (nodeId: number) => SpatiallyIndexedSkeletonNode | undefined;
  inspectionState?: SpatiallyIndexedSkeletonInspectionState;
  maxRetainedOverlaySegments?: number;
}

interface SpatiallyIndexedSkeletonInspectionState {
  readonly nodeDataVersion: WatchableValueInterface<number>;
  readonly pendingNodePositionVersion: WatchableValueInterface<number>;
  getCachedSegmentNodes(
    segmentId: number,
  ): readonly SpatiallyIndexedSkeletonNode[] | undefined;
  getFullSegmentNodes(
    skeletonLayer: SpatiallyIndexedSkeletonLayer,
    segmentId: number,
  ): Promise<readonly SpatiallyIndexedSkeletonNode[]>;
  evictInactiveSegmentNodes(activeSegmentIds: Iterable<number>): void;
}

class SkeletonOverlayChunk implements SkeletonGPUGeometry {
  readonly vertexAttributeTextures: (WebGLTexture | null)[];
  readonly indexBuffer: GLBuffer;
  readonly numIndices: number;
  readonly numVertices: number;
  readonly pickNodeIds: Int32Array;
  readonly pickNodePositions: Float32Array;
  readonly pickSegmentIds: Uint32Array;
  readonly pickEdgeSegmentIds: Uint32Array;
  private readonly nodeIdToVertexIndex: Map<number, number>;
  private readonly selectedFormat: TextureFormat;

  constructor(
    gl: GL,
    geometry: SpatiallyIndexedSkeletonOverlayGeometry,
    formats: TextureFormat[],
  ) {
    const attributeBuffers = [
      new Uint8Array(
        geometry.positions.buffer,
        geometry.positions.byteOffset,
        geometry.positions.byteLength,
      ),
      new Uint8Array(
        geometry.segmentIds.buffer,
        geometry.segmentIds.byteOffset,
        geometry.segmentIds.byteLength,
      ),
      new Uint8Array(
        geometry.selected.buffer,
        geometry.selected.byteOffset,
        geometry.selected.byteLength,
      ),
    ];
    const overlayTextures: (WebGLTexture | null)[] =
      (this.vertexAttributeTextures = []);
    for (let i = 0; i < attributeBuffers.length; i++) {
      const texture = gl.createTexture();
      gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, texture);
      setOneDimensionalTextureData(gl, formats[i], attributeBuffers[i]);
      overlayTextures[i] = texture;
    }
    gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, null);
    this.indexBuffer = GLBuffer.fromData(
      gl,
      geometry.indices,
      WebGL2RenderingContext.ARRAY_BUFFER,
      WebGL2RenderingContext.STATIC_DRAW,
    );
    this.numIndices = geometry.indices.length;
    this.numVertices = geometry.numVertices;
    this.pickNodeIds = geometry.nodeIds;
    // positions and nodePositions were identical — reuse positions for picking.
    this.pickNodePositions = geometry.positions;
    this.pickSegmentIds = geometry.pickSegmentIds;
    this.pickEdgeSegmentIds = geometry.pickEdgeSegmentIds;
    const nodeIdToVertexIndex = new Map<number, number>();
    const { nodeIds } = geometry;
    for (let i = 0; i < nodeIds.length; i++) {
      const nodeId = nodeIds[i];
      if (nodeId > 0) nodeIdToVertexIndex.set(nodeId, i);
    }
    this.nodeIdToVertexIndex = nodeIdToVertexIndex;
    this.selectedFormat = formats[2];
  }

  // Updates the selected-node highlight in-place without a full GPU rebuild.
  // Clears oldNodeId's texel and sets newNodeId's texel.
  updateSelectedNode(
    gl: GL,
    oldNodeId: number | undefined,
    newNodeId: number | undefined,
  ) {
    if (oldNodeId === newNodeId) return;
    const texture = this.vertexAttributeTextures[2];
    if (texture === null) return;
    if (oldNodeId !== undefined) {
      const idx = this.nodeIdToVertexIndex.get(oldNodeId);
      if (idx !== undefined) {
        updateOneDimensionalTextureElement(
          gl,
          texture,
          this.selectedFormat,
          this.numVertices,
          idx,
          OVERLAY_SELECTED_FLOAT_ZERO,
        );
      }
    }
    if (newNodeId !== undefined) {
      const idx = this.nodeIdToVertexIndex.get(newNodeId);
      if (idx !== undefined) {
        updateOneDimensionalTextureElement(
          gl,
          texture,
          this.selectedFormat,
          this.numVertices,
          idx,
          OVERLAY_SELECTED_FLOAT_ONE,
        );
      }
    }
  }

  dispose(gl: GL) {
    for (const texture of this.vertexAttributeTextures) {
      if (texture) gl.deleteTexture(texture);
    }
    this.indexBuffer.dispose();
  }
}

function getSpatialSkeletonGridSpacing(
  transformedSource: TransformedSource,
  levels:
    | Array<{ size: { x: number; y: number; z: number }; lod: number }>
    | undefined,
  gridIndex: number,
) {
  const levelSize = levels?.[gridIndex]?.size;
  if (levelSize !== undefined) {
    return Math.max(Math.min(levelSize.x, levelSize.y, levelSize.z), 1e-6);
  }
  const chunkSize = transformedSource.chunkLayout.size;
  return Math.max(Math.min(chunkSize[0], chunkSize[1], chunkSize[2]), 1e-6);
}

/**
 * World units per screen pixel at `worldPoint`, derived from a
 * model-view-projection matrix and viewport dimensions.  Same
 * formulation the multiscale-mesh renderer uses to pick per-fragment
 * LOD ({@link getDesiredMultiscaleMeshChunks} in
 * `src/mesh/multiscale.ts:154-202`): take the maximum of x-, y-, and
 * z-axis screen-space scale factors, divide the point's w-component
 * by that scaleFactor to get world-units-per-screen-pixel.
 *
 * Returns `+Infinity` for a behind-camera or invalid `w` so callers
 * fall back to the largest available level.
 */
function computeWorldUnitsPerScreenPixel(
  modelViewProjection: mat4,
  viewportWidth: number,
  viewportHeight: number,
  worldPoint: Float32Array,
): number {
  const m = modelViewProjection;
  // Column-major mat4 indices.
  const m00 = m[0], m10 = m[1];
  const m01 = m[4], m11 = m[5];
  const m02 = m[8], m12 = m[9];
  const m30 = m[3], m31 = m[7], m32 = m[11], m33 = m[15];
  const w = m30 * worldPoint[0] + m31 * worldPoint[1] + m32 * worldPoint[2] + m33;
  if (!Number.isFinite(w) || w <= 0) return Number.POSITIVE_INFINITY;
  const xScale = Math.sqrt(
    (m00 * viewportWidth) ** 2 + (m10 * viewportHeight) ** 2,
  );
  const yScale = Math.sqrt(
    (m01 * viewportWidth) ** 2 + (m11 * viewportHeight) ** 2,
  );
  const zScale = Math.sqrt(
    (m02 * viewportWidth) ** 2 + (m12 * viewportHeight) ** 2,
  );
  const scaleFactor = Math.max(xScale, yScale, zScale);
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return w / scaleFactor;
}

/**
 * Multiplier from "world units per screen pixel" to the resolution
 * target the level picker matches against `levels[k].size`.  The picker
 * finds the level whose spacing is closest to the target, so target
 * needs to live in the same magnitude as a level spacing (typical
 * neuroscience streamline chunk = 50–500 µm/mm, while raw world-units-
 * per-pixel is a couple of orders of magnitude smaller for a normal
 * zoom).  200 means "a chunk should be ~200 screen pixels at the
 * matching level" — finest level when chunks are bigger than that on
 * screen, coarser otherwise.  Mirrors the mesh layer's `detailCutoff`
 * tunable in [src/mesh/multiscale.ts:202](src/mesh/multiscale.ts#L202).
 */
const AUTO_SPATIAL_SKELETON_GRID_DETAIL_CUTOFF = 200;

/**
 * If `displayState.autoSpatialSkeletonGridLevel{view}` is enabled,
 * compute the camera-derived "world units per screen pixel" at a
 * representative world position, multiply by the detail-cutoff
 * constant, and write the result to
 * `spatialSkeletonGridResolutionTarget{view}`.  Because
 * `findClosestSpatialSkeletonGridLevelBySpacing` re-runs on every
 * change of that target, the picker (and the histogram widget) snap
 * to the appropriate discrete level for the current zoom.
 *
 * No-op when:
 * - The flag is absent or false (default; CATMAID/legacy behaviour).
 * - The target watchable isn't wired up.
 * - The computed target isn't finite.
 *
 * Reference point: prefer `projectionParameters.globalPosition` (the
 * camera's look-at point in global space).  Fall back to
 * `localPosition` (per-layer position, usually empty for segmentation
 * layers without layer-local dimensions) and finally to the origin.
 * In orthographic projection `w` is independent of position, so the
 * choice only matters for perspective views; either way the helper
 * returns a meaningful value for any of these fallbacks.
 */
function maybeUpdateAutoSpatialSkeletonGridResolutionTarget(
  displayState: SpatiallyIndexedSkeletonLayerDisplayState,
  projectionParameters: {
    viewProjectionMat: mat4;
    width: number;
    height: number;
    globalPosition?: Float32Array;
    displayDimensionRenderInfo?: { displayDimensionScales: Float64Array };
  },
  localPosition: Float32Array,
  view: "2d" | "3d",
): void {
  const autoFlag =
    view === "3d"
      ? displayState.autoSpatialSkeletonGridLevel3d
      : displayState.autoSpatialSkeletonGridLevel2d;
  if (autoFlag === undefined || autoFlag.value !== true) return;
  const target =
    view === "3d"
      ? displayState.spatialSkeletonGridResolutionTarget3d
      : displayState.spatialSkeletonGridResolutionTarget2d;
  if (target === undefined) return;
  // Pick the first non-empty reference position.  GlobalPosition is
  // populated for all 3D-view renders even when the segmentation
  // layer has no layer-local dimensions (the common case, where
  // `localPosition` is a zero-length array).
  let reference: Float32Array | undefined;
  if (
    projectionParameters.globalPosition !== undefined &&
    projectionParameters.globalPosition.length >= 3
  ) {
    reference = projectionParameters.globalPosition;
  } else if (localPosition.length >= 3) {
    reference = localPosition;
  } else {
    reference = new Float32Array(3); // origin fallback
  }
  const pixelSize = computeWorldUnitsPerScreenPixel(
    projectionParameters.viewProjectionMat,
    projectionParameters.width,
    projectionParameters.height,
    reference,
  );
  if (!Number.isFinite(pixelSize) || pixelSize <= 0) return;
  // `pixelSize` is in global coordinate units; grid spacings are reported
  // in physical meters, so convert to meters/pixel via the display
  // dimension scales (meters per global unit).  Use the finest axis to
  // match the `min()` convention used for grid spacing.
  let metersPerUnit = 1;
  const ddScales = projectionParameters.displayDimensionRenderInfo?.displayDimensionScales;
  if (ddScales !== undefined && ddScales.length > 0) {
    metersPerUnit = Infinity;
    for (let i = 0; i < ddScales.length; ++i) {
      const s = ddScales[i];
      if (Number.isFinite(s) && s > 0) metersPerUnit = Math.min(metersPerUnit, s);
    }
    if (!Number.isFinite(metersPerUnit)) metersPerUnit = 1;
  }
  // Camera-only target (no user bias yet).
  const autoUnbiased =
    pixelSize * metersPerUnit * AUTO_SPATIAL_SKELETON_GRID_DETAIL_CUTOFF;

  // The multiplicative detail `bias` (set when the user clicks/drags the
  // widget) lives in the *persistent* displayState so the calibration
  // survives a page refresh; the `lastAuto` value we wrote last frame is
  // transient and stays in a WeakMap keyed by the target.  A manual
  // interaction changes `target.value` away from `lastAuto`; we interpret
  // that as "make this zoom map to the level I picked" and fold it into
  // `bias`, so zoom keeps driving the level afterwards (the click rebiases
  // the offset, it does NOT freeze the target).
  const biasWatchable =
    view === "3d"
      ? displayState.spatialSkeletonGridResolutionBias3d
      : displayState.spatialSkeletonGridResolutionBias2d;
  let st = autoSpatialSkeletonBias.get(target);
  if (st === undefined) {
    st = { lastAuto: undefined };
    autoSpatialSkeletonBias.set(target, st);
  }
  let bias =
    biasWatchable !== undefined && Number.isFinite(biasWatchable.value) && biasWatchable.value > 0
      ? biasWatchable.value
      : 1;
  const cur = target.value as number;
  if (
    st.lastAuto !== undefined &&
    Math.abs(cur - st.lastAuto) > Math.max(st.lastAuto, 1e-30) * 1e-6 &&
    autoUnbiased > 0 &&
    Number.isFinite(cur) &&
    cur > 0
  ) {
    bias = cur / autoUnbiased;
    if (biasWatchable !== undefined && biasWatchable.value !== bias) {
      biasWatchable.value = bias;
    }
  }
  const next = autoUnbiased * bias;
  // Only write when the value changes by more than 0.1% — the setter
  // dispatches `changed` unconditionally (level pick → re-attach chain).
  if (
    st.lastAuto !== undefined &&
    Math.abs(cur - next) < Math.max(cur, next) * 1e-3
  ) {
    st.lastAuto = next;
    return;
  }
  target.value = next;
  st.lastAuto = next;
}

// Transient per-resolution-target auto-LOD state: the last auto-written
// target value, used to detect manual widget interaction frame-to-frame.
// The persistent detail `bias` lives in displayState (see
// `spatialSkeletonGridResolutionBias{2d,3d}`), not here.  Keyed weakly by
// the target.
const autoSpatialSkeletonBias = new WeakMap<
  WatchableValueInterface<number>,
  { lastAuto: number | undefined }
>();

// Tracks chunk keys already counted for a given histogram within a single frame,
// preventing the same chunk from being counted multiple times when it falls within
// the visible frustum of more than one slice panel in the same frame.
const seenChunkKeysPerFrame = new WeakMap<
  RenderScaleHistogram,
  { frameNumber: number; keys: Set<string> }
>();

function updateSpatialSkeletonGridRenderScaleHistogram(
  histogram: RenderScaleHistogram,
  frameNumber: number,
  transformedSources: readonly TransformedSource[][],
  projectionParameters: any,
  localPosition: Float32Array,
  lod: number | undefined,
  levels:
    | Array<{ size: { x: number; y: number; z: number }; lod: number }>
    | undefined,
) {
  histogram.begin(frameNumber);
  if (lod === undefined || transformedSources.length === 0) {
    return;
  }
  const lodSuffix = `:${lod}`;
  const scales = transformedSources[0] ?? [];
  if (scales.length === 0) {
    return;
  }
  let seen = seenChunkKeysPerFrame.get(histogram);
  if (seen === undefined || seen.frameNumber !== frameNumber) {
    seen = { frameNumber, keys: new Set() };
    seenChunkKeysPerFrame.set(histogram, seen);
  }
  const seenKeys = seen.keys;
  for (const tsource of scales) {
    const gridIndex = getSpatiallyIndexedSkeletonGridIndex(tsource.source);
    if (gridIndex === undefined) {
      continue;
    }
    const source = tsource.source as SpatiallyIndexedSkeletonSource;
    let presentCount = 0;
    let missingCount = 0;
    forEachVisibleVolumetricChunk(
      projectionParameters,
      localPosition,
      tsource,
      (positionInChunks) => {
        const chunkKey = `${positionInChunks.join()}${lodSuffix}`;
        const seenKey = `${gridIndex}:${chunkKey}`;
        if (seenKeys.has(seenKey)) return;
        seenKeys.add(seenKey);
        const chunk = source.chunks.get(chunkKey);
        if (chunk?.state === ChunkState.GPU_MEMORY) {
          presentCount++;
        } else {
          missingCount++;
        }
      },
    );
    const spacing = getSpatialSkeletonGridSpacing(tsource, levels, gridIndex);
    const total = presentCount + missingCount;
    if (total > 0) {
      histogram.add(spacing, spacing, presentCount, missingCount);
    } else if (!histogram.spatialScales.has(spacing)) {
      // Keep the row visible in the histogram when no chunks are in view,
      // but only if no earlier panel already populated it this frame.
      histogram.add(spacing, spacing, 0, 1, true);
    }
  }
}

export interface SpatiallyIndexedSkeletonLayerDisplayState
  extends SkeletonLayerDisplayState {
  spatialSkeletonGridLevel2d?: WatchableValueInterface<number>;
  spatialSkeletonGridLevel3d?: WatchableValueInterface<number>;
  skeletonLod?: WatchableValueInterface<number>;
  spatialSkeletonLod2d?: WatchableValueInterface<number>;
  spatialSkeletonGridLevels?: WatchableValueInterface<
    Array<{ size: { x: number; y: number; z: number }; lod: number }>
  >;
  spatialSkeletonGridRenderScaleHistogram2d?: RenderScaleHistogram;
  spatialSkeletonGridRenderScaleHistogram3d?: RenderScaleHistogram;
  /**
   * Optional writable target that the picker is matched against;
   * paired with the `auto*` flags below.  When auto is enabled the
   * render layer overwrites this every frame from the camera
   * projection.
   */
  spatialSkeletonGridResolutionTarget2d?: WatchableValueInterface<number> & {
    value: number;
  };
  spatialSkeletonGridResolutionTarget3d?: WatchableValueInterface<number> & {
    value: number;
  };
  /**
   * Persistent multiplicative detail bias applied on top of the
   * camera-derived auto target (1 = pure camera).  Clicking/dragging the
   * render-scale widget folds the manual offset into this value so the
   * calibration survives a page refresh (the camera-derived target itself
   * is recomputed every frame and is not meaningful to persist).  Paired
   * with the `auto*` flags below.
   */
  spatialSkeletonGridResolutionBias2d?: WatchableValueInterface<number> & {
    value: number;
  };
  spatialSkeletonGridResolutionBias3d?: WatchableValueInterface<number> & {
    value: number;
  };
  /**
   * When `true` the render layer auto-derives `spatialSkeletonGridResolutionTarget*`
   * from the current camera projection at the layer's `localPosition`
   * (world units per screen pixel).  Default off; opt in to get
   * camera-driven LOD switching for spatially-indexed skeletons.
   */
  autoSpatialSkeletonGridLevel2d?: WatchableValueInterface<boolean>;
  autoSpatialSkeletonGridLevel3d?: WatchableValueInterface<boolean>;
}

/**
 * Resolve a picked node/edge offset to its owning segment as a full uint64
 * `bigint`.  `segmentIds` is the interleaved per-vertex segment column with
 * `segmentComponents` uint32 per vertex (2 = `[lo, hi]` full uint64; 1 = a
 * uint32 id with implicit high half 0).  Returns `undefined` for an absent /
 * zero id.
 */
export function resolveSpatiallyIndexedSkeletonSegmentPick(
  chunk: { indices: Uint32Array; numVertices: number },
  segmentIds: Uint32Array,
  pickedOffset: number,
  kind: "node" | "edge",
  segmentComponents = 1,
): bigint | undefined {
  const readId = (vertex: number): bigint | undefined => {
    const base = vertex * segmentComponents;
    if (vertex < 0 || base + segmentComponents > segmentIds.length) {
      return undefined;
    }
    const lo = BigInt(segmentIds[base] >>> 0);
    const hi = segmentComponents >= 2 ? BigInt(segmentIds[base + 1] >>> 0) : 0n;
    const id = lo | (hi << 32n);
    return id > 0n ? id : undefined;
  };
  if (pickedOffset < 0) return undefined;
  if (kind === "node") {
    if (pickedOffset >= chunk.numVertices) return undefined;
    return readId(pickedOffset);
  }
  const indexOffset = pickedOffset * 2;
  if (indexOffset + 1 >= chunk.indices.length) {
    return undefined;
  }
  return (
    readId(chunk.indices[indexOffset]) ?? readId(chunk.indices[indexOffset + 1])
  );
}

export class SpatiallyIndexedSkeletonLayer
  extends RefCounted
  implements SkeletonShaderContext
{
  layerChunkProgressInfo = new LayerChunkProgressInfo();
  redrawNeeded = new NullarySignal();
  vertexAttributes: VertexAttributeRenderInfo[];
  segmentColorAttributeIndex: number | undefined;
  selectedNodeAttributeIndex: number | undefined;
  readonly browsePassLayerView: SkeletonShaderContext;
  readonly skeletonShaderParameters: WatchableValue<SkeletonShaderParameters>;
  readonly browsePassSkeletonShaderParameters: WatchableValueInterface<SkeletonShaderParameters>;
  fallbackShaderParameters = new WatchableValue(
    getFallbackBuilderState(parseShaderUiControls(DEFAULT_FRAGMENT_MAIN)),
  );
  backend: ChunkRenderLayerFrontend;
  localPosition: WatchableValueInterface<Float32Array>;
  readonly chunkTransform: WatchableValueInterface<
    ValueOrError<ChunkTransformParameters>
  >;
  rpc: RPC | undefined;

  private overlayAttributeTextureFormats_?: TextureFormat[];
  private get overlayAttributeTextureFormats(): TextureFormat[] {
    return (this.overlayAttributeTextureFormats_ ??= this.vertexAttributes.map(
      ({ dataType, numComponents }) =>
        computeTextureFormat(new TextureFormat(), dataType, numComponents),
    ));
  }
  gridLevel: WatchableValueInterface<number>;
  lod: WatchableValueInterface<number>;
  gridLevel2d: WatchableValueInterface<number>;
  lod2d: WatchableValueInterface<number>;
  private selectedNodeId:
    | WatchableValueInterface<number | undefined>
    | undefined;
  private pendingNodePositionVersion:
    | WatchableValueInterface<number>
    | undefined;
  private getPendingNodePositionOverride:
    | ((nodeId: number) => ArrayLike<number> | undefined)
    | undefined;
  private getCachedNodeInfo:
    | ((nodeId: number) => SpatiallyIndexedSkeletonNode | undefined)
    | undefined;
  private inspectionState: SpatiallyIndexedSkeletonInspectionState | undefined;
  private overlayChunk: SkeletonOverlayChunk | undefined;
  private overlayChunkKey: string | undefined;
  private overlayGeometryKey: string | undefined;
  private cachedSelectedNodeId: number | undefined;
  private overlayRebuildFrame = -1;
  private pendingOverlaySegmentLoads = new Set<number>();
  private browseExcludedSegments = new Uint64Set();
  private gpuBrowseExcludedSegmentsHashTable: GPUHashTable<HashSetUint64>;
  private browseExcludedSegmentsKey: string | undefined;
  private suppressedBrowseSegmentIds = new Set<number>();
  private retainedOverlaySegmentIds: number[] = [];
  private maxRetainedOverlaySegments: number;

  private disposeOverlayChunk() {
    this.overlayChunk?.dispose(this.gl);
    this.overlayChunk = undefined;
    this.overlayChunkKey = undefined;
    this.overlayGeometryKey = undefined;
    this.cachedSelectedNodeId = undefined;
  }

  private requestOverlaySegmentLoad(segmentId: number) {
    if (
      this.inspectionState === undefined ||
      this.pendingOverlaySegmentLoads.has(segmentId)
    ) {
      return;
    }
    this.pendingOverlaySegmentLoads.add(segmentId);
    void this.inspectionState
      .getFullSegmentNodes(this, segmentId)
      .catch(() => {})
      .finally(() => {
        this.pendingOverlaySegmentLoads.delete(segmentId);
        this.disposeOverlayChunk();
        this.redrawNeeded.dispatch();
      });
  }

  private getOverlayGeometryKey(segmentIds: readonly number[]) {
    return [
      segmentIds.join(","),
      `pending:${this.pendingNodePositionVersion?.value ?? ""}`,
      `data:${this.inspectionState?.nodeDataVersion.value ?? ""}`,
    ].join("|");
  }

  private getActiveEditableSegmentIds() {
    const segments = getVisibleSegments(
      this.displayState.segmentationGroupState.value,
    );
    const segmentIds: number[] = [];
    for (const segmentId of segments.keys()) {
      const normalizedSegmentId = Number(segmentId);
      if (
        !Number.isSafeInteger(normalizedSegmentId) ||
        normalizedSegmentId <= 0
      ) {
        continue;
      }
      segmentIds.push(normalizedSegmentId);
    }
    segmentIds.sort((a, b) => a - b);
    return segmentIds;
  }

  getRetainedOverlaySegmentIds() {
    return this.retainedOverlaySegmentIds;
  }

  retainOverlaySegment(segmentId: number) {
    const nextRetainedOverlaySegmentIds =
      retainSpatiallyIndexedSkeletonOverlaySegment(
        this.retainedOverlaySegmentIds,
        segmentId,
        { maxRetained: this.maxRetainedOverlaySegments },
      );
    if (
      nextRetainedOverlaySegmentIds.length ===
        this.retainedOverlaySegmentIds.length &&
      nextRetainedOverlaySegmentIds.every(
        (candidateSegmentId, index) =>
          candidateSegmentId === this.retainedOverlaySegmentIds[index],
      )
    ) {
      return false;
    }
    this.retainedOverlaySegmentIds = nextRetainedOverlaySegmentIds;
    this.redrawNeeded.dispatch();
    return true;
  }

  suppressBrowseSegment(segmentId: number) {
    const normalizedSegmentId = Math.round(Number(segmentId));
    if (
      !Number.isSafeInteger(normalizedSegmentId) ||
      normalizedSegmentId <= 0 ||
      this.suppressedBrowseSegmentIds.has(normalizedSegmentId)
    ) {
      return false;
    }
    this.suppressedBrowseSegmentIds.add(normalizedSegmentId);
    this.redrawNeeded.dispatch();
    return true;
  }

  private getOverlayRenderSegmentIds() {
    return mergeSpatiallyIndexedSkeletonOverlaySegmentIds(
      this.getActiveEditableSegmentIds(),
      this.retainedOverlaySegmentIds,
    );
  }

  private getLoadedOverlaySegmentIds(
    segmentIds: readonly number[] = this.getOverlayRenderSegmentIds(),
  ) {
    if (this.inspectionState === undefined) {
      return [];
    }
    return segmentIds.filter(
      (segmentId) =>
        this.inspectionState?.getCachedSegmentNodes(segmentId) !== undefined,
    );
  }

  private getNormalizedBrowsePassExcludedSegmentIds() {
    const segmentIds = new Set<number>();
    for (const segmentId of this.getLoadedOverlaySegmentIds()) {
      const normalizedSegmentId = Math.round(Number(segmentId));
      if (
        !Number.isSafeInteger(normalizedSegmentId) ||
        normalizedSegmentId <= 0
      ) {
        continue;
      }
      segmentIds.add(normalizedSegmentId);
    }
    for (const segmentId of this.suppressedBrowseSegmentIds) {
      const normalizedSegmentId = Math.round(Number(segmentId));
      if (
        !Number.isSafeInteger(normalizedSegmentId) ||
        normalizedSegmentId <= 0
      ) {
        continue;
      }
      segmentIds.add(normalizedSegmentId);
    }
    return [...segmentIds].sort((a, b) => a - b);
  }

  private getBrowsePassExcludedSegments() {
    const segmentIds = this.getNormalizedBrowsePassExcludedSegmentIds();
    if (segmentIds.length === 0) {
      if (this.browseExcludedSegments.size !== 0) {
        this.browseExcludedSegments.clear();
      }
      this.browseExcludedSegmentsKey = undefined;
      return undefined;
    }
    const excludedSegmentsKey = segmentIds.join(",");
    if (this.browseExcludedSegmentsKey !== excludedSegmentsKey) {
      this.browseExcludedSegments.clear();
      this.browseExcludedSegments.add(
        segmentIds
          .filter(
            (segmentId) => Number.isSafeInteger(segmentId) && segmentId > 0,
          )
          .map((segmentId) => BigInt(segmentId)),
      );
      this.browseExcludedSegmentsKey = excludedSegmentsKey;
    }
    return this.browseExcludedSegments;
  }

  private resolveSourceBackedOverlayChunk(): SkeletonOverlayChunk | undefined {
    const frameNumber =
      this.chunkManager.chunkQueueManager.frameNumberCounter.frameNumber;
    // Cache result for the entire frame — both slice and perspective draw calls
    // share the same chunk, and "no overlay" is also cached to avoid per-frame
    // allocation when the inspection overlay is inactive.
    if (this.overlayRebuildFrame === frameNumber) {
      return this.overlayChunk;
    }
    this.overlayRebuildFrame = frameNumber;
    if (this.inspectionState === undefined) {
      this.disposeOverlayChunk();
      return undefined;
    }
    const overlaySegmentIds = this.getOverlayRenderSegmentIds();
    if (overlaySegmentIds.length === 0) {
      this.disposeOverlayChunk();
      return undefined;
    }
    this.inspectionState.evictInactiveSegmentNodes(overlaySegmentIds);

    // Pass 1: cheap scan to determine which segments are loaded and check cache.
    const loadedSegmentIds: number[] = [];
    for (const segmentId of overlaySegmentIds) {
      if (this.inspectionState.getCachedSegmentNodes(segmentId) !== undefined) {
        loadedSegmentIds.push(segmentId);
      } else {
        this.requestOverlaySegmentLoad(segmentId);
      }
    }
    if (loadedSegmentIds.length === 0) {
      this.disposeOverlayChunk();
      return undefined;
    }

    const overlayGeometryKey = this.getOverlayGeometryKey(loadedSegmentIds);
    const selectedNodeId = this.selectedNodeId?.value;
    const overlayChunkKey = `${overlayGeometryKey}|selected:${selectedNodeId ?? ""}`;

    if (this.overlayChunk !== undefined) {
      if (this.overlayGeometryKey === overlayGeometryKey) {
        // Geometry unchanged — update only the selected-node highlight in-place
        // rather than reallocating all GPU textures.
        if (this.overlayChunkKey !== overlayChunkKey) {
          this.overlayChunk.updateSelectedNode(
            this.gl,
            this.cachedSelectedNodeId,
            selectedNodeId,
          );
          this.overlayChunkKey = overlayChunkKey;
          this.cachedSelectedNodeId = selectedNodeId;
        }
        return this.overlayChunk;
      }
    }

    // Pass 2: geometry cache miss — collect node sets and rebuild.
    const segmentNodeSets: (readonly SpatiallyIndexedSkeletonNode[])[] = [];
    for (const segmentId of loadedSegmentIds) {
      const segmentNodes =
        this.inspectionState.getCachedSegmentNodes(segmentId);
      if (segmentNodes !== undefined) {
        segmentNodeSets.push(segmentNodes);
      }
    }
    this.disposeOverlayChunk();
    const geometry = buildSpatiallyIndexedSkeletonOverlayGeometry(
      segmentNodeSets,
      {
        selectedNodeId,
        getPendingNodePosition: this.getPendingNodePositionOverride,
      },
    );
    this.overlayChunk = new SkeletonOverlayChunk(
      this.gl,
      geometry,
      this.overlayAttributeTextureFormats,
    );
    this.overlayChunkKey = overlayChunkKey;
    this.overlayGeometryKey = overlayGeometryKey;
    this.cachedSelectedNodeId = selectedNodeId;
    return this.overlayChunk;
  }

  sources: SpatiallyIndexedSkeletonSourceEntry[];
  sources2d: SpatiallyIndexedSkeletonSourceEntry[];
  source: SpatiallyIndexedSkeletonSource;

  constructor(
    public chunkManager: ChunkManager,
    sources:
      | SpatiallyIndexedSkeletonSourceEntry[]
      | SpatiallyIndexedSkeletonSource,
    public displayState: SpatiallyIndexedSkeletonLayerDisplayState & {
      localPosition: WatchableValueInterface<Float32Array>;
    },
    options: SpatiallyIndexedSkeletonLayerOptions = {},
  ) {
    super();
    this.registerDisposer(() => {
      this.disposeOverlayChunk();
    });
    let sources3d: SpatiallyIndexedSkeletonSourceEntry[];
    let sources2d = options.sources2d ?? [];
    if (Array.isArray(sources)) {
      sources3d = sources;
    } else {
      sources3d = [
        {
          chunkSource: sources,
          chunkToMultiscaleTransform: mat4.create(),
        },
      ];
    }
    if (sources3d.length === 0 && sources2d.length > 0) {
      sources3d = sources2d;
    }
    if (sources2d.length === 0) {
      sources2d = sources3d;
    }
    if (sources3d.length === 0) {
      throw new Error(
        "SpatiallyIndexedSkeletonLayer requires at least one source.",
      );
    }
    this.sources = sources3d;
    this.sources2d = sources2d;
    this.source = sources3d[0].chunkSource;
    this.localPosition = displayState.localPosition;
    this.chunkTransform = this.registerDisposer(
      makeCachedLazyDerivedWatchableValue(
        (modelTransform) =>
          makeValueOrError(() =>
            getChunkTransformParameters(valueOrThrow(modelTransform)),
          ),
        this.displayState.transform,
      ),
    );
    this.gridLevel =
      options.gridLevel ??
      displayState.spatialSkeletonGridLevel3d ??
      new WatchableValue(0);
    this.lod = options.lod ?? displayState.skeletonLod ?? new WatchableValue(0);
    this.gridLevel2d =
      options.gridLevel2d ??
      displayState.spatialSkeletonGridLevel2d ??
      this.gridLevel;
    this.lod2d = options.lod2d ?? displayState.spatialSkeletonLod2d ?? this.lod;
    this.selectedNodeId = options.selectedNodeId;
    this.pendingNodePositionVersion = options.pendingNodePositionVersion;
    this.getPendingNodePositionOverride = options.getPendingNodePosition;
    this.getCachedNodeInfo = options.getCachedNode;
    this.inspectionState = options.inspectionState;
    this.maxRetainedOverlaySegments = Math.max(
      1,
      Math.round(
        options.maxRetainedOverlaySegments ??
          DEFAULT_MAX_RETAINED_OVERLAY_SEGMENTS,
      ),
    );
    registerRedrawWhenSegmentationDisplayState3DChanged(displayState, this);
    this.displayState.shaderError.value = undefined;
    const { skeletonRenderingOptions: renderingOptions } = displayState;
    this.registerDisposer(
      renderingOptions.shader.changed.add(() => {
        this.displayState.shaderError.value = undefined;
        this.redrawNeeded.dispatch();
      }),
    );

    this.vertexAttributes = [
      ...this.source.vertexAttributes,
      selectedNodeAttribute,
    ];
    this.skeletonShaderParameters =
      new WatchableValue<SkeletonShaderParameters>({
        dynamicSegmentAppearance: true,
        hasSegmentStatedColors: false,
        hasSegmentDefaultColor: false,
        hoverHighlight: false,
        spatialChunkCulling: false,
      });
    const updateSkeletonShaderParameters = () => {
      const colorGroupState =
        this.displayState.segmentationColorGroupState.value;
      this.skeletonShaderParameters.value = {
        dynamicSegmentAppearance: true,
        hasSegmentStatedColors: colorGroupState.segmentStatedColors.size !== 0,
        hasSegmentDefaultColor:
          colorGroupState.segmentDefaultColor.value !== undefined ||
          DEBUG_SPATIAL_SKELETON_CHUNKS,
        hoverHighlight: this.displayState.hoverHighlight.value,
        spatialChunkCulling: false,
      };
    };
    this.registerDisposer(
      registerNested((context, colorGroupState) => {
        context.registerDisposer(
          colorGroupState.segmentStatedColors.changed.add(
            updateSkeletonShaderParameters,
          ),
        );
        context.registerDisposer(
          colorGroupState.segmentDefaultColor.changed.add(
            updateSkeletonShaderParameters,
          ),
        );
        updateSkeletonShaderParameters();
      }, this.displayState.segmentationColorGroupState),
    );
    this.registerDisposer(
      this.displayState.hoverHighlight.changed.add(
        updateSkeletonShaderParameters,
      ),
    );
    this.browsePassSkeletonShaderParameters = this.registerDisposer(
      makeCachedLazyDerivedWatchableValue(
        (params) => ({ ...params, spatialChunkCulling: true }),
        this.skeletonShaderParameters,
      ),
    );

    // Browse pass uses uniform-based dynamic segment color (not per-vertex attribute),
    // so segmentColorAttributeIndex is intentionally undefined here.
    this.browsePassLayerView = {
      vertexAttributes: this.source.vertexAttributes,
      segmentColorAttributeIndex: undefined,
      gl: this.gl,
      fallbackShaderParameters: this.fallbackShaderParameters,
      displayState: this.displayState,
      skeletonShaderParameters: this.browsePassSkeletonShaderParameters,
    };
    const selectedNodeIndex = this.vertexAttributes.findIndex(
      (x) => x.name === selectedNodeAttribute.name,
    );
    this.selectedNodeAttributeIndex =
      selectedNodeIndex >= 0 ? selectedNodeIndex : undefined;
    const requestRedraw = () => this.redrawNeeded.dispatch();
    const selectedNodeWatchable = this.selectedNodeId;
    if (selectedNodeWatchable?.changed) {
      this.registerDisposer(selectedNodeWatchable.changed.add(requestRedraw));
    }
    const pendingNodePositionVersion = options.pendingNodePositionVersion;
    if (pendingNodePositionVersion?.changed) {
      this.registerDisposer(
        pendingNodePositionVersion.changed.add(requestRedraw),
      );
    }
    const inspectionState = this.inspectionState;
    if (inspectionState !== undefined) {
      this.registerDisposer(
        inspectionState.nodeDataVersion.changed.add(() => {
          this.redrawNeeded.dispatch();
        }),
      );
    }
    // Create backend for perspective view chunk management
    const sharedObject = this.registerDisposer(
      new ChunkRenderLayerFrontend(this.layerChunkProgressInfo),
    );
    const rpc = chunkManager.rpc!;
    this.rpc = rpc;
    sharedObject.RPC_TYPE_ID = SPATIALLY_INDEXED_SKELETON_RENDER_LAYER_RPC_ID;

    const renderScaleTargetWatchable = this.registerDisposer(
      SharedWatchableValue.makeFromExisting(
        rpc,
        displayState.renderScaleTarget,
      ),
    );

    const skeletonLodWatchable = this.registerDisposer(
      SharedWatchableValue.makeFromExisting(rpc, this.lod),
    );

    const skeletonGridLevelWatchable = this.registerDisposer(
      SharedWatchableValue.makeFromExisting(rpc, this.gridLevel),
    );

    const skeletonLod2dWatchable = this.registerDisposer(
      SharedWatchableValue.makeFromExisting(rpc, this.lod2d),
    );

    const skeletonGridLevel2dWatchable = this.registerDisposer(
      SharedWatchableValue.makeFromExisting(rpc, this.gridLevel2d),
    );

    sharedObject.initializeCounterpart(rpc, {
      chunkManager: chunkManager.rpcId,
      localPosition: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(rpc, this.localPosition),
      ).rpcId,
      renderScaleTarget: renderScaleTargetWatchable.rpcId,
      skeletonLod: skeletonLodWatchable.rpcId,
      skeletonGridLevel: skeletonGridLevelWatchable.rpcId,
      skeletonLod2d: skeletonLod2dWatchable.rpcId,
      skeletonGridLevel2d: skeletonGridLevel2dWatchable.rpcId,
    });
    this.backend = sharedObject;
    this.gpuBrowseExcludedSegmentsHashTable = this.registerDisposer(
      GPUHashTable.get(this.gl, this.browseExcludedSegments.hashTable),
    );
  }

  get gl() {
    return this.chunkManager.chunkQueueManager.gl;
  }

  getSources(view: SpatiallyIndexedSkeletonView) {
    return view === "2d" ? this.sources2d : this.sources;
  }

  private selectSourcesForViewAndGrid(
    view: SpatiallyIndexedSkeletonView,
    gridLevel: number | undefined,
  ) {
    return selectSpatiallyIndexedSkeletonEntriesForView(
      this.getSources(view),
      view,
      gridLevel,
      getSpatiallyIndexedSkeletonSourceView,
      getSpatiallyIndexedSkeletonGridIndex,
    );
  }

  private getCachedNodeSnapshot(nodeId: number) {
    const cachedNode = this.getCachedNodeInfo?.(nodeId);
    if (cachedNode === undefined) {
      return undefined;
    }
    const pendingPosition =
      this.getPendingNodePositionOverride?.(cachedNode.nodeId) ??
      cachedNode.position;
    return {
      ...cachedNode,
      position: new Float32Array([
        Number(pendingPosition[0]),
        Number(pendingPosition[1]),
        Number(pendingPosition[2]),
      ]),
    };
  }

  invalidateSourceCellsForPositions(
    positions: Iterable<ArrayLike<number> | undefined>,
  ) {
    const positionList = [...positions].filter(
      (position): position is ArrayLike<number> => position !== undefined,
    );
    if (positionList.length === 0) {
      return false;
    }
    let invalidated = false;
    const seenSourceIds = new Set<string>();
    for (const sourceEntry of [...this.sources, ...this.sources2d]) {
      const chunkSource = sourceEntry.chunkSource;
      const sourceId = getObjectId(chunkSource);
      if (seenSourceIds.has(sourceId)) continue;
      seenSourceIds.add(sourceId);
      const keyPrefixes = new Set<string>();
      const { chunkDataSize } = chunkSource.spec;
      for (const position of positionList) {
        // Spatial skeleton node positions are already source/model coordinates;
        // render-layer transforms do not apply to CATMAID grid-cell keys.
        const keyPrefix = getSpatialSkeletonCellKeyPrefix(
          position,
          chunkDataSize,
        );
        if (keyPrefix !== undefined) {
          keyPrefixes.add(keyPrefix);
        }
      }
      if (keyPrefixes.size === 0) {
        continue;
      }
      chunkSource.invalidateCacheKeyPrefixes(keyPrefixes);
      invalidated = true;
    }
    if (!invalidated) {
      return false;
    }
    this.redrawNeeded.dispatch();
    return true;
  }

  private getChunkPositionAndSegmentArrays(
    chunk: SpatiallyIndexedSkeletonChunk,
  ) {
    const offsets = chunk.vertexAttributeOffsets;
    if (!offsets || offsets.length < 1) return undefined;
    const positions = new Float32Array(
      chunk.vertexAttributes.buffer,
      chunk.vertexAttributes.byteOffset + offsets[0],
      chunk.numVertices * 3,
    );
    // Locate the "segment" column by its actual attribute index — the
    // zarr-vectors layout is [position, tangent, …, segment], so segment is
    // NOT necessarily offsets[1].  Count the uint32 it occupies per vertex:
    // a UINT64 attribute (zarr-vectors full uint64) is 2 uint32 [lo, hi]
    // despite numComponents===1; a UINT32 attribute (CATMAID) is 1 (high
    // half implicitly 0).
    const segIdx = this.vertexAttributes.findIndex((a) => a.name === "segment");
    if (segIdx < 0 || segIdx >= offsets.length) return undefined;
    const segInfo = this.vertexAttributes[segIdx];
    const segmentComponents =
      segInfo.dataType === DataType.UINT64
        ? 2 * segInfo.numComponents
        : segInfo.numComponents;
    const segmentIds = new Uint32Array(
      chunk.vertexAttributes.buffer,
      chunk.vertexAttributes.byteOffset + offsets[segIdx],
      chunk.numVertices * segmentComponents,
    );
    return { positions, segmentIds, segmentComponents };
  }

  resolveSegmentPickFromChunk(
    chunk: SpatiallyIndexedSkeletonChunk,
    pickedOffset: number,
    kind: "node" | "edge",
  ) {
    const data = this.getChunkPositionAndSegmentArrays(chunk);
    if (data === undefined) {
      return undefined;
    }
    return resolveSpatiallyIndexedSkeletonSegmentPick(
      chunk,
      data.segmentIds,
      pickedOffset,
      kind,
      data.segmentComponents,
    );
  }

  resolveNodePickFromChunk(
    chunk: SpatiallyIndexedSkeletonChunk,
    pickedOffset: number,
  ) {
    const data = this.getChunkPositionAndSegmentArrays(chunk);
    if (
      data === undefined ||
      pickedOffset < 0 ||
      pickedOffset >= chunk.numVertices ||
      pickedOffset >= chunk.nodeIds.length
    ) {
      return undefined;
    }
    const nodeId = chunk.nodeIds[pickedOffset];
    if (!Number.isSafeInteger(nodeId) || nodeId <= 0) {
      return undefined;
    }
    const segmentId = resolveSpatiallyIndexedSkeletonSegmentPick(
      chunk,
      data.segmentIds,
      pickedOffset,
      "node",
      data.segmentComponents,
    );
    if (segmentId === undefined) {
      return undefined;
    }
    const baseOffset = pickedOffset * 3;
    return {
      nodeId,
      segmentId,
      position: data.positions.subarray(baseOffset, baseOffset + 3),
      sourceState: chunk.nodeSourceStates[pickedOffset],
    };
  }

  // Iterates every chunk slot in view for the given view/gridLevel/lod.
  // Callback receives (chunkKey, chunkSource, chunkLayout); return false to stop early.
  private forEachVisibleChunkSlot(
    view: SpatiallyIndexedSkeletonView,
    gridLevel: number | undefined,
    transformedSources: readonly TransformedSource[][],
    projectionParameters: ProjectionParameters,
    lod: number,
    callback: (
      chunkKey: string,
      chunkSource: SpatiallyIndexedSkeletonSource,
      chunkLayout: ChunkLayout,
    ) => boolean | void,
  ) {
    const selectedSourceIds = new Set(
      this.selectSourcesForViewAndGrid(view, gridLevel).map((s) =>
        getObjectId(s.chunkSource),
      ),
    );
    const lodSuffix = `:${lod}`;
    let shouldContinue = true;
    for (const scales of transformedSources) {
      for (const tsource of scales) {
        if (!shouldContinue) return;
        if (!selectedSourceIds.has(getObjectId(tsource.source))) continue;
        forEachVisibleVolumetricChunk(
          projectionParameters,
          this.localPosition.value,
          tsource,
          (positionInChunks) => {
            if (!shouldContinue) return;
            const chunkKey = `${positionInChunks.join()}${lodSuffix}`;
            if (
              callback(
                chunkKey,
                tsource.source as SpatiallyIndexedSkeletonSource,
                tsource.chunkLayout,
              ) === false
            ) {
              shouldContinue = false;
            }
          },
        );
      }
    }
  }

  getVisibleChunksInCurrentViewAndLod(
    view: SpatiallyIndexedSkeletonView,
    gridLevel: number | undefined,
    transformedSources: readonly TransformedSource[][],
    projectionParameters: any,
    lod: number | undefined,
  ): VisibleChunk[] {
    if (lod === undefined) {
      return [];
    }
    const result: VisibleChunk[] = [];
    this.forEachVisibleChunkSlot(
      view,
      gridLevel,
      transformedSources,
      projectionParameters,
      lod,
      (chunkKey, chunkSource, chunkLayout) => {
        const chunk = chunkSource.chunks.get(chunkKey);
        if (chunk?.state === ChunkState.GPU_MEMORY) {
          result.push({ chunk, chunkLayout });
        }
      },
    );
    return result;
  }

  private areVisibleChunksReady(
    view: SpatiallyIndexedSkeletonView,
    gridLevel: number | undefined,
    transformedSources: readonly TransformedSource[][],
    projectionParameters: ProjectionParameters,
    lod: number | undefined,
  ) {
    if (
      this.displayState.objectAlpha.value <= 0.0 &&
      this.displayState.hiddenObjectAlpha.value <= 0.0
    ) {
      return true;
    }
    if (lod === undefined) {
      // No LOD configured — draw() renders nothing in this case, so nothing to wait for.
      return true;
    }
    if (transformedSources.length === 0) {
      return false;
    }
    let ready = true;
    this.forEachVisibleChunkSlot(
      view,
      gridLevel,
      transformedSources,
      projectionParameters,
      lod,
      (chunkKey, chunkSource, _) => {
        const chunk = chunkSource.chunks.get(chunkKey);
        if (chunk?.state !== ChunkState.GPU_MEMORY) {
          ready = false;
          return false;
        }
        return true;
      },
    );
    return ready;
  }

  getNode(
    nodeId: number,
    options: {
      lod?: number;
    } = {},
  ): SpatiallyIndexedSkeletonNode | undefined {
    void options.lod;
    if (!Number.isSafeInteger(nodeId) || nodeId <= 0) return undefined;
    return this.getCachedNodeSnapshot(nodeId);
  }

  getNodes(
    options: {
      segmentId?: bigint;
      lod?: number;
    } = {},
  ): SpatiallyIndexedSkeletonNode[] {
    void options.lod;
    const normalizedSegmentFilter =
      options.segmentId === undefined
        ? undefined
        : Math.round(Number(options.segmentId));
    const useSegmentFilter =
      normalizedSegmentFilter !== undefined &&
      Number.isFinite(normalizedSegmentFilter);
    const segmentIds =
      normalizedSegmentFilter === undefined
        ? this.getActiveEditableSegmentIds()
        : [normalizedSegmentFilter];
    const nodes = new Map<number, SpatiallyIndexedSkeletonNode>();
    for (const segmentId of segmentIds) {
      const segmentNodes =
        this.inspectionState?.getCachedSegmentNodes(segmentId) ?? [];
      for (const node of segmentNodes) {
        if (nodes.has(node.nodeId)) continue;
        const cachedNode = this.getCachedNodeSnapshot(node.nodeId);
        if (cachedNode === undefined) continue;
        if (
          useSegmentFilter &&
          normalizedSegmentFilter !== undefined &&
          cachedNode.segmentId !== normalizedSegmentFilter
        ) {
          continue;
        }
        nodes.set(cachedNode.nodeId, cachedNode);
      }
    }
    return [...nodes.values()].sort((a, b) => a.nodeId - b.nodeId);
  }

  private beginSkeletonRenderPass(
    renderContext: SliceViewPanelRenderContext | PerspectiveViewRenderContext,
    renderHelper: RenderHelper,
    modelMatrix: mat4,
    lineWidth: number,
    pointDiameter: number,
    excludedGPUTable?: GPUHashTable<HashSetUint64>,
  ):
    | {
        gl: GL;
        edgeShader: ShaderProgram;
        nodeShader: ShaderProgram;
        skeletonParams: SkeletonShaderParameters;
      }
    | undefined {
    const { gl } = this;
    const edgeShaderResult = renderHelper.edgeShaderGetter(
      renderContext.emitter,
    );
    const nodeShaderResult = renderHelper.nodeShaderGetter(
      renderContext.emitter,
    );
    const {
      shader: edgeShader,
      parameters: edgeShaderParameters,
      extraParameters: skeletonParams,
    } = edgeShaderResult;
    const { shader: nodeShader, parameters: nodeShaderParameters } =
      nodeShaderResult;
    if (edgeShader === null || nodeShader === null) return undefined;

    const { shaderControlState } = this.displayState.skeletonRenderingOptions;

    edgeShader.bind();
    renderHelper.beginLayer(gl, edgeShader, renderContext, modelMatrix);
    gl.uniform1f(edgeShader.uniform("uLineWidth"), lineWidth);
    renderHelper.setPickInstanceStride(gl, edgeShader, 0);
    setControlsInShader(
      gl,
      edgeShader,
      shaderControlState,
      edgeShaderParameters.parseResult.controls,
    );
    renderHelper.setColor(gl, edgeShader, kOneVec4);
    renderHelper.maybeEnableDynamicSegmentAppearance(
      gl,
      edgeShader,
      skeletonParams,
      excludedGPUTable,
    );

    nodeShader.bind();
    renderHelper.beginLayer(gl, nodeShader, renderContext, modelMatrix);
    gl.uniform1f(nodeShader.uniform("uNodeDiameter"), pointDiameter);
    renderHelper.setPickInstanceStride(gl, nodeShader, 0);
    setControlsInShader(
      gl,
      nodeShader,
      shaderControlState,
      nodeShaderParameters.parseResult.controls,
    );
    renderHelper.setColor(gl, nodeShader, kOneVec4);
    renderHelper.maybeEnableDynamicSegmentAppearance(
      gl,
      nodeShader,
      skeletonParams,
      excludedGPUTable,
    );

    return { gl, edgeShader, nodeShader, skeletonParams };
  }

  private endSkeletonRenderPass(
    renderHelper: RenderHelper,
    gl: GL,
    edgeShader: ShaderProgram,
    nodeShader: ShaderProgram,
    skeletonParams: SkeletonShaderParameters,
  ) {
    renderHelper.maybeDisableDynamicSegmentAppearance(
      gl,
      edgeShader,
      skeletonParams,
    );
    renderHelper.maybeDisableDynamicSegmentAppearance(
      gl,
      nodeShader,
      skeletonParams,
    );
    renderHelper.endLayer(gl, edgeShader, nodeShader);
  }

  private drawBrowsePass(
    renderContext: SliceViewPanelRenderContext | PerspectiveViewRenderContext,
    layer: RenderLayer,
    renderHelper: RenderHelper,
    modelMatrix: mat4,
    lineWidth: number,
    pointDiameter: number,
    visibleChunks: VisibleChunk[],
    renderMode: SkeletonRenderMode = SkeletonRenderMode.LINES_AND_POINTS,
  ) {
    if (visibleChunks.length === 0) return;
    const hasExcludedSegments =
      this.getBrowsePassExcludedSegments() !== undefined;
    const passState = this.beginSkeletonRenderPass(
      renderContext,
      renderHelper,
      modelMatrix,
      lineWidth,
      pointDiameter,
      hasExcludedSegments ? this.gpuBrowseExcludedSegmentsHashTable : undefined,
    );
    if (passState === undefined) return;
    const { gl, edgeShader, nodeShader, skeletonParams } = passState;

    const chunkOrigin = vec3.create();
    const chunkBound = vec3.create();
    for (const { chunk, chunkLayout } of visibleChunks) {
      if (skeletonParams.spatialChunkCulling) {
        vec3.mul(chunkOrigin, chunk.chunkGridPosition, chunkLayout.size);
        vec3.add(chunkBound, chunkOrigin, chunkLayout.size);
        edgeShader.bind();
        renderHelper.setChunkBounds(gl, edgeShader, chunkOrigin, chunkBound);
        nodeShader.bind();
        renderHelper.setChunkBounds(gl, nodeShader, chunkOrigin, chunkBound);
      }
      if (renderContext.emitPickID) {
        let edgePickId = 0;
        let edgePickStride = 0;
        let nodePickId = 0;
        let nodePickStride = 0;
        if (chunk.numIndices > 0) {
          edgePickId = renderContext.pickIDs.register(
            layer,
            chunk.numIndices / 2,
            0n,
            {
              kind: "segment-edge",
              chunk,
            } satisfies SpatiallyIndexedSkeletonPickData,
          );
          edgePickStride = 1;
        }
        if (chunk.numVertices > 0) {
          nodePickId = renderContext.pickIDs.register(
            layer,
            chunk.numVertices,
            0n,
            {
              kind: "segment-node",
              chunk,
            } satisfies SpatiallyIndexedSkeletonPickData,
          );
          nodePickStride = 1;
        }
        edgeShader.bind();
        renderHelper.setPickID(gl, edgeShader, edgePickId);
        renderHelper.setPickInstanceStride(gl, edgeShader, edgePickStride);
        nodeShader.bind();
        renderHelper.setPickID(gl, nodeShader, nodePickId);
        renderHelper.setPickInstanceStride(gl, nodeShader, nodePickStride);
      }
      // Render each chunk with different node/edge colors for debugging
      if (DEBUG_SPATIAL_SKELETON_CHUNKS) {
        const chunkKey = `${chunk.chunkGridPosition[0]},${chunk.chunkGridPosition[1]},${chunk.chunkGridPosition[2]}`;
        let randomColor = tempChunkKeyToColorMap.get(chunkKey);
        if (randomColor === undefined) {
          // Use same strategy as segment color hashing to be consistent
          // in colors across neuroglancer sessions
          randomColor = new Float32Array([0, 0, 0]);
          let h = hashCombine(0, chunk.chunkGridPosition[0]);
          h = hashCombine(h, chunk.chunkGridPosition[1]);
          h = hashCombine(h, chunk.chunkGridPosition[2]);
          const c0 = (h & 0xff) / 255;
          const c1 = ((h >> 8) & 0xff) / 255;
          hsvToRgb(randomColor, c0, 0.5 + 0.5 * c1, 1.0);
          tempChunkKeyToColorMap.set(chunkKey, randomColor);
        }
        if (skeletonParams.hasSegmentDefaultColor) {
          nodeShader.bind();
          gl.uniform3fv(
            nodeShader.uniform("uSegmentDefaultColor"),
            randomColor,
          );
          edgeShader.bind();
          gl.uniform3fv(
            edgeShader.uniform("uSegmentDefaultColor"),
            randomColor,
          );
        }
      }
      renderHelper.drawSkeletons(
        gl,
        edgeShader,
        nodeShader,
        chunk,
        renderContext.projectionParameters,
        renderMode,
      );
    }
    this.endSkeletonRenderPass(
      renderHelper,
      gl,
      edgeShader,
      nodeShader,
      skeletonParams,
    );
  }

  private drawInspectionOverlayPass(
    renderContext: SliceViewPanelRenderContext | PerspectiveViewRenderContext,
    layer: RenderLayer,
    renderHelper: RenderHelper,
    modelMatrix: mat4,
    lineWidth: number,
    pointDiameter: number,
    renderMode: SkeletonRenderMode = SkeletonRenderMode.LINES_AND_POINTS,
  ) {
    const overlayChunk = this.resolveSourceBackedOverlayChunk();
    if (overlayChunk === undefined) return;
    const passState = this.beginSkeletonRenderPass(
      renderContext,
      renderHelper,
      modelMatrix,
      lineWidth,
      pointDiameter,
    );
    if (passState === undefined) return;
    const { gl, edgeShader, nodeShader, skeletonParams } = passState;

    if (renderContext.emitPickID) {
      const edgePickId =
        overlayChunk.numIndices > 0 &&
        overlayChunk.pickEdgeSegmentIds !== undefined &&
        overlayChunk.pickEdgeSegmentIds.length > 0
          ? renderContext.pickIDs.register(
              layer,
              overlayChunk.pickEdgeSegmentIds.length,
              0n,
              {
                kind: "edge",
                segmentIds: overlayChunk.pickEdgeSegmentIds,
              } satisfies SpatiallyIndexedSkeletonPickData,
            )
          : 0;
      edgeShader.bind();
      renderHelper.setPickID(gl, edgeShader, edgePickId);
      renderHelper.setPickInstanceStride(
        gl,
        edgeShader,
        edgePickId === 0 ? 0 : 1,
      );

      const nodePickId =
        overlayChunk.numVertices > 0 &&
        overlayChunk.pickNodeIds !== undefined &&
        overlayChunk.pickNodePositions !== undefined &&
        overlayChunk.pickSegmentIds !== undefined
          ? renderContext.pickIDs.register(
              layer,
              overlayChunk.numVertices,
              0n,
              {
                kind: "node",
                nodeIds: overlayChunk.pickNodeIds,
                nodePositions: overlayChunk.pickNodePositions,
                segmentIds: overlayChunk.pickSegmentIds,
              } satisfies SpatiallyIndexedSkeletonPickData,
            )
          : 0;
      nodeShader.bind();
      renderHelper.setPickID(gl, nodeShader, nodePickId);
      renderHelper.setPickInstanceStride(
        gl,
        nodeShader,
        nodePickId === 0 ? 0 : 1,
      );
    }

    renderHelper.drawSkeletons(
      gl,
      edgeShader,
      nodeShader,
      overlayChunk,
      renderContext.projectionParameters,
      renderMode,
    );
    this.endSkeletonRenderPass(
      renderHelper,
      gl,
      edgeShader,
      nodeShader,
      skeletonParams,
    );
  }

  draw(
    renderContext: SliceViewPanelRenderContext | PerspectiveViewRenderContext,
    layer: RenderLayer,
    overlayRenderHelper: RenderHelper,
    browseRenderHelper: RenderHelper,
    renderOptions: ViewSpecificSkeletonRenderingOptions,
    modelMatrix: mat4,
    visibleChunks: VisibleChunk[],
  ) {
    const { displayState } = this;
    if (
      displayState.objectAlpha.value <= 0.0 &&
      displayState.hiddenObjectAlpha.value <= 0.0
    ) {
      return;
    }

    const lineWidth = renderOptions.lineWidth.value;
    const pointDiameter = getSkeletonNodeDiameter(
      renderOptions.mode.value,
      lineWidth,
    );

    this.drawBrowsePass(
      renderContext,
      layer,
      browseRenderHelper,
      modelMatrix,
      lineWidth,
      pointDiameter,
      visibleChunks,
      renderOptions.mode.value,
    );
    this.drawInspectionOverlayPass(
      renderContext,
      layer,
      overlayRenderHelper,
      modelMatrix,
      lineWidth,
      pointDiameter,
      renderOptions.mode.value,
    );
  }

  isReady(
    view: SpatiallyIndexedSkeletonView,
    gridLevel: number | undefined,
    transformedSources: readonly TransformedSource[][],
    projectionParameters: ProjectionParameters,
    lod?: number,
  ) {
    return this.areVisibleChunksReady(
      view,
      gridLevel,
      transformedSources,
      projectionParameters,
      lod,
    );
  }
}

function transformSpatiallyIndexedSkeletonPickedValue(
  pickState: PickState,
): bigint | undefined {
  const u64 = pickState.pickedSpatialSkeleton?.segmentIdU64;
  return typeof u64 === "bigint" && u64 > 0n ? u64 : undefined;
}

const MAX_SAFE_SEGMENT_ID = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Split a full uint64 segment id into the dual representation stored on
 * `PickedSpatialSkeletonState`: the `bigint` for the selection widget, and a
 * safe-integer `number` for the legacy edit/overlay tooling (undefined when
 * the id exceeds 2⁵³, e.g. flywire ids).
 */
function pickedSegmentIdFields(u64: bigint): {
  segmentIdU64: bigint;
  segmentId?: number;
} {
  return {
    segmentIdU64: u64,
    segmentId: u64 <= MAX_SAFE_SEGMENT_ID ? Number(u64) : undefined,
  };
}

function updateSpatiallyIndexedSkeletonMouseState(
  base: SpatiallyIndexedSkeletonLayer,
  mouseState: MouseSelectionState,
  pickedOffset: number,
  data: SpatiallyIndexedSkeletonPickData | undefined,
): void {
  if (data === undefined) return;
  if (data.kind === "node") {
    if (
      pickedOffset < 0 ||
      pickedOffset >= data.nodeIds.length ||
      pickedOffset >= data.segmentIds.length
    ) {
      return;
    }
    const rawSegmentId = data.segmentIds[pickedOffset];
    if (!Number.isSafeInteger(rawSegmentId) || rawSegmentId <= 0) {
      return;
    }
    const segmentId = BigInt(rawSegmentId);
    mouseState.pickedSpatialSkeleton = pickedSegmentIdFields(segmentId);
    if (
      !getVisibleSegments(base.displayState.segmentationGroupState.value).has(
        segmentId,
      )
    ) {
      return;
    }
    const nodeId = data.nodeIds[pickedOffset];
    if (!Number.isSafeInteger(nodeId) || nodeId <= 0) return;
    const nodePosition = data.nodePositions.subarray(
      pickedOffset * 3,
      pickedOffset * 3 + 3,
    );
    mouseState.pickedSpatialSkeleton = {
      nodeId,
      ...pickedSegmentIdFields(segmentId),
      position: new Float32Array(nodePosition),
    };
    const transform = base.displayState.transform.value;
    if (transform.error === undefined) {
      setMouseStatePositionFromSpatialSkeletonNode(
        mouseState,
        nodePosition,
        transform,
      );
    }
    return;
  }
  if (data.kind === "edge") {
    if (pickedOffset < 0 || pickedOffset >= data.segmentIds.length) {
      return;
    }
    const rawSegmentId = data.segmentIds[pickedOffset];
    if (Number.isSafeInteger(rawSegmentId) && rawSegmentId > 0) {
      mouseState.pickedSpatialSkeleton = pickedSegmentIdFields(
        BigInt(rawSegmentId),
      );
    }
    return;
  }
  if (data.kind === "segment-node" || data.kind === "segment-edge") {
    if (data.kind === "segment-node") {
      const pickedNode = base.resolveNodePickFromChunk(
        data.chunk,
        pickedOffset,
      );
      if (pickedNode !== undefined) {
        mouseState.pickedSpatialSkeleton = {
          nodeId: pickedNode.nodeId,
          ...pickedSegmentIdFields(pickedNode.segmentId),
          position: new Float32Array(pickedNode.position),
          sourceState: pickedNode.sourceState,
        };
      }
      return;
    }
    const segmentId = base.resolveSegmentPickFromChunk(
      data.chunk,
      pickedOffset,
      "edge",
    );
    if (segmentId !== undefined) {
      mouseState.pickedSpatialSkeleton = pickedSegmentIdFields(segmentId);
    }
  }
}

function attachSpatiallyIndexedSkeletonLayer(
  base: SpatiallyIndexedSkeletonLayer,
  renderLayer: {
    transformedSources: TransformedSource[][];
    redrawNeeded: NullarySignal;
  },
  attachment: VisibleLayerInfo<
    LayerView,
    ThreeDimensionalRenderLayerAttachmentState
  >,
  view: "2d" | "3d",
): void {
  const { redrawNeeded } = renderLayer;
  attachment.registerDisposer(
    registerNested(
      (context, transform, displayDimensionRenderInfo) => {
        const transformedSources = getVolumetricTransformedSources(
          displayDimensionRenderInfo,
          transform,
          () => [
            base.getSources(view).map((sourceEntry) => ({
              chunkSource: sourceEntry.chunkSource,
              chunkToMultiscaleTransform:
                sourceEntry.chunkToMultiscaleTransform,
            })),
          ],
          attachment.messages,
          renderLayer,
        );
        for (const scales of transformedSources) {
          for (const tsource of scales) {
            context.registerDisposer(tsource.source);
          }
        }
        attachment.view.flushBackendProjectionParameters();
        renderLayer.transformedSources = transformedSources;
        base.rpc!.invoke(
          SPATIALLY_INDEXED_SKELETON_RENDER_LAYER_UPDATE_SOURCES_RPC_ID,
          {
            layer: base.backend.rpcId,
            view: attachment.view.rpcId,
            displayDimensionRenderInfo,
            sources: serializeAllTransformedSources(transformedSources),
          },
        );
        redrawNeeded.dispatch();
        return transformedSources;
      },
      base.displayState.transform,
      attachment.view.displayDimensionRenderInfo,
    ),
  );
}

export class PerspectiveViewSpatiallyIndexedSkeletonLayer extends PerspectiveViewRenderLayer {
  private renderHelper: RenderHelper;
  private browseRenderHelper: RenderHelper;
  private renderOptions: ViewSpecificSkeletonRenderingOptions;
  transformedSources: TransformedSource[][] = [];
  backend: ChunkRenderLayerFrontend;

  constructor(public base: SpatiallyIndexedSkeletonLayer) {
    super();
    this.backend = base.backend;
    this.renderHelper = this.registerDisposer(new RenderHelper(base, false));
    this.browseRenderHelper = this.registerDisposer(
      new RenderHelper(base.browsePassLayerView, false),
    );
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
    const histogram3d =
      base.displayState.spatialSkeletonGridRenderScaleHistogram3d;
    if (histogram3d !== undefined) {
      this.registerDisposer(histogram3d.visibility.add(this.visibility));
    }
  }

  attach(
    attachment: VisibleLayerInfo<
      PerspectivePanel,
      ThreeDimensionalRenderLayerAttachmentState
    >,
  ) {
    super.attach(attachment);
    attachSpatiallyIndexedSkeletonLayer(this.base, this, attachment, "3d");
  }

  get gl() {
    return this.base.gl;
  }

  get isTransparent() {
    const { objectAlpha, hiddenObjectAlpha } = this.base.displayState;
    const opaque =
      (objectAlpha.value == 1.0 &&
        (hiddenObjectAlpha.value == 1.0 || hiddenObjectAlpha.value == 0.0)) ||
      (objectAlpha.value == 0.0 && hiddenObjectAlpha.value == 1.0);
    return !opaque;
  }

  getValueAt(_position: Float32Array) {
    return undefined;
  }

  transformPickedValue(pickState: PickState) {
    return transformSpatiallyIndexedSkeletonPickedValue(pickState);
  }

  updateMouseState(
    mouseState: MouseSelectionState,
    _pickedValue: bigint,
    pickedOffset: number,
    data: unknown,
  ) {
    updateSpatiallyIndexedSkeletonMouseState(
      this.base,
      mouseState,
      pickedOffset,
      data as SpatiallyIndexedSkeletonPickData | undefined,
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
      return;
    }
    const { displayState } = this.base;
    // Auto-LOD: refresh the resolution target from the current camera
    // projection before chunk selection, so the picker tracks zoom
    // (same path the manual slider takes).  Opt-in via
    // `autoSpatialSkeletonGridLevel3d` to preserve existing
    // user-driven behaviour for layers that don't want it.
    maybeUpdateAutoSpatialSkeletonGridResolutionTarget(
      displayState,
      renderContext.projectionParameters,
      this.base.localPosition.value,
      "3d",
    );
    const lodValue = displayState.skeletonLod?.value;
    const visibleChunks = this.base.getVisibleChunksInCurrentViewAndLod(
      "3d",
      displayState.spatialSkeletonGridLevel3d?.value,
      this.transformedSources,
      renderContext.projectionParameters,
      lodValue,
    );
    const levels = displayState.spatialSkeletonGridLevels?.value;
    const histogram = displayState.spatialSkeletonGridRenderScaleHistogram3d;
    if (histogram !== undefined) {
      const frameNumber =
        this.base.chunkManager.chunkQueueManager.frameNumberCounter.frameNumber;
      updateSpatialSkeletonGridRenderScaleHistogram(
        histogram,
        frameNumber,
        this.transformedSources,
        renderContext.projectionParameters,
        this.base.localPosition.value,
        lodValue,
        levels,
      );
    }
    const modelMatrix = update3dRenderLayerAttachment(
      displayState.transform.value,
      renderContext.projectionParameters.displayDimensionRenderInfo,
      attachment,
    );
    if (modelMatrix === undefined) return;
    this.base.draw(
      renderContext,
      this,
      this.renderHelper,
      this.browseRenderHelper,
      this.renderOptions,
      modelMatrix,
      visibleChunks,
    );
    if (renderContext.wireFrame) {
      this.drawChunkBoundsWireframe(renderContext, visibleChunks, modelMatrix);
    }
  }

  private drawChunkBoundsWireframe(
    renderContext: PerspectiveViewRenderContext,
    visibleChunks: VisibleChunk[],
    modelMatrix?: mat4,
  ) {
    if (
      visibleChunks.length === 0 ||
      !renderContext.emitColor ||
      modelMatrix === undefined
    )
      return;

    const { gl } = this.base;
    const wireframeHelper = ChunkWireframeHelper.get(gl);
    const shader = wireframeHelper.getShader(renderContext.emitter);
    shader.bind();
    const { viewProjectionMat } = renderContext.projectionParameters;

    mat4.multiply(tempMat4, viewProjectionMat, modelMatrix);
    gl.uniformMatrix4fv(shader.uniform("uChunkToClip"), false, tempMat4);

    for (const { chunk, chunkLayout } of visibleChunks) {
      wireframeHelper.setChunkUniforms(
        gl,
        shader,
        chunkLayout,
        chunk.chunkGridPosition,
      );
      drawBoxEdges(gl, 1, 1);
    }
  }

  isReady(
    renderContext: PerspectiveViewReadyRenderContext,
    _attachment: VisibleLayerInfo<
      PerspectivePanel,
      ThreeDimensionalRenderLayerAttachmentState
    >,
  ) {
    const { displayState } = this.base;
    return this.base.isReady(
      "3d",
      displayState.spatialSkeletonGridLevel3d?.value,
      this.transformedSources,
      renderContext.projectionParameters,
      displayState.skeletonLod?.value,
    );
  }
}

export class SliceViewPanelSpatiallyIndexedSkeletonLayer extends SliceViewPanelRenderLayer {
  private renderHelper: RenderHelper;
  private browseRenderHelper: RenderHelper;
  private renderOptions: ViewSpecificSkeletonRenderingOptions;
  transformedSources: TransformedSource[][] = [];
  backend: ChunkRenderLayerFrontend;
  constructor(public base: SpatiallyIndexedSkeletonLayer) {
    super();
    this.backend = base.backend;
    this.renderHelper = this.registerDisposer(new RenderHelper(base, true));
    this.browseRenderHelper = this.registerDisposer(
      new RenderHelper(base.browsePassLayerView, true),
    );
    this.renderOptions = base.displayState.skeletonRenderingOptions.params2d;
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
    const { displayState: displayState2d } = base;
    const gridLevel2d = displayState2d.spatialSkeletonGridLevel2d;
    if (gridLevel2d?.changed) {
      this.registerDisposer(
        gridLevel2d.changed.add(this.redrawNeeded.dispatch),
      );
    }
    const lod2d = displayState2d.spatialSkeletonLod2d;
    if (lod2d?.changed) {
      this.registerDisposer(lod2d.changed.add(this.redrawNeeded.dispatch));
    }
    const histogram2d =
      displayState2d.spatialSkeletonGridRenderScaleHistogram2d;
    if (histogram2d !== undefined) {
      this.registerDisposer(histogram2d.visibility.add(this.visibility));
    }
  }

  get gl() {
    return this.base.gl;
  }

  getValueAt(_position: Float32Array) {
    return undefined;
  }

  transformPickedValue(pickState: PickState) {
    return transformSpatiallyIndexedSkeletonPickedValue(pickState);
  }

  updateMouseState(
    mouseState: MouseSelectionState,
    _pickedValue: bigint,
    pickedOffset: number,
    data: unknown,
  ) {
    updateSpatiallyIndexedSkeletonMouseState(
      this.base,
      mouseState,
      pickedOffset,
      data as SpatiallyIndexedSkeletonPickData | undefined,
    );
  }

  attach(
    attachment: VisibleLayerInfo<
      SliceViewPanel,
      ThreeDimensionalRenderLayerAttachmentState
    >,
  ) {
    super.attach(attachment);
    attachSpatiallyIndexedSkeletonLayer(this.base, this, attachment, "2d");
  }

  draw(
    renderContext: SliceViewPanelRenderContext,
    attachment: VisibleLayerInfo<
      SliceViewPanel,
      ThreeDimensionalRenderLayerAttachmentState
    >,
  ) {
    const { displayState } = this.base;
    maybeUpdateAutoSpatialSkeletonGridResolutionTarget(
      displayState,
      renderContext.sliceView.projectionParameters.value,
      this.base.localPosition.value,
      "2d",
    );
    const lodValue = displayState.spatialSkeletonLod2d?.value;
    const visibleChunks = this.base.getVisibleChunksInCurrentViewAndLod(
      "2d",
      displayState.spatialSkeletonGridLevel2d?.value,
      this.transformedSources,
      renderContext.sliceView.projectionParameters.value,
      lodValue,
    );
    const levels = displayState.spatialSkeletonGridLevels?.value;
    const histogram = displayState.spatialSkeletonGridRenderScaleHistogram2d;
    if (histogram !== undefined) {
      const frameNumber =
        this.base.chunkManager.chunkQueueManager.frameNumberCounter.frameNumber;
      updateSpatialSkeletonGridRenderScaleHistogram(
        histogram,
        frameNumber,
        this.transformedSources,
        renderContext.sliceView.projectionParameters.value,
        this.base.localPosition.value,
        lodValue,
        levels,
      );
    }
    const modelMatrix = update3dRenderLayerAttachment(
      displayState.transform.value,
      renderContext.projectionParameters.displayDimensionRenderInfo,
      attachment,
    );
    if (modelMatrix === undefined) return;
    this.base.draw(
      renderContext,
      this,
      this.renderHelper,
      this.browseRenderHelper,
      this.renderOptions,
      modelMatrix,
      visibleChunks,
    );
  }

  isReady(
    renderContext: SliceViewPanelReadyRenderContext,
    _attachment: VisibleLayerInfo<
      SliceViewPanel,
      ThreeDimensionalRenderLayerAttachmentState
    >,
  ) {
    const { displayState } = this.base;
    return this.base.isReady(
      "2d",
      displayState.spatialSkeletonGridLevel2d?.value,
      this.transformedSources,
      renderContext.projectionParameters,
      displayState.spatialSkeletonLod2d?.value,
    );
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

export type SkeletonSourceOptions = object;

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
  getChunk(x: PackedSkeletonGeometry) {
    return new SkeletonChunk(this, x);
  }

  get vertexAttributes(): Map<string, VertexAttributeInfo> {
    return emptyVertexAttributes;
  }
}
