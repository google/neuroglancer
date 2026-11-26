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
import { HashMapUint64, type HashSetUint64 } from "#src/gpu_hash/hash_table.js";
import {
  GPUHashTable,
  HashMapShaderManager,
  HashSetShaderManager,
} from "#src/gpu_hash/shader.js";
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
  DEFAULT_USER_MAIN_SEGMENT_COLOR,
  encodeSegmentPropertyShaderDefinition,
  type SegmentationColorUserShaderManagerParameters,
  type SegmentPropertyShaderDefinition,
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
import { type SkeletonEdge, type SkeletonNode } from "#src/skeleton/api.js";
import {
  SKELETON_LAYER_RPC_ID,
  type VertexAttributeInfo,
} from "#src/skeleton/base.js";
import type { SkeletonNodeAccess } from "#src/skeleton/navigation.js";
import {
  getSkeletonChunkNodes,
  type SkeletonChunkNodes,
} from "#src/skeleton/topology.js";
import type { SliceViewPanel } from "#src/sliceview/panel.js";
import type { SliceViewPanelRenderContext } from "#src/sliceview/renderlayer.js";
import { SliceViewPanelRenderLayer } from "#src/sliceview/renderlayer.js";
import type { TrackableAlphaValue } from "#src/trackable_alpha.js";
import { TrackableBoolean } from "#src/trackable_boolean.js";
import {
  AggregateWatchableValue,
  makeCachedDerivedWatchableValue,
  TrackableValue,
  WatchableValue,
} from "#src/trackable_value.js";
import { DataType } from "#src/util/data_type.js";
import { RefCounted } from "#src/util/disposable.js";
import { mat4, vec3 } from "#src/util/geom.js";
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
  makeAggregateWatchableShaderError,
  makeTrackableFragmentMain,
  makeWatchableShaderError,
  parameterizedEmitterDependentShaderGetter,
  wrapUserShaderMain,
} from "#src/webgl/dynamic_shader.js";
import {
  defineLineShader,
  drawLines,
  initializeLineShader,
} from "#src/webgl/lines.js";
import { drawQuads } from "#src/webgl/quad.js";
import {
  glsl_raycastFragmentSetup,
  initializeRaycastPrimitiveShader,
  projectionMatrixShaderModule,
} from "#src/webgl/raycast_primitive.js";
import { defineRaycastSphereShader } from "#src/webgl/raycast_sphere.js";
import { defineRaycastConeShader } from "#src/webgl/raycast_truncated_cone.js";
import type {
  ShaderBuilder,
  ShaderProgram,
  ShaderSamplerType,
} from "#src/webgl/shader.js";
import type { ViewBinding } from "#src/webgl/shader_control_reachability.js";
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
const tempCanonicalVoxelClip = mat4.create();
const tempModelToCanonicalVoxel = mat4.create();
const tempCanonicalVoxelScaleMatrix = mat4.create();
const tempCameraOffset = vec3.create();
const tempCanonicalVoxelScale = vec3.create();
const tempInverseCanonicalVoxelScale = vec3.create();

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

export enum SkeletonGeometryKind {
  // Each draw holds one segment, named by the draw.
  SINGLE_SEGMENT,
  // Each vertex names its segment.
  SEGMENT_PER_VERTEX,
  // Each vertex names its segment, and each draw is culled to its chunk bounds.
  // Segments flagged EXCLUDED_FROM_CHUNKS are hidden.
  SPATIAL_INDEX_CHUNK,
}

// Bit flags, combined per segment.
export enum SkeletonSegmentState {
  // Another pass draws the whole skeleton.
  EXCLUDED_FROM_CHUNKS = 1,
  PROVISIONAL = 2,
}

