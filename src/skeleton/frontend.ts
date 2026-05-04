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
import { GPUHashTable, HashSetShaderManager } from "#src/gpu_hash/shader.js";
import type {
  LayerView,
  MouseSelectionState,
  PickState,
  UserLayer,
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
import { RENDERED_VIEW_ADD_LAYER_RPC_ID } from "#src/render_layer_common.js";
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
import type {
  SegmentationDisplayState3D,
  SegmentationDisplayState,
} from "#src/segmentation_display_state/frontend.js";
import {
  forEachVisibleSegmentToDraw,
  registerRedrawWhenSegmentationDisplayState3DChanged,
  SegmentationLayerSharedObject,
} from "#src/segmentation_display_state/frontend.js";
import { SharedWatchableValue } from "#src/shared_watchable_value.js";
import type { SpatiallyIndexedSkeletonNode } from "#src/skeleton/api.js";
import type { VertexAttributeInfo } from "#src/skeleton/base.js";
import {
  SKELETON_LAYER_RPC_ID,
  SPATIALLY_INDEXED_SKELETON_RENDER_LAYER_RPC_ID,
  SPATIALLY_INDEXED_SKELETON_RENDER_LAYER_UPDATE_SOURCES_RPC_ID,
  SPATIALLY_INDEXED_SKELETON_SLICEVIEW_RENDER_LAYER_RPC_ID,
} from "#src/skeleton/base.js";
import { uploadVertexAttributesToGPU } from "#src/skeleton/gpu_upload_utils.js";
import { buildSpatiallyIndexedSkeletonOverlayGeometry } from "#src/skeleton/overlay_geometry.js";
import {
  DEFAULT_MAX_RETAINED_OVERLAY_SEGMENTS,
  mergeSpatiallyIndexedSkeletonOverlaySegmentIds,
  retainSpatiallyIndexedSkeletonOverlaySegment,
} from "#src/skeleton/overlay_segment_retention.js";
import { resolveSpatiallyIndexedSkeletonSegmentPick } from "#src/skeleton/picking.js";
import { SkeletonRenderMode } from "#src/skeleton/render_mode.js";
import {
  getSpatiallyIndexedSkeletonGridIndex,
  getSpatiallyIndexedSkeletonSourceView,
  selectSpatiallyIndexedSkeletonEntriesByGrid,
  selectSpatiallyIndexedSkeletonEntriesForView,
  type SpatiallyIndexedSkeletonView,
} from "#src/skeleton/source_selection.js";
import { spatiallyIndexedSkeletonTextureAttributeSpecs } from "#src/skeleton/spatial_attribute_layout.js";
import {
  forEachPlaneIntersectingVolumetricChunk,
  getNormalizedChunkLayout,
  forEachVisibleVolumetricChunk,
  type SliceViewBase,
  type SliceViewChunkSpecification,
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
  SliceViewRenderContext,
  SliceViewPanelReadyRenderContext,
} from "#src/sliceview/renderlayer.js";
import {
  SliceViewPanelRenderLayer,
  SliceViewRenderLayer,
} from "#src/sliceview/renderlayer.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import {
  makeCachedLazyDerivedWatchableValue,
  TrackableValue,
  WatchableValue,
  registerNested,
} from "#src/trackable_value.js";
import { Uint64Set } from "#src/uint64_set.js";
import { gatherUpdate } from "#src/util/array.js";
import { DATA_TYPE_SIGNED, DataType } from "#src/util/data_type.js";
import { RefCounted } from "#src/util/disposable.js";
import type { ValueOrError } from "#src/util/error.js";
import { makeValueOrError, valueOrThrow } from "#src/util/error.js";
import { mat4 } from "#src/util/geom.js";
import { verifyFinitePositiveFloat } from "#src/util/json.js";
import * as matrix from "#src/util/matrix.js";
import { getObjectId } from "#src/util/object_id.js";
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
  TextureFormat,
} from "#src/webgl/texture_access.js";
import { defineVertexId, VertexIdHelper } from "#src/webgl/vertex_id.js";
import type { RPC } from "#src/worker_rpc.js";

const tempMat2 = mat4.create();
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
const segmentTextureFormat = computeTextureFormat(
  new TextureFormat(),
  DataType.UINT32,
  1,
);
const selectedNodeTextureFormat = computeTextureFormat(
  new TextureFormat(),
  DataType.FLOAT32,
  1,
);

interface SkeletonLayerInterface {
  vertexAttributes: VertexAttributeRenderInfo[];
  segmentColorAttributeIndex?: number;
  dynamicSegmentAppearance?: boolean;
  gl: GL;
  fallbackShaderParameters: WatchableValue<ShaderControlsBuilderState>;
  displayState: SkeletonLayerDisplayState;
}

interface SkeletonChunkInterface {
  vertexAttributeTextures: (WebGLTexture | null)[];
  indexBuffer: GLBuffer;
  numIndices: number;
  numVertices: number;
  pickNodeIds?: Int32Array;
  pickNodePositions?: Float32Array;
  pickSegmentIds?: Uint32Array;
  pickEdgeSegmentIds?: Uint32Array;
}

interface SkeletonChunkData {
  vertexAttributes: Uint8Array;
  indices: Uint32Array;
  numVertices: number;
  vertexAttributeOffsets: Uint32Array;
  nodeIds?: Int32Array;
  nodeRevisionTokens?: Array<string | undefined>;
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
  private dynamicSegmentAppearance: boolean;
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
  private gpuSegmentStatedColorHashTable: GPUHashTable<any> | undefined;
  private emptySegmentSet = new Uint64Set();
  get vertexAttributes(): VertexAttributeRenderInfo[] {
    return this.base.vertexAttributes;
  }

  defineCommonShader(builder: ShaderBuilder) {
    defineVertexId(builder);
    builder.addUniform("highp vec4", "uColor");
    builder.addUniform("highp mat4", "uProjection");
    builder.addUniform("highp uint", "uPickID");
  }

  private getSegmentColorExpression() {
    const index = this.segmentColorAttributeIndex;
    if (index === undefined) {
      return "uColor";
    }
    return `vCustom${index}`;
  }

  edgeShaderGetter;
  nodeShaderGetter;

  get gl(): GL {
    return this.base.gl;
  }

  disposed() {
    this.gpuSegmentStatedColorHashTable?.dispose();
    super.disposed();
  }

  private defineDynamicSegmentAppearance(builder: ShaderBuilder) {
    this.visibleSegmentsShaderManager.defineShader(builder);
    this.excludedSegmentsShaderManager.defineShader(builder);
    this.segmentColorShaderManager.defineShader(builder);
    this.segmentStatedColorShaderManager.defineShader(builder);
    builder.addUniform("highp float", "uVisibleAlpha");
    builder.addUniform("highp float", "uHiddenAlpha");
    builder.addUniform("highp vec3", "uSegmentDefaultColor");
    builder.addUniform("highp uint", "uSkipVisibleSegments");
    builder.addUniform("highp uint", "uUseSegmentDefaultColor");
    builder.addUniform("highp uint", "uUseSegmentStatedColors");
    builder.addFragmentCode(`
uint64_t getSegmentAppearanceId(highp uint segmentValue) {
  return uint64_t(uvec2(segmentValue, 0u));
}
vec3 getSegmentLookupColor(uint64_t segmentId) {
  vec4 statedColor;
  if (
    uUseSegmentStatedColors != 0u &&
    ${this.segmentStatedColorShaderManager.getFunctionName}(segmentId, statedColor)
  ) {
    return statedColor.rgb;
  }
  if (uUseSegmentDefaultColor != 0u) {
    return uSegmentDefaultColor;
  }
  return ${this.segmentColorShaderManager.prefix}(segmentId);
}
float getSegmentLookupAlpha(uint64_t segmentId) {
  if (${this.excludedSegmentsShaderManager.hasFunctionName}(segmentId)) {
    return 0.0;
  }
  bool isVisible = ${this.visibleSegmentsShaderManager.hasFunctionName}(segmentId);
  if (uSkipVisibleSegments != 0u && isVisible) {
    return 0.0;
  }
  return isVisible ? uVisibleAlpha : uHiddenAlpha;
}
vec4 getSegmentAppearance(highp uint segmentValue) {
  uint64_t segmentId = getSegmentAppearanceId(segmentValue);
  return vec4(getSegmentLookupColor(segmentId), getSegmentLookupAlpha(segmentId));
}
`);
  }

  enableDynamicSegmentAppearance(
    gl: GL,
    shader: ShaderProgram,
    skipVisibleSegments: boolean,
    excludedSegments?: Uint64Set,
  ) {
    if (!this.dynamicSegmentAppearance) return;
    const segmentationGroupState =
      this.base.displayState.segmentationGroupState.value;
    const visibleSegments = segmentationGroupState.useTemporaryVisibleSegments
      .value
      ? segmentationGroupState.temporaryVisibleSegments
      : segmentationGroupState.visibleSegments;
    this.visibleSegmentsShaderManager.enable(
      gl,
      shader,
      GPUHashTable.get(gl, visibleSegments.hashTable),
    );
    this.excludedSegmentsShaderManager.enable(
      gl,
      shader,
      GPUHashTable.get(
        gl,
        (excludedSegments ?? this.emptySegmentSet).hashTable,
      ),
    );
    gl.uniform1f(
      shader.uniform("uVisibleAlpha"),
      this.base.displayState.objectAlpha.value,
    );
    gl.uniform1f(
      shader.uniform("uHiddenAlpha"),
      this.base.displayState.hiddenObjectAlpha.value,
    );
    gl.uniform1ui(
      shader.uniform("uSkipVisibleSegments"),
      skipVisibleSegments ? 1 : 0,
    );

    const colorGroupState =
      this.base.displayState.segmentationColorGroupState.value;
    this.segmentColorShaderManager.enable(
      gl,
      shader,
      colorGroupState.segmentColorHash.value,
    );
    const segmentDefaultColor = colorGroupState.segmentDefaultColor.value;
    if (segmentDefaultColor === undefined) {
      gl.uniform1ui(shader.uniform("uUseSegmentDefaultColor"), 0);
    } else {
      gl.uniform1ui(shader.uniform("uUseSegmentDefaultColor"), 1);
      gl.uniform3f(
        shader.uniform("uSegmentDefaultColor"),
        segmentDefaultColor[0],
        segmentDefaultColor[1],
        segmentDefaultColor[2],
      );
    }

    const segmentStatedColors = colorGroupState.segmentStatedColors;
    if (segmentStatedColors.size === 0) {
      gl.uniform1ui(shader.uniform("uUseSegmentStatedColors"), 0);
      this.segmentStatedColorShaderManager.disable(gl, shader);
      return;
    }
    gl.uniform1ui(shader.uniform("uUseSegmentStatedColors"), 1);
    let { gpuSegmentStatedColorHashTable } = this;
    if (
      gpuSegmentStatedColorHashTable === undefined ||
      gpuSegmentStatedColorHashTable.hashTable !== segmentStatedColors.hashTable
    ) {
      gpuSegmentStatedColorHashTable?.dispose();
      this.gpuSegmentStatedColorHashTable = gpuSegmentStatedColorHashTable =
        GPUHashTable.get(gl, segmentStatedColors.hashTable);
    }
    this.segmentStatedColorShaderManager.enable(
      gl,
      shader,
      gpuSegmentStatedColorHashTable,
    );
  }

  disableDynamicSegmentAppearance(gl: GL, shader: ShaderProgram) {
    if (!this.dynamicSegmentAppearance) return;
    this.visibleSegmentsShaderManager.disable(gl, shader);
    this.excludedSegmentsShaderManager.disable(gl, shader);
    this.segmentStatedColorShaderManager.disable(gl, shader);
  }

