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

import "#src/skeleton/frontend.css";

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
import type {
  PanelOverlayContext,
  PanelOverlaySource,
} from "#src/panel_overlay.js";
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
  onTemporaryVisibleSegmentsStateChanged,
  onVisibleSegmentsStateChanged,
} from "#src/segmentation_display_state/base.js";
import type { SegmentationDisplayState3D } from "#src/segmentation_display_state/frontend.js";
import {
  forEachVisibleSegmentToDraw,
  getBaseObjectColor,
  registerRedrawWhenSegmentationDisplayState3DChanged,
  SegmentationLayerSharedObject,
} from "#src/segmentation_display_state/frontend.js";
import { SharedWatchableValue } from "#src/shared_watchable_value.js";
import type {
  SpatiallyIndexedSkeletonNode,
  SpatialSkeletonSourceState,
} from "#src/skeleton/api.js";
import {
  forEachSpatialSkeletonSourceScale,
  forEachVisibleSpatialSkeletonChunk,
  SKELETON_LAYER_RPC_ID,
  type SpatiallyIndexedSkeletonChunkSpecification,
  SPATIALLY_INDEXED_SKELETON_RENDER_LAYER_RPC_ID,
  SPATIALLY_INDEXED_SKELETON_RENDER_LAYER_UPDATE_SOURCES_RPC_ID,
  type VertexAttributeInfo,
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
import type { EdgeShadingGlsl } from "#src/skeleton/skeleton_shader_color.js";
import {
  edgeColorPathsGlsl,
  raycastFragmentSetup,
  nodeColorPathsGlsl,
} from "#src/skeleton/skeleton_shader_color.js";
import type { SpatiallyIndexedSkeletonView } from "#src/skeleton/source_selection.js";
import {
  getChunkKey,
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
import { TrackableBoolean } from "#src/trackable_boolean.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import {
  makeCachedDerivedWatchableValue,
  makeCachedLazyDerivedWatchableValue,
  TrackableValue,
  WatchableValue,
  registerNested,
} from "#src/trackable_value.js";
import { Uint64Set } from "#src/uint64_set.js";
import { gatherUpdate } from "#src/util/array.js";
import {
  getRelativeLuminance,
  getSaturation,
  pickHighestContrastColor,
  saturateColor,
} from "#src/util/color.js";
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
import { drawQuads } from "#src/webgl/quad.js";
import { defineRaycastCylinderShader } from "#src/webgl/raycast_cylinder.js";
import { defineRaycastSphereShader } from "#src/webgl/raycast_sphere.js";
import type {
  ShaderModule,
  ShaderProgram,
  ShaderSamplerType,
} from "#src/webgl/shader.js";
import { ShaderBuilder } from "#src/webgl/shader.js";
import {
  dataTypeShaderDefinition,
  getShaderType,
  glsl_string,
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
} from "#src/webgl/texture_access.js";
import { defineVertexId, VertexIdHelper } from "#src/webgl/vertex_id.js";
import type { RPC } from "#src/worker_rpc.js";

const DEBUG_SPATIAL_SKELETON_OVERLAY = false;
const DEBUG_EXCLUDED_SEGMENTS = false;
const DEBUG_SPATIAL_SKELETON_CHUNKS = false;

const DEFAULT_FRAGMENT_MAIN = `void main() {
  emitDefault();
}
`;
const SELECTED_NODE_OUTLINE_FALLBACK_COLOR = vec3.fromValues(1.0, 0.95, 0.35);

// Converts a linear 0..1 RGB triple to a CSS `rgb(...)` string for DOM markers.
function vec3ToCssColor(color: vec3): string {
  return `rgb(${Math.round(color[0] * 255)}, ${Math.round(
    color[1] * 255,
  )}, ${Math.round(color[2] * 255)})`;
}
const SELECTED_NODE_OUTLINE_MIN_WIDTH_2D = "3.5";
const SELECTED_NODE_OUTLINE_MAX_WIDTH_2D = "8.0";
const SELECTED_NODE_OUTLINE_MIN_WIDTH_3D = "3.0";
const SELECTED_NODE_OUTLINE_MAX_WIDTH_3D = "7.0";
// Fraction of the node diameter used as the highlight outline width before
// clamping to the min/max above. Nodes are small (~5-6px), so this mostly hits
// the min for typical nodes and scales up the ring for larger nodes.
const SELECTED_NODE_OUTLINE_DIAMETER_FRACTION = "0.5";

// Saturation adjustment factor and threshold for the highlighted (hovered) node border: each
// moves the segment's color away from (>1) or towards (<1) the perceptual-grey
// axis by this multiplier, clamped to [0, 1]. A segment color that is already
// very saturated has little room left to move further from grey, so boosting it
// further is barely visible; in that case the color is desaturated instead, which
// remains a visible change in either direction. Mirrors the saturation-flip
// logic in getObjectColor (segmentation_display_state/frontend.ts).
const HIGHLIGHTED_NODE_BORDER_SATURATION_FACTOR = 0.5;
const HIGHLIGHTED_NODE_BORDER_SATURATION_THRESHOLD = 0.5;

// Muted colors for the selected (pinned) node -- less vibrant.
const SELECTED_NODE_HIGHLIGHT_COLORS: readonly vec3[] = [
  vec3.fromValues(0.1, 0.1, 0.1), // near-black
  vec3.fromValues(0.7, 0.67, 0.6), // stone (light warm gray)
  vec3.fromValues(0.5, 0.45, 0.15), // olive
];

// Used for debugging chunks via a different color for each chunk
const tempChunkKeyToColorMap = new Map<string, Float32Array>();
const tempMat4 = mat4.create();
// Scratch matrices/vectors for raycast uniform computation in beginLayer.
const tempInvProjection = mat4.create();
const tempInvModel = mat4.create();
const tempNormalTransform = mat4.create();
const tempLightVec = new Float32Array(4);

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

interface EdgeGeometry {
  vertexMain: string;
  fragmentSetup: string;
  shading: EdgeShadingGlsl;
}

interface NodeGeometry {
  vertexMain: string;
  fragmentSetup: string;
  // Whether the legacy path premultiplies rgb by alpha before emitting (raycast
  // does; the billboard preserves its original un-premultiplied behavior).
  legacyPremultiply: boolean;
}

class RenderHelper extends RefCounted {
  private textureAccessHelper = new OneDimensionalTextureAccessHelper(
    "vertexData",
  );
  private vertexIdHelper;
  private segmentAttributeIndex: number | undefined;
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
    // Perspective (3D) views render cylinders/spheres as raycasts; slice (2D)
    // views keep the screen-space line/circle billboards.
    const raycast = !this.targetIsSliceView;
    if (raycast) {
      builder.addUniform("highp mat4", "uInvProjection");
      builder.addUniform("highp mat4", "uNormalTransform");
      builder.addUniform("highp vec4", "uLightDirection");
      builder.addUniform("highp vec2", "uViewportSize");
      // Set per-fragment by the raycast setup; the emit bodies multiply the
      // color by it.
      builder.addFragmentCode("highp float raycastLightingFactor = 1.0;\n");
    }
    if (skeletonParams.spatialChunkCulling) {
      builder.addUniform("highp vec3", "uChunkOrigin");
      builder.addUniform("highp vec3", "uChunkBound");
      builder.addFragmentCode(`
void spatialChunkCull(highp vec3 cullPos) {
  if (any(lessThan(cullPos, uChunkOrigin)) ||
      any(greaterThanEqual(cullPos, uChunkBound))) discard;
}
`);
      if (!raycast) {
        // Billboard path culls using the interpolated per-fragment position.
        builder.addVarying("highp vec3", "vCullPos");
        builder.addFragmentCode(`
void spatialChunkCull() { spatialChunkCull(vCullPos); }
`);
      }
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
    fragmentSetup = "",
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
      if (i === this.segmentAttributeIndex) {
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
    builder.addFragmentCode(glsl_string);
    builder.addFragmentCode(`void userMain();\n`);
    builder.addFragmentCode(
      "#define main userMain\n" +
        shaderCodeWithLineDirective(shaderBuilderState.parseResult.code) +
        "\n#undef main\n",
    );
    // `fragmentSetup` runs the raycast intersection (writing gl_FragDepth /
    // lighting) or the billboard chunk cull before the user's fragment main.
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
    builder.addVarying("highp uint", "vSegmentValue", "flat");

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
  float isHovered = float(segmentId.value.x == uHoveredSegmentId.x &&
                          segmentId.value.y == uHoveredSegmentId.y);
  saturation += isHovered * (0.5 - step(0.5, saturation));`
      : "";

    builder.addFragmentCode(`
uint64_t getSegmentAppearanceId(highp uint segmentValue) {
  return uint64_t(uvec2(segmentValue, 0u));
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
vec4 getSegmentAppearance(highp uint segmentValue) {
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

  private dynamicColorPath(skeletonParams: SkeletonShaderParameters): boolean {
    return (
      skeletonParams.dynamicSegmentAppearance &&
      this.segmentAttributeIndex !== undefined
    );
  }

  // Vertex-shader assignment of `vSegmentValue`, read by the dynamic color path.
  private readSegmentValueGlsl(
    skeletonParams: SkeletonShaderParameters,
    indexExpression: string,
  ): string {
    if (!this.dynamicColorPath(skeletonParams)) return "";
    return `vSegmentValue = toRaw(readAttribute${this.segmentAttributeIndex}(${indexExpression}));\n`;
  }

  private defineEdgeShader(
    builder: ShaderBuilder,
    shaderBuilderState: ShaderControlsBuilderState,
    skeletonParams: SkeletonShaderParameters,
  ) {
    this.defineCommonShader(builder, shaderBuilderState, skeletonParams);
    const geometry = this.targetIsSliceView
      ? this.defineEdgeLineBillboard(builder, skeletonParams)
      : this.defineEdgeRaycastCylinder(builder, skeletonParams);
    const path = this.dynamicColorPath(skeletonParams) ? "dynamic" : "legacy";
    builder.addFragmentCode(edgeColorPathsGlsl(path, geometry.shading));
    builder.addFragmentCode(glsl_string);
    this.finalizeShaderBuilder(
      builder,
      shaderBuilderState,
      skeletonParams,
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
    const geometry = this.targetIsSliceView
      ? this.defineNodeCircleBillboard(builder, skeletonParams)
      : this.defineNodeRaycastSphere(builder, skeletonParams);
    const path = this.dynamicColorPath(skeletonParams) ? "dynamic" : "legacy";
    builder.addFragmentCode(
      nodeColorPathsGlsl(path, geometry.legacyPremultiply),
    );
    builder.addFragmentCode(glsl_string);
    this.finalizeShaderBuilder(
      builder,
      shaderBuilderState,
      skeletonParams,
      geometry.vertexMain,
      geometry.fragmentSetup,
    );
  }

  // Slice view: screen-space anti-aliased line billboard (constant pixel width).
  private defineEdgeLineBillboard(
    builder: ShaderBuilder,
    skeletonParams: SkeletonShaderParameters,
  ): EdgeGeometry {
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
    vertexMain += this.readSegmentValueGlsl(skeletonParams, "aVertexIndex.x");
    return {
      vertexMain,
      fragmentSetup,
      shading: {
        coverageAlpha: ` * getLineAlpha() * ${this.getCrossSectionFadeFactor()}`,
        shadeColor: "",
        legacyDefaultPremultiply: "",
      },
    };
  }

  // Perspective view: raycast cylinder (2 triangles).  Each end is
  // clipped by the node radius so it does not overlap the node sphere (which
  // would double-blend under order-independent transparency).
  private defineEdgeRaycastCylinder(
    builder: ShaderBuilder,
    skeletonParams: SkeletonShaderParameters,
  ): EdgeGeometry {
    defineRaycastCylinderShader(builder, { capped: false });
    builder.addAttribute("highp uvec2", "aVertexIndex");
    builder.addUniform("highp float", "uEdgePixelRadius");
    builder.addUniform("highp float", "uNodePixelRadius");
    let vertexMain = `
highp uint pickOffset = uint(gl_InstanceID) * uPickInstanceStride;
vPickID = uPickID + pickOffset;
highp vec3 vertexA = applyNodePositionOverride(aVertexIndex.x, readAttribute0(aVertexIndex.x));
highp vec3 vertexB = applyNodePositionOverride(aVertexIndex.y, readAttribute0(aVertexIndex.y));
highp uint vertexIndex = aVertexIndex.x;
highp vec3 edgeMidpoint = mix(vertexA, vertexB, 0.5);
highp float edgeRadius = getRaycastModelRadiusForPixels(edgeMidpoint, uEdgePixelRadius);
highp float clipRadiusA = getRaycastModelRadiusForPixels(vertexA, uNodePixelRadius);
highp float clipRadiusB = getRaycastModelRadiusForPixels(vertexB, uNodePixelRadius);
`;
    vertexMain += this.readSegmentValueGlsl(skeletonParams, "aVertexIndex.x");
    vertexMain += `emitRaycastCylinder(vertexA, vertexB, edgeRadius, clipRadiusA, clipRadiusB);\n`;
    return {
      vertexMain,
      fragmentSetup: raycastFragmentSetup(
        "intersectRaycastCylinder",
        skeletonParams.spatialChunkCulling,
      ),
      shading: {
        coverageAlpha: "",
        shadeColor: " * raycastLightingFactor",
        legacyDefaultPremultiply: " * uColor.a",
      },
    };
  }

  // Slice view: screen-space anti-aliased circle billboard (constant pixel
  // diameter).  Feather/border are applied by `getCircleColor`.
  private defineNodeCircleBillboard(
    builder: ShaderBuilder,
    skeletonParams: SkeletonShaderParameters,
  ): NodeGeometry {
    defineCircleShader(builder, /*crossSectionFade=*/ this.targetIsSliceView);
    builder.addUniform("highp float", "uNodeDiameter");
    builder.addFragmentCode(`
vec4 finishNodeColor(vec4 color) {
  return getCircleColor(color, color);
}
`);
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
    vertexMain += this.readSegmentValueGlsl(skeletonParams, "vertexIndex");
    vertexMain += `emitCircle(uProjection * vec4(vertexPosition, 1.0), uNodeDiameter, 0.0);\n`;
    // The legacy path emits the circle color un-premultiplied (preserved).
    return { vertexMain, fragmentSetup, legacyPremultiply: false };
  }

  // Perspective view: raycast sphere (2 triangles).
  private defineNodeRaycastSphere(
    builder: ShaderBuilder,
    skeletonParams: SkeletonShaderParameters,
  ): NodeGeometry {
    defineRaycastSphereShader(builder);
    builder.addUniform("highp float", "uNodePixelRadius");
    builder.addFragmentCode(`
vec4 finishNodeColor(vec4 color) {
  return vec4(color.rgb * raycastLightingFactor, color.a);
}
`);
    let vertexMain = `
highp uint vertexIndex = uint(gl_InstanceID);
highp uint pickOffset = vertexIndex * uPickInstanceStride;
vPickID = uPickID + pickOffset;
highp vec3 vertexPosition = applyNodePositionOverride(vertexIndex, readAttribute0(vertexIndex));
highp float nodeRadius = getRaycastModelRadiusForPixels(vertexPosition, uNodePixelRadius);
`;
    vertexMain += this.readSegmentValueGlsl(skeletonParams, "vertexIndex");
    vertexMain += `emitRaycastSphere(vertexPosition, nodeRadius);\n`;
    return {
      vertexMain,
      fragmentSetup: raycastFragmentSetup(
        "intersectRaycastSphere",
        skeletonParams.spatialChunkCulling,
      ),
      legacyPremultiply: true,
    };
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
    if (!this.targetIsSliceView) {
      // Raycast uniforms (perspective view).  Intersection is done in model
      // space, so we provide clip->model and the model-normal->display normal
      // transform (inverse-transpose of the model matrix), plus the light and
      // viewport size.  Mirrors src/annotation/ellipsoid.ts.
      const invProjection = mat4.invert(tempInvProjection, mat);
      if (invProjection !== null) {
        gl.uniformMatrix4fv(
          shader.uniform("uInvProjection"),
          false,
          invProjection,
        );
      }
      const invModel = mat4.invert(tempInvModel, modelMatrix);
      if (invModel !== null) {
        const normalTransform = mat4.transpose(tempNormalTransform, invModel);
        gl.uniformMatrix4fv(
          shader.uniform("uNormalTransform"),
          false,
          normalTransform,
        );
      }
      const { width, height } = renderContext.projectionParameters;
      gl.uniform2f(shader.uniform("uViewportSize"), width, height);
      const perspectiveContext = renderContext as PerspectiveViewRenderContext;
      const lightVec = tempLightVec as unknown as vec3;
      vec3.scale(
        lightVec,
        perspectiveContext.lightDirection,
        perspectiveContext.directionalLighting,
      );
      tempLightVec[3] = perspectiveContext.ambientLighting;
      gl.uniform4fv(shader.uniform("uLightDirection"), tempLightVec);
    }
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

  // Sets the edge-size uniforms for whichever edge shader variant is active:
  // the billboard line width (slice view) or the raycast-cylinder pixel radius
  // (perspective view).
  setEdgeSizeUniforms(
    gl: GL,
    shader: ShaderProgram,
    lineWidth: number,
    pointDiameter: number,
  ) {
    if (this.targetIsSliceView) {
      gl.uniform1f(shader.uniform("uLineWidth"), lineWidth);
      gl.uniform1f(
        shader.uniform("uLineEndpointClipRadius"),
        pointDiameter / 2,
      );
    } else {
      gl.uniform1f(shader.uniform("uEdgePixelRadius"), lineWidth * 0.5);
      // Node radius, used to clip the cylinder ends against the node spheres.
      gl.uniform1f(shader.uniform("uNodePixelRadius"), pointDiameter * 0.5);
    }
  }

  // Sets the node-size uniforms for whichever node shader variant is active:
  // the billboard circle diameter (slice view) or the raycast-sphere pixel
  // radius (perspective view).
  setNodeSizeUniforms(gl: GL, shader: ShaderProgram, pointDiameter: number) {
    if (this.targetIsSliceView) {
      gl.uniform1f(shader.uniform("uNodeDiameter"), pointDiameter);
    } else {
      gl.uniform1f(shader.uniform("uNodePixelRadius"), pointDiameter * 0.5);
    }
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

    const raycast = !this.targetIsSliceView;

    // Draw edges: lines (slice) or raycast cylinders (perspective).  Both are
    // instanced quads whose per-instance endpoint pair comes from `aVertexIndex`.
    {
      edgeShader.bind();
      const aVertexIndex = edgeShader.attribute("aVertexIndex");
      skeletonGpuGeometry.indexBuffer.bindToVertexAttribI(
        aVertexIndex,
        2,
        WebGL2RenderingContext.UNSIGNED_INT,
      );
      gl.vertexAttribDivisor(aVertexIndex, 1);
      if (raycast) {
        drawQuads(gl, 1, skeletonGpuGeometry.numIndices / 2);
      } else {
        initializeLineShader(edgeShader, projectionParameters, 1.0);
        drawLines(gl, 1, skeletonGpuGeometry.numIndices / 2);
      }
      gl.vertexAttribDivisor(aVertexIndex, 0);
      gl.disableVertexAttribArray(aVertexIndex);
    }

    // Draw nodes: circles (slice) or raycast spheres (perspective).  Position
    // is pulled per-instance from the position texture by gl_InstanceID.
    {
      nodeShader.bind();
      if (raycast) {
        drawQuads(gl, 1, skeletonGpuGeometry.numVertices);
      } else {
        initializeCircleShader(nodeShader, projectionParameters, {
          featherWidthInPixels: 1.0,
        });
        drawCircles(nodeShader.gl, 1, skeletonGpuGeometry.numVertices);
      }
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

// A selected/hovered node highlight to draw as a DOM ring overlay.  `diameter`
// and `borderWidth` are in render-viewport device px (matching the node's
// on-screen size); the panel converts them to CSS px via `cssPerDevicePixel`.
interface HighlightMarker {
  position: Float32Array; // global coordinate space
  kind: "selected" | "hovered";
  color: string; // CSS ring color, derived from the node's segment color
  outlineColor: string; // CSS halo color, contrasting with `color`
  diameter: number;
  borderWidth: number;
}

// Reconciles the ring child elements of an overlay source's per-panel container
// to `markers`, projecting each via the panel context.  Reuses/pools children.
function updateSkeletonHighlightOverlay(
  markers: HighlightMarker[],
  ctx: PanelOverlayContext,
) {
  const { container, cssPerDevicePixel } = ctx;
  let count = 0;
  for (const marker of markers) {
    const pos = ctx.project(marker.position);
    if (pos === undefined) continue;
    let element = container.children[count] as HTMLElement | undefined;
    if (element === undefined) {
      element = document.createElement("div");
      element.className = "neuroglancer-skeleton-node-highlight";
      container.appendChild(element);
    }
    ++count;
    const size = marker.diameter * cssPerDevicePixel;
    const { style } = element;
    style.display = "";
    style.width = `${size}px`;
    style.height = `${size}px`;
    style.borderWidth = `${Math.max(1, marker.borderWidth * cssPerDevicePixel)}px`;
    style.borderColor = marker.color;
    style.setProperty("--ng-node-highlight-outline", marker.outlineColor);
    style.opacity = `${pos.opacity ?? 1}`;
    style.transform = `translate(${pos.x - size / 2}px, ${pos.y - size / 2}px)`;
  }
  const { children } = container;
  for (let i = count; i < children.length; ++i) {
    (children[i] as HTMLElement).style.display = "none";
  }
}

// On-screen size (render-viewport device px) of a node's selection ring,
// matching the old in-shader outline: a band of `borderWidth` sitting just
// outside the node, so the outer `diameter` = nodeDiameter + 2 * outline.
function getSkeletonNodeHighlightRing(
  renderMode: SkeletonRenderMode,
  lineWidth: number,
  targetIsSliceView: boolean,
): { diameter: number; borderWidth: number } {
  const nodeDiameter = getSkeletonNodeDiameter(renderMode, lineWidth);
  const minWidth = Number(
    targetIsSliceView
      ? SELECTED_NODE_OUTLINE_MIN_WIDTH_2D
      : SELECTED_NODE_OUTLINE_MIN_WIDTH_3D,
  );
  const maxWidth = Number(
    targetIsSliceView
      ? SELECTED_NODE_OUTLINE_MAX_WIDTH_2D
      : SELECTED_NODE_OUTLINE_MAX_WIDTH_3D,
  );
  const outline = Math.min(
    maxWidth,
    Math.max(
      minWidth,
      Number(SELECTED_NODE_OUTLINE_DIAMETER_FRACTION) * nodeDiameter,
    ),
  );
  return { diameter: nodeDiameter + 2 * outline, borderWidth: outline };
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
  shaderError: WatchableShaderError;
  skeletonRenderingOptions: SkeletonRenderingOptions;
}

export class SkeletonLayer extends RefCounted implements SkeletonShaderContext {
  layerChunkProgressInfo = new LayerChunkProgressInfo();
  redrawNeeded = new NullarySignal();
  private sharedObject: SegmentationLayerSharedObject;
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
      edgeShaderParameters.parseResult,
    );
    renderHelper.setEdgeSizeUniforms(gl, edgeShader, lineWidth!, pointDiameter);

    nodeShader.bind();
    renderHelper.beginLayer(gl, nodeShader, renderContext, modelMatrix);
    renderHelper.setNodeSizeUniforms(gl, nodeShader, pointDiameter);
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

export interface SpatiallyIndexedSkeletonSourceRuntimeDisposalOptions {
  invalidateCache?: boolean;
}

export function disposeSpatiallyIndexedSkeletonSourceRuntimeState(
  sources: Iterable<SpatiallyIndexedSkeletonSource>,
  options: SpatiallyIndexedSkeletonSourceRuntimeDisposalOptions = {},
) {
  const uniqueSources = new Set(sources);
  const invalidateCache = options.invalidateCache ?? true;
  const chunkQueueManagersWithDeletedChunks = new Set<
    ChunkManager["chunkQueueManager"]
  >();
  let changed = false;
  for (const source of uniqueSources) {
    if (source.chunks.size !== 0) {
      for (const chunkKey of source.chunks.keys()) {
        source.deleteChunk(chunkKey);
      }
      chunkQueueManagersWithDeletedChunks.add(
        source.chunkManager.chunkQueueManager,
      );
      changed = true;
    }
    if (
      invalidateCache &&
      source.wasDisposed !== true &&
      source.rpc !== null &&
      source.rpcId !== null
    ) {
      source.invalidateCache();
      changed = true;
    }
  }
  for (const chunkQueueManager of chunkQueueManagersWithDeletedChunks) {
    chunkQueueManager.visibleChunksChanged.dispatch();
  }
  return changed;
}

// Options are provided by the SliceView framework for scale selection,
// but spatial skeleton sources expose all grid levels unconditionally.
// TODO (SKM): validate if this is an ok deviation from the SliceView
export const SPATIAL_SKELETON_SOURCE_OPTIONS: SliceViewSourceOptions = {
  displayRank: 0,
  multiscaleToViewTransform: new Float32Array(0),
  modelChannelDimensionIndices: [],
};

/**
 * Returns the key of the chunk containing `position`, given in the source's own voxel coordinates,
 * or undefined if no single chunk can be named.
 *
 * A skeleton node position is 3D, so it identifies exactly one chunk only while the grid is also 3D.
 * Every spatial skeleton source today is (see `CatmaidMultiscaleSpatiallyIndexedSkeletonSource`); a
 * higher-rank grid would spread one 3D cell over every combination of the extra dimensions, which
 * cannot be named without enumerating the source's chunks, so this reports undefined rather than
 * guessing. The grid is anchored at the origin rather than at the source's lower bound, matching the
 * chunk index computation in `updateFixedCurPositionInChunks`.
 */
export function getSpatialSkeletonChunkKey(
  spec: SliceViewChunkSpecification,
  position: ArrayLike<number>,
): string | undefined {
  const { rank, chunkDataSize } = spec;
  if (rank !== 3) return undefined;
  const chunkGridPosition = new Array<number>(rank);
  for (let i = 0; i < rank; ++i) {
    const coordinate = position[i];
    const chunkSize = chunkDataSize[i];
    if (!Number.isFinite(coordinate) || !(chunkSize > 0)) return undefined;
    chunkGridPosition[i] = Math.floor(coordinate / chunkSize);
  }
  return getChunkKey(chunkGridPosition);
}

export abstract class MultiscaleSpatiallyIndexedSkeletonSource extends MultiscaleSliceViewChunkSource<SpatiallyIndexedSkeletonSource> {
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
}

type SpatiallyIndexedSkeletonSourceEntry =
  SliceViewSingleResolutionSource<SpatiallyIndexedSkeletonSource>;

interface SelectedSkeletonNodeInfo {
  readonly nodeId: number;
  readonly segmentId?: number;
  readonly position?: Float32Array;
}

interface SpatiallyIndexedSkeletonLayerOptions {
  sources2d?: SpatiallyIndexedSkeletonSourceEntry[];
  selectedNodeInfo?: WatchableValueInterface<
    SelectedSkeletonNodeInfo | undefined
  >;
  // When true, the selected-node highlight is hidden even though a node may be
  // selected (used while entering merge/split modes).
  suppressSelectedNodeHighlight?: WatchableValueInterface<boolean>;
  hoveredNodeInfo?: WatchableValueInterface<
    SelectedSkeletonNodeInfo | undefined
  >;
  pendingNodePositionVersion?: WatchableValueInterface<number>;
  getPendingNodePosition?: (nodeId: number) => ArrayLike<number> | undefined;
  // Node ids that currently have a pending (drag) position override.
  getPendingNodeIds?: () => Iterable<number>;
  getCachedNode?: (nodeId: number) => SpatiallyIndexedSkeletonNode | undefined;
  // Transforms a node's model-space position into the global coordinate space
  // used by the panels, so node highlights can be projected to screen.
  resolveGlobalPosition?: (
    modelPosition: ArrayLike<number>,
  ) => Float32Array | undefined;
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
  // Maps nodeId to packed vertex index, used to target a live node drag's
  // position override to the correct vertex via a shader uniform (no rebuild).
  readonly nodeIndex: ReadonlyMap<number, number>;

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
    this.nodeIndex = geometry.nodeIndex;
  }

  dispose(gl: GL) {
    for (const texture of this.vertexAttributeTextures) {
      if (texture) gl.deleteTexture(texture);
    }
    this.indexBuffer.dispose();
  }
}

// Tracks chunk keys already counted for a given histogram within a single frame,
// preventing the same chunk from being counted multiple times when it falls within
// the visible frustum of more than one slice panel in the same frame.
const seenChunkKeysPerFrame = new WeakMap<
  RenderScaleHistogram,
  { frameNumber: number; keys: Set<string> }
>();

const SPATIAL_SKELETON_RESOLUTION_INDICATOR_BAR_HEIGHT = 10;

export interface SpatiallyIndexedSkeletonLayerDisplayState
  extends SkeletonLayerDisplayState {
  spatialSkeletonSpacingTarget2d: WatchableValueInterface<number>;
  spatialSkeletonSpacingTarget3d: WatchableValueInterface<number>;
  spatialSkeletonSpacingHistogram2d: RenderScaleHistogram;
  spatialSkeletonSpacingHistogram3d: RenderScaleHistogram;
}

export function resolveSpatiallyIndexedSkeletonSegmentPick(
  chunk: { indices: Uint32Array; numVertices: number },
  segmentIds: Uint32Array,
  pickedOffset: number,
  kind: "node" | "edge",
) {
  if (pickedOffset < 0) return undefined;
  if (kind === "node") {
    if (
      pickedOffset >= segmentIds.length ||
      pickedOffset >= chunk.numVertices
    ) {
      return undefined;
    }
    const segmentId = segmentIds[pickedOffset];
    return Number.isSafeInteger(segmentId) && segmentId > 0
      ? segmentId
      : undefined;
  }
  const indexOffset = pickedOffset * 2;
  if (indexOffset + 1 >= chunk.indices.length) {
    return undefined;
  }
  const vertexA = chunk.indices[indexOffset];
  const vertexB = chunk.indices[indexOffset + 1];
  let segmentId = segmentIds[vertexA];
  if (!Number.isSafeInteger(segmentId) || segmentId <= 0) {
    segmentId = segmentIds[vertexB];
  }
  return Number.isSafeInteger(segmentId) && segmentId > 0
    ? segmentId
    : undefined;
}

export class SpatiallyIndexedSkeletonLayer
  extends RefCounted
  implements SkeletonShaderContext
{
  layerChunkProgressInfo = new LayerChunkProgressInfo();
  redrawNeeded = new NullarySignal();
  vertexAttributes: VertexAttributeRenderInfo[];
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
  private selectedNodeInfo:
    | WatchableValueInterface<SelectedSkeletonNodeInfo | undefined>
    | undefined;
  private suppressSelectedNodeHighlight:
    | WatchableValueInterface<boolean>
    | undefined;
  private hoveredNodeInfo:
    | WatchableValueInterface<SelectedSkeletonNodeInfo | undefined>
    | undefined;
  private getPendingNodePositionOverride:
    | ((nodeId: number) => ArrayLike<number> | undefined)
    | undefined;
  // Node ids with a live pending (drag) position. Used to target the shader
  // position override without scanning all nodes; one entry during a drag.
  private getPendingNodeIds: (() => Iterable<number>) | undefined;
  private getCachedNodeInfo:
    | ((nodeId: number) => SpatiallyIndexedSkeletonNode | undefined)
    | undefined;
  private resolveGlobalPosition:
    | ((modelPosition: ArrayLike<number>) => Float32Array | undefined)
    | undefined;
  // Fires when the set of highlighted nodes (selected/hovered) changes, so panels
  // can reposition their DOM node-highlight markers without a full canvas redraw.
  readonly highlightMarkersChanged = new NullarySignal();
  private inspectionState: SpatiallyIndexedSkeletonInspectionState | undefined;
  private overlayChunk: SkeletonOverlayChunk | undefined;
  // Identifies the overlay geometry topology (which segments are loaded plus the
  // node-data version). A change forces a full rebuild. Live-drag position
  // changes do not affect it — they are applied per-draw via a shader uniform.
  private overlayTopologyKey: string | undefined;
  private overlayRebuildFrame = -1;
  private pendingOverlaySegmentLoads = new Set<number>();
  private browseExcludedSegments = new Uint64Set();
  private gpuBrowseExcludedSegmentsHashTable: GPUHashTable<HashSetUint64>;
  private browseExcludedSegmentsKey: string | undefined;
  private readonly editedSegmentIds = new Set<number>();
  // Bumped on every mutation of `editedSegmentIds` so the per-frame browse
  // excluded-segments computation can be skipped when nothing changed.
  private editedSegmentIdsVersion = 0;
  private cachedBrowseExcludedResult: Uint64Set | undefined;
  private cachedBrowseExcludedVersion = -1;
  // Segment id -> last-touched sequence number; doubles as pool membership
  // (key) and recency (value).
  private retainedOverlaySegments: Map<number, number> = new Map();
  // Shared sequence counter assigned to each touch.
  private overlaySegmentTouchCounter = 0;
  // Bumped when the set of keys in `retainedOverlaySegments` changes, so the
  // merged render segment-id list can be cached across frames. Recency-only
  // touches don't bump this, since the merged, sorted list is unaffected.
  private retainedOverlaySegmentIdsVersion = 0;
  private cachedOverlayRenderSegmentIds: number[] = [];
  private cachedOverlayRenderVisibleSet: Uint64Set | undefined;
  private cachedOverlayRenderVisibleGeneration = -1;
  private cachedOverlayRenderRetainedVersion = -1;
  private maxRetainedOverlaySegments: number;
  private readonly selectedNodeOutlineColor = vec3.clone(
    SELECTED_NODE_OUTLINE_FALLBACK_COLOR,
  );
  private readonly highlightedNodeOutlineColor = vec3.clone(
    SELECTED_NODE_OUTLINE_FALLBACK_COLOR,
  );
  // The selected and hovered outline colors are derived together from a single
  // source segment color, so they share one cache generation.
  private nodeOutlineColorGeneration = 0;
  private cachedNodeOutlineColorGeneration = -1;

  private disposeOverlayChunk() {
    const changed =
      this.overlayChunk !== undefined || this.overlayTopologyKey !== undefined;
    this.overlayChunk?.dispose(this.gl);
    this.overlayChunk = undefined;
    this.overlayTopologyKey = undefined;
    return changed;
  }

  getUniqueChunkSources() {
    const sources = new Set<SpatiallyIndexedSkeletonSource>();
    for (const sourceEntry of [...this.sources, ...this.sources2d]) {
      sources.add(sourceEntry.chunkSource);
    }
    return sources;
  }

  private clearOverlayRuntimeState() {
    let changed = this.disposeOverlayChunk();
    if (this.pendingOverlaySegmentLoads.size !== 0) {
      this.pendingOverlaySegmentLoads.clear();
      changed = true;
    }
    if (this.editedSegmentIds.size !== 0) {
      this.editedSegmentIds.clear();
      ++this.editedSegmentIdsVersion;
      changed = true;
    }
    if (this.retainedOverlaySegments.size !== 0) {
      this.retainedOverlaySegments = new Map();
      ++this.retainedOverlaySegmentIdsVersion;
      changed = true;
    }
    if (this.browseExcludedSegments.size !== 0) {
      this.browseExcludedSegments.clear();
      changed = true;
    }
    if (this.browseExcludedSegmentsKey !== undefined) {
      this.browseExcludedSegmentsKey = undefined;
      changed = true;
    }
    this.overlayRebuildFrame = -1;
    return changed;
  }

  disposeRuntimeState(
    options: SpatiallyIndexedSkeletonSourceRuntimeDisposalOptions = {},
  ) {
    const overlayChanged = this.clearOverlayRuntimeState();
    const sourceChanged = disposeSpatiallyIndexedSkeletonSourceRuntimeState(
      this.getUniqueChunkSources(),
      options,
    );
    const changed = overlayChanged || sourceChanged;
    if (changed) {
      this.redrawNeeded.dispatch();
    }
    return changed;
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

  private getOverlayTopologyKey(segmentIds: readonly number[]) {
    return [
      segmentIds.join(","),
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

  // Segment fill color a node's outline should contrast against, or undefined
  // when no segment can be resolved. Falls back to the currently selected
  // segment when the node carries no segment id.
  private getNodeSegmentColor(
    nodeInfo: SelectedSkeletonNodeInfo,
  ): Float32Array | undefined {
    const segmentId =
      nodeInfo.segmentId !== undefined
        ? BigInt(nodeInfo.segmentId)
        : this.displayState.segmentSelectionState.baseValue;
    if (segmentId === undefined) {
      return undefined;
    }
    return getBaseObjectColor(this.displayState, segmentId);
  }

  // Updates `selectedNodeOutlineColor` and `highlightedNodeOutlineColor` in
  // place. Each outline is chosen, independently of the other, for high contrast
  // against its own node's segment color: the selected node uses the muted
  // palette, and the hovered node uses its own segment color pushed away from
  // (or, if already very saturated, towards) grey. Because the two are computed
  // independently, a given segment color always yields the same selected color
  // and the same hovered color.
  private updateNodeOutlineColorPair() {
    const currentGeneration = this.nodeOutlineColorGeneration;
    if (this.cachedNodeOutlineColorGeneration === currentGeneration) {
      return;
    }
    this.cachedNodeOutlineColorGeneration = currentGeneration;

    const selectedNodeInfo = this.selectedNodeInfo?.value;
    const selectedSegmentColor =
      selectedNodeInfo !== undefined
        ? this.getNodeSegmentColor(selectedNodeInfo)
        : undefined;
    if (selectedSegmentColor !== undefined) {
      this.selectedNodeOutlineColor.set(
        pickHighestContrastColor(
          SELECTED_NODE_HIGHLIGHT_COLORS,
          selectedSegmentColor,
        ),
      );
    } else {
      vec3.copy(
        this.selectedNodeOutlineColor,
        SELECTED_NODE_OUTLINE_FALLBACK_COLOR,
      );
    }

    const hoveredNodeInfo = this.hoveredNodeInfo?.value;
    const hoveredSegmentColor =
      hoveredNodeInfo !== undefined
        ? this.getNodeSegmentColor(hoveredNodeInfo)
        : undefined;
    if (hoveredSegmentColor !== undefined) {
      const saturationFactor =
        getSaturation(hoveredSegmentColor) >
        HIGHLIGHTED_NODE_BORDER_SATURATION_THRESHOLD
          ? 1.0 - HIGHLIGHTED_NODE_BORDER_SATURATION_FACTOR
          : 1.0 + HIGHLIGHTED_NODE_BORDER_SATURATION_FACTOR;
      this.highlightedNodeOutlineColor.set(
        saturateColor(hoveredSegmentColor, saturationFactor),
      );
    } else {
      vec3.copy(
        this.highlightedNodeOutlineColor,
        SELECTED_NODE_OUTLINE_FALLBACK_COLOR,
      );
    }
  }

  getRetainedOverlaySegmentIds() {
    return [...this.retainedOverlaySegments.keys()];
  }

  /**
   * Stores `nextRetainedOverlaySegments` and reports whether the set of keys
   * changed. A recency-only touch still updates the stored map, but only a
   * membership change bumps `retainedOverlaySegmentIdsVersion` and warrants
   * a redraw. Shared by `retainOverlaySegment` and `markSegmentEdited`.
   */
  private applyRetainedOverlaySegments(
    nextRetainedOverlaySegments: Map<number, number>,
  ): boolean {
    const previousRetainedOverlaySegments = this.retainedOverlaySegments;
    this.retainedOverlaySegments = nextRetainedOverlaySegments;
    if (
      nextRetainedOverlaySegments.size ===
        previousRetainedOverlaySegments.size &&
      [...nextRetainedOverlaySegments.keys()].every((candidateSegmentId) =>
        previousRetainedOverlaySegments.has(candidateSegmentId),
      )
    ) {
      return false;
    }
    ++this.retainedOverlaySegmentIdsVersion;
    return true;
  }

  retainOverlaySegment(segmentId: number) {
    return this.markSegmentEdited(segmentId);
  }

  markSegmentEdited(segmentId: number) {
    const normalizedSegmentId = Math.round(Number(segmentId));
    if (
      !Number.isSafeInteger(normalizedSegmentId) ||
      normalizedSegmentId <= 0
    ) {
      return false;
    }
    let changed = false;
    if (!this.editedSegmentIds.has(normalizedSegmentId)) {
      this.editedSegmentIds.add(normalizedSegmentId);
      ++this.editedSegmentIdsVersion;
      changed = true;
    }
    // Refresh recency on every edit, not just the first, so a segment under
    // continuous editing doesn't age out of the pool between retains.
    if (
      this.applyRetainedOverlaySegments(
        retainSpatiallyIndexedSkeletonOverlaySegment(
          this.retainedOverlaySegments,
          normalizedSegmentId,
          ++this.overlaySegmentTouchCounter,
          { maxRetained: this.maxRetainedOverlaySegments },
        ),
      )
    ) {
      changed = true;
    }
    if (changed) {
      this.redrawNeeded.dispatch();
    }
    return changed;
  }

  private getOverlayRenderSegmentIds() {
    // The merged list depends only on the visible-segment set and the retained
    // list; both expose a cheap version (the hash-table generation and a counter
    // bumped on replacement), so the sort/merge can be skipped when unchanged.
    const visibleSet = getVisibleSegments(
      this.displayState.segmentationGroupState.value,
    );
    const visibleGeneration = visibleSet.hashTable.generation;
    if (
      this.cachedOverlayRenderVisibleSet === visibleSet &&
      this.cachedOverlayRenderVisibleGeneration === visibleGeneration &&
      this.cachedOverlayRenderRetainedVersion ===
        this.retainedOverlaySegmentIdsVersion
    ) {
      return this.cachedOverlayRenderSegmentIds;
    }
    const result = mergeSpatiallyIndexedSkeletonOverlaySegmentIds(
      this.getActiveEditableSegmentIds(),
      [...this.retainedOverlaySegments.keys()],
    );
    this.cachedOverlayRenderVisibleSet = visibleSet;
    this.cachedOverlayRenderVisibleGeneration = visibleGeneration;
    this.cachedOverlayRenderRetainedVersion =
      this.retainedOverlaySegmentIdsVersion;
    this.cachedOverlayRenderSegmentIds = result;
    return result;
  }

  private getNormalizedBrowsePassExcludedSegmentIds() {
    return [...this.editedSegmentIds].sort((a, b) => a - b);
  }

  private getBrowsePassExcludedSegments() {
    // Called once per browse pass per panel per frame. `editedSegmentIds` only
    // changes on edit operations, so skip the sort/join/set rebuild entirely
    // while it is unchanged.
    if (this.cachedBrowseExcludedVersion === this.editedSegmentIdsVersion) {
      return this.cachedBrowseExcludedResult;
    }
    this.cachedBrowseExcludedVersion = this.editedSegmentIdsVersion;
    const segmentIds = this.getNormalizedBrowsePassExcludedSegmentIds();
    if (segmentIds.length === 0) {
      if (this.browseExcludedSegments.size !== 0) {
        this.browseExcludedSegments.clear();
      }
      this.browseExcludedSegmentsKey = undefined;
      this.cachedBrowseExcludedResult = undefined;
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
    this.cachedBrowseExcludedResult = this.browseExcludedSegments;
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

    const topologyKey = this.getOverlayTopologyKey(loadedSegmentIds);

    if (
      this.overlayChunk !== undefined &&
      this.overlayTopologyKey === topologyKey
    ) {
      // Topology unchanged, so no rebuild. Live node-drag position changes are
      // applied per-draw via a shader uniform (see applyOverlayNodePositionOverride),
      // and selection/hover highlights are DOM overlays — none of these rebuild
      // the GPU geometry.
      return this.overlayChunk;
    }

    // Topology cache miss — collect node sets and rebuild.
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
      { getPendingNodePosition: this.getPendingNodePositionOverride },
    );
    this.overlayChunk = new SkeletonOverlayChunk(
      this.gl,
      geometry,
      this.overlayAttributeTextureFormats,
    );
    this.overlayTopologyKey = topologyKey;
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
      this.disposeRuntimeState();
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
    this.selectedNodeInfo = options.selectedNodeInfo;
    this.suppressSelectedNodeHighlight = options.suppressSelectedNodeHighlight;
    this.hoveredNodeInfo = options.hoveredNodeInfo;
    this.getPendingNodePositionOverride = options.getPendingNodePosition;
    this.getPendingNodeIds = options.getPendingNodeIds;
    this.getCachedNodeInfo = options.getCachedNode;
    this.resolveGlobalPosition = options.resolveGlobalPosition;
    this.inspectionState = options.inspectionState;
    this.maxRetainedOverlaySegments = Math.max(
      1,
      Math.round(
        options.maxRetainedOverlaySegments ??
          DEFAULT_MAX_RETAINED_OVERLAY_SEGMENTS,
      ),
    );
    registerRedrawWhenSegmentationDisplayState3DChanged(displayState, this);
    const invalidateNodeOutlineColors = () => {
      ++this.nodeOutlineColorGeneration;
    };
    this.displayState.shaderError.value = undefined;
    const { skeletonRenderingOptions: renderingOptions } = displayState;
    this.registerDisposer(
      renderingOptions.shader.changed.add(() => {
        this.displayState.shaderError.value = undefined;
        this.redrawNeeded.dispatch();
      }),
    );

    this.vertexAttributes = [...this.source.vertexAttributes];
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
      registerNested((context, colorGroupState) => {
        context.registerDisposer(
          colorGroupState.segmentColorHash.changed.add(
            invalidateNodeOutlineColors,
          ),
        );
        context.registerDisposer(
          colorGroupState.segmentStatedColors.changed.add(
            invalidateNodeOutlineColors,
          ),
        );
        context.registerDisposer(
          colorGroupState.segmentDefaultColor.changed.add(
            invalidateNodeOutlineColors,
          ),
        );
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

    this.browsePassLayerView = {
      vertexAttributes: this.source.vertexAttributes,
      gl: this.gl,
      fallbackShaderParameters: this.fallbackShaderParameters,
      displayState: this.displayState,
      skeletonShaderParameters: this.browsePassSkeletonShaderParameters,
    };
    const requestRedraw = () => this.redrawNeeded.dispatch();
    // Node highlights are DOM overlays, so a selected/hovered change repositions
    // the markers without a canvas redraw.
    if (this.selectedNodeInfo?.changed) {
      this.registerDisposer(
        this.selectedNodeInfo.changed.add(() => {
          // Recompute the marker's contrast color for the new node.
          invalidateNodeOutlineColors();
          this.highlightMarkersChanged.dispatch();
        }),
      );
    }
    if (this.suppressSelectedNodeHighlight?.changed) {
      this.registerDisposer(
        // The selected-node ring is a DOM overlay, so toggling suppression must
        // refresh the markers (not just request a canvas redraw).
        this.suppressSelectedNodeHighlight.changed.add(() => {
          this.highlightMarkersChanged.dispatch();
        }),
      );
    }
    if (this.hoveredNodeInfo?.changed) {
      this.registerDisposer(
        this.hoveredNodeInfo.changed.add(() => {
          invalidateNodeOutlineColors();
          this.highlightMarkersChanged.dispatch();
        }),
      );
    }
    const pendingNodePositionVersion = options.pendingNodePositionVersion;
    if (pendingNodePositionVersion?.changed) {
      this.registerDisposer(
        pendingNodePositionVersion.changed.add(() => {
          // A node's position moved: redraw geometry and reposition markers.
          requestRedraw();
          this.highlightMarkersChanged.dispatch();
        }),
      );
    }
    const inspectionState = this.inspectionState;
    if (inspectionState !== undefined) {
      this.registerDisposer(
        inspectionState.nodeDataVersion.changed.add(() => {
          invalidateNodeOutlineColors();
          this.redrawNeeded.dispatch();
          // A highlighted node's cached position may now be available.
          this.highlightMarkersChanged.dispatch();
        }),
      );
    }
    // A marker is emitted only when its node's skeleton would be drawn (see
    // computeHighlightMarkers), so its visibility depends on the object alphas
    // and the visible-segment set. Refresh the overlay when any of those change.
    const refreshHighlightVisibility = () => {
      this.highlightMarkersChanged.dispatch();
    };
    this.registerDisposer(
      this.displayState.objectAlpha.changed.add(refreshHighlightVisibility),
    );
    this.registerDisposer(
      this.displayState.hiddenObjectAlpha.changed.add(
        refreshHighlightVisibility,
      ),
    );
    const segmentationGroupState =
      this.displayState.segmentationGroupState.value;
    onVisibleSegmentsStateChanged(
      this,
      segmentationGroupState,
      refreshHighlightVisibility,
    );
    onTemporaryVisibleSegmentsStateChanged(
      this,
      segmentationGroupState,
      refreshHighlightVisibility,
    );
    // Create backend for perspective view chunk management
    const sharedObject = this.registerDisposer(
      new ChunkRenderLayerFrontend(this.layerChunkProgressInfo),
    );
    const rpc = chunkManager.rpc!;
    this.rpc = rpc;
    sharedObject.RPC_TYPE_ID = SPATIALLY_INDEXED_SKELETON_RENDER_LAYER_RPC_ID;

    const skeletonSpacingTargetWatchable = this.registerDisposer(
      SharedWatchableValue.makeFromExisting(
        rpc,
        this.displayState.spatialSkeletonSpacingTarget3d,
      ),
    );

    const skeletonSpacingTarget2dWatchable = this.registerDisposer(
      SharedWatchableValue.makeFromExisting(
        rpc,
        this.displayState.spatialSkeletonSpacingTarget2d,
      ),
    );

    const hiddenSkeletonsVisibleWatchable = this.registerDisposer(
      SharedWatchableValue.makeFromExisting(
        rpc,
        this.registerDisposer(
          makeCachedDerivedWatchableValue(
            (alpha) => alpha > 0,
            [this.displayState.hiddenObjectAlpha],
          ),
        ),
      ),
    );

    sharedObject.initializeCounterpart(rpc, {
      chunkManager: chunkManager.rpcId,
      localPosition: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(rpc, this.localPosition),
      ).rpcId,
      skeletonSpacingTarget: skeletonSpacingTargetWatchable.rpcId,
      skeletonSpacingTarget2d: skeletonSpacingTarget2dWatchable.rpcId,
      hiddenSkeletonsVisible: hiddenSkeletonsVisibleWatchable.rpcId,
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

  /**
   * Builds highlight markers for the selected/hovered nodes.  `diameter` and
   * `borderWidth` are the node's on-screen ring size (device px) for the calling
   * view, so the marker matches the node's size — the old in-shader outline sat
   * just outside the node with the same thickness.  Positions are resolved from
   * the stored info (model space) or the node cache, then transformed to global
   * space; entries whose position is unavailable are omitted.
   */
  computeHighlightMarkers(
    diameter: number,
    borderWidth: number,
  ): HighlightMarker[] {
    const { resolveGlobalPosition } = this;
    if (resolveGlobalPosition === undefined) return [];
    // Refresh the per-node contrast colors (selected uses the muted palette,
    // hovered uses its saturated segment color) so markers match the previous
    // in-shader outline colors.
    this.updateNodeOutlineColorPair();
    // Mirror the shader's per-segment visibility so a ring is never drawn over a
    // skeleton that isn't rendered: a segment draws at `objectAlpha` when it is
    // visible/selected and at `hiddenObjectAlpha` otherwise.
    const visibleSegments = getVisibleSegments(
      this.displayState.segmentationGroupState.value,
    );
    const objectAlpha = this.displayState.objectAlpha.value;
    const hiddenObjectAlpha = this.displayState.hiddenObjectAlpha.value;
    const markers: HighlightMarker[] = [];
    const add = (
      info: SelectedSkeletonNodeInfo | undefined,
      kind: HighlightMarker["kind"],
      color: vec3,
    ) => {
      const nodeId = info?.nodeId;
      if (nodeId === undefined) return;
      const segmentId = info?.segmentId;
      if (segmentId !== undefined) {
        const effectiveAlpha = visibleSegments.has(BigInt(segmentId))
          ? objectAlpha
          : hiddenObjectAlpha;
        if (effectiveAlpha <= 0) return;
      } else if (objectAlpha <= 0 && hiddenObjectAlpha <= 0) {
        // Unknown segment: fall back to the whole-layer invisibility test.
        return;
      }
      // Prefer the live cached position (which applies any pending move) so the
      // marker stays in sync when the node moves; fall back to the position
      // captured at selection time if the node isn't currently cached.
      const modelPosition =
        this.getCachedNodeSnapshot(nodeId)?.position ?? info?.position;
      if (modelPosition === undefined) return;
      const global = resolveGlobalPosition(modelPosition);
      if (global === undefined) return;
      // Halo contrasts with the ring color: white around a dark ring, black
      // around a light one (WCAG black/white crossover luminance ~0.179).
      const outlineColor =
        getRelativeLuminance(color) < 0.179
          ? "rgba(255, 255, 255, 0.85)"
          : "rgba(0, 0, 0, 0.75)";
      markers.push({
        position: global,
        kind,
        color: vec3ToCssColor(color),
        outlineColor,
        diameter,
        borderWidth,
      });
    };
    const selectedNodeId = this.suppressSelectedNodeHighlight?.value
      ? undefined
      : this.selectedNodeInfo?.value?.nodeId;
    const hoveredNodeId = this.hoveredNodeInfo?.value?.nodeId;
    // When the same node is both selected and hovered, show only the hovered
    // marker (as the old shader did — hovered won over selected), avoiding an
    // overlapping ring.
    if (selectedNodeId !== undefined && selectedNodeId !== hoveredNodeId) {
      add(
        this.selectedNodeInfo?.value,
        "selected",
        this.selectedNodeOutlineColor,
      );
    }
    add(
      this.hoveredNodeInfo?.value,
      "hovered",
      this.highlightedNodeOutlineColor,
    );
    return markers;
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
      const chunkKeys = new Set<string>();
      const { spec } = chunkSource;
      for (const position of positionList) {
        // Spatial skeleton node positions are already source/model coordinates;
        // render-layer transforms do not apply to CATMAID grid-cell keys.
        const chunkKey = getSpatialSkeletonChunkKey(spec, position);
        if (chunkKey !== undefined) {
          chunkKeys.add(chunkKey);
        }
      }
      if (chunkKeys.size === 0) {
        continue;
      }
      chunkSource.invalidateCacheKeys(chunkKeys);
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
    if (!offsets || offsets.length < 2) return undefined;
    const positions = new Float32Array(
      chunk.vertexAttributes.buffer,
      chunk.vertexAttributes.byteOffset + offsets[0],
      chunk.numVertices * 3,
    );
    const segmentIds = new Uint32Array(
      chunk.vertexAttributes.buffer,
      chunk.vertexAttributes.byteOffset + offsets[1],
      chunk.numVertices,
    );
    return { positions, segmentIds };
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

  // Iterates every chunk slot selected by the current spacing target.
  // Callback receives (chunkKey, chunkSource, chunkLayout).
  private forEachVisibleChunkSlot(
    transformedSources: readonly TransformedSource[][],
    projectionParameters: ProjectionParameters,
    spacingTarget: number,
    callback: (
      chunkKey: string,
      chunkSource: SpatiallyIndexedSkeletonSource,
      chunkLayout: ChunkLayout,
    ) => void,
  ) {
    for (const scales of transformedSources) {
      forEachVisibleSpatialSkeletonChunk(
        projectionParameters,
        this.localPosition.value,
        spacingTarget,
        scales,
        () => {},
        (tsource) => {
          callback(
            tsource.curPositionInChunks.join(),
            tsource.source as SpatiallyIndexedSkeletonSource,
            tsource.chunkLayout,
          );
        },
      );
    }
  }

  // Walks the visible chunk set once per panel per frame: collects GPU-resident
  // chunks into the reused `out` array (pooled to avoid per-frame allocation of a
  // fresh array plus one object per visible chunk) and updates the resolution
  // histogram (present/absent bars plus unselected-scale indicator bars) in the
  // same traversal, rather than walking the chunk set a second time. Returns
  // `out`, whose length is set to the number of collected chunks.
  updateVisibleChunksAndHistogram(
    transformedSources: readonly TransformedSource[][],
    projectionParameters: ProjectionParameters,
    spacingTarget: number,
    histogram: RenderScaleHistogram,
    frameNumber: number,
    out: VisibleChunk[],
  ): VisibleChunk[] {
    histogram.begin(frameNumber);
    let count = 0;
    if (transformedSources.length === 0) {
      out.length = 0;
      return out;
    }
    let seen = seenChunkKeysPerFrame.get(histogram);
    if (seen === undefined || seen.frameNumber !== frameNumber) {
      seen = { frameNumber, keys: new Set() };
      seenChunkKeysPerFrame.set(histogram, seen);
    }
    const seenKeys = seen.keys;
    const localPosition = this.localPosition.value;
    for (const scales of transformedSources) {
      forEachSpatialSkeletonSourceScale(
        projectionParameters,
        spacingTarget,
        scales,
        (tsource, _, physicalSpacing, pixelSpacing, selected) => {
          if (selected) return;
          const source = tsource.source as SpatiallyIndexedSkeletonSource;
          const indicatorKey = `indicator:${getObjectId(source)}`;
          if (seenKeys.has(indicatorKey)) return;
          seenKeys.add(indicatorKey);
          histogram.add(
            physicalSpacing,
            pixelSpacing,
            0,
            SPATIAL_SKELETON_RESOLUTION_INDICATOR_BAR_HEIGHT,
            true,
          );
        },
      );
      forEachVisibleSpatialSkeletonChunk(
        projectionParameters,
        localPosition,
        spacingTarget,
        scales,
        () => {},
        (tsource, _, physicalSpacing, pixelSpacing) => {
          const source = tsource.source as SpatiallyIndexedSkeletonSource;
          const chunkKey = tsource.curPositionInChunks.join();
          const chunk = source.chunks.get(chunkKey);
          const isGpuResident = chunk?.state === ChunkState.GPU_MEMORY;
          if (isGpuResident) {
            // Collect for drawing. Pooled: reuse existing entry objects in place,
            // growing the array only when this frame has more chunks than the last.
            const entry = out[count];
            if (entry === undefined) {
              out[count] = { chunk: chunk!, chunkLayout: tsource.chunkLayout };
            } else {
              entry.chunk = chunk!;
              entry.chunkLayout = tsource.chunkLayout;
            }
            ++count;
          }
          // Histogram present/absent accounting is deduplicated across panels via
          // the per-frame seen set so a chunk visible in more than one panel is
          // counted once; the draw list above is intentionally per-panel and not
          // deduplicated.
          const seenKey = `${getObjectId(source)}:${chunkKey}`;
          if (!seenKeys.has(seenKey)) {
            seenKeys.add(seenKey);
            if (isGpuResident) {
              histogram.add(physicalSpacing, pixelSpacing, 1, 0);
            } else {
              histogram.add(physicalSpacing, pixelSpacing, 0, 1);
            }
          }
        },
      );
    }
    out.length = count;
    return out;
  }

  private areVisibleChunksReady(
    transformedSources: readonly TransformedSource[][],
    projectionParameters: ProjectionParameters,
    spacingTarget: number,
  ) {
    if (
      this.displayState.objectAlpha.value <= 0.0 &&
      this.displayState.hiddenObjectAlpha.value <= 0.0
    ) {
      return true;
    }
    if (transformedSources.length === 0) {
      return false;
    }
    let ready = true;
    this.forEachVisibleChunkSlot(
      transformedSources,
      projectionParameters,
      spacingTarget,
      (chunkKey, chunkSource, _) => {
        const chunk = chunkSource.chunks.get(chunkKey);
        if (chunk?.state !== ChunkState.GPU_MEMORY) {
          ready = false;
        }
      },
    );
    return ready;
  }

  getNode(nodeId: number): SpatiallyIndexedSkeletonNode | undefined {
    if (!Number.isSafeInteger(nodeId) || nodeId <= 0) return undefined;
    return this.getCachedNodeSnapshot(nodeId);
  }

  getNodes(
    options: {
      segmentId?: bigint;
    } = {},
  ): SpatiallyIndexedSkeletonNode[] {
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
    renderHelper.setEdgeSizeUniforms(gl, edgeShader, lineWidth, pointDiameter);
    renderHelper.setPickInstanceStride(gl, edgeShader, 0);
    setControlsInShader(
      gl,
      edgeShader,
      shaderControlState,
      edgeShaderParameters.parseResult,
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
    renderHelper.setNodeSizeUniforms(gl, nodeShader, pointDiameter);
    renderHelper.setPickInstanceStride(gl, nodeShader, 0);
    setControlsInShader(
      gl,
      nodeShader,
      shaderControlState,
      nodeShaderParameters.parseResult,
    );
    renderHelper.setColor(gl, nodeShader, kOneVec4);
    renderHelper.maybeEnableDynamicSegmentAppearance(
      gl,
      nodeShader,
      skeletonParams,
      excludedGPUTable,
    );

    return {
      gl,
      edgeShader,
      nodeShader,
      skeletonParams,
    };
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

    nodeShader.bind();

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
      // this is kept in addition to the wireframe because of cross
      // chunk edge double drawing issues
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

  // Sets the shader position override to the one node currently being dragged
  // (if any) that belongs to `overlayChunk`. Reads the live pending state each
  // draw; leaves the override disabled (as beginLayer set it) when no dragged
  // node maps into this chunk.
  private applyOverlayNodePositionOverride(
    gl: GL,
    renderHelper: RenderHelper,
    edgeShader: ShaderProgram,
    nodeShader: ShaderProgram,
    overlayChunk: SkeletonOverlayChunk,
  ) {
    const getPendingNodeIds = this.getPendingNodeIds;
    const getPendingNodePosition = this.getPendingNodePositionOverride;
    if (
      getPendingNodeIds === undefined ||
      getPendingNodePosition === undefined
    ) {
      return;
    }
    for (const nodeId of getPendingNodeIds()) {
      const vertexIndex = overlayChunk.nodeIndex.get(nodeId);
      if (vertexIndex === undefined) continue;
      const position = getPendingNodePosition(nodeId);
      if (position === undefined) continue;
      edgeShader.bind();
      renderHelper.setNodePositionOverride(
        gl,
        edgeShader,
        vertexIndex,
        position,
      );
      nodeShader.bind();
      renderHelper.setNodePositionOverride(
        gl,
        nodeShader,
        vertexIndex,
        position,
      );
      // Exactly one node is dragged at a time.
      return;
    }
  }

  private drawInspectionOverlayPass(
    renderContext: SliceViewPanelRenderContext | PerspectiveViewRenderContext,
    layer: RenderLayer,
    renderHelper: RenderHelper,
    modelMatrix: mat4,
    lineWidth: number,
    pointDiameter: number,
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

    nodeShader.bind();

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

    // Live node drag: override just the moving vertex's position via a uniform,
    // instead of re-uploading the position texture. `beginSkeletonRenderPass`
    // left the override disabled (-1); set it here for the one dragged node that
    // belongs to this overlay chunk. Exactly one node moves at a time.
    this.applyOverlayNodePositionOverride(
      gl,
      renderHelper,
      edgeShader,
      nodeShader,
      overlayChunk,
    );

    renderHelper.drawSkeletons(
      gl,
      edgeShader,
      nodeShader,
      overlayChunk,
      renderContext.projectionParameters,
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
    );
    this.drawInspectionOverlayPass(
      renderContext,
      layer,
      overlayRenderHelper,
      modelMatrix,
      lineWidth,
      pointDiameter,
    );
  }

  isReady(
    transformedSources: readonly TransformedSource[][],
    projectionParameters: ProjectionParameters,
    spacingTarget: number,
  ) {
    return this.areVisibleChunksReady(
      transformedSources,
      projectionParameters,
      spacingTarget,
    );
  }
}

function transformSpatiallyIndexedSkeletonPickedValue(
  pickState: PickState,
): bigint | undefined {
  const pickedSegmentId = pickState.pickedSpatialSkeleton?.segmentId;
  if (
    typeof pickedSegmentId === "number" &&
    Number.isSafeInteger(pickedSegmentId)
  ) {
    return BigInt(pickedSegmentId);
  }
  return undefined;
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
    const segmentId = data.segmentIds[pickedOffset];
    if (!Number.isSafeInteger(segmentId) || segmentId <= 0) {
      return;
    }
    mouseState.pickedSpatialSkeleton = { segmentId };
    const nodeId = data.nodeIds[pickedOffset];
    if (!Number.isSafeInteger(nodeId) || nodeId <= 0) return;
    const nodePosition = data.nodePositions.subarray(
      pickedOffset * 3,
      pickedOffset * 3 + 3,
    );
    mouseState.pickedSpatialSkeleton = {
      nodeId,
      segmentId,
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
    const segmentId = data.segmentIds[pickedOffset];
    if (Number.isSafeInteger(segmentId) && segmentId > 0) {
      mouseState.pickedSpatialSkeleton = { segmentId };
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
          segmentId: pickedNode.segmentId,
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
      mouseState.pickedSpatialSkeleton = { segmentId };
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

export class PerspectiveViewSpatiallyIndexedSkeletonLayer
  extends PerspectiveViewRenderLayer
  implements PanelOverlaySource
{
  private renderHelper: RenderHelper;
  private browseRenderHelper: RenderHelper;
  private renderOptions: ViewSpecificSkeletonRenderingOptions;
  transformedSources: TransformedSource[][] = [];
  // Reused across frames to avoid allocating a fresh array plus one object per
  // visible chunk on every draw. Consumed synchronously within draw().
  private readonly visibleChunksScratch: VisibleChunk[] = [];
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
    const spacingTarget3d = base.displayState.spatialSkeletonSpacingTarget3d;
    this.registerDisposer(
      spacingTarget3d.changed.add(this.redrawNeeded.dispatch),
    );
    const histogram3d = base.displayState.spatialSkeletonSpacingHistogram3d;
    this.registerDisposer(histogram3d.visibility.add(this.visibility));
  }

  readonly overlayPriority = 0;
  get overlayUpdateNeeded() {
    return this.base.highlightMarkersChanged;
  }
  updatePanelOverlays(ctx: PanelOverlayContext) {
    const { renderOptions } = this;
    const ring = getSkeletonNodeHighlightRing(
      renderOptions.mode.value,
      renderOptions.lineWidth.value,
      /*targetIsSliceView=*/ false,
    );
    updateSkeletonHighlightOverlay(
      this.base.computeHighlightMarkers(ring.diameter, ring.borderWidth),
      ctx,
    );
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
    const spacingTarget = displayState.spatialSkeletonSpacingTarget3d.value;
    const histogram = displayState.spatialSkeletonSpacingHistogram3d;
    const frameNumber =
      this.base.chunkManager.chunkQueueManager.frameNumberCounter.frameNumber;
    const visibleChunks = this.base.updateVisibleChunksAndHistogram(
      this.transformedSources,
      renderContext.projectionParameters,
      spacingTarget,
      histogram,
      frameNumber,
      this.visibleChunksScratch,
    );
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
      this.transformedSources,
      renderContext.projectionParameters,
      displayState.spatialSkeletonSpacingTarget3d.value,
    );
  }
}

export class SliceViewPanelSpatiallyIndexedSkeletonLayer
  extends SliceViewPanelRenderLayer
  implements PanelOverlaySource
{
  private renderHelper: RenderHelper;
  private browseRenderHelper: RenderHelper;
  private renderOptions: ViewSpecificSkeletonRenderingOptions;
  transformedSources: TransformedSource[][] = [];
  // Reused across frames to avoid allocating a fresh array plus one object per
  // visible chunk on every draw. Consumed synchronously within draw().
  private readonly visibleChunksScratch: VisibleChunk[] = [];
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
    const spacingTarget2d = displayState2d.spatialSkeletonSpacingTarget2d;
    this.registerDisposer(
      spacingTarget2d.changed.add(this.redrawNeeded.dispatch),
    );
    const histogram2d = displayState2d.spatialSkeletonSpacingHistogram2d;
    this.registerDisposer(histogram2d.visibility.add(this.visibility));
  }

  get gl() {
    return this.base.gl;
  }

  readonly overlayPriority = 0;
  get overlayUpdateNeeded() {
    return this.base.highlightMarkersChanged;
  }
  updatePanelOverlays(ctx: PanelOverlayContext) {
    const { renderOptions } = this;
    const ring = getSkeletonNodeHighlightRing(
      renderOptions.mode.value,
      renderOptions.lineWidth.value,
      /*targetIsSliceView=*/ true,
    );
    updateSkeletonHighlightOverlay(
      this.base.computeHighlightMarkers(ring.diameter, ring.borderWidth),
      ctx,
    );
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
    const spacingTarget = displayState.spatialSkeletonSpacingTarget2d.value;
    const histogram = displayState.spatialSkeletonSpacingHistogram2d;
    const frameNumber =
      this.base.chunkManager.chunkQueueManager.frameNumberCounter.frameNumber;
    const visibleChunks = this.base.updateVisibleChunksAndHistogram(
      this.transformedSources,
      renderContext.sliceView.projectionParameters.value,
      spacingTarget,
      histogram,
      frameNumber,
      this.visibleChunksScratch,
    );
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
      this.transformedSources,
      renderContext.projectionParameters,
      displayState.spatialSkeletonSpacingTarget2d.value,
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