export interface SkeletonShaderContext {
  readonly vertexAttributes: VertexAttributeRenderInfo[];
  readonly gl: GL;
  readonly displayState: SkeletonLayerDisplayState;
  readonly geometryKind: SkeletonGeometryKind;
  readonly segmentStatesHashMap?: HashMapUint64;
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

// How a user vertex attribute reaches the fragment shader.
enum SkeletonAttributeAccess {
  // A varying read at `vertexIndex`, which the rasteriser interpolates.
  VERTEX_INDEX,
  // Mixed along the cone in the fragment shader, since quad corners are not endpoints.
  CONE_ENDPOINTS,
}

interface SkeletonGeometry {
  readonly vertexMain: string;
  readonly fragmentSetup: string;
  readonly attributeAccess: SkeletonAttributeAccess;
}

export interface SkeletonDrawOptions {
  readonly modelMatrix: mat4;
  // Holds the shader controls that the draw uses.
  readonly binding: ViewBinding;
}

// A number picks the whole skeleton. Otherwise IDs count up per edge and per node.
type SkeletonPickIds =
  | number
  | { readonly firstEdgePickId: number; readonly firstNodePickId: number };

function resolveSkeletonPickIds(pickIds: SkeletonPickIds | undefined) {
  if (pickIds === undefined) return undefined;
  if (typeof pickIds === "number") {
    return { edgePickId: pickIds, nodePickId: pickIds, stride: 0 };
  }
  return {
    edgePickId: pickIds.firstEdgePickId,
    nodePickId: pickIds.firstNodePickId,
    stride: 1,
  };
}

interface SkeletonPass {
  readonly shader: ShaderProgram;
  readonly raycastEnabled: boolean;
}

function getSkeletonPass({
  shader,
  extraParameters: raycastEnabled,
}: {
  readonly shader: ShaderProgram | null;
  readonly extraParameters: boolean;
}): SkeletonPass | undefined {
  return shader === null ? undefined : { shader, raycastEnabled };
}

interface SkeletonDrawParameters {
  readonly colorSegmentId?: bigint;
  readonly pickIds?: SkeletonPickIds;
  readonly chunkBounds?: {
    readonly origin: Float32Array;
    readonly upperBound: Float32Array;
  };
  readonly nodePositionOverride?: {
    readonly vertexIndex: number;
    readonly position: ArrayLike<number>;
  };
}

interface SkeletonShaderParameters {
  readonly segmentColorParameters: SegmentationColorUserShaderManagerParameters;
  readonly segmentColorProperties: readonly SegmentPropertyShaderDefinition[];
  readonly segmentColorShaderBuilderState: ShaderControlsBuilderState;
  readonly skeletonShaderBuilderState: ShaderControlsBuilderState;
}

function encodeSkeletonShaderParameters(parameters: SkeletonShaderParameters) {
  return `${parameters.skeletonShaderBuilderState.key}/${parameters.segmentColorShaderBuilderState.key}/${JSON.stringify(parameters.segmentColorParameters)}/${JSON.stringify(parameters.segmentColorProperties.map(encodeSegmentPropertyShaderDefinition))}`;
}

const glsl_derivedEmitters = `
void emitRGB(vec3 color) {
  emitRGBA(vec4(color, 1.0));
}
void emitDefault() {
  emitRGBA(segmentColor());
}
`;

// Colours stay straight-alpha until `premultiplyAlpha` at emission.
const glsl_lineEmitter = `
void emitRGBA(vec4 color) {
  color.a *= getSegmentAlpha() * getLineAlpha() * getCrossSectionFade();
  if (color.a <= 0.0) discard;
  emit(premultiplyAlpha(color), vPickID);
}
`;

const glsl_circleEmitter = `
void emitRGBA(vec4 color) {
  color.a *= getSegmentAlpha();
  if (color.a <= 0.0) discard;
  // Keep the circle color in a local to avoid an ANGLE D3D11 compiler error.
  vec4 nodeColor = getCircleColor(color, color);
  emit(premultiplyAlpha(nodeColor), vPickID);
}
`;

// A raycast silhouette is exact, so it needs no coverage alpha.
const glsl_raycastEmitter = `
void emitRGBA(vec4 color) {
  color.a *= getSegmentAlpha();
  if (color.a <= 0.0) discard;
  emit(premultiplyAlpha(vec4(color.rgb * raycastLightingFactor, color.a)),
       raycastSurfaceDepth, vPickID);
}
`;

const glsl_edgeVertexSetup = `
highp uint pickOffset = uint(gl_InstanceID) * uPickInstanceStride;
vPickID = uPickID + pickOffset;
highp vec3 vertexA = applyNodePositionOverride(aVertexIndex.x, readAttribute0(aVertexIndex.x));
highp vec3 vertexB = applyNodePositionOverride(aVertexIndex.y, readAttribute0(aVertexIndex.y));
`;

const glsl_nodeVertexSetup = `
highp uint vertexIndex = uint(gl_InstanceID);
highp uint pickOffset = vertexIndex * uPickInstanceStride;
vPickID = uPickID + pickOffset;
highp vec3 vertexPosition = applyNodePositionOverride(vertexIndex, readAttribute0(vertexIndex));
`;

export class RenderHelper extends RefCounted {
  private textureAccessHelper = new OneDimensionalTextureAccessHelper(
    "vertexData",
  );
  private vertexIdHelper;
  private visibleSegmentsShaderManager = new HashSetShaderManager(
    "visibleSegments",
  );
  private segmentStatesShaderManager = new HashMapShaderManager(
    "segmentStates",
  );
  private readonly clearedTextureUnits = new Set<number>();
  private emptySegmentStates = new HashMapUint64();
  private gpuVisibleSegmentsHashTable: GPUHashTable<HashSetUint64>;
  private gpuTemporaryVisibleSegmentsHashTable: GPUHashTable<HashSetUint64>;
  private gpuSegmentStatesHashTable: GPUHashTable<HashMapUint64>;
  get vertexAttributes(): VertexAttributeRenderInfo[] {
    return this.base.vertexAttributes;
  }

  private get hasSegmentIdPerVertex() {
    return this.base.geometryKind !== SkeletonGeometryKind.SINGLE_SEGMENT;
  }

  private defineCommonShader(
    builder: ShaderBuilder,
    {
      segmentColorParameters,
      segmentColorShaderBuilderState,
      skeletonShaderBuilderState,
    }: SkeletonShaderParameters,
  ): void {
    if (skeletonShaderBuilderState.parseResult.errors.length !== 0) {
      throw new Error("Invalid UI control specification");
    }
    this.base.displayState.segmentationColorUserShader.defineShader(
      builder,
      /*fragment=*/ true,
      segmentColorShaderBuilderState,
      segmentColorParameters,
    );
    defineVertexId(builder);
    builder.addUniform("highp float", "uAlpha");
    builder.require(projectionMatrixShaderModule);
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
    // The slice view composites straight-alpha colours.
    builder.addFragmentCode(`
vec4 premultiplyAlpha(vec4 color) {
  return ${this.targetIsSliceView ? "color" : "vec4(color.rgb * color.a, color.a)"};
}
float getCrossSectionFade() {
  return ${this.getCrossSectionFadeFactor()};
}
`);
    if (this.hasSegmentIdPerVertex) {
      this.definePerVertexSegments(builder);
    } else {
      builder.addUniform("highp uvec2", "uSegmentId");
      builder.addFragmentCode(`
vec4 segmentColor() {
  return segmentColorUserShader(uint64_t(uSegmentId));
}
highp float getSegmentAlpha() {
  return uAlpha;
}
`);
    }
    if (this.base.geometryKind === SkeletonGeometryKind.SPATIAL_INDEX_CHUNK) {
      builder.addUniform("highp vec3", "uChunkOrigin");
      builder.addUniform("highp vec3", "uChunkBound");
      builder.addFragmentCode(`
void spatialChunkCull(highp vec3 cullPos) {
  if (any(lessThan(cullPos, uChunkOrigin)) ||
      any(greaterThanEqual(cullPos, uChunkBound))) discard;
}
`);
    }
  }