  constructor(
    public base: SkeletonLayerInterface,
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
    this.dynamicSegmentAppearance =
      base.dynamicSegmentAppearance === true &&
      this.segmentAttributeIndex !== undefined;
    this.segmentColorAttributeIndex = base.segmentColorAttributeIndex;
    const selectedNodeAttrIndex = this.vertexAttributes.findIndex(
      (x) => x.name === selectedNodeAttribute.name,
    );
    this.selectedNodeAttributeIndex =
      selectedNodeAttrIndex >= 0 ? selectedNodeAttrIndex : undefined;
    this.edgeShaderGetter = parameterizedEmitterDependentShaderGetter(
      this,
      this.gl,
      {
        memoizeKey: {
          type: "skeleton/SkeletonShaderManager/edge",
          dynamicSegmentAppearance: this.dynamicSegmentAppearance,
          vertexAttributes: this.vertexAttributes,
        },
        fallbackParameters: this.base.fallbackShaderParameters,
        parameters:
          this.base.displayState.skeletonRenderingOptions.shaderControlState
            .builderState,
        shaderError: this.base.displayState.shaderError,
        defineShader: (
          builder: ShaderBuilder,
          shaderBuilderState: ShaderControlsBuilderState,
        ) => {
          if (shaderBuilderState.parseResult.errors.length !== 0) {
            throw new Error("Invalid UI control specification");
          }
          this.defineCommonShader(builder);
          this.defineAttributeAccess(builder);
          if (this.dynamicSegmentAppearance) {
            this.defineDynamicSegmentAppearance(builder);
          }
          defineLineShader(builder);
          builder.addAttribute("highp uvec2", "aVertexIndex");
          builder.addUniform("highp float", "uLineWidth");
          builder.addUniform("highp uint", "uPickInstanceStride");
          builder.addVarying("highp uint", "vPickID", "flat");
          if (this.dynamicSegmentAppearance) {
            builder.addVarying("highp uint", "vSegmentValue", "flat");
          }
          let vertexMain = `
highp uint pickOffset = uint(gl_InstanceID) * uPickInstanceStride;
vPickID = uPickID + pickOffset;
highp vec3 vertexA = readAttribute0(aVertexIndex.x);
highp vec3 vertexB = readAttribute0(aVertexIndex.y);
emitLine(uProjection, vertexA, vertexB, uLineWidth);
highp uint lineEndpointIndex = getLineEndpointIndex();
highp uint vertexIndex = aVertexIndex.x * (1u - lineEndpointIndex) + aVertexIndex.y * lineEndpointIndex;
`;
          if (
            this.dynamicSegmentAppearance &&
            this.segmentAttributeIndex !== undefined
          ) {
            vertexMain += `vSegmentValue = toRaw(readAttribute${this.segmentAttributeIndex}(aVertexIndex.x));\n`;
          }

          const segmentColorExpression = this.getSegmentColorExpression();
          const segmentAlphaExpression =
            this.segmentColorAttributeIndex === undefined
              ? "uColor.a"
              : `${segmentColorExpression}.a`;
          if (this.dynamicSegmentAppearance) {
            builder.addFragmentCode(`
vec4 segmentColor() {
  return getSegmentAppearance(vSegmentValue);
}
void emitRGB(vec3 color) {
  vec4 baseColor = segmentColor();
  highp float alpha = baseColor.a * getLineAlpha() * ${this.getCrossSectionFadeFactor()};
  if (alpha <= 0.0) discard;
  emit(vec4(color * alpha, alpha), vPickID);
}
void emitDefault() {
  vec4 baseColor = segmentColor();
  highp float alpha = baseColor.a * getLineAlpha() * ${this.getCrossSectionFadeFactor()};
  if (alpha <= 0.0) discard;
  emit(vec4(baseColor.rgb * alpha, alpha), vPickID);
}
`);
          } else if (this.segmentColorAttributeIndex === undefined) {
            // Preserve legacy skeleton behavior where `uColor` is already
            // premultiplied by `objectAlpha` in `getObjectColor`.
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
            builder.addFragmentCode(`
vec4 segmentColor() {
  return ${segmentColorExpression};
}
void emitRGB(vec3 color) {
  highp float alpha = ${segmentAlphaExpression} * getLineAlpha() * ${this.getCrossSectionFadeFactor()};
  emit(vec4(color * alpha, alpha), vPickID);
}
void emitDefault() {
  vec4 baseColor = segmentColor();
  highp float alpha = baseColor.a * getLineAlpha() * ${this.getCrossSectionFadeFactor()};
  emit(vec4(baseColor.rgb * alpha, alpha), vPickID);
}
`);
          }
          builder.addFragmentCode(glsl_COLORMAPS);
          const { vertexAttributes } = this;
          const numAttributes = vertexAttributes.length;
          for (let i = 1; i < numAttributes; ++i) {
            const info = vertexAttributes[i];
            if (
              this.dynamicSegmentAppearance &&
              i === this.segmentAttributeIndex
            ) {
              builder.addFragmentCode(dataTypeShaderDefinition[info.dataType]);
              builder.addFragmentCode(
                `#define ${info.name} ${info.glslDataType}(vSegmentValue)\n`,
              );
              builder.addFragmentCode(
                `#define prop_${info.name}() ${info.glslDataType}(vSegmentValue)\n`,
              );
              continue;
            }
            builder.addVarying(
              `highp ${getVertexAttributeVaryingType(info)}`,
              `vCustom${i}`,
              getVertexAttributeInterpolationMode(info.dataType),
            );
            vertexMain += `vCustom${i} = ${getVertexAttributeReadExpression(i, "vertexIndex", info)};\n`;
            if (info.dataType !== DataType.FLOAT32) {
              builder.addFragmentCode(dataTypeShaderDefinition[info.dataType]);
            }
            const fragmentExpression = getVertexAttributeFragmentExpression(
              `vCustom${i}`,
              info,
            );
            builder.addFragmentCode(
              `#define ${info.name} ${fragmentExpression}\n`,
            );
            builder.addFragmentCode(
              `#define prop_${info.name}() ${fragmentExpression}\n`,
            );
          }
          builder.setVertexMain(vertexMain);
          addControlsToBuilder(shaderBuilderState, builder);
          const edgeFragmentCode = shaderCodeWithLineDirective(
            shaderBuilderState.parseResult.code,
          );
          builder.setFragmentMainFunction(edgeFragmentCode);
        },
      },
    );

    this.nodeShaderGetter = parameterizedEmitterDependentShaderGetter(
      this,
      this.gl,
      {
        memoizeKey: {
          type: "skeleton/SkeletonShaderManager/node",
          dynamicSegmentAppearance: this.dynamicSegmentAppearance,
          vertexAttributes: this.vertexAttributes,
        },
        fallbackParameters: this.base.fallbackShaderParameters,
        parameters:
          this.base.displayState.skeletonRenderingOptions.shaderControlState
            .builderState,
        shaderError: this.base.displayState.shaderError,
        defineShader: (
          builder: ShaderBuilder,
          shaderBuilderState: ShaderControlsBuilderState,
        ) => {
          if (shaderBuilderState.parseResult.errors.length !== 0) {
            throw new Error("Invalid UI control specification");
          }
          this.defineCommonShader(builder);
          this.defineAttributeAccess(builder);
          if (this.dynamicSegmentAppearance) {
            this.defineDynamicSegmentAppearance(builder);
          }
          defineCircleShader(
            builder,
            /*crossSectionFade=*/ this.targetIsSliceView,
          );
          builder.addUniform("highp float", "uNodeDiameter");
          builder.addUniform("highp uint", "uPickInstanceStride");
          builder.addVarying("highp uint", "vPickID", "flat");
          if (this.dynamicSegmentAppearance) {
            builder.addVarying("highp uint", "vSegmentValue", "flat");
          }
          const selectedOutlineMinWidth = this.targetIsSliceView
            ? SELECTED_NODE_OUTLINE_MIN_WIDTH_2D
            : SELECTED_NODE_OUTLINE_MIN_WIDTH_3D;
          const selectedOutlineMaxWidth = this.targetIsSliceView
            ? SELECTED_NODE_OUTLINE_MAX_WIDTH_2D
            : SELECTED_NODE_OUTLINE_MAX_WIDTH_3D;
          const selectedNodeAttributeReadExpression =
            this.selectedNodeAttributeIndex === undefined
              ? "0.0"
              : `readAttribute${this.selectedNodeAttributeIndex}(vertexIndex)`;
          const selectedOutlineWidthExpression =
            this.selectedNodeAttributeIndex === undefined
              ? "0.0"
              : `((${selectedNodeAttributeReadExpression} > 0.5) ? clamp(0.25 * uNodeDiameter, ${selectedOutlineMinWidth}, ${selectedOutlineMaxWidth}) : 0.0)`;
          let vertexMain = `
highp uint vertexIndex = uint(gl_InstanceID);
highp uint pickOffset = vertexIndex * uPickInstanceStride;
vPickID = uPickID + pickOffset;
highp vec3 vertexPosition = readAttribute0(vertexIndex);
emitCircle(
  uProjection * vec4(vertexPosition, 1.0),
  uNodeDiameter,
  ${selectedOutlineWidthExpression}
);
`;
          if (
            this.dynamicSegmentAppearance &&
            this.segmentAttributeIndex !== undefined
          ) {
            vertexMain += `vSegmentValue = toRaw(readAttribute${this.segmentAttributeIndex}(vertexIndex));\n`;
          }

          const segmentColorExpression = this.getSegmentColorExpression();
          if (
            this.dynamicSegmentAppearance &&
            this.segmentAttributeIndex !== undefined
          ) {
            const segmentExpression = `vSegmentValue`;
            const selectedNodeExpression =
              this.selectedNodeAttributeIndex === undefined
                ? undefined
                : `vCustom${this.selectedNodeAttributeIndex}`;
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
  emit(vec4(circleColor.rgb * circleColor.a, circleColor.a), vPickID);
}
void emitRGB(vec3 color) {
  emitRGBA(vec4(color, 1.0));
}
void emitDefault() {
  vec4 baseColor = segmentColor();
  highp float alpha = baseColor.a;
  if (alpha <= 0.0) discard;
  vec4 renderColor = vec4(baseColor.rgb, alpha);
  vec4 borderColor = ${borderColorExpression};
  vec4 circleColor = getCircleColor(renderColor, borderColor);
  emit(vec4(circleColor.rgb * circleColor.a, circleColor.a), vPickID);
}
`);
          } else if (this.segmentColorAttributeIndex === undefined) {
            // Preserve legacy skeleton behavior for non-spatial skeletons.
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
            const selectedNodeExpression =
              this.selectedNodeAttributeIndex === undefined
                ? undefined
                : `vCustom${this.selectedNodeAttributeIndex}`;
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
  emit(vec4(circleColor.rgb * circleColor.a, circleColor.a), vPickID);
}
void emitRGB(vec3 color) {
  emitRGBA(vec4(color, 1.0));
}
void emitDefault() {
  emitRGBA(segmentColor());
}
`);
          }
          builder.addFragmentCode(glsl_COLORMAPS);
          const { vertexAttributes } = this;
          const numAttributes = vertexAttributes.length;
          for (let i = 1; i < numAttributes; ++i) {
            const info = vertexAttributes[i];
            if (
              this.dynamicSegmentAppearance &&
              i === this.segmentAttributeIndex
            ) {
              builder.addFragmentCode(dataTypeShaderDefinition[info.dataType]);
              builder.addFragmentCode(
                `#define ${info.name} ${info.glslDataType}(vSegmentValue)\n`,
              );
              builder.addFragmentCode(
                `#define prop_${info.name}() ${info.glslDataType}(vSegmentValue)\n`,
              );
              continue;
            }
            builder.addVarying(
              `highp ${getVertexAttributeVaryingType(info)}`,
              `vCustom${i}`,
              getVertexAttributeInterpolationMode(info.dataType),
            );
            vertexMain += `vCustom${i} = ${getVertexAttributeReadExpression(i, "vertexIndex", info)};\n`;
            if (info.dataType !== DataType.FLOAT32) {
              builder.addFragmentCode(dataTypeShaderDefinition[info.dataType]);
            }
            const fragmentExpression = getVertexAttributeFragmentExpression(
              `vCustom${i}`,
              info,
            );
            builder.addFragmentCode(
              `#define ${info.name} ${fragmentExpression}\n`,
            );
            builder.addFragmentCode(
              `#define prop_${info.name}() ${fragmentExpression}\n`,
            );
          }
          builder.setVertexMain(vertexMain);
          addControlsToBuilder(shaderBuilderState, builder);
          builder.setFragmentMainFunction(
            shaderCodeWithLineDirective(shaderBuilderState.parseResult.code),
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

  beginLayer(
    gl: GL,
    shader: ShaderProgram,
    renderContext: SliceViewPanelRenderContext | PerspectiveViewRenderContext,
    modelMatrix: mat4,
  ) {
    const { viewProjectionMat } = renderContext.projectionParameters;
    const mat = mat4.multiply(tempMat2, viewProjectionMat, modelMatrix);
    gl.uniformMatrix4fv(shader.uniform("uProjection"), false, mat);
    this.vertexIdHelper.enable();
  }

  setColor(gl: GL, shader: ShaderProgram, color: Float32Array | number[]) {
    const a =
      (color as Float32Array).length >= 4
        ? (color as Float32Array)[3]
        : this.base.displayState.objectAlpha.value;
    gl.uniform4f(
      shader.uniform("uColor"),
      (color as Float32Array)[0],
      (color as Float32Array)[1],
      (color as Float32Array)[2],
      a,
    );
  }

  setPickID(gl: GL, shader: ShaderProgram, pickID: number) {
    gl.uniform1ui(shader.uniform("uPickID"), pickID);
  }

  setEdgePickInstanceStride(gl: GL, shader: ShaderProgram, stride: number) {
    gl.uniform1ui(shader.uniform("uPickInstanceStride"), stride);
  }

  setNodePickInstanceStride(gl: GL, shader: ShaderProgram, stride: number) {
    gl.uniform1ui(shader.uniform("uPickInstanceStride"), stride);
  }

  drawSkeleton(
    gl: GL,
    edgeShader: ShaderProgram,
    nodeShader: ShaderProgram | null,
    skeletonChunk: SkeletonChunkInterface,
    projectionParameters: { width: number; height: number },
  ) {
    // Bind vertex attribute textures to be used across edge and node shaders
    // The edge shader and node shader share the same texture unit for each attribute
    // so we only bind once. However, if this ever changes, we
    // instead must bind for the edge shader, draw, then bind for node shader
    const { vertexAttributes } = this;
    const { vertexAttributeTextures } = skeletonChunk;
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
      skeletonChunk.indexBuffer.bindToVertexAttribI(
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
      drawLines(gl, 1, skeletonChunk.numIndices / 2);
      gl.vertexAttribDivisor(aVertexIndex, 0);
      gl.disableVertexAttribArray(aVertexIndex);
    }

    // Draw nodes if in line and node mode
    if (nodeShader !== null) {
      nodeShader.bind();
      initializeCircleShader(nodeShader, projectionParameters, {
        featherWidthInPixels: this.targetIsSliceView ? 1.0 : 0.0,
      });
      drawCircles(nodeShader.gl, 2, skeletonChunk.numVertices);
    }
  }

  endLayer(gl: GL, ...shaders: Array<ShaderProgram | null>) {
    const { vertexAttributes } = this;
    const numAttributes = vertexAttributes.length;
    const clearedTextureUnits = new Set<number>();
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

export { SkeletonRenderMode } from "#src/skeleton/render_mode.js";

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

export class SkeletonLayer extends RefCounted {
  layerChunkProgressInfo = new LayerChunkProgressInfo();
  redrawNeeded = new NullarySignal();
  private sharedObject: SegmentationLayerSharedObject;
  vertexAttributes: VertexAttributeRenderInfo[];
  segmentColorAttributeIndex: number | undefined = undefined;
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
    renderHelper.setEdgePickInstanceStride(gl, edgeShader, 0);
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
    renderHelper.setNodePickInstanceStride(gl, nodeShader, 0);
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
          renderHelper.setColor(gl, edgeShader, color as Float32Array);
          nodeShader.bind();
          renderHelper.setColor(gl, nodeShader, color as Float32Array);
        }
        if (pickIndex !== undefined) {
          edgeShader.bind();
          renderHelper.setPickID(gl, edgeShader, pickIndex);
          nodeShader.bind();
          renderHelper.setPickID(gl, nodeShader, pickIndex);
        }
        renderHelper.drawSkeleton(
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

function getVertexAttributeInterpolationMode(dataType: DataType) {
  return dataType === DataType.FLOAT32 ? "" : "flat";
}

// Custom integer wrapper types like `uint32_t` are defined in fragment code,
// which is emitted after varying declarations. Keep varyings on raw GLSL
// scalar/vector types and wrap them back into helper structs in fragment code.
function getVertexAttributeVaryingType(info: VertexAttributeInfo) {
  const { dataType, numComponents } = info;
  if (dataType === DataType.FLOAT32) {
    return getShaderType(dataType, numComponents);
  }
  if (dataType === DataType.UINT64) {
    if (numComponents === 1) return "uvec2";
    if (numComponents === 2) return "uvec4";
  }
  const vectorTypePrefix = DATA_TYPE_SIGNED[dataType] ? "ivec" : "uvec";
  if (numComponents === 1) {
    return DATA_TYPE_SIGNED[dataType] ? "int" : "uint";
  }
  if (numComponents >= 2 && numComponents <= 4) {
    return `${vectorTypePrefix}${numComponents}`;
  }
  throw new Error(
    `No varying type for ${DataType[dataType]}[${numComponents}].`,
  );
}

function getVertexAttributeReadExpression(
  attributeIndex: number,
  indexExpression: string,
  info: VertexAttributeInfo,
) {
  const readExpression = `readAttribute${attributeIndex}(${indexExpression})`;
  if (info.dataType === DataType.FLOAT32) {
    return readExpression;
  }
  if (info.dataType === DataType.UINT64) {
    return `${readExpression}.value`;
  }
  return `toRaw(${readExpression})`;
}

function getVertexAttributeFragmentExpression(
  varyingName: string,
  info: VertexAttributeRenderInfo,
) {
  if (info.dataType === DataType.FLOAT32) {
    return varyingName;
  }
  return `${info.glslDataType}(${varyingName})`;
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

export class SkeletonChunk extends Chunk implements SkeletonChunkInterface {
  declare source: SkeletonSource;
  vertexAttributes: Uint8Array;
  indices: Uint32Array;
  indexBuffer!: GLBuffer;
  numIndices: number;
  numVertices: number;
  vertexAttributeOffsets: Uint32Array;
  vertexAttributeTextures: (WebGLTexture | null)[] = [];

  constructor(source: SkeletonSource, x: any) {
    super(source);
    this.vertexAttributes = x.vertexAttributes;
    const indices = (this.indices = x.indices);
    this.numVertices = x.numVertices;
    this.vertexAttributeOffsets = x.vertexAttributeOffsets;
    this.numIndices = indices.length;
  }

  copyToGPU(gl: GL) {
    super.copyToGPU(gl);
    const { attributeTextureFormats } = this.source;
    const { vertexAttributes, vertexAttributeOffsets } = this;

    this.vertexAttributeTextures = uploadVertexAttributesToGPU(
      gl,
      vertexAttributes,
      vertexAttributeOffsets,
      attributeTextureFormats,
    );

    this.indexBuffer = GLBuffer.fromData(
      gl,
      this.indices,
      WebGL2RenderingContext.ARRAY_BUFFER,
      WebGL2RenderingContext.STATIC_DRAW,
    );
  }

  freeGPUMemory(gl: GL) {
    super.freeGPUMemory(gl);
    const { vertexAttributeTextures } = this;
    for (const texture of vertexAttributeTextures) {
      gl.deleteTexture(texture);
    }
    vertexAttributeTextures.length = 0;
    this.indexBuffer.dispose();
  }
}

export class SpatiallyIndexedSkeletonChunk
  extends SliceViewChunk
  implements SkeletonChunkInterface
{
  declare source: SpatiallyIndexedSkeletonSource;
  vertexAttributes: Uint8Array;
  indices: Uint32Array;
  indexBuffer!: GLBuffer;
  numIndices: number;
  numVertices: number;
  vertexAttributeOffsets: Uint32Array;
  vertexAttributeTextures: (WebGLTexture | null)[] = [];
  nodeIds: Int32Array = new Int32Array(0);
  nodeRevisionTokens: Array<string | undefined> = [];
  lod: number | undefined;

  constructor(
    source: SpatiallyIndexedSkeletonSource,
    chunkData: SkeletonChunkData,
  ) {
    super(source, chunkData);
    this.vertexAttributes = chunkData.vertexAttributes;
    const indices = (this.indices = chunkData.indices);
    this.numVertices = chunkData.numVertices;
    this.numIndices = indices.length;
    this.vertexAttributeOffsets = chunkData.vertexAttributeOffsets;
    this.lod = (chunkData as any).lod;
    const nodeIdsData = (chunkData as any).nodeIds;
    if (nodeIdsData instanceof Int32Array) {
      this.nodeIds = nodeIdsData;
    } else if (ArrayBuffer.isView(nodeIdsData)) {
      this.nodeIds = new Int32Array(
        nodeIdsData.buffer,
        nodeIdsData.byteOffset,
        nodeIdsData.byteLength / Int32Array.BYTES_PER_ELEMENT,
      );
    } else {
      this.nodeIds = new Int32Array(0);
    }
    const nodeRevisionTokens = (chunkData as any).nodeRevisionTokens;
    this.nodeRevisionTokens = Array.isArray(nodeRevisionTokens)
      ? nodeRevisionTokens.map((value) =>
          typeof value === "string" ? value : undefined,
        )
      : [];
  }

  copyToGPU(gl: GL) {
    const wasGpuResident = this.state === ChunkState.GPU_MEMORY;
    super.copyToGPU(gl);
    if (wasGpuResident) return;
    const { attributeTextureFormats } = this.source;
    this.vertexAttributeTextures = uploadVertexAttributesToGPU(
      gl,
      this.vertexAttributes,
      this.vertexAttributeOffsets,
      attributeTextureFormats,
    );
    this.indexBuffer = GLBuffer.fromData(
      gl,
      this.indices,
      WebGL2RenderingContext.ARRAY_BUFFER,
      WebGL2RenderingContext.STATIC_DRAW,
    );
    this.source.bumpLookupGeneration();
  }

  freeGPUMemory(gl: GL) {
    const wasGpuResident = this.state === ChunkState.GPU_MEMORY;
    super.freeGPUMemory(gl);
    if (!wasGpuResident) return;
    this.indexBuffer.dispose();
    const { vertexAttributeTextures } = this;
    for (let i = 0, length = vertexAttributeTextures.length; i < length; ++i) {
      gl.deleteTexture(vertexAttributeTextures[i]);
    }
    vertexAttributeTextures.length = 0;
    this.source.bumpLookupGeneration();
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

export class SpatiallyIndexedSkeletonSource extends SliceViewChunkSource<
  SpatiallyIndexedSkeletonChunkSpecification,
  SpatiallyIndexedSkeletonChunk
> {
  vertexAttributes: VertexAttributeRenderInfo[];
  lookupGeneration = 0;
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

  bumpLookupGeneration() {
    ++this.lookupGeneration;
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

  getChunk(chunkData: SkeletonChunkData) {
    return new SpatiallyIndexedSkeletonChunk(this, chunkData);
  }
}

export abstract class MultiscaleSpatiallyIndexedSkeletonSource extends MultiscaleSliceViewChunkSource<SpatiallyIndexedSkeletonSource> {
  getPerspectiveSources(): SliceViewSingleResolutionSource<SpatiallyIndexedSkeletonSource>[] {
    const sources = this.getSources({ view: "3d" } as any);
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

export class MultiscaleSliceViewSpatiallyIndexedSkeletonLayer extends SliceViewRenderLayer<SpatiallyIndexedSkeletonSource> {
  private renderOptions: ViewSpecificSkeletonRenderingOptions;
  private visibleChunkKeysBySliceView = new Map<
    number,
    VisibleSpatialChunkKeysBySource
  >();
  private trackedChunkStatsSliceViews = new Set<number>();
  RPC_TYPE_ID = SPATIALLY_INDEXED_SKELETON_SLICEVIEW_RENDER_LAYER_RPC_ID;
  constructor(
    public chunkManager: ChunkManager,
    public multiscaleSource: MultiscaleSpatiallyIndexedSkeletonSource,
    public displayState: SegmentationDisplayState,
  ) {
    const renderScaleTarget = (displayState as any)
      .renderScaleTarget as WatchableValueInterface<number>;
    const gridLevel2d = (displayState as any).spatialSkeletonGridLevel2d as
      | WatchableValueInterface<number>
      | undefined;
    super(chunkManager, multiscaleSource, {
      transform: (displayState as any).transform,
      localPosition: (displayState as any).localPosition,
      renderScaleTarget,
      visibleSourcesInvalidation:
        gridLevel2d === undefined ? [] : [gridLevel2d],
    });
    this.renderOptions = (
      displayState as any
    ).skeletonRenderingOptions.params2d;
    this.registerDisposer(
      this.renderOptions.mode.changed.add(this.redrawNeeded.dispatch),
    );
    this.registerDisposer(
      this.renderOptions.lineWidth.changed.add(this.redrawNeeded.dispatch),
    );
    const rpc = this.chunkManager.rpc!;
    const lod2d = (displayState as any).spatialSkeletonLod2d;
    if (gridLevel2d !== undefined && lod2d !== undefined) {
      this.rpcTransfer = {
        ...this.rpcTransfer,
        chunkManager: this.chunkManager.rpcId,
        skeletonGridLevel: this.registerDisposer(
          SharedWatchableValue.makeFromExisting(rpc, gridLevel2d),
        ).rpcId,
        skeletonLod: this.registerDisposer(
          SharedWatchableValue.makeFromExisting(rpc, lod2d),
        ).rpcId,
      };
    }
    this.initializeCounterpart();
  }

  filterVisibleSources(
    sliceView: SliceViewBase,
    sources: readonly TransformedSource[],
  ): Iterable<TransformedSource> {
    const gridLevel = (this.displayState as any).spatialSkeletonGridLevel2d
      ?.value as number | undefined;
    if (
      gridLevel === undefined ||
      sources.length === 0 ||
      !sources.every(
        (source) => getSpatiallyIndexedSkeletonGridIndex(source) !== undefined,
      )
    ) {
      return super.filterVisibleSources(sliceView, sources);
    }
    return selectSpatiallyIndexedSkeletonEntriesByGrid(
      sources,
      gridLevel,
      getSpatiallyIndexedSkeletonGridIndex,
    );
  }

  private updateChunkStatsWatchable() {
    const { presentCount, totalCount } = mergeVisibleSpatialChunkKeyCounts(
      this.visibleChunkKeysBySliceView.values(),
    );
    updateSpatialSkeletonGridChunkStatsWatchable(
      (this.displayState as any).spatialSkeletonGridChunkStats2d as
        | WatchableValue<SpatialSkeletonGridChunkStats>
        | undefined,
      presentCount,
      totalCount,
    );
  }

  private setVisibleChunkKeysForSliceView(
    sliceViewId: number,
    visibleChunkKeysBySource: VisibleSpatialChunkKeysBySource,
  ) {
    this.visibleChunkKeysBySliceView.set(sliceViewId, visibleChunkKeysBySource);
    this.updateChunkStatsWatchable();
  }

  private clearVisibleChunkKeysForSliceView(sliceViewId: number) {
    if (!this.visibleChunkKeysBySliceView.delete(sliceViewId)) {
      return;
    }
    this.updateChunkStatsWatchable();
  }

  private registerChunkStatsSliceView(
    sliceView: RefCounted & { rpcId: number },
  ) {
    const { rpcId } = sliceView;
    if (this.trackedChunkStatsSliceViews.has(rpcId)) {
      return;
    }
    this.trackedChunkStatsSliceViews.add(rpcId);
    sliceView.registerDisposer(() => {
      this.trackedChunkStatsSliceViews.delete(rpcId);
      this.clearVisibleChunkKeysForSliceView(rpcId);
    });
  }

  draw(renderContext: SliceViewRenderContext) {
    const displayState = this.displayState as any;
    const lodValue = displayState.spatialSkeletonLod2d?.value as number;
    const sliceView = renderContext.sliceView;
    this.registerChunkStatsSliceView(
      sliceView as RefCounted & { rpcId: number },
    );
    if (
      displayState.objectAlpha?.value <= 0.0 &&
      displayState.hiddenObjectAlpha?.value <= 0.0
    ) {
      this.clearVisibleChunkKeysForSliceView(sliceView.rpcId);
      return;
    }
    const visibleSources =
      renderContext.sliceView.visibleLayers.get(this)?.visibleSources ?? [];
    this.setVisibleChunkKeysForSliceView(
      sliceView.rpcId,
      collectPlaneIntersectingSpatialChunkKeysBySource(
        visibleSources,
        renderContext.projectionParameters,
        this.localPosition.value,
        lodValue,
      ),
    );
  }
}

type SpatiallyIndexedSkeletonSourceEntry =
  SliceViewSingleResolutionSource<SpatiallyIndexedSkeletonSource>;

interface SpatiallyIndexedSkeletonLayerOptions {
  gridLevel?: WatchableValueInterface<number>;
  lod?: WatchableValueInterface<number>;
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

interface SpatiallyIndexedSkeletonOverlayChunk extends SkeletonChunkInterface {
  dispose(gl: GL): void;
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
  relative: boolean,
  pixelSize: number,
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
  const safePixelSize = Math.max(pixelSize, 1e-6);
  for (const tsource of scales) {
    const gridIndex = (tsource.source as any).parameters?.gridIndex as
      | number
      | undefined;
    if (gridIndex === undefined) {
      continue;
    }
    const source = tsource.source as unknown as {
      chunks: Map<string, SpatiallyIndexedSkeletonChunk>;
    };
    let presentCount = 0;
    let missingCount = 0;
    forEachVisibleVolumetricChunk(
      projectionParameters,
      localPosition,
      tsource,
      (positionInChunks) => {
        const key = `${positionInChunks.join()}${lodSuffix}`;
        const chunk = source.chunks.get(key) as
          | SpatiallyIndexedSkeletonChunk
          | undefined;
        if (chunk?.state === ChunkState.GPU_MEMORY) {
          presentCount++;
        } else {
          missingCount++;
        }
      },
    );
    const spacing = getSpatialSkeletonGridSpacing(tsource, levels, gridIndex);
    const renderScale = relative ? spacing / safePixelSize : spacing;
    const total = presentCount + missingCount;
    if (total > 0) {
      histogram.add(spacing, renderScale, presentCount, missingCount);
    } else {
      // Keep all grid rows visible in the histogram even when currently empty.
      histogram.add(spacing, renderScale, 0, 1, true);
    }
  }
}

type VisibleSpatialChunksBySource = Map<
  string,
  readonly SpatiallyIndexedSkeletonChunk[]
>;

interface VisibleSpatialChunkKeys {
  presentChunkKeys: Set<string>;
  totalChunkKeys: Set<string>;
}

type VisibleSpatialChunkKeysBySource = Map<string, VisibleSpatialChunkKeys>;

interface SpatialSkeletonGridChunkStats {
  presentCount: number;
  totalCount: number;
}

function getOrCreateVisibleSpatialChunkKeys(
  visibleChunkKeysBySource: VisibleSpatialChunkKeysBySource,
  sourceId: string,
) {
  let visibleChunkKeys = visibleChunkKeysBySource.get(sourceId);
  if (visibleChunkKeys === undefined) {
    visibleChunkKeys = {
      presentChunkKeys: new Set<string>(),
      totalChunkKeys: new Set<string>(),
    };
    visibleChunkKeysBySource.set(sourceId, visibleChunkKeys);
  }
  return visibleChunkKeys;
}

function updateSpatialSkeletonGridChunkStatsWatchable(
  watchable: WatchableValue<SpatialSkeletonGridChunkStats> | undefined,
  presentCount: number,
  totalCount: number,
) {
  if (watchable === undefined) return;
  const prev = watchable.value;
  if (prev.presentCount === presentCount && prev.totalCount === totalCount) {
    return;
  }
  watchable.value = { presentCount, totalCount };
}

function mergeVisibleSpatialChunkKeyCounts(
  visibleChunkKeysByView: Iterable<VisibleSpatialChunkKeysBySource>,
  selectedSourceIds?: Iterable<string>,
) {
  const presentChunkKeys = new Set<string>();
  const totalChunkKeys = new Set<string>();
  const selectedSourceIdSet =
    selectedSourceIds === undefined ? undefined : new Set(selectedSourceIds);
  for (const visibleChunkKeysBySource of visibleChunkKeysByView) {
    for (const [sourceId, visibleChunkKeys] of visibleChunkKeysBySource) {
      if (
        selectedSourceIdSet !== undefined &&
        !selectedSourceIdSet.has(sourceId)
      ) {
        continue;
      }
      for (const chunkKey of visibleChunkKeys.presentChunkKeys) {
        presentChunkKeys.add(`${sourceId}:${chunkKey}`);
      }
      for (const chunkKey of visibleChunkKeys.totalChunkKeys) {
        totalChunkKeys.add(`${sourceId}:${chunkKey}`);
      }
    }
  }
  return {
    presentCount: presentChunkKeys.size,
    totalCount: totalChunkKeys.size,
  };
}

function collectPlaneIntersectingSpatialChunkKeysBySource(
  transformedSources: readonly TransformedSource[],
  projectionParameters: any,
  localPosition: Float32Array,
  lod: number | undefined,
) {
  const visibleChunkKeysBySource: VisibleSpatialChunkKeysBySource = new Map();
  if (lod === undefined || transformedSources.length === 0) {
    return visibleChunkKeysBySource;
  }
  const lodSuffix = `:${lod}`;
  const seenChunkKeysBySource = new Map<string, Set<string>>();
  for (const tsource of transformedSources) {
    const sourceId = getObjectId(tsource.source);
    const visibleChunkKeys = getOrCreateVisibleSpatialChunkKeys(
      visibleChunkKeysBySource,
      sourceId,
    );
    let seenChunkKeys = seenChunkKeysBySource.get(sourceId);
    if (seenChunkKeys === undefined) {
      seenChunkKeys = new Set<string>();
      seenChunkKeysBySource.set(sourceId, seenChunkKeys);
    }
    const chunkLayout = getNormalizedChunkLayout(
      projectionParameters,
      tsource.chunkLayout,
    );
    forEachPlaneIntersectingVolumetricChunk(
      projectionParameters,
      localPosition,
      tsource,
      chunkLayout,
      (positionInChunks) => {
        const chunkKey = `${positionInChunks.join()}${lodSuffix}`;
        if (seenChunkKeys!.has(chunkKey)) {
          return;
        }
        seenChunkKeys!.add(chunkKey);
        visibleChunkKeys.totalChunkKeys.add(chunkKey);
        const chunk = (
          tsource.source as SpatiallyIndexedSkeletonSource
        ).chunks.get(chunkKey) as SpatiallyIndexedSkeletonChunk | undefined;
        if (chunk?.state === ChunkState.GPU_MEMORY) {
          visibleChunkKeys.presentChunkKeys.add(chunkKey);
        }
      },
    );
  }
  return visibleChunkKeysBySource;
}

export class SpatiallyIndexedSkeletonLayer
  extends RefCounted
  implements SkeletonLayerInterface
{
  layerChunkProgressInfo = new LayerChunkProgressInfo();
  redrawNeeded = new NullarySignal();
  dynamicSegmentAppearance = true;
  vertexAttributes: VertexAttributeRenderInfo[];
  segmentColorAttributeIndex: number | undefined;
  selectedNodeAttributeIndex: number | undefined;
  readonly chunkGeometryRenderLayerInterface: SkeletonLayerInterface;
  fallbackShaderParameters = new WatchableValue(
    getFallbackBuilderState(parseShaderUiControls(DEFAULT_FRAGMENT_MAIN)),
  );
  backend: ChunkRenderLayerFrontend;
  localPosition: WatchableValueInterface<Float32Array>;
  readonly chunkTransform: WatchableValueInterface<
    ValueOrError<ChunkTransformParameters>
  >;
  rpc: RPC | undefined;

  private overlayAttributeTextureFormats = [
    vertexPositionTextureFormat,
    segmentTextureFormat,
    selectedNodeTextureFormat,
  ];
  private regularSkeletonLayerWatchable = new WatchableValue(false);
  private regularSkeletonLayerUserLayer: UserLayer | undefined;
  private removeRegularSkeletonLayerUserLayerListener:
    | (() => boolean)
    | undefined;
  private visibleChunksByView = new Map<
    SpatiallyIndexedSkeletonView,
    VisibleSpatialChunksBySource
  >();
  private visibleChunkKeysByRenderedView = new Map<
    SpatiallyIndexedSkeletonView,
    Map<number, VisibleSpatialChunkKeysBySource>
  >();
  gridLevel: WatchableValueInterface<number>;
  lod: WatchableValueInterface<number>;
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
  private overlayChunk: SpatiallyIndexedSkeletonOverlayChunk | undefined;
  private overlayChunkKey: string | undefined;
  private pendingOverlaySegmentLoads = new Set<number>();
  private browseExcludedSegments = new Uint64Set();
  private browseExcludedSegmentsKey: string | undefined;
  private suppressedBrowseSegmentIds = new Set<number>();
  private retainedOverlaySegmentIds: number[] = [];
  private maxRetainedOverlaySegments: number;

  private *iterateUniqueChunkSources() {
    const seenSourceIds = new Set<string>();
    for (const sourceEntry of [...this.sources, ...this.sources2d]) {
      const sourceId = getObjectId(sourceEntry.chunkSource);
      if (seenSourceIds.has(sourceId)) continue;
      seenSourceIds.add(sourceId);
      yield sourceEntry.chunkSource;
    }
  }

  private disposeOverlayChunk() {
    this.overlayChunk?.dispose(this.gl);
    this.overlayChunk = undefined;
    this.overlayChunkKey = undefined;
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

  private getOverlayChunkKey(segmentIds: readonly number[]) {
    return [
      segmentIds.join(","),
      `selected:${this.selectedNodeId?.value ?? ""}`,
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

  private resolveSourceBackedOverlayChunk():
    | SpatiallyIndexedSkeletonOverlayChunk
    | undefined {
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
    const segmentNodeSets: SpatiallyIndexedSkeletonNode[][] = [];
    const loadedSegmentIds: number[] = [];
    for (const segmentId of overlaySegmentIds) {
      const segmentNodes =
        this.inspectionState.getCachedSegmentNodes(segmentId);
      if (segmentNodes === undefined) {
        this.requestOverlaySegmentLoad(segmentId);
        continue;
      }
      loadedSegmentIds.push(segmentId);
      segmentNodeSets.push(segmentNodes.map((node) => node));
    }
    if (loadedSegmentIds.length === 0) {
      this.disposeOverlayChunk();
      return undefined;
    }
    const overlayChunkKey = this.getOverlayChunkKey(loadedSegmentIds);
    if (
      this.overlayChunk !== undefined &&
      this.overlayChunkKey === overlayChunkKey
    ) {
      return this.overlayChunk;
    }
    this.disposeOverlayChunk();
    const geometry = buildSpatiallyIndexedSkeletonOverlayGeometry(
      segmentNodeSets,
      {
        selectedNodeId: this.selectedNodeId?.value,
        getPendingNodePosition: this.getPendingNodePositionOverride,
      },
    );
    const positionBytes = new Uint8Array(geometry.positions.buffer);
    const segmentBytes = new Uint8Array(geometry.segmentIds.buffer);
    const selectedBytes = new Uint8Array(geometry.selected.buffer);
    const vertexBytes = new Uint8Array(
      positionBytes.byteLength +
        segmentBytes.byteLength +
        selectedBytes.byteLength,
    );
    vertexBytes.set(positionBytes, 0);
    vertexBytes.set(segmentBytes, positionBytes.byteLength);
    vertexBytes.set(
      selectedBytes,
      positionBytes.byteLength + segmentBytes.byteLength,
    );
    const vertexOffsets = new Uint32Array([
      0,
      positionBytes.byteLength,
      positionBytes.byteLength + segmentBytes.byteLength,
    ]);
    const vertexAttributeTextures = uploadVertexAttributesToGPU(
      this.gl,
      vertexBytes,
      vertexOffsets,
      this.overlayAttributeTextureFormats,
    );
    const indexBuffer = GLBuffer.fromData(
      this.gl,
      geometry.indices,
      WebGL2RenderingContext.ARRAY_BUFFER,
      WebGL2RenderingContext.STATIC_DRAW,
    );
    this.overlayChunk = {
      vertexAttributeTextures,
      indexBuffer,
      numIndices: geometry.indices.length,
      numVertices: geometry.numVertices,
      pickNodeIds: geometry.nodeIds,
      pickNodePositions: geometry.nodePositions,
      pickSegmentIds: geometry.pickSegmentIds,
      pickEdgeSegmentIds: geometry.pickEdgeSegmentIds,
      dispose: (gl: GL) => {
        for (const texture of vertexAttributeTextures) {
          if (texture) gl.deleteTexture(texture);
        }
        indexBuffer.dispose();
      },
    };
    this.overlayChunkKey = overlayChunkKey;
    return this.overlayChunk;
  }

  private computeHasRegularSkeletonLayer(userLayer: UserLayer) {
    for (const renderLayer of userLayer.renderLayers) {
      if (
        renderLayer instanceof PerspectiveViewSkeletonLayer ||
        renderLayer instanceof SliceViewPanelSkeletonLayer
      ) {
        return true;
      }
    }
    return false;
  }

  private updateHasRegularSkeletonLayerWatchable(
    userLayer: UserLayer | undefined,
  ) {
    if (this.regularSkeletonLayerUserLayer !== userLayer) {
      this.removeRegularSkeletonLayerUserLayerListener?.();
      this.removeRegularSkeletonLayerUserLayerListener = undefined;
      this.regularSkeletonLayerUserLayer = userLayer;
      if (userLayer !== undefined) {
        const update = () => {
          const nextValue = this.computeHasRegularSkeletonLayer(userLayer);
          if (this.regularSkeletonLayerWatchable.value !== nextValue) {
            this.regularSkeletonLayerWatchable.value = nextValue;
            this.redrawNeeded.dispatch();
          }
        };
        update();
        this.removeRegularSkeletonLayerUserLayerListener =
          userLayer.layersChanged.add(update);
      } else if (this.regularSkeletonLayerWatchable.value) {
        this.regularSkeletonLayerWatchable.value = false;
        this.redrawNeeded.dispatch();
      }
    }
    return this.regularSkeletonLayerWatchable.value;
  }

  private lodMatches(
    chunk: SpatiallyIndexedSkeletonChunk,
    targetLod: number | undefined,
  ) {
    if (targetLod === undefined || chunk.lod === undefined) {
      return true;
    }
    return Math.abs(chunk.lod - targetLod) < 1e-6;
  }

  sources: SpatiallyIndexedSkeletonSourceEntry[];
  sources2d: SpatiallyIndexedSkeletonSourceEntry[];
  source: SpatiallyIndexedSkeletonSource;

  constructor(
    public chunkManager: ChunkManager,
    sources:
      | SpatiallyIndexedSkeletonSourceEntry[]
      | SpatiallyIndexedSkeletonSource,
    public displayState: SkeletonLayerDisplayState & {
      localPosition: WatchableValueInterface<Float32Array>;
    },
    options: SpatiallyIndexedSkeletonLayerOptions = {},
  ) {
    super();
    this.registerDisposer(() => {
      this.removeRegularSkeletonLayerUserLayerListener?.();
      this.removeRegularSkeletonLayerUserLayerListener = undefined;
      this.regularSkeletonLayerUserLayer = undefined;
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
      (displayState as any).spatialSkeletonGridLevel3d ??
      new WatchableValue(0);
    this.lod =
      options.lod ?? (displayState as any).skeletonLod ?? new WatchableValue(0);
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
    this.chunkGeometryRenderLayerInterface = {
      vertexAttributes: this.source.vertexAttributes,
      segmentColorAttributeIndex: this.segmentColorAttributeIndex,
      dynamicSegmentAppearance: this.dynamicSegmentAppearance,
      gl: this.gl,
      fallbackShaderParameters: this.fallbackShaderParameters,
      displayState: this.displayState,
    };
    this.segmentColorAttributeIndex = undefined;
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
        inspectionState.nodeDataVersion.changed.add(requestRedraw),
      );
    }
    // TODO (SKM): there should be maybe be a redraw on lod changing
    // these were removed because there were too many of them
    // a separate PR is working on a cleaner display state
    // at that point we can likely add something back here
    // for now it should be fine, because the chunks update
    // as a result of the lod changing, which triggers a draw
    // will check the pattern in slice view

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

    sharedObject.initializeCounterpart(rpc, {
      chunkManager: chunkManager.rpcId,
      localPosition: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(rpc, this.localPosition),
      ).rpcId,
      renderScaleTarget: renderScaleTargetWatchable.rpcId,
      skeletonLod: skeletonLodWatchable.rpcId,
      skeletonGridLevel: skeletonGridLevelWatchable.rpcId,
    });
    this.backend = sharedObject;
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

  private getVisibleChunksForView(view: SpatiallyIndexedSkeletonView) {
    return this.visibleChunksByView.get(view);
  }

  private getGridLevelForView(view: SpatiallyIndexedSkeletonView) {
    const displayState = this.displayState as any;
    return (
      view === "2d"
        ? displayState.spatialSkeletonGridLevel2d?.value
        : displayState.spatialSkeletonGridLevel3d?.value
    ) as number | undefined;
  }

  private getGridChunkStatsWatchable(view: SpatiallyIndexedSkeletonView) {
    return (
      view === "2d"
        ? (this.displayState as any).spatialSkeletonGridChunkStats2d
        : (this.displayState as any).spatialSkeletonGridChunkStats3d
    ) as WatchableValue<SpatialSkeletonGridChunkStats> | undefined;
  }

  private updateSelectedChunkStatsForView(view: SpatiallyIndexedSkeletonView) {
    const visibleChunkKeysByRenderedView =
      this.visibleChunkKeysByRenderedView.get(view);
    const selectedSourceIds = new Set<string>();
    for (const sourceEntry of this.selectSourcesForViewAndGrid(
      view,
      this.getGridLevelForView(view),
    )) {
      selectedSourceIds.add(getObjectId(sourceEntry.chunkSource));
    }
    const { presentCount, totalCount } = mergeVisibleSpatialChunkKeyCounts(
      visibleChunkKeysByRenderedView?.values() ?? [],
      selectedSourceIds,
    );
    updateSpatialSkeletonGridChunkStatsWatchable(
      this.getGridChunkStatsWatchable(view),
      presentCount,
      totalCount,
    );
  }

  setVisibleChunkKeysForRenderedView(
    view: SpatiallyIndexedSkeletonView,
    renderedViewId: number,
    visibleChunkKeysBySource: VisibleSpatialChunkKeysBySource,
  ) {
    let visibleChunkKeysByRenderedView =
      this.visibleChunkKeysByRenderedView.get(view);
    if (visibleChunkKeysByRenderedView === undefined) {
      visibleChunkKeysByRenderedView = new Map();
      this.visibleChunkKeysByRenderedView.set(
        view,
        visibleChunkKeysByRenderedView,
      );
    }
    visibleChunkKeysByRenderedView.set(
      renderedViewId,
      visibleChunkKeysBySource,
    );
    this.updateSelectedChunkStatsForView(view);
  }

  clearVisibleChunkKeysForRenderedView(
    view: SpatiallyIndexedSkeletonView,
    renderedViewId: number,
  ) {
    const visibleChunkKeysByRenderedView =
      this.visibleChunkKeysByRenderedView.get(view);
    if (visibleChunkKeysByRenderedView === undefined) {
      return;
    }
    if (!visibleChunkKeysByRenderedView.delete(renderedViewId)) {
      return;
    }
    if (visibleChunkKeysByRenderedView.size === 0) {
      this.visibleChunkKeysByRenderedView.delete(view);
    }
    this.updateSelectedChunkStatsForView(view);
  }

  private *iterateCandidateChunks(
    selectedSources: readonly SpatiallyIndexedSkeletonSourceEntry[],
    targetLod: number | undefined,
    options: {
      view?: SpatiallyIndexedSkeletonView;
    } = {},
  ): Iterable<SpatiallyIndexedSkeletonChunk> {
    const visibleChunksBySource =
      options.view === undefined
        ? undefined
        : this.getVisibleChunksForView(options.view);
    const useVisibleChunks = visibleChunksBySource !== undefined;
    for (const sourceEntry of selectedSources) {
      if (useVisibleChunks) {
        const visibleChunks = visibleChunksBySource.get(
          getObjectId(sourceEntry.chunkSource),
        );
        if (visibleChunks === undefined) {
          continue;
        }
        for (const chunk of visibleChunks) {
          if (!this.lodMatches(chunk, targetLod)) continue;
          if (chunk.state !== ChunkState.GPU_MEMORY) continue;
          yield chunk;
        }
        continue;
      }
      for (const chunk of sourceEntry.chunkSource.chunks.values()) {
        const typedChunk = chunk as SpatiallyIndexedSkeletonChunk;
        if (!this.lodMatches(typedChunk, targetLod)) continue;
        if (typedChunk.state !== ChunkState.GPU_MEMORY) continue;
        yield typedChunk;
      }
    }
  }

  invalidateSourceCaches() {
    let invalidated = false;
    for (const chunkSource of this.iterateUniqueChunkSources()) {
      chunkSource.invalidateCache();
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
      revisionToken: chunk.nodeRevisionTokens[pickedOffset],
    };
  }

  updateVisibleChunksForView(
    view: SpatiallyIndexedSkeletonView,
    transformedSources: readonly TransformedSource[][],
    projectionParameters: any,
    lod: number | undefined,
    renderedViewId?: number,
  ) {
    if (lod === undefined) {
      this.visibleChunksByView.delete(view);
      if (renderedViewId !== undefined) {
        this.clearVisibleChunkKeysForRenderedView(view, renderedViewId);
      }
      return;
    }
    const lodSuffix = `:${lod}`;
    const chunksBySource: VisibleSpatialChunksBySource = new Map();
    const visibleChunkKeysBySource: VisibleSpatialChunkKeysBySource = new Map();
    const seenChunkKeysBySource = new Map<string, Set<string>>();
    for (const scales of transformedSources) {
      for (const tsource of scales) {
        const sourceId = getObjectId(tsource.source);
        let visibleChunks = chunksBySource.get(sourceId);
        if (visibleChunks === undefined) {
          visibleChunks = [];
          chunksBySource.set(sourceId, visibleChunks);
        }
        const visibleChunkKeys = getOrCreateVisibleSpatialChunkKeys(
          visibleChunkKeysBySource,
          sourceId,
        );
        let seenChunkKeys = seenChunkKeysBySource.get(sourceId);
        if (seenChunkKeys === undefined) {
          seenChunkKeys = new Set<string>();
          seenChunkKeysBySource.set(sourceId, seenChunkKeys);
        }
        forEachVisibleVolumetricChunk(
          projectionParameters,
          this.localPosition.value,
          tsource,
          (positionInChunks) => {
            const chunkKey = `${positionInChunks.join()}${lodSuffix}`;
            if (seenChunkKeys!.has(chunkKey)) {
              return;
            }
            seenChunkKeys!.add(chunkKey);
            visibleChunkKeys.totalChunkKeys.add(chunkKey);
            const chunkSource =
              tsource.source as SpatiallyIndexedSkeletonSource;
            const chunk = chunkSource.chunks.get(chunkKey) as
              | SpatiallyIndexedSkeletonChunk
              | undefined;
            if (chunk?.state !== ChunkState.GPU_MEMORY) {
              return;
            }
            visibleChunkKeys.presentChunkKeys.add(chunkKey);
            (visibleChunks as SpatiallyIndexedSkeletonChunk[]).push(chunk);
          },
        );
      }
    }
    this.visibleChunksByView.set(view, chunksBySource);
    if (renderedViewId !== undefined) {
      this.setVisibleChunkKeysForRenderedView(
        view,
        renderedViewId,
        visibleChunkKeysBySource,
      );
    }
  }

  private areVisibleChunksReady(
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
    if (lod === undefined || transformedSources.length === 0) {
      return false;
    }
    const lodSuffix = `:${lod}`;
    const seenChunkKeysBySource = new Map<string, Set<string>>();
    let ready = true;
    for (const scales of transformedSources) {
      for (const tsource of scales) {
        const sourceId = getObjectId(tsource.source);
        let seenChunkKeys = seenChunkKeysBySource.get(sourceId);
        if (seenChunkKeys === undefined) {
          seenChunkKeys = new Set<string>();
          seenChunkKeysBySource.set(sourceId, seenChunkKeys);
        }
        forEachVisibleVolumetricChunk(
          projectionParameters,
          this.localPosition.value,
          tsource,
          (positionInChunks) => {
            if (!ready) {
              return;
            }
            const chunkKey = `${positionInChunks.join()}${lodSuffix}`;
            if (seenChunkKeys!.has(chunkKey)) {
              return;
            }
            seenChunkKeys!.add(chunkKey);
            const chunkSource =
              tsource.source as SpatiallyIndexedSkeletonSource;
            const chunk = chunkSource.chunks.get(chunkKey) as
              | SpatiallyIndexedSkeletonChunk
              | undefined;
            if (chunk?.state !== ChunkState.GPU_MEMORY) {
              ready = false;
            }
          },
        );
        if (!ready) {
          return false;
        }
      }
    }
    return true;
  }

  getNode(
    nodeId: number,
    options: {
      lod?: number;
    } = {},
  ): SpatiallyIndexedSkeletonNode | undefined {
    void options;
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

  private drawBrowsePass(
    renderContext: SliceViewPanelRenderContext | PerspectiveViewRenderContext,
    layer: RenderLayer,
    renderHelper: RenderHelper,
    modelMatrix: mat4,
    lineWidth: number,
    pointDiameter: number,
    hasRegularSkeletonLayer: boolean,
    selectedSources: readonly SpatiallyIndexedSkeletonSourceEntry[],
    targetLod: number | undefined,
    view: SpatiallyIndexedSkeletonView,
  ) {
    const { gl } = this;
    const excludedSegments = this.getBrowsePassExcludedSegments();
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
      return;
    }
    const { shaderControlState } = this.displayState.skeletonRenderingOptions;
    edgeShader.bind();
    renderHelper.beginLayer(gl, edgeShader, renderContext, modelMatrix);
    renderHelper.setEdgePickInstanceStride(gl, edgeShader, 0);
    setControlsInShader(
      gl,
      edgeShader,
      shaderControlState,
      edgeShaderParameters.parseResult.controls,
    );
    gl.uniform1f(edgeShader.uniform("uLineWidth"), lineWidth);
    nodeShader.bind();
    renderHelper.beginLayer(gl, nodeShader, renderContext, modelMatrix);
    gl.uniform1f(nodeShader.uniform("uNodeDiameter"), pointDiameter);
    renderHelper.setNodePickInstanceStride(gl, nodeShader, 0);
    setControlsInShader(
      gl,
      nodeShader,
      shaderControlState,
      nodeShaderParameters.parseResult.controls,
    );
    const baseColor = new Float32Array([1, 1, 1, 1]);
    edgeShader.bind();
    renderHelper.setColor(gl, edgeShader, baseColor);
    renderHelper.enableDynamicSegmentAppearance(
      gl,
      edgeShader,
      hasRegularSkeletonLayer,
      excludedSegments,
    );
    nodeShader.bind();
    renderHelper.setColor(gl, nodeShader, baseColor);
    renderHelper.enableDynamicSegmentAppearance(
      gl,
      nodeShader,
      hasRegularSkeletonLayer,
      excludedSegments,
    );
    if (renderContext.emitPickID) {
      edgeShader.bind();
      renderHelper.setPickID(gl, edgeShader, 0);
      renderHelper.setEdgePickInstanceStride(gl, edgeShader, 0);
      nodeShader.bind();
      renderHelper.setPickID(gl, nodeShader, 0);
      renderHelper.setNodePickInstanceStride(gl, nodeShader, 0);
    }
    for (const chunk of this.iterateCandidateChunks(
      selectedSources,
      targetLod,
      {
        view,
      },
    )) {
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
        renderHelper.setEdgePickInstanceStride(gl, edgeShader, edgePickStride);
        nodeShader.bind();
        renderHelper.setPickID(gl, nodeShader, nodePickId);
        renderHelper.setNodePickInstanceStride(gl, nodeShader, nodePickStride);
      }
      renderHelper.drawSkeleton(
        gl,
        edgeShader,
        nodeShader,
        chunk,
        renderContext.projectionParameters,
      );
    }
    renderHelper.disableDynamicSegmentAppearance(gl, edgeShader);
    renderHelper.disableDynamicSegmentAppearance(gl, nodeShader);
    renderHelper.endLayer(gl, edgeShader, nodeShader);
  }

  private drawInspectionOverlayPass(
    renderContext: SliceViewPanelRenderContext | PerspectiveViewRenderContext,
    layer: RenderLayer,
    renderHelper: RenderHelper,
    modelMatrix: mat4,
    lineWidth: number,
    pointDiameter: number,
    hasRegularSkeletonLayer: boolean,
  ) {
    const overlayChunk = this.resolveSourceBackedOverlayChunk();
    if (overlayChunk === undefined) {
      return;
    }
    const { gl } = this;
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
      return;
    }
    const { shaderControlState } = this.displayState.skeletonRenderingOptions;
    edgeShader.bind();
    renderHelper.beginLayer(gl, edgeShader, renderContext, modelMatrix);
    renderHelper.setEdgePickInstanceStride(gl, edgeShader, 0);
    setControlsInShader(
      gl,
      edgeShader,
      shaderControlState,
      edgeShaderParameters.parseResult.controls,
    );
    gl.uniform1f(edgeShader.uniform("uLineWidth"), lineWidth);
    nodeShader.bind();
    renderHelper.beginLayer(gl, nodeShader, renderContext, modelMatrix);
    gl.uniform1f(nodeShader.uniform("uNodeDiameter"), pointDiameter);
    renderHelper.setNodePickInstanceStride(gl, nodeShader, 0);
    setControlsInShader(
      gl,
      nodeShader,
      shaderControlState,
      nodeShaderParameters.parseResult.controls,
    );
    const baseColor = new Float32Array([1, 1, 1, 1]);
    edgeShader.bind();
    renderHelper.setColor(gl, edgeShader, baseColor);
    renderHelper.enableDynamicSegmentAppearance(
      gl,
      edgeShader,
      hasRegularSkeletonLayer,
    );
    nodeShader.bind();
    renderHelper.setColor(gl, nodeShader, baseColor);
    renderHelper.enableDynamicSegmentAppearance(
      gl,
      nodeShader,
      hasRegularSkeletonLayer,
    );
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
      renderHelper.setEdgePickInstanceStride(
        gl,
        edgeShader,
        edgePickId === 0 ? 0 : 1,
      );
      nodeShader.bind();
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
      renderHelper.setPickID(gl, nodeShader, nodePickId);
      renderHelper.setNodePickInstanceStride(
        gl,
        nodeShader,
        nodePickId === 0 ? 0 : 1,
      );
    }
    renderHelper.drawSkeleton(
      gl,
      edgeShader,
      nodeShader,
      overlayChunk,
      renderContext.projectionParameters,
    );
    renderHelper.disableDynamicSegmentAppearance(gl, edgeShader);
    renderHelper.disableDynamicSegmentAppearance(gl, nodeShader);
    renderHelper.endLayer(gl, edgeShader, nodeShader);
  }

  draw(
    renderContext: SliceViewPanelRenderContext | PerspectiveViewRenderContext,
    layer: RenderLayer,
    renderHelper: RenderHelper,
    browseRenderHelper: RenderHelper,
    renderOptions: ViewSpecificSkeletonRenderingOptions,
    attachment: VisibleLayerInfo<
      LayerView,
      ThreeDimensionalRenderLayerAttachmentState
    >,
    drawOptions?: {
      view?: SpatiallyIndexedSkeletonView;
      gridLevel?: number;
      lod?: number;
    },
  ) {
    const lineWidth = renderOptions.lineWidth.value;
    const { displayState } = this;
    if (
      displayState.objectAlpha.value <= 0.0 &&
      displayState.hiddenObjectAlpha.value <= 0.0
    ) {
      return;
    }
    const modelMatrix = update3dRenderLayerAttachment(
      displayState.transform.value,
      renderContext.projectionParameters.displayDimensionRenderInfo,
      attachment,
    );
    if (modelMatrix === undefined) return;

    const hasRegularSkeletonLayer = this.updateHasRegularSkeletonLayerWatchable(
      layer.userLayer,
    );
    const targetLod = drawOptions?.lod;
    const view = drawOptions?.view ?? "3d";
    const pointDiameter = getSkeletonNodeDiameter(
      renderOptions.mode.value,
      lineWidth,
    );

    const selectedSources = this.selectSourcesForViewAndGrid(
      view,
      drawOptions?.gridLevel,
    );
    this.drawBrowsePass(
      renderContext,
      layer,
      browseRenderHelper,
      modelMatrix,
      lineWidth,
      pointDiameter,
      hasRegularSkeletonLayer,
      selectedSources,
      targetLod,
      view,
    );
    this.drawInspectionOverlayPass(
      renderContext,
      layer,
      renderHelper,
      modelMatrix,
      lineWidth,
      pointDiameter,
      hasRegularSkeletonLayer,
    );
  }

  isReady(
    transformedSources: readonly TransformedSource[][],
    projectionParameters: ProjectionParameters,
    lod?: number,
  ) {
    // TODO (SKM) I don't think this is getting
    // called as expected, for example, I think
    // the screenshot should call this but it doesn't seem to
    return this.areVisibleChunksReady(
      transformedSources,
      projectionParameters,
      lod,
    );
  }
}

export class PerspectiveViewSpatiallyIndexedSkeletonLayer extends PerspectiveViewRenderLayer {
  private renderHelper: RenderHelper;
  private browseRenderHelper: RenderHelper;
  private renderOptions: ViewSpecificSkeletonRenderingOptions;
  private transformedSources: TransformedSource[][] = [];
  backend: ChunkRenderLayerFrontend;

  constructor(public base: SpatiallyIndexedSkeletonLayer) {
    super();
    this.backend = base.backend;
    this.renderHelper = this.registerDisposer(new RenderHelper(base, false));
    this.browseRenderHelper = this.registerDisposer(
      new RenderHelper(base.chunkGeometryRenderLayerInterface, false),
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
    const histogram = (base.displayState as any)
      .spatialSkeletonGridRenderScaleHistogram3d as
      | RenderScaleHistogram
      | undefined;
    if (histogram !== undefined) {
      this.registerDisposer(histogram.visibility.add(this.visibility));
    }
  }

  attach(
    attachment: VisibleLayerInfo<
      PerspectivePanel,
      ThreeDimensionalRenderLayerAttachmentState
    >,
  ) {
    super.attach(attachment);
    attachment.registerDisposer(() =>
      this.base.clearVisibleChunkKeysForRenderedView(
        "3d",
        attachment.view.rpcId,
      ),
    );

    // Manually add layer to backend
    const backend = this.backend;
    if (backend && backend.rpc) {
      backend.rpc.invoke(RENDERED_VIEW_ADD_LAYER_RPC_ID, {
        layer: backend.rpcId,
        view: attachment.view.rpcId,
      });
    }

    // Capture references to avoid losing 'this' context in callback
    const baseLayer = this.base;
    const redrawNeeded = this.redrawNeeded;

    attachment.registerDisposer(
      registerNested(
        (context, transform, displayDimensionRenderInfo) => {
          const transformedSources = getVolumetricTransformedSources(
            displayDimensionRenderInfo,
            transform,
            () => [
              baseLayer.getSources("3d").map((sourceEntry) => ({
                chunkSource: sourceEntry.chunkSource,
                chunkToMultiscaleTransform:
                  sourceEntry.chunkToMultiscaleTransform,
              })),
            ],
            attachment.messages,
            this,
          );
          for (const scales of transformedSources) {
            for (const tsource of scales) {
              context.registerDisposer(tsource.source);
            }
          }
          attachment.view.flushBackendProjectionParameters();
          this.transformedSources = transformedSources;
          baseLayer.rpc!.invoke(
            SPATIALLY_INDEXED_SKELETON_RENDER_LAYER_UPDATE_SOURCES_RPC_ID,
            {
              layer: baseLayer.backend.rpcId,
              view: attachment.view.rpcId,
              displayDimensionRenderInfo,
              sources: serializeAllTransformedSources(transformedSources),
            },
          );
          redrawNeeded.dispatch();
          return transformedSources;
        },
        baseLayer.displayState.transform,
        attachment.view.displayDimensionRenderInfo,
      ),
    );
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

  getValueAt(position: Float32Array) {
    position;
    return undefined;
  }

  transformPickedValue(pickState: PickState) {
    const pickedSegmentId = pickState.pickedSpatialSkeleton?.segmentId;
    if (
      typeof pickedSegmentId === "number" &&
      Number.isSafeInteger(pickedSegmentId)
    ) {
      return BigInt(pickedSegmentId);
    }
    return undefined;
  }

  updateMouseState(
    mouseState: MouseSelectionState,
    _pickedValue: bigint,
    pickedOffset: number,
    data: any,
  ) {
    const pickData = data as SpatiallyIndexedSkeletonPickData | undefined;
    if (pickData === undefined) return;
    if (pickData.kind === "node") {
      if (
        pickedOffset < 0 ||
        pickedOffset >= pickData.nodeIds.length ||
        pickedOffset >= pickData.segmentIds.length
      ) {
        return;
      }
      const segmentId = pickData.segmentIds[pickedOffset];
      if (!Number.isSafeInteger(segmentId) || segmentId <= 0) {
        return;
      }
      mouseState.pickedSpatialSkeleton = { segmentId };
      if (
        !getVisibleSegments(
          this.base.displayState.segmentationGroupState.value,
        ).has(BigInt(segmentId))
      ) {
        return;
      }
      const nodeId = pickData.nodeIds[pickedOffset];
      if (!Number.isSafeInteger(nodeId) || nodeId <= 0) return;
      const nodePosition = pickData.nodePositions.subarray(
        pickedOffset * 3,
        pickedOffset * 3 + 3,
      );
      mouseState.pickedSpatialSkeleton = {
        nodeId,
        segmentId,
        position: new Float32Array(nodePosition),
      };
      const transform = this.base.displayState.transform.value;
      if (transform.error === undefined) {
        setMouseStatePositionFromSpatialSkeletonNode(
          mouseState,
          nodePosition,
          transform,
        );
      }
      return;
    }
    if (pickData.kind === "edge") {
      if (pickedOffset < 0 || pickedOffset >= pickData.segmentIds.length) {
        return;
      }
      const segmentId = pickData.segmentIds[pickedOffset];
      if (Number.isSafeInteger(segmentId) && segmentId > 0) {
        mouseState.pickedSpatialSkeleton = { segmentId };
      }
      return;
    }
    if (pickData.kind === "segment-node" || pickData.kind === "segment-edge") {
      if (pickData.kind === "segment-node") {
        const pickedNode = this.base.resolveNodePickFromChunk(
          pickData.chunk,
          pickedOffset,
        );
        if (pickedNode !== undefined) {
          mouseState.pickedSpatialSkeleton = {
            nodeId: pickedNode.nodeId,
            segmentId: pickedNode.segmentId,
            position: new Float32Array(pickedNode.position),
            revisionToken: pickedNode.revisionToken,
          };
        }
        return;
      }
      const segmentId = this.base.resolveSegmentPickFromChunk(
        pickData.chunk,
        pickedOffset,
        "edge",
      );
      if (segmentId !== undefined) {
        mouseState.pickedSpatialSkeleton = { segmentId };
      }
    }
  }

  draw(
    renderContext: PerspectiveViewRenderContext,
    attachment: VisibleLayerInfo<
      PerspectivePanel,
      ThreeDimensionalRenderLayerAttachmentState
    >,
  ) {
    const pixelSizeWatchable = (this.base.displayState as any)
      .spatialSkeletonGridPixelSize3d as
      | WatchableValueInterface<number>
      | undefined;
    if (pixelSizeWatchable !== undefined) {
      const voxelPhysicalScales =
        renderContext.projectionParameters.displayDimensionRenderInfo
          ?.voxelPhysicalScales;
      if (voxelPhysicalScales !== undefined) {
        const { invViewMatrix } = renderContext.projectionParameters;
        let computedPixelSize = 0;
        for (let i = 0; i < 3; ++i) {
          const s = voxelPhysicalScales[i];
          const x = invViewMatrix[i];
          computedPixelSize += (s * x) ** 2;
        }
        const pixelSize = Math.sqrt(computedPixelSize);
        if (
          Number.isFinite(pixelSize) &&
          pixelSizeWatchable.value !== pixelSize
        ) {
          pixelSizeWatchable.value = pixelSize;
        }
      }
    }
    if (!renderContext.emitColor && renderContext.alreadyEmittedPickID) {
      return;
    }
    const displayState = this.base.displayState as any;
    const lodValue = displayState.skeletonLod?.value as number | undefined;
    this.base.updateVisibleChunksForView(
      "3d",
      this.transformedSources,
      renderContext.projectionParameters,
      lodValue,
      attachment.view.rpcId,
    );
    const levels = displayState.spatialSkeletonGridLevels?.value as
      | Array<{ size: { x: number; y: number; z: number }; lod: number }>
      | undefined;
    const histogram = displayState.spatialSkeletonGridRenderScaleHistogram3d as
      | RenderScaleHistogram
      | undefined;
    if (histogram !== undefined) {
      const frameNumber =
        this.base.chunkManager.chunkQueueManager.frameNumberCounter.frameNumber;
      const relative =
        displayState.spatialSkeletonGridResolutionRelative3d?.value === true;
      const pixelSize = Math.max(pixelSizeWatchable?.value ?? 1, 1e-6);
      updateSpatialSkeletonGridRenderScaleHistogram(
        histogram,
        frameNumber,
        this.transformedSources,
        renderContext.projectionParameters,
        this.base.localPosition.value,
        lodValue,
        levels,
        relative,
        pixelSize,
      );
    }
    this.base.draw(
      renderContext,
      this,
      this.renderHelper,
      this.browseRenderHelper,
      this.renderOptions,
      attachment,
      {
        view: "3d",
        gridLevel: displayState.spatialSkeletonGridLevel3d?.value as
          | number
          | undefined,
        lod: lodValue,
      },
    );
  }

  isReady(
    renderContext: PerspectiveViewReadyRenderContext,
    _attachment: VisibleLayerInfo<
      PerspectivePanel,
      ThreeDimensionalRenderLayerAttachmentState
    >,
  ) {
    const displayState = this.base.displayState as any;
    const lodValue = displayState.skeletonLod?.value as number | undefined;
    return this.base.isReady(
      this.transformedSources,
      renderContext.projectionParameters,
      lodValue,
    );
  }
}

export class SliceViewSpatiallyIndexedSkeletonLayer extends SliceViewRenderLayer {
  private renderOptions: ViewSpecificSkeletonRenderingOptions;
  private trackedChunkStatsSliceViews = new Set<number>();
  constructor(public base: SpatiallyIndexedSkeletonLayer) {
    super(
      base.chunkManager,
      {
        getSources: () => {
          return [
            [
              {
                chunkSource: base.source,
                chunkToMultiscaleTransform: mat4.create(),
              },
            ],
          ];
        },
      } as any,
      {
        transform: base.displayState.transform,
        localPosition: (base.displayState as any).localPosition,
      },
    );
    // @ts-expect-error RenderHelper requires panel-specific initialization here.
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
    this.initializeCounterpart();
  }
  get gl() {
    return this.base.gl;
  }

  getValueAt(position: Float32Array) {
    position;
    return undefined;
  }

  draw(renderContext: SliceViewRenderContext) {
    const displayState = this.base.displayState as any;
    const lodValue = displayState.spatialSkeletonLod2d?.value as
      | number
      | undefined;
    const sliceView = renderContext.sliceView;
    const sliceViewId = sliceView.rpcId;
    if (!this.trackedChunkStatsSliceViews.has(sliceViewId)) {
      this.trackedChunkStatsSliceViews.add(sliceViewId);
      sliceView.registerDisposer(() => {
        this.trackedChunkStatsSliceViews.delete(sliceViewId);
        this.base.clearVisibleChunkKeysForRenderedView("2d", sliceViewId);
      });
    }
    if (
      (displayState.objectAlpha?.value <= 0.0 &&
        displayState.hiddenObjectAlpha?.value <= 0.0) ||
      lodValue === undefined
    ) {
      this.base.clearVisibleChunkKeysForRenderedView("2d", sliceViewId);
      return;
    }
    const visibleSources =
      renderContext.sliceView.visibleLayers.get(this)?.visibleSources ?? [];
    this.base.setVisibleChunkKeysForRenderedView(
      "2d",
      sliceViewId,
      collectPlaneIntersectingSpatialChunkKeysBySource(
        visibleSources,
        renderContext.projectionParameters,
        this.base.localPosition.value,
        lodValue,
      ),
    );
  }
}

export class SliceViewPanelSpatiallyIndexedSkeletonLayer extends SliceViewPanelRenderLayer {
  private renderHelper: RenderHelper;
  private browseRenderHelper: RenderHelper;
  private renderOptions: ViewSpecificSkeletonRenderingOptions;
  private transformedSources: TransformedSource[][] = [];
  constructor(public base: SpatiallyIndexedSkeletonLayer) {
    super();
    this.renderHelper = this.registerDisposer(new RenderHelper(base, true));
    this.browseRenderHelper = this.registerDisposer(
      new RenderHelper(base.chunkGeometryRenderLayerInterface, true),
    );
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
    const gridLevel2d = (base.displayState as any).spatialSkeletonGridLevel2d;
    if (gridLevel2d?.changed) {
      this.registerDisposer(
        gridLevel2d.changed.add(this.redrawNeeded.dispatch),
      );
    }
    const lod2d = (base.displayState as any).spatialSkeletonLod2d;
    if (lod2d?.changed) {
      this.registerDisposer(lod2d.changed.add(this.redrawNeeded.dispatch));
    }
    const histogram = (base.displayState as any)
      .spatialSkeletonGridRenderScaleHistogram2d as
      | RenderScaleHistogram
      | undefined;
    if (histogram !== undefined) {
      this.registerDisposer(histogram.visibility.add(this.visibility));
    }
    this.registerDisposer(base.redrawNeeded.add(this.redrawNeeded.dispatch));
  }
  get gl() {
    return this.base.gl;
  }

  getValueAt(position: Float32Array) {
    position;
    return undefined;
  }

  transformPickedValue(pickState: PickState) {
    const pickedSegmentId = pickState.pickedSpatialSkeleton?.segmentId;
    if (
      typeof pickedSegmentId === "number" &&
      Number.isSafeInteger(pickedSegmentId)
    ) {
      return BigInt(pickedSegmentId);
    }
    return undefined;
  }

  updateMouseState(
    mouseState: MouseSelectionState,
    _pickedValue: bigint,
    pickedOffset: number,
    data: any,
  ) {
    const pickData = data as SpatiallyIndexedSkeletonPickData | undefined;
    if (pickData === undefined) return;
    if (pickData.kind === "node") {
      if (
        pickedOffset < 0 ||
        pickedOffset >= pickData.nodeIds.length ||
        pickedOffset >= pickData.segmentIds.length
      ) {
        return;
      }
      const segmentId = pickData.segmentIds[pickedOffset];
      if (!Number.isSafeInteger(segmentId) || segmentId <= 0) {
        return;
      }
      mouseState.pickedSpatialSkeleton = { segmentId };
      if (
        !getVisibleSegments(
          this.base.displayState.segmentationGroupState.value,
        ).has(BigInt(segmentId))
      ) {
        return;
      }
      const nodeId = pickData.nodeIds[pickedOffset];
      if (!Number.isSafeInteger(nodeId) || nodeId <= 0) return;
      const nodePosition = pickData.nodePositions.subarray(
        pickedOffset * 3,
        pickedOffset * 3 + 3,
      );
      mouseState.pickedSpatialSkeleton = {
        nodeId,
        segmentId,
        position: new Float32Array(nodePosition),
      };
      const transform = this.base.displayState.transform.value;
      if (transform.error === undefined) {
        setMouseStatePositionFromSpatialSkeletonNode(
          mouseState,
          nodePosition,
          transform,
        );
      }
      return;
    }
    if (pickData.kind === "edge") {
      if (pickedOffset < 0 || pickedOffset >= pickData.segmentIds.length) {
        return;
      }
      const segmentId = pickData.segmentIds[pickedOffset];
      if (Number.isSafeInteger(segmentId) && segmentId > 0) {
        mouseState.pickedSpatialSkeleton = { segmentId };
      }
      return;
    }
    if (pickData.kind === "segment-node" || pickData.kind === "segment-edge") {
      if (pickData.kind === "segment-node") {
        const pickedNode = this.base.resolveNodePickFromChunk(
          pickData.chunk,
          pickedOffset,
        );
        if (pickedNode !== undefined) {
          mouseState.pickedSpatialSkeleton = {
            nodeId: pickedNode.nodeId,
            segmentId: pickedNode.segmentId,
            position: new Float32Array(pickedNode.position),
            revisionToken: pickedNode.revisionToken,
          };
        }
        return;
      }
      const segmentId = this.base.resolveSegmentPickFromChunk(
        pickData.chunk,
        pickedOffset,
        "edge",
      );
      if (segmentId !== undefined) {
        mouseState.pickedSpatialSkeleton = { segmentId };
      }
    }
  }

  attach(
    attachment: VisibleLayerInfo<
      SliceViewPanel,
      ThreeDimensionalRenderLayerAttachmentState
    >,
  ) {
    super.attach(attachment);
    const baseLayer = this.base;
    const redrawNeeded = this.redrawNeeded;
    attachment.registerDisposer(
      registerNested(
        (context, transform, displayDimensionRenderInfo) => {
          const transformedSources = getVolumetricTransformedSources(
            displayDimensionRenderInfo,
            transform,
            () => [
              baseLayer.getSources("2d").map((sourceEntry) => ({
                chunkSource: sourceEntry.chunkSource,
                chunkToMultiscaleTransform:
                  sourceEntry.chunkToMultiscaleTransform,
              })),
            ],
            attachment.messages,
            this,
          );
          for (const scales of transformedSources) {
            for (const tsource of scales) {
              context.registerDisposer(tsource.source);
            }
          }
          this.transformedSources = transformedSources;
          redrawNeeded.dispatch();
          return transformedSources;
        },
        baseLayer.displayState.transform,
        attachment.view.displayDimensionRenderInfo,
      ),
    );
  }

  draw(
    renderContext: SliceViewPanelRenderContext,
    attachment: VisibleLayerInfo<
      SliceViewPanel,
      ThreeDimensionalRenderLayerAttachmentState
    >,
  ) {
    const pixelSizeWatchable = (this.base.displayState as any)
      .spatialSkeletonGridPixelSize2d as
      | WatchableValueInterface<number>
      | undefined;
    if (pixelSizeWatchable !== undefined) {
      const pixelSize =
        renderContext.sliceView.projectionParameters.value.pixelSize;
      if (
        Number.isFinite(pixelSize) &&
        pixelSizeWatchable.value !== pixelSize
      ) {
        pixelSizeWatchable.value = pixelSize;
      }
    }
    const displayState = this.base.displayState as any;
    const lodValue = displayState.spatialSkeletonLod2d?.value as
      | number
      | undefined;
    this.base.updateVisibleChunksForView(
      "2d",
      this.transformedSources,
      renderContext.sliceView.projectionParameters.value,
      lodValue,
    );
    const levels = displayState.spatialSkeletonGridLevels?.value as
      | Array<{ size: { x: number; y: number; z: number }; lod: number }>
      | undefined;
    const histogram = displayState.spatialSkeletonGridRenderScaleHistogram2d as
      | RenderScaleHistogram
      | undefined;
    if (histogram !== undefined) {
      const frameNumber =
        this.base.chunkManager.chunkQueueManager.frameNumberCounter.frameNumber;
      const relative =
        displayState.spatialSkeletonGridResolutionRelative2d?.value === true;
      const pixelSize = Math.max(pixelSizeWatchable?.value ?? 1, 1e-6);
      updateSpatialSkeletonGridRenderScaleHistogram(
        histogram,
        frameNumber,
        this.transformedSources,
        renderContext.sliceView.projectionParameters.value,
        this.base.localPosition.value,
        lodValue,
        levels,
        relative,
        pixelSize,
      );
    }
    this.base.draw(
      renderContext,
      this,
      this.renderHelper,
      this.browseRenderHelper,
      this.renderOptions,
      attachment,
      {
        view: "2d",
        gridLevel: displayState.spatialSkeletonGridLevel2d?.value as
          | number
          | undefined,
        lod: lodValue,
      },
    );
  }

  isReady(
    renderContext: SliceViewPanelReadyRenderContext,
    _attachment: VisibleLayerInfo<
      SliceViewPanel,
      ThreeDimensionalRenderLayerAttachmentState
    >,
  ) {
    const displayState = this.base.displayState as any;
    const lodValue = displayState.spatialSkeletonLod2d?.value as
      | number
      | undefined;
    return this.base.isReady(
      this.transformedSources,
      renderContext.projectionParameters,
      lodValue,
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
  getChunk(x: any) {
    return new SkeletonChunk(this, x);
  }

  get vertexAttributes(): Map<string, VertexAttributeInfo> {
    return emptyVertexAttributes;
  }
}
