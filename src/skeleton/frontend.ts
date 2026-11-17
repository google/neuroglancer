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
import type { LayerView, VisibleLayerInfo } from "#src/layer/index.js";
import type { PerspectivePanel } from "#src/perspective_view/panel.js";
import type { PerspectiveViewRenderContext } from "#src/perspective_view/render_layer.js";
import { PerspectiveViewRenderLayer } from "#src/perspective_view/render_layer.js";
import type {
  RenderLayer,
  ThreeDimensionalRenderLayerAttachmentState,
} from "#src/renderlayer.js";
import { update3dRenderLayerAttachment } from "#src/renderlayer.js";
import type {
  SegmentationColorUserShaderManagerParameters,
  SegmentPropertyShaderDefinition,
} from "#src/segment_color.js";
import {
  DEFAULT_USER_MAIN_SEGMENT_COLOR,
  encodeSegmentPropertyShaderDefinition,
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
import type { VertexAttributeInfo } from "#src/skeleton/base.js";
import { SKELETON_LAYER_RPC_ID } from "#src/skeleton/base.js";
import type { SliceViewPanel } from "#src/sliceview/panel.js";
import type { SliceViewPanelRenderContext } from "#src/sliceview/renderlayer.js";
import { SliceViewPanelRenderLayer } from "#src/sliceview/renderlayer.js";
import { TrackableBoolean } from "#src/trackable_boolean.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import {
  makeCachedDerivedWatchableValue,
  AggregateWatchableValue,
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
import type { ParameterizedShaderGetterResult } from "#src/webgl/dynamic_shader.js";
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

const tempModelClip = mat4.create();
const tempCanonicalVoxelClip = mat4.create();
const tempModelToCanonicalVoxel = mat4.create();
const tempCameraOffset = vec3.create();
const tempCanonicalVoxelScaleMatrix = mat4.create();
const tempCanonicalVoxelScale = vec3.create();
const tempInverseCanonicalVoxelScale = vec3.create();

const DEFAULT_FRAGMENT_MAIN = `void main() {
  emitDefault();
}
`;

// The colour of a raycast primitive, shared by the cone and the sphere.
// raycastLightingFactor applies spotlight and ambient lighting in a Lambertian
// shading model.
const glsl_raycastSkeletonEmit = `
void emitRGBA(vec4 color) {
  color.a *= uAlpha;
  emit(premultiplyAlpha(vec4(color.rgb * raycastLightingFactor, color.a)),
       raycastSurfaceDepth, uPickID);
}
`;

export enum SkeletonRenderMode3d {
  LINES = 0,
  LINES_AND_POINTS = 1,
  CYLINDERS = 2,
  CYLINDERS_AND_BALLS = 3,
}

export enum SkeletonRenderMode2d {
  LINES = SkeletonRenderMode3d.LINES,
  LINES_AND_POINTS = SkeletonRenderMode3d.LINES_AND_POINTS,
}

export type SkeletonRenderMode = SkeletonRenderMode2d | SkeletonRenderMode3d;

function isRaycastMode(mode: SkeletonRenderMode) {
  return (
    mode === SkeletonRenderMode3d.CYLINDERS ||
    mode === SkeletonRenderMode3d.CYLINDERS_AND_BALLS
  );
}

function hasEnlargedNodes(mode: SkeletonRenderMode) {
  return (
    mode === SkeletonRenderMode3d.LINES_AND_POINTS ||
    mode === SkeletonRenderMode3d.CYLINDERS_AND_BALLS
  );
}

interface VisibleSkeletonToDraw {
  readonly skeleton: SkeletonChunk;
  readonly pickIndex: number;
  readonly colorObjectId: bigint;
}

interface SkeletonShaderParameters {
  segmentColorParameters: SegmentationColorUserShaderManagerParameters;
  segmentColorProperties: readonly SegmentPropertyShaderDefinition[];
  segmentColorShaderBuilderState: ShaderControlsBuilderState;
  skeletonShaderBuilderState: ShaderControlsBuilderState;
}

// What one draw call covers, which decides how a vertex attribute reaches the
// fragment shader.
enum SkeletonShaderGeometry {
  // A quad whose two ends are the edge's endpoints, so the rasteriser interpolates.
  LINE_QUAD = 0,
  // One quad per node, reading that node's attribute.
  CIRCLE_QUAD = 1,
  // A bounding quad whose vertices are corners, not endpoints. Nothing to
  // interpolate from, so the fragment shader has to do it: two flat varyings per
  // attribute instead of one, mixed by where the hit falls along the cone.
  RAYCAST_CONE = 2,
  // One bounding quad per node, as CIRCLE_QUAD.
  RAYCAST_SPHERE = 3,
}

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

class RenderHelper extends RefCounted {
  private textureAccessHelper = new OneDimensionalTextureAccessHelper(
    "vertexData",
  );
  private vertexIdHelper;
  private readonly raycastEnabled: WatchableValueInterface<boolean>;
  get vertexAttributes(): VertexAttributeRenderInfo[] {
    return this.base.vertexAttributes;
  }

  defineCommonShader(
    builder: ShaderBuilder,
    {
      segmentColorParameters,
      segmentColorShaderBuilderState,
    }: SkeletonShaderParameters,
  ) {
    this.base.displayState.segmentationColorUserShader.defineShader(
      builder,
      /*fragment=*/ true,
      segmentColorShaderBuilderState,
      segmentColorParameters,
    );
    defineVertexId(builder);
    builder.require(projectionMatrixShaderModule);
    // Skeleton shaders use straight-alpha colors until the final emission.
    builder.addUniform("highp float", "uAlpha");
    builder.addUniform("highp uint", "uPickID");
    builder.addUniform("highp uvec2", "uID");
    this.defineAttributeAccess(builder);
    builder.addFragmentCode(`
// Layer opacity is applied by emitRGBA.
vec4 segmentColor() {
  return segmentColorUserShader(uint64_t(uID));
}
vec4 premultiplyAlpha(vec4 color) {
  return ${this.targetIsSliceView ? "color" : "vec4(color.rgb * color.a, color.a)"};
}
`);
  }

  get featherWidthInPixels() {
    return this.targetIsSliceView ? 1.0 : 0.0;
  }

  edgeShaderGetter;
  nodeShaderGetter;

  get gl(): GL {
    return this.base.gl;
  }

  constructor(
    public base: SkeletonLayer,
    public targetIsSliceView: boolean,
    renderOptions: ViewSpecificSkeletonRenderingOptions,
  ) {
    super();

    const { displayState } = base;
    const parameters: WatchableValueInterface<SkeletonShaderParameters> =
      this.registerDisposer(
        new AggregateWatchableValue(() => ({
          segmentColorParameters:
            displayState.segmentationColorUserShader.shaderParameters,
          segmentColorProperties:
            displayState.segmentationColorUserShader.usedProperties,
          segmentColorShaderBuilderState:
            displayState.segmentColorShaderControlState.builderState,
          skeletonShaderBuilderState:
            displayState.skeletonRenderingOptions.shaderControlState
              .builderState,
        })),
      );
    const initialFallbackParameters: SkeletonShaderParameters = {
      segmentColorParameters:
        displayState.segmentationColorUserShader.shaderParameters.value,
      segmentColorProperties: [],
      segmentColorShaderBuilderState: getFallbackBuilderState(
        parseShaderUiControls(DEFAULT_USER_MAIN_SEGMENT_COLOR),
      ),
      skeletonShaderBuilderState: getFallbackBuilderState(
        parseShaderUiControls(DEFAULT_FRAGMENT_MAIN),
      ),
    };

    this.vertexIdHelper = this.registerDisposer(VertexIdHelper.get(this.gl));
    this.raycastEnabled = this.registerDisposer(
      makeCachedDerivedWatchableValue(
        (mode: SkeletonRenderMode) => !targetIsSliceView && isRaycastMode(mode),
        [renderOptions.mode],
      ),
    );

    const sharedShaderOptions = {
      parameters,
      encodeParameters: (p: SkeletonShaderParameters) =>
        `${p.skeletonShaderBuilderState.key}/${p.segmentColorShaderBuilderState.key}/${JSON.stringify(p.segmentColorParameters)}/${JSON.stringify(p.segmentColorProperties.map(encodeSegmentPropertyShaderDefinition))}`,
      extraParameters: this.raycastEnabled,
    };
    this.edgeShaderGetter = parameterizedEmitterDependentShaderGetter(
      this,
      this.gl,
      {
        ...sharedShaderOptions,
        shaderError: displayState.skeletonRenderingOptions.edgeShaderError,
        fallbackParameters: new WatchableValue(initialFallbackParameters),
        memoizeKey: {
          type: "skeleton/edge",
          vertexAttributes: this.vertexAttributes,
        },
        defineShader: this.defineEdgeShader.bind(this),
      },
    );
    this.nodeShaderGetter = parameterizedEmitterDependentShaderGetter(
      this,
      this.gl,
      {
        ...sharedShaderOptions,
        shaderError: displayState.skeletonRenderingOptions.nodeShaderError,
        fallbackParameters: new WatchableValue(initialFallbackParameters),
        memoizeKey: {
          type: "skeleton/node",
          vertexAttributes: this.vertexAttributes,
        },
        defineShader: this.defineNodeShader.bind(this),
      },
    );
  }

  private defineEdgeShader(
    builder: ShaderBuilder,
    parameters: SkeletonShaderParameters,
    useRaycast: boolean,
  ) {
    this.defineCommonShader(builder, parameters);
    builder.addAttribute("highp uvec2", "aVertexIndex");
    builder.addUniform("highp float", "uNodeClipPixelRadius");
    let vertexMain = `
highp vec3 vertexA = readAttribute0(aVertexIndex.x);
highp vec3 vertexB = readAttribute0(aVertexIndex.y);
`;
    if (useRaycast) {
      defineRaycastConeShader(builder);
      builder.addUniform("highp float", "uEdgePixelRadius");
      builder.addUniform("highp mat4", "uModelToCanonicalVoxel");
      vertexMain += `
highp vec3 canonicalVertexA = (uModelToCanonicalVoxel * vec4(vertexA, 1.0)).xyz;
highp vec3 canonicalVertexB = (uModelToCanonicalVoxel * vec4(vertexB, 1.0)).xyz;
highp vec2 edgeRadii = getRaycastSegmentRadiiForPixels(
    canonicalVertexA, canonicalVertexB, uEdgePixelRadius);
emitRaycastCone(canonicalVertexA, canonicalVertexB, edgeRadii.x, edgeRadii.y,
                    getRaycastRadiusForPixels(canonicalVertexA, uNodeClipPixelRadius),
                    getRaycastRadiusForPixels(canonicalVertexB, uNodeClipPixelRadius));
`;
      builder.addFragmentCode(glsl_raycastSkeletonEmit);
    } else {
      defineLineShader(builder, { endpointClipping: true });
      builder.addUniform("highp float", "uLineWidth");
      vertexMain += `
emitLine(uProjection, vertexA, vertexB, uLineWidth,
         uNodeClipPixelRadius, uNodeClipPixelRadius);
highp uint lineEndpointIndex = getLineEndpointIndex();
highp uint vertexIndex = aVertexIndex.x * (1u - lineEndpointIndex) + aVertexIndex.y * lineEndpointIndex;
`;
      builder.addFragmentCode(`
void emitRGBA(vec4 color) {
  color.a *= uAlpha * getLineAlpha() * ${this.getCrossSectionFadeFactor()};
  emit(premultiplyAlpha(color), uPickID);
}
`);
    }
    this.finalizeShaderBuilder(
      builder,
      parameters.skeletonShaderBuilderState,
      vertexMain,
      useRaycast
        ? SkeletonShaderGeometry.RAYCAST_CONE
        : SkeletonShaderGeometry.LINE_QUAD,
    );
  }

  private defineNodeShader(
    builder: ShaderBuilder,
    parameters: SkeletonShaderParameters,
    useRaycast: boolean,
  ) {
    this.defineCommonShader(builder, parameters);
    let vertexMain = `
highp uint vertexIndex = uint(gl_InstanceID);
highp vec3 vertexPosition = readAttribute0(vertexIndex);
`;
    if (useRaycast) {
      defineRaycastSphereShader(builder);
      builder.addUniform("highp float", "uNodePixelRadius");
      builder.addUniform("highp mat4", "uModelToCanonicalVoxel");
      vertexMain += `
highp vec3 canonicalPosition = (uModelToCanonicalVoxel * vec4(vertexPosition, 1.0)).xyz;
emitRaycastSphere(
    canonicalPosition,
    getRaycastRadiusForPixels(canonicalPosition, uNodePixelRadius));
`;
      builder.addFragmentCode(glsl_raycastSkeletonEmit);
    } else {
      defineCircleShader(builder, /*crossSectionFade=*/ this.targetIsSliceView);
      builder.addUniform("highp float", "uNodeDiameter");
      vertexMain += `emitCircle(uProjection * vec4(vertexPosition, 1.0), uNodeDiameter, 0.0);\n`;
      builder.addFragmentCode(`
void emitRGBA(vec4 color) {
  color.a *= uAlpha;
  vec4 borderColor = color;
  vec4 circleColor = getCircleColor(color, borderColor);
  emit(premultiplyAlpha(circleColor), uPickID);
}
`);
    }
    this.finalizeShaderBuilder(
      builder,
      parameters.skeletonShaderBuilderState,
      vertexMain,
      useRaycast
        ? SkeletonShaderGeometry.RAYCAST_SPHERE
        : SkeletonShaderGeometry.CIRCLE_QUAD,
    );
  }

  private finalizeShaderBuilder(
    builder: ShaderBuilder,
    shaderBuilderState: ShaderControlsBuilderState,
    vertexMain: string,
    geometry: SkeletonShaderGeometry,
  ) {
    if (shaderBuilderState.parseResult.errors.length !== 0) {
      throw new Error("Invalid UI control specification");
    }
    const useRaycast =
      geometry === SkeletonShaderGeometry.RAYCAST_CONE ||
      geometry === SkeletonShaderGeometry.RAYCAST_SPHERE;
    const interpolateInFragment =
      geometry === SkeletonShaderGeometry.RAYCAST_CONE;
    builder.addFragmentCode(`
void emitRGB(vec3 color) {
  emitRGBA(vec4(color, 1.0));
}
void emitDefault() {
  emitRGBA(segmentColor());
}
`);
    builder.addFragmentCode(glsl_COLORMAPS);
    const { vertexAttributes } = this;
    for (let i = 1; i < vertexAttributes.length; ++i) {
      const info = vertexAttributes[i];
      let attributeExpression: string;
      if (!interpolateInFragment) {
        builder.addVarying(`highp ${info.glslDataType}`, `vCustom${i}`);
        vertexMain += `vCustom${i} = readAttribute${i}(vertexIndex);\n`;
        attributeExpression = `vCustom${i}`;
      } else {
        builder.addVarying(
          `highp ${info.glslDataType}`,
          `vCustomA${i}`,
          "flat",
        );
        builder.addVarying(
          `highp ${info.glslDataType}`,
          `vCustomB${i}`,
          "flat",
        );
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
    addControlsToBuilder(shaderBuilderState, builder);
    builder.addFragmentCode(glsl_string);
    builder.addFragmentCode("void userMain();\n");
    builder.addFragmentCode(
      wrapUserShaderMain(shaderBuilderState.parseResult.code),
    );
    // The raycast setup runs first so that a miss discards before the user's code.
    builder.setFragmentMain(
      (useRaycast ? glsl_raycastFragmentSetup : "") + "userMain();",
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
    if (this.raycastEnabled.value) {
      this.setRaycastUniforms(gl, shader, renderContext, modelMatrix);
    } else {
      gl.uniformMatrix4fv(
        shader.uniform("uProjection"),
        false,
        mat4.multiply(
          tempModelClip,
          renderContext.projectionParameters.viewProjectionMat,
          modelMatrix,
        ),
      );
    }
    gl.uniform1f(
      shader.uniform("uAlpha"),
      this.base.displayState.objectAlpha.value,
    );
    this.vertexIdHelper.enable();
  }

  // The raycast solves a true sphere, so it needs a space with no anisotropic
  // scale left in it. Global coordinates scaled to canonical voxels is that space.
  // Solving in layer coordinates would draw every node of an anisotropic dataset as
  // an ellipsoid. The light direction is given in the same space, so the surface
  // normal needs no further transform.
  private setRaycastUniforms(
    gl: GL,
    shader: ShaderProgram,
    renderContext: SliceViewPanelRenderContext | PerspectiveViewRenderContext,
    modelMatrix: mat4,
  ) {
    const { projectionParameters } = renderContext;
    const { canonicalVoxelFactors } =
      projectionParameters.displayDimensionRenderInfo;
    const canonicalVoxelScale = vec3.set(
      tempCanonicalVoxelScale,
      canonicalVoxelFactors[0],
      canonicalVoxelFactors[1],
      canonicalVoxelFactors[2],
    );
    // Camera-relative, so that both the geometry and the ray origin the fragment
    // shader reconstructs sit near zero. Without it both carry the camera's own
    // coordinates, and float32 cannot hold their difference finely enough: a
    // dataset 1e4 canonical voxels from the origin loses the surface normal
    // outright, which shows as dark patches and banding along a tube.
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
    // Puts the offset back, so the pair still maps model coordinates to the same
    // clip coordinates as before.
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
      renderContext as PerspectiveViewRenderContext;
    gl.uniform4f(
      shader.uniform("uLightDirection"),
      lightDirection[0] * directionalLighting,
      lightDirection[1] * directionalLighting,
      lightDirection[2] * directionalLighting,
      ambientLighting,
    );
  }

  setEdgeSizeUniforms(
    gl: GL,
    shader: ShaderProgram,
    projectionParameters: { width: number; height: number },
    lineWidth: number,
    nodeDiameter: number,
  ) {
    gl.uniform1f(
      shader.uniform("uNodeClipPixelRadius"),
      nodeDiameter / 2 + this.featherWidthInPixels,
    );
    if (this.raycastEnabled.value) {
      gl.uniform1f(shader.uniform("uEdgePixelRadius"), lineWidth / 2);
    } else {
      initializeLineShader(
        shader,
        projectionParameters,
        this.featherWidthInPixels,
      );
      gl.uniform1f(shader.uniform("uLineWidth"), lineWidth);
    }
  }

  setNodeSizeUniforms(
    gl: GL,
    shader: ShaderProgram,
    projectionParameters: { width: number; height: number },
    nodeDiameter: number,
  ) {
    if (this.raycastEnabled.value) {
      gl.uniform1f(shader.uniform("uNodePixelRadius"), nodeDiameter / 2);
    } else {
      initializeCircleShader(shader, projectionParameters, {
        featherWidthInPixels: this.featherWidthInPixels,
      });
      gl.uniform1f(shader.uniform("uNodeDiameter"), nodeDiameter);
    }
  }

  setPickID(gl: GL, shader: ShaderProgram, pickID: number) {
    gl.uniform1ui(shader.uniform("uPickID"), pickID);
  }

  setID(gl: GL, shader: ShaderProgram, id: bigint) {
    gl.uniform2ui(
      shader.uniform("uID"),
      Number(id & 0xffffffffn),
      Number(id >> 32n),
    );
  }

  private bindVertexAttributeTextures(
    gl: GL,
    shader: ShaderProgram,
    skeletonChunk: SkeletonChunk,
  ) {
    const { vertexAttributes } = this;
    const numAttributes = vertexAttributes.length;
    const { vertexAttributeTextures } = skeletonChunk;
    for (let i = 0; i < numAttributes; ++i) {
      const textureUnit =
        WebGL2RenderingContext.TEXTURE0 +
        shader.textureUnit(vertexAttributeSamplerSymbols[i])!;
      gl.activeTexture(textureUnit);
      gl.bindTexture(
        WebGL2RenderingContext.TEXTURE_2D,
        vertexAttributeTextures[i],
      );
    }
  }

  beginEdges(gl: GL, shader: ShaderProgram) {
    gl.vertexAttribDivisor(shader.attribute("aVertexIndex"), 1);
  }

  drawEdges(gl: GL, shader: ShaderProgram, skeletonChunk: SkeletonChunk) {
    this.bindVertexAttributeTextures(gl, shader, skeletonChunk);
    skeletonChunk.indexBuffer.bindToVertexAttribI(
      shader.attribute("aVertexIndex"),
      2,
      WebGL2RenderingContext.UNSIGNED_INT,
    );
    const numEdges = skeletonChunk.numIndices / 2;
    if (this.raycastEnabled.value) {
      drawQuads(gl, 1, numEdges);
    } else {
      drawLines(gl, 1, numEdges);
    }
  }

  endEdges(gl: GL, shader: ShaderProgram) {
    const edgeAttributeIndex = shader.attribute("aVertexIndex");
    gl.vertexAttribDivisor(edgeAttributeIndex, 0);
    gl.disableVertexAttribArray(edgeAttributeIndex);
  }

  // Nodes are drawn in every render mode so that there are no visible gaps
  // between edges.
  drawNodes(gl: GL, shader: ShaderProgram, skeletonChunk: SkeletonChunk) {
    this.bindVertexAttributeTextures(gl, shader, skeletonChunk);
    if (this.raycastEnabled.value) {
      drawQuads(gl, 1, skeletonChunk.numVertices);
    } else {
      drawCircles(gl, 1, skeletonChunk.numVertices);
    }
  }

  endLayer(
    gl: GL,
    ...shaderResults: ParameterizedShaderGetterResult<SkeletonShaderParameters>[]
  ) {
    const { vertexAttributes } = this;
    const { segmentationColorUserShader } = this.base.displayState;
    const numAttributes = vertexAttributes.length;
    for (const { shader, parameters } of shaderResults) {
      if (shader === null) continue;
      for (let i = 0; i < numAttributes; ++i) {
        const textureUnit =
          shader.textureUnit(vertexAttributeSamplerSymbols[i])! +
          WebGL2RenderingContext.TEXTURE0;
        gl.activeTexture(textureUnit);
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
      segmentationColorUserShader.disable(
        gl,
        shader,
        parameters.segmentColorParameters,
      );
    }
    this.vertexIdHelper.disable();
  }
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

export interface ViewSpecificSkeletonRenderingOptions<
  Mode extends SkeletonRenderMode = SkeletonRenderMode,
> {
  mode: TrackableEnum<Mode>;
  lineWidth: TrackableSkeletonLineWidth;
}

export class SkeletonRenderingOptions extends RefCounted implements Trackable {
  private compound = new CompoundTrackable();
  get changed() {
    return this.compound.changed;
  }

  shader = makeTrackableFragmentMain(DEFAULT_FRAGMENT_MAIN);
  readonly edgeShaderError = makeWatchableShaderError();
  readonly nodeShaderError = makeWatchableShaderError();
  readonly shaderError = makeAggregateWatchableShaderError(this, [
    this.edgeShaderError,
    this.nodeShaderError,
  ]);
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

  constructor() {
    super();
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
  skeletonRenderingOptions: SkeletonRenderingOptions;
}

export class SkeletonLayer extends RefCounted {
  layerChunkProgressInfo = new LayerChunkProgressInfo();
  redrawNeeded = new NullarySignal();
  private sharedObject: SegmentationLayerSharedObject;
  vertexAttributes: VertexAttributeRenderInfo[];

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
    const { gl, displayState } = this;
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
    const nodeDiameter = hasEnlargedNodes(renderOptions.mode.value)
      ? Math.max(5, lineWidth * 2)
      : lineWidth;

    const edgeShaderResult = renderHelper.edgeShaderGetter(
      renderContext.emitter,
    );
    const nodeShaderResult = renderHelper.nodeShaderGetter(
      renderContext.emitter,
    );
    const { shader: edgeShader } = edgeShaderResult;
    const { shader: nodeShader } = nodeShaderResult;
    if (edgeShader === null && nodeShader === null) return;

    const { projectionParameters } = renderContext;

    const visibleSkeletons = this.collectVisibleSkeletons(layer, renderContext);

    if (edgeShader !== null) {
      edgeShader.bind();
      renderHelper.beginLayer(gl, edgeShader, renderContext, modelMatrix);
      this.enableShaderControls(edgeShader, edgeShaderResult, attachment);
      renderHelper.setEdgeSizeUniforms(
        gl,
        edgeShader,
        projectionParameters,
        lineWidth,
        nodeDiameter,
      );
      renderHelper.beginEdges(gl, edgeShader);
      this.drawPass(
        renderContext,
        visibleSkeletons,
        renderHelper,
        edgeShader,
        (skeleton) => renderHelper.drawEdges(gl, edgeShader, skeleton),
      );
      renderHelper.endEdges(gl, edgeShader);
    }

    if (nodeShader !== null) {
      nodeShader.bind();
      renderHelper.beginLayer(gl, nodeShader, renderContext, modelMatrix);
      renderHelper.setNodeSizeUniforms(
        gl,
        nodeShader,
        projectionParameters,
        nodeDiameter,
      );
      this.enableShaderControls(nodeShader, nodeShaderResult, attachment);
      this.drawPass(
        renderContext,
        visibleSkeletons,
        renderHelper,
        nodeShader,
        (skeleton) => renderHelper.drawNodes(gl, nodeShader, skeleton),
      );
    }

    renderHelper.endLayer(gl, edgeShaderResult, nodeShaderResult);
  }

  private enableShaderControls(
    shader: ShaderProgram,
    shaderResult: ParameterizedShaderGetterResult<SkeletonShaderParameters>,
    attachment: VisibleLayerInfo<
      LayerView,
      ThreeDimensionalRenderLayerAttachmentState
    >,
  ) {
    const { gl, displayState } = this;
    const { shaderControlState } = displayState.skeletonRenderingOptions;
    const { parameters, fallback } = shaderResult;
    shaderControlState.activeControls.trackShader(
      { ...shaderResult, parameters: parameters.skeletonShaderBuilderState },
      attachment,
    );
    setControlsInShader(
      gl,
      shader,
      shaderControlState,
      parameters.skeletonShaderBuilderState.parseResult,
    );
    displayState.segmentationColorUserShader.enable(
      gl,
      shader,
      parameters.segmentColorShaderBuilderState,
      { fallback, binding: attachment },
      parameters.segmentColorParameters,
    );
  }

  // Once for both passes. Per pass would run the walk and the pick ID
  // registration twice per segment, and give a segment two pick IDs.
  private collectVisibleSkeletons(
    layer: RenderLayer,
    renderContext: SliceViewPanelRenderContext | PerspectiveViewRenderContext,
  ) {
    const { displayState } = this;
    const skeletons = this.source.chunks;
    const visibleSkeletons: VisibleSkeletonToDraw[] = [];
    forEachVisibleSegmentToDraw(
      displayState,
      layer,
      renderContext.emitPickID ? renderContext.pickIDs : undefined,
      (objectId, pickIndex, colorObjectId) => {
        const skeleton = skeletons.get(getObjectKey(objectId));
        if (
          skeleton === undefined ||
          skeleton.state !== ChunkState.GPU_MEMORY
        ) {
          return;
        }
        visibleSkeletons.push({
          skeleton,
          pickIndex: pickIndex ?? 0,
          colorObjectId,
        });
      },
    );
    return visibleSkeletons;
  }

  private drawPass(
    renderContext: SliceViewPanelRenderContext | PerspectiveViewRenderContext,
    visibleSkeletons: readonly VisibleSkeletonToDraw[],
    renderHelper: RenderHelper,
    shader: ShaderProgram,
    drawCallback: (skeleton: SkeletonChunk) => void,
  ) {
    const { gl } = this;
    const { emitPickID } = renderContext;
    for (const { skeleton, pickIndex, colorObjectId } of visibleSkeletons) {
      renderHelper.setID(gl, shader, colorObjectId);
      if (emitPickID) renderHelper.setPickID(gl, shader, pickIndex);
      drawCallback(skeleton);
    }
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
      displayState.objectAlpha.value < 1.0 ||
      stripComments(
        displayState.skeletonRenderingOptions.shader.value,
      ).includes("emitRGBA") ||
      displayState.segmentationColorUserShader.mayReturnAlpha
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

const vertexPositionAttribute: VertexAttributeRenderInfo = {
  dataType: DataType.FLOAT32,
  numComponents: 3,
  name: "",
  webglDataType: WebGL2RenderingContext.FLOAT,
  glslDataType: "vec3",
};

export class SkeletonChunk extends Chunk {
  declare source: SkeletonSource;
  vertexAttributes: Uint8Array;
  indices: Uint32Array;
  indexBuffer: GLBuffer;
  numIndices: number;
  numVertices: number;
  vertexAttributeOffsets: Uint32Array;
  vertexAttributeTextures: (WebGLTexture | null)[];

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
    const vertexAttributeTextures: (WebGLTexture | null)[] =
      (this.vertexAttributeTextures = []);
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