  private finalizeShaderBuilder(
    builder: ShaderBuilder,
    shaderBuilderState: ShaderControlsBuilderState,
    { vertexMain, fragmentSetup, attributeAccess }: SkeletonGeometry,
  ): void {
    builder.addFragmentCode(glsl_derivedEmitters);
    builder.addFragmentCode(glsl_COLORMAPS);
    const { vertexAttributes } = this;
    const numAttributes = vertexAttributes.length;
    for (let i = 1; i < numAttributes; ++i) {
      const info = vertexAttributes[i];
      const varyingType = `highp ${info.glslDataType}`;
      let attributeExpression: string;
      if (attributeAccess === SkeletonAttributeAccess.VERTEX_INDEX) {
        builder.addVarying(varyingType, `vCustom${i}`);
        vertexMain += `vCustom${i} = readAttribute${i}(vertexIndex);\n`;
        attributeExpression = `vCustom${i}`;
      } else {
        builder.addVarying(varyingType, `vCustomA${i}`, "flat");
        builder.addVarying(varyingType, `vCustomB${i}`, "flat");
        vertexMain += `vCustomA${i} = readAttribute${i}(aVertexIndex.x);\n`;
        vertexMain += `vCustomB${i} = readAttribute${i}(aVertexIndex.y);\n`;
        attributeExpression = `mix(vCustomA${i}, vCustomB${i}, raycastConeAxialFraction)`;
      }
      builder.addFragmentCode(`#define ${info.name} ${attributeExpression}\n`);
      builder.addFragmentCode(
        `#define prop_${info.name}() ${attributeExpression}\n`,
      );
    }
    builder.setVertexMain(vertexMain);
    builder.addFragmentCode(glsl_string);
    addControlsToBuilder(shaderBuilderState, builder);
    builder.addFragmentCode(`void userMain();\n`);
    builder.addFragmentCode(
      wrapUserShaderMain(shaderBuilderState.parseResult.code),
    );
    builder.setFragmentMain(fragmentSetup + "userMain();");
  }

  readonly edgeShaderGetter;
  readonly nodeShaderGetter;

  get gl(): GL {
    return this.base.gl;
  }

  private definePerVertexSegments(builder: ShaderBuilder) {
    this.visibleSegmentsShaderManager.defineShader(builder);
    this.segmentStatesShaderManager.defineShader(builder);
    builder.addUniform("highp float", "uHiddenAlpha");
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
    const excludedAlphaFragment =
      this.base.geometryKind === SkeletonGeometryKind.SPATIAL_INDEX_CHUNK
        ? `
  if ((states & ${SkeletonSegmentState.EXCLUDED_FROM_CHUNKS}u) != 0u) {
    return 0.0;
  }`
        : "";
    builder.addFragmentCode(`
uint getSegmentStates(uint64_t segmentId) {
  uint64_t states;
  return ${this.segmentStatesShaderManager.getFunctionName}(segmentId, states) ? states.value[0] : 0u;
}
vec4 segmentColor() {
  uint64_t segmentId = uint64_t(vSegmentId);
  if ((getSegmentStates(segmentId) & ${SkeletonSegmentState.PROVISIONAL}u) != 0u) {
    return vec4(1.0, 0.0, 0.0, 1.0);
  }
  return segmentColorUserShader(segmentId);
}
highp float getSegmentAlpha() {
  uint64_t segmentId = uint64_t(vSegmentId);
  uint states = getSegmentStates(segmentId);
${excludedAlphaFragment}
  bool isVisible = ${this.visibleSegmentsShaderManager.hasFunctionName}(segmentId);
  return isVisible ? uAlpha : uHiddenAlpha;
}
`);
  }

  private enablePerVertexSegments(shader: ShaderProgram) {
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
    this.segmentStatesShaderManager.enable(
      gl,
      shader,
      this.gpuSegmentStatesHashTable,
    );
    gl.uniform1f(
      shader.uniform("uHiddenAlpha"),
      displayState.hiddenObjectAlpha.value,
    );
  }

  private disablePerVertexSegments(shader: ShaderProgram) {
    const { gl } = this;
    this.visibleSegmentsShaderManager.disable(gl, shader);
    this.segmentStatesShaderManager.disable(gl, shader);
  }

  constructor(
    public base: SkeletonShaderContext,
    public targetIsSliceView: boolean,
    private readonly renderOptions: ViewSpecificSkeletonRenderingOptions,
  ) {
    super();
    const { displayState } = base;
    const raycastEnabled = this.registerDisposer(
      makeCachedDerivedWatchableValue(
        (mode: SkeletonRenderMode) => !targetIsSliceView && isRaycastMode(mode),
        [renderOptions.mode],
      ),
    );
    const { segmentationColorUserShader } = displayState;
    const parameters = this.registerDisposer(
      new AggregateWatchableValue(() => ({
        segmentColorParameters: segmentationColorUserShader.shaderParameters,
        segmentColorProperties: segmentationColorUserShader.usedProperties,
        segmentColorShaderBuilderState:
          displayState.segmentColorShaderControlState.builderState,
        skeletonShaderBuilderState:
          displayState.skeletonRenderingOptions.shaderControlState.builderState,
      })),
    );
    const fallbackParameters: SkeletonShaderParameters = {
      segmentColorParameters:
        segmentationColorUserShader.shaderParameters.value,
      segmentColorProperties: [],
      segmentColorShaderBuilderState: getFallbackBuilderState(
        parseShaderUiControls(DEFAULT_USER_MAIN_SEGMENT_COLOR),
      ),
      skeletonShaderBuilderState: getFallbackBuilderState(
        parseShaderUiControls(DEFAULT_FRAGMENT_MAIN),
      ),
    };

    this.vertexIdHelper = this.registerDisposer(VertexIdHelper.get(this.gl));

    const segmentationGroupState = displayState.segmentationGroupState.value;
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
    this.gpuSegmentStatesHashTable = this.registerDisposer(
      GPUHashTable.get(
        this.gl,
        base.segmentStatesHashMap ?? this.emptySegmentStates,
      ),
    );

    const memoizeKey = {
      vertexAttributes: this.vertexAttributes,
      geometryKind: base.geometryKind,
    };
    const { edgeShaderError, nodeShaderError } =
      displayState.skeletonRenderingOptions;
    this.edgeShaderGetter = parameterizedEmitterDependentShaderGetter(
      this,
      this.gl,
      {
        memoizeKey: {
          ...memoizeKey,
          type: "skeleton/SkeletonShaderManager/edge",
        },
        fallbackParameters: new WatchableValue(fallbackParameters),
        parameters,
        encodeParameters: encodeSkeletonShaderParameters,
        extraParameters: raycastEnabled,
        shaderError: edgeShaderError,
        defineShader: (builder, shaderParameters, raycastEnabled) =>
          this.defineEdgeShader(builder, shaderParameters, raycastEnabled),
      },
    );
    this.nodeShaderGetter = parameterizedEmitterDependentShaderGetter(
      this,
      this.gl,
      {
        memoizeKey: {
          ...memoizeKey,
          type: "skeleton/SkeletonShaderManager/node",
        },
        fallbackParameters: new WatchableValue(fallbackParameters),
        parameters,
        encodeParameters: encodeSkeletonShaderParameters,
        extraParameters: raycastEnabled,
        shaderError: nodeShaderError,
        defineShader: (builder, shaderParameters, raycastEnabled) =>
          this.defineNodeShader(builder, shaderParameters, raycastEnabled),
      },
    );
  }

  draw(
    renderContext: SliceViewPanelRenderContext | PerspectiveViewRenderContext,
    { modelMatrix, binding }: SkeletonDrawOptions,
    callback: (
      drawSkeleton: (
        geometry: SkeletonGPUGeometry,
        parameters: SkeletonDrawParameters,
      ) => void,
    ) => void,
  ): void {
    const edgeShaderResult = this.edgeShaderGetter(renderContext.emitter);
    const nodeShaderResult = this.nodeShaderGetter(renderContext.emitter);
    const edgePass = getSkeletonPass(edgeShaderResult);
    const nodePass = getSkeletonPass(nodeShaderResult);
    if (edgePass === undefined && nodePass === undefined) return;
    const { gl, renderOptions, featherWidthInPixels } = this;
    const { displayState, geometryKind } = this.base;
    const { segmentationColorUserShader } = displayState;
    const { shaderControlState } = displayState.skeletonRenderingOptions;
    const { projectionParameters } = renderContext;
    const lineWidth = renderOptions.lineWidth.value;
    const nodeDiameter = getSkeletonNodeDiameter(
      renderOptions.mode.value,
      lineWidth,
    );
    const shaderResults = [edgeShaderResult, nodeShaderResult];
    for (const shaderResult of shaderResults) {
      const {
        shader,
        parameters,
        fallback,
        extraParameters: raycastEnabled,
      } = shaderResult;
      if (shader === null) continue;
      shader.bind();
      if (raycastEnabled) {
        this.setRaycastUniforms(
          shader,
          renderContext as PerspectiveViewRenderContext,
          modelMatrix,
        );
      } else {
        gl.uniformMatrix4fv(
          shader.uniform("uProjection"),
          false,
          mat4.multiply(
            tempMat4,
            projectionParameters.viewProjectionMat,
            modelMatrix,
          ),
        );
      }
      gl.uniform1f(shader.uniform("uAlpha"), displayState.objectAlpha.value);
      gl.uniform1ui(shader.uniform("uPickInstanceStride"), 0);
      shaderControlState.activeControls.trackShader(
        { ...shaderResult, parameters: parameters.skeletonShaderBuilderState },
        binding,
      );
      setControlsInShader(
        gl,
        shader,
        shaderControlState,
        parameters.skeletonShaderBuilderState.parseResult,
      );
      segmentationColorUserShader.enable(
        gl,
        shader,
        parameters.segmentColorShaderBuilderState,
        { fallback, binding },
        parameters.segmentColorParameters,
      );
      if (this.hasSegmentIdPerVertex) {
        this.enablePerVertexSegments(shader);
      }
    }
    if (edgePass !== undefined) {
      const edgeShader = edgePass.shader;
      edgeShader.bind();
      gl.uniform1f(
        edgeShader.uniform("uNodeClipPixelRadius"),
        nodeDiameter / 2 + featherWidthInPixels,
      );
      if (edgePass.raycastEnabled) {
        gl.uniform1f(edgeShader.uniform("uEdgePixelRadius"), lineWidth / 2);
      } else {
        initializeLineShader(
          edgeShader,
          projectionParameters,
          featherWidthInPixels,
        );
        gl.uniform1f(edgeShader.uniform("uLineWidth"), lineWidth);
      }
    }
    if (nodePass !== undefined) {
      const nodeShader = nodePass.shader;
      nodeShader.bind();
      if (nodePass.raycastEnabled) {
        gl.uniform1f(nodeShader.uniform("uNodePixelRadius"), nodeDiameter / 2);
      } else {
        initializeCircleShader(nodeShader, projectionParameters, {
          featherWidthInPixels,
        });
        gl.uniform1f(nodeShader.uniform("uNodeDiameter"), nodeDiameter);
      }
    }
    this.vertexIdHelper.enable();
    callback((geometry, parameters) => {
      if (
        geometryKind === SkeletonGeometryKind.SPATIAL_INDEX_CHUNK &&
        parameters.chunkBounds === undefined
      ) {
        throw new Error("A spatial index chunk is drawn without its bounds.");
      }
      if (
        geometryKind === SkeletonGeometryKind.SINGLE_SEGMENT &&
        parameters.colorSegmentId === undefined
      ) {
        throw new Error("A single-segment skeleton is drawn without its ID.");
      }
      this.drawSkeleton(edgePass, nodePass, geometry, parameters);
    });
    const drawnShaders: ShaderProgram[] = [];
    for (const { shader, parameters } of shaderResults) {
      if (shader === null) continue;
      drawnShaders.push(shader);
      if (this.hasSegmentIdPerVertex) {
        this.disablePerVertexSegments(shader);
      }
      segmentationColorUserShader.disable(
        gl,
        shader,
        parameters.segmentColorParameters,
      );
    }
    this.unbindTextures(drawnShaders);
    this.vertexIdHelper.disable();
  }

  private drawSkeleton(
    edgePass: SkeletonPass | undefined,
    nodePass: SkeletonPass | undefined,
    geometry: SkeletonGPUGeometry,
    parameters: SkeletonDrawParameters,
  ) {
    const { gl } = this;
    // Both shaders declare their samplers in the same order, so they share texture units.
    const textureShader = (edgePass ?? nodePass)!.shader;
    const { vertexAttributeTextures } = geometry;
    for (let i = 0; i < this.vertexAttributes.length; ++i) {
      gl.activeTexture(
        WebGL2RenderingContext.TEXTURE0 +
          textureShader.textureUnit(vertexAttributeSamplerSymbols[i])!,
      );
      gl.bindTexture(
        WebGL2RenderingContext.TEXTURE_2D,
        vertexAttributeTextures[i],
      );
    }
    if (textureShader.textureUnits.has(segmentIdSamplerSymbol)) {
      gl.activeTexture(
        WebGL2RenderingContext.TEXTURE0 +
          textureShader.textureUnit(segmentIdSamplerSymbol)!,
      );
      gl.bindTexture(
        WebGL2RenderingContext.TEXTURE_2D,
        geometry.segmentIdTexture ?? null,
      );
    }
    const pickIds = resolveSkeletonPickIds(parameters.pickIds);
    if (edgePass !== undefined) {
      const edgeShader = edgePass.shader;
      const numEdges = geometry.numIndices / 2;
      edgeShader.bind();
      this.setDrawUniforms(edgeShader, parameters);
      if (pickIds !== undefined) {
        this.setPickUniforms(edgeShader, pickIds.edgePickId, pickIds.stride);
      }
      const aVertexIndex = edgeShader.attribute("aVertexIndex");
      geometry.indexBuffer.bindToVertexAttribI(
        aVertexIndex,
        2,
        WebGL2RenderingContext.UNSIGNED_INT,
      );
      gl.vertexAttribDivisor(aVertexIndex, 1);
      if (edgePass.raycastEnabled) {
        drawQuads(gl, 1, numEdges);
      } else {
        drawLines(gl, 1, numEdges);
      }
      gl.vertexAttribDivisor(aVertexIndex, 0);
      gl.disableVertexAttribArray(aVertexIndex);
    }

    // Every render mode draws nodes, so that no gap shows between edges.
    if (nodePass !== undefined) {
      const nodeShader = nodePass.shader;
      nodeShader.bind();
      this.setDrawUniforms(nodeShader, parameters);
      if (pickIds !== undefined) {
        this.setPickUniforms(nodeShader, pickIds.nodePickId, pickIds.stride);
      }
      if (nodePass.raycastEnabled) {
        drawQuads(gl, 1, geometry.numVertices);
      } else {
        drawCircles(gl, 1, geometry.numVertices);
      }
    }
  }

  private setPickUniforms(
    shader: ShaderProgram,
    pickId: number,
    stride: number,
  ) {
    this.gl.uniform1ui(shader.uniform("uPickID"), pickId);
    this.gl.uniform1ui(shader.uniform("uPickInstanceStride"), stride);
  }

  private setDrawUniforms(
    shader: ShaderProgram,
    {
      colorSegmentId,
      chunkBounds,
      nodePositionOverride,
    }: SkeletonDrawParameters,
  ) {
    const { gl } = this;
    if (colorSegmentId !== undefined) {
      gl.uniform2ui(
        shader.uniform("uSegmentId"),
        Number(colorSegmentId & 0xffff_ffffn),
        Number(colorSegmentId >> 32n),
      );
    }
    if (chunkBounds !== undefined) {
      gl.uniform3fv(shader.uniform("uChunkOrigin"), chunkBounds.origin);
      gl.uniform3fv(shader.uniform("uChunkBound"), chunkBounds.upperBound);
    }
    // A uniform left at 0 would move vertex 0.
    gl.uniform1i(
      shader.uniform("uOverrideVertexIndex"),
      nodePositionOverride?.vertexIndex ?? -1,
    );
    if (nodePositionOverride !== undefined) {
      const { position } = nodePositionOverride;
      gl.uniform3f(
        shader.uniform("uOverridePosition"),
        position[0],
        position[1],
        position[2],
      );
    }
  }

  private readSegmentIdGlsl(indexExpression: string): string {
    if (!this.hasSegmentIdPerVertex) return "";
    return `vSegmentId = readSegmentId(${indexExpression}).value;\n`;
  }

  private defineEdgeShader(
    builder: ShaderBuilder,
    shaderParameters: SkeletonShaderParameters,
    raycastEnabled: boolean,
  ) {
    this.defineCommonShader(builder, shaderParameters);
    builder.addAttribute("highp uvec2", "aVertexIndex");
    builder.addUniform("highp float", "uNodeClipPixelRadius");
    const geometry = raycastEnabled
      ? this.defineEdgeConeGeometry(builder)
      : this.defineEdgeLineGeometry(builder);
    this.finalizeShaderBuilder(
      builder,
      shaderParameters.skeletonShaderBuilderState,
      geometry,
    );
  }

  private defineNodeShader(
    builder: ShaderBuilder,
    shaderParameters: SkeletonShaderParameters,
    raycastEnabled: boolean,
  ) {
    this.defineCommonShader(builder, shaderParameters);
    const geometry = raycastEnabled
      ? this.defineNodeSphereGeometry(builder)
      : this.defineNodeCircleGeometry(builder);
    this.finalizeShaderBuilder(
      builder,
      shaderParameters.skeletonShaderBuilderState,
      geometry,
    );
  }

  private get hasSpatialChunkCull() {
    return this.base.geometryKind === SkeletonGeometryKind.SPATIAL_INDEX_CHUNK;
  }

  private defineEdgeLineGeometry(builder: ShaderBuilder): SkeletonGeometry {
    defineLineShader(builder, { endpointClipping: true });
    builder.addUniform("highp float", "uLineWidth");
    builder.addFragmentCode(glsl_lineEmitter);
    let vertexMain =
      glsl_edgeVertexSetup +
      `
emitLine(uProjection, vertexA, vertexB, uLineWidth,
         uNodeClipPixelRadius, uNodeClipPixelRadius);
highp uint lineEndpointIndex = getLineEndpointIndex();
highp uint vertexIndex = aVertexIndex.x * (1u - lineEndpointIndex) + aVertexIndex.y * lineEndpointIndex;
`;
    let fragmentSetup = "";
    if (this.hasSpatialChunkCull) {
      builder.addVarying("highp vec3", "vCullPos");
      vertexMain += `vCullPos = mix(vertexA, vertexB, float(lineEndpointIndex));\n`;
      fragmentSetup = `spatialChunkCull(vCullPos);\n`;
    }
    vertexMain += this.readSegmentIdGlsl("aVertexIndex.x");
    return {
      vertexMain,
      fragmentSetup,
      attributeAccess: SkeletonAttributeAccess.VERTEX_INDEX,
    };
  }

  private defineEdgeConeGeometry(builder: ShaderBuilder): SkeletonGeometry {
    defineRaycastConeShader(builder);
    builder.addUniform("highp mat4", "uModelToCanonicalVoxel");
    builder.addUniform("highp float", "uEdgePixelRadius");
    builder.addFragmentCode(glsl_raycastEmitter);
    let vertexMain =
      glsl_edgeVertexSetup +
      `
highp vec3 canonicalVertexA = (uModelToCanonicalVoxel * vec4(vertexA, 1.0)).xyz;
highp vec3 canonicalVertexB = (uModelToCanonicalVoxel * vec4(vertexB, 1.0)).xyz;
highp vec2 edgeRadii = getRaycastSegmentRadiiForPixels(
    canonicalVertexA, canonicalVertexB, uEdgePixelRadius);
emitRaycastCone(canonicalVertexA, canonicalVertexB, edgeRadii.x, edgeRadii.y,
                getRaycastRadiusForPixels(canonicalVertexA, uNodeClipPixelRadius),
                getRaycastRadiusForPixels(canonicalVertexB, uNodeClipPixelRadius));
`;
    let fragmentSetup = glsl_raycastFragmentSetup;
    if (this.hasSpatialChunkCull) {
      builder.addVarying("highp vec3", "vCullPosA", "flat");
      builder.addVarying("highp vec3", "vCullPosB", "flat");
      vertexMain += `vCullPosA = vertexA;\nvCullPosB = vertexB;\n`;
      fragmentSetup += `spatialChunkCull(mix(vCullPosA, vCullPosB, raycastConeAxialFraction));\n`;
    }
    vertexMain += this.readSegmentIdGlsl("aVertexIndex.x");
    return {
      vertexMain,
      fragmentSetup,
      attributeAccess: SkeletonAttributeAccess.CONE_ENDPOINTS,
    };
  }

  private defineNodeCircleGeometry(builder: ShaderBuilder): SkeletonGeometry {
    defineCircleShader(builder, /*crossSectionFade=*/ this.targetIsSliceView);
    builder.addUniform("highp float", "uNodeDiameter");
    builder.addFragmentCode(glsl_circleEmitter);
    let vertexMain = glsl_nodeVertexSetup;
    let fragmentSetup = "";
    if (this.hasSpatialChunkCull) {
      builder.addVarying("highp vec3", "vCullPos");
      vertexMain += `vCullPos = vertexPosition;\n`;
      fragmentSetup = `spatialChunkCull(vCullPos);\n`;
    }
    vertexMain += this.readSegmentIdGlsl("vertexIndex");
    vertexMain += `emitCircle(uProjection * vec4(vertexPosition, 1.0), uNodeDiameter, 0.0);\n`;
    return {
      vertexMain,
      fragmentSetup,
      attributeAccess: SkeletonAttributeAccess.VERTEX_INDEX,
    };
  }

  private defineNodeSphereGeometry(builder: ShaderBuilder): SkeletonGeometry {
    defineRaycastSphereShader(builder);
    builder.addUniform("highp mat4", "uModelToCanonicalVoxel");
    builder.addUniform("highp float", "uNodePixelRadius");
    builder.addFragmentCode(glsl_raycastEmitter);
    let vertexMain =
      glsl_nodeVertexSetup +
      `
highp vec3 canonicalPosition = (uModelToCanonicalVoxel * vec4(vertexPosition, 1.0)).xyz;
emitRaycastSphere(
    canonicalPosition,
    getRaycastRadiusForPixels(canonicalPosition, uNodePixelRadius));
`;
    let fragmentSetup = glsl_raycastFragmentSetup;
    if (this.hasSpatialChunkCull) {
      builder.addVarying("highp vec3", "vCullPos", "flat");
      vertexMain += `vCullPos = vertexPosition;\n`;
      fragmentSetup += `spatialChunkCull(vCullPos);\n`;
    }
    vertexMain += this.readSegmentIdGlsl("vertexIndex");
    return {
      vertexMain,
      fragmentSetup,
      attributeAccess: SkeletonAttributeAccess.VERTEX_INDEX,
    };
  }

  // Canonical voxels have no anisotropic scale, so a node never draws as an
  // ellipsoid.
  private setRaycastUniforms(
    shader: ShaderProgram,
    renderContext: PerspectiveViewRenderContext,
    modelMatrix: mat4,
  ) {
    const { gl } = this;
    const { projectionParameters } = renderContext;
    const { canonicalVoxelFactors } =
      projectionParameters.displayDimensionRenderInfo;
    const canonicalVoxelScale = vec3.set(
      tempCanonicalVoxelScale,
      canonicalVoxelFactors[0],
      canonicalVoxelFactors[1],
      canonicalVoxelFactors[2],
    );
    // Camera-relative, because float32 visibly distorts the surface from about 1e6
    // canonical voxels from the origin.
    const { invViewMatrix } = projectionParameters;
    const cameraOffset = vec3.set(
      tempCameraOffset,
      invViewMatrix[12] * canonicalVoxelScale[0],
      invViewMatrix[13] * canonicalVoxelScale[1],
      invViewMatrix[14] * canonicalVoxelScale[2],
    );
    const modelToCanonicalVoxel = mat4.multiply(
      tempModelToCanonicalVoxel,
      mat4.fromScaling(tempCanonicalVoxelScaleMatrix, canonicalVoxelScale),
      modelMatrix,
    );
    modelToCanonicalVoxel[12] -= cameraOffset[0];
    modelToCanonicalVoxel[13] -= cameraOffset[1];
    modelToCanonicalVoxel[14] -= cameraOffset[2];
    const canonicalVoxelClip = mat4.scale(
      tempCanonicalVoxelClip,
      projectionParameters.viewProjectionMat,
      vec3.inverse(tempInverseCanonicalVoxelScale, canonicalVoxelScale),
    );
    // Undoes the camera offset, so model coordinates reach the same clip
    // coordinates.
    mat4.translate(canonicalVoxelClip, canonicalVoxelClip, cameraOffset);
    gl.uniformMatrix4fv(
      shader.uniform("uModelToCanonicalVoxel"),
      false,
      modelToCanonicalVoxel,
    );
    initializeRaycastPrimitiveShader(
      shader,
      canonicalVoxelClip,
      projectionParameters,
    );
    const { lightDirection, ambientLighting, directionalLighting } =
      renderContext;
    gl.uniform4f(
      shader.uniform("uLightDirection"),
      lightDirection[0] * directionalLighting,
      lightDirection[1] * directionalLighting,
      lightDirection[2] * directionalLighting,
      ambientLighting,
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

  private get featherWidthInPixels() {
    return this.targetIsSliceView ? 1.0 : 0.0;
  }

  getCrossSectionFadeFactor() {
    if (this.targetIsSliceView) {
      return "(clamp(1.0 - 2.0 * abs(0.5 - gl_FragCoord.z), 0.0, 1.0))";
    }
    return "(1.0)";
  }

  private unbindTextures(shaders: readonly ShaderProgram[]) {
    const { gl, clearedTextureUnits } = this;
    const numAttributes = this.vertexAttributes.length;
    clearedTextureUnits.clear();
    for (const shader of shaders) {
      const textureUnits = vertexAttributeSamplerSymbols
        .slice(0, numAttributes)
        .map((symbol) => shader.textureUnit(symbol)!);
      if (shader.textureUnits.has(segmentIdSamplerSymbol)) {
        textureUnits.push(shader.textureUnit(segmentIdSamplerSymbol)!);
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

export enum SkeletonRenderMode3d {
  LINES = 0,
  LINES_AND_POINTS = 1,
  CYLINDERS = 2,
  CYLINDERS_AND_SPHERES = 3,
}

export enum SkeletonRenderMode2d {
  LINES = SkeletonRenderMode3d.LINES,
  LINES_AND_POINTS = SkeletonRenderMode3d.LINES_AND_POINTS,
}

export type SkeletonRenderMode = SkeletonRenderMode2d | SkeletonRenderMode3d;

function isRaycastMode(mode: SkeletonRenderMode) {
  return (
    mode === SkeletonRenderMode3d.CYLINDERS ||
    mode === SkeletonRenderMode3d.CYLINDERS_AND_SPHERES
  );
}

function hasEnlargedNodes(mode: SkeletonRenderMode) {
  return (
    mode === SkeletonRenderMode3d.LINES_AND_POINTS ||
    mode === SkeletonRenderMode3d.CYLINDERS_AND_SPHERES
  );
}

export class TrackableSkeletonRenderMode2d extends TrackableEnum<SkeletonRenderMode2d> {
  constructor(
    value: SkeletonRenderMode2d,
    defaultValue: SkeletonRenderMode2d = value,
  ) {
    super(SkeletonRenderMode2d, value, defaultValue);
  }
}

export class TrackableSkeletonRenderMode3d extends TrackableEnum<SkeletonRenderMode3d> {
  constructor(
    value: SkeletonRenderMode3d,
    defaultValue: SkeletonRenderMode3d = value,
  ) {
    super(SkeletonRenderMode3d, value, defaultValue);
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
  return hasEnlargedNodes(renderMode) ? Math.max(5, lineWidth * 2) : lineWidth;
}

export interface ViewSpecificSkeletonRenderingOptions<
  Mode extends SkeletonRenderMode = SkeletonRenderMode,
> {
  mode: TrackableEnum<Mode>;
  lineWidth: TrackableSkeletonLineWidth;
}

export class SkeletonRenderingOptions implements Trackable {
  private compound = new CompoundTrackable();
  get changed() {
    return this.compound.changed;
  }

  shader = makeTrackableFragmentMain(DEFAULT_FRAGMENT_MAIN);
  readonly edgeShaderError = makeWatchableShaderError();
  readonly nodeShaderError = makeWatchableShaderError();
  readonly shaderError: WatchableShaderError;
  shaderControlState = new ShaderControlState(this.shader);
  codeVisible = new TrackableBoolean(true);
  hideInactiveShaderControls = new TrackableBoolean(false);
  params2d: ViewSpecificSkeletonRenderingOptions<SkeletonRenderMode2d> = {
    mode: new TrackableSkeletonRenderMode2d(
      SkeletonRenderMode2d.LINES_AND_POINTS,
    ),
    lineWidth: new TrackableSkeletonLineWidth(2),
  };
  params3d: ViewSpecificSkeletonRenderingOptions<SkeletonRenderMode3d> = {
    mode: new TrackableSkeletonRenderMode3d(SkeletonRenderMode3d.LINES),
    lineWidth: new TrackableSkeletonLineWidth(1),
  };

  constructor(layer: RefCounted) {
    this.shaderError = makeAggregateWatchableShaderError(layer, [
      this.edgeShaderError,
      this.nodeShaderError,
    ]);
    const { compound } = this;
    compound.add("shader", this.shader);
    compound.add("shaderControls", this.shaderControlState);
    compound.add("codeVisible", this.codeVisible);
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
    SkeletonChunkNodes
  >();
  vertexAttributes: VertexAttributeRenderInfo[];
  readonly geometryKind = SkeletonGeometryKind.SINGLE_SEGMENT;

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
    const { skeletonRenderingOptions: renderingOptions } = displayState;
    const resetShaderErrors = () => {
      renderingOptions.edgeShaderError.value = undefined;
      renderingOptions.nodeShaderError.value = undefined;
    };
    resetShaderErrors();
    this.registerDisposer(
      renderingOptions.shader.changed.add(() => {
        resetShaderErrors();
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

  private getSegmentChunkNodes(
    segmentId: bigint,
  ): SkeletonChunkNodes | undefined {
    const chunk = this.source.chunks.get(getObjectKey(segmentId));
    if (chunk === undefined) return undefined;
    let chunkNodes = this.chunkNodes.get(chunk);
    if (chunkNodes === undefined) {
      chunkNodes = getSkeletonChunkNodes(segmentId, chunk);
      this.chunkNodes.set(chunk, chunkNodes);
    }
    return chunkNodes;
  }

  getSegmentNodes(segmentId: bigint): readonly SkeletonNode[] | undefined {
    return this.getSegmentChunkNodes(segmentId)?.nodes;
  }

  getSegmentLoopEdges(segmentId: bigint): readonly SkeletonEdge[] | undefined {
    return this.getSegmentChunkNodes(segmentId)?.loopEdges;
  }

  readonly parentsInferred = true;

  draw(
    renderContext: SliceViewPanelRenderContext | PerspectiveViewRenderContext,
    layer: RenderLayer,
    renderHelper: RenderHelper,
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
    renderHelper.draw(
      renderContext,
      { modelMatrix, binding: attachment },
      (drawSkeleton) => {
        forEachVisibleSegmentToDraw(
          displayState,
          layer,
          renderContext.emitPickID ? renderContext.pickIDs : undefined,
          (objectId, pickIndex, colorSegmentId) => {
            const skeleton = skeletons.get(getObjectKey(objectId));
            if (
              skeleton === undefined ||
              skeleton.state !== ChunkState.GPU_MEMORY
            ) {
              return;
            }
            drawSkeleton(skeleton, { colorSegmentId, pickIds: pickIndex });
          },
        );
      },
    );
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

export function skeletonEmitsAlpha(displayState: SkeletonLayerDisplayState) {
  return (
    stripComments(displayState.skeletonRenderingOptions.shader.value).includes(
      "emitRGBA",
    ) || displayState.segmentationColorUserShader.mayReturnAlpha
  );
}

export class PerspectiveViewSkeletonLayer extends PerspectiveViewRenderLayer {
  private renderHelper: RenderHelper;
  private renderOptions: ViewSpecificSkeletonRenderingOptions;
  constructor(public base: SkeletonLayer) {
    super();
    this.renderOptions = base.displayState.skeletonRenderingOptions.params3d;
    this.renderHelper = this.registerDisposer(
      new RenderHelper(base, false, this.renderOptions),
    );

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
      displayState.objectAlpha.value < 1.0 || skeletonEmitsAlpha(displayState)
    );
  }

  get transparentPickEnabled() {
    return this.base.displayState.transparentPickEnabled.value;
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
    this.base.draw(renderContext, this, this.renderHelper, attachment);
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
    this.renderOptions = base.displayState.skeletonRenderingOptions.params2d;
    this.renderHelper = this.registerDisposer(
      new RenderHelper(base, true, this.renderOptions),
    );
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
    this.base.draw(renderContext, this, this.renderHelper, attachment);
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
