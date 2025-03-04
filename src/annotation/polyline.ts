/**
 * @license
 * Copyright 2018 Google Inc.
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

/**
 * @file Support for rendering polyline annotations.
 */

import type { PolyLine } from "#src/annotation/index.js";
import { AnnotationType } from "#src/annotation/index.js";
import type {
  AnnotationRenderContext,
  AnnotationShaderGetter,
} from "#src/annotation/type_handler.js";
import {
  AnnotationRenderHelper,
  registerAnnotationTypeRenderHandler,
} from "#src/annotation/type_handler.js";
// import { projectPointToLineSegment } from "#src/util/geom.js";
import {
  defineCircleShader,
  drawCircles,
  initializeCircleShader,
  VERTICES_PER_CIRCLE,
} from "#src/webgl/circles.js";
import {
  defineLineShader,
  drawLines,
  initializeLineShader,
} from "#src/webgl/lines.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";
import { defineVectorArrayVertexShaderInput } from "#src/webgl/shader_lib.js";
import { defineVertexId, VertexIdHelper } from "#src/webgl/vertex_id.js";

const FULL_OBJECT_PICK_OFFSET = 0;
const ENDPOINTS_PICK_OFFSET = FULL_OBJECT_PICK_OFFSET + 1;
const PICK_IDS_PER_INSTANCE = ENDPOINTS_PICK_OFFSET + 2;

function defineNoOpEndpointMarkerSetters(builder: ShaderBuilder) {
  builder.addVertexCode(`
void setPolyEndpointMarkerSize(float startSize, float endSize) {}
void setPolyEndpointMarkerBorderWidth(float startSize, float endSize) {}
void setPolyEndpointMarkerColor(vec4 startColor, vec4 endColor) {}
void setPolyEndpointMarkerBorderColor(vec4 startColor, vec4 endColor) {}
`);
}

function defineNoOpLineSetters(builder: ShaderBuilder) {
  builder.addVertexCode(`
void setPolyLineWidth(float width) {}
void setPolyLineColor(vec4 startColor, vec4 endColor) {}
`);
}

class RenderHelper extends AnnotationRenderHelper {
  defineShader(builder: ShaderBuilder) {
    defineVertexId(builder);
    // Position of endpoints in model coordinates.
    const { rank } = this;
    defineVectorArrayVertexShaderInput(
      builder,
      "float",
      WebGL2RenderingContext.FLOAT,
      /*normalized=*/ false,
      "VertexPosition",
      rank,
      2,
    );
    const type = "uint";
    const name = "aPolyLineNumVertices";
    builder.addAttribute(type, name);
    builder.addVertexCode(
      `${type} getPolyLineNumVertices() { return ${name}; }`,
    );
    builder.addInitializer((shader) => {
      const location = shader.attribute(name);
      const { gl } = shader;
      shader.vertexShaderInputBinders[name] =
        location === -1
          ? { enable() {}, disable() {}, bind() {} }
          : {
              enable(divisor: number) {
                gl.enableVertexAttribArray(location);
                gl.vertexAttribDivisor(location, divisor);
              },
              disable() {
                gl.vertexAttribDivisor(location, 0);
                gl.disableVertexAttribArray(location);
              },
              bind(stride: number, offset: number) {
                gl.vertexAttribIPointer(
                  location,
                  1,
                  WebGL2RenderingContext.UNSIGNED_INT,
                  stride,
                  offset + 2 * rank * 4,
                );
              },
            };
    });
  }

  private vertexIdHelper = this.registerDisposer(VertexIdHelper.get(this.gl));

  private edgeShaderGetter = this.getDependentShader(
    "annotation/polyline/edge",
    (builder: ShaderBuilder) => {
      const { rank } = this;
      this.defineShader(builder);
      defineLineShader(builder);
      builder.addVarying(`highp float[${rank}]`, "vModelPosition");
      builder.addVertexCode(`
  float ng_PolyLineWidth;
  `);
      defineNoOpEndpointMarkerSetters(builder);
      builder.addVertexCode(`
  void setPolyLineWidth(float width) {
    ng_PolyLineWidth = width;
  }
  void setPolyLineColor(vec4 startColor, vec4 endColor) {
    vColor = mix(startColor, endColor, getLineEndpointCoefficient());
  }
  `);
      builder.setVertexMain(`
  float modelPositionA[${rank}] = getVertexPosition0();
  float modelPositionB[${rank}] = getVertexPosition1();
  for (int i = 0; i < ${rank}; ++i) {
    vModelPosition[i] = mix(modelPositionA[i], modelPositionB[i], getLineEndpointCoefficient());
  }
  ng_PolyLineWidth = 1.0;
  vColor = vec4(0.0, 0.0, 0.0, 0.0);
  ${this.invokeUserMain}
  emitLine(uModelViewProjection * vec4(projectModelVectorToSubspace(modelPositionA), 1.0),
           uModelViewProjection * vec4(projectModelVectorToSubspace(modelPositionB), 1.0),
           ng_PolyLineWidth);
  ${this.setPartIndex(builder)};
  `);
      builder.setFragmentMain(`
  float clipCoefficient = getSubspaceClipCoefficient(vModelPosition);
  emitAnnotation(vec4(vColor.rgb, vColor.a * getLineAlpha() *
                                  ${this.getCrossSectionFadeFactor()} *
                                  clipCoefficient));
  `);
    },
  );

  private endpointShaderGetter = this.getDependentShader(
    "annotation/polyline/endpoint",
    (builder: ShaderBuilder) => {
      const { rank } = this;
      this.defineShader(builder);
      defineCircleShader(builder, this.targetIsSliceView);
      builder.addVarying("highp float", "vClipCoefficient");
      builder.addVarying("highp vec4", "vBorderColor");
      defineNoOpLineSetters(builder);
      builder.addVertexCode(`
  float ng_PolyMarkerDiameter;
  float ng_PolyMarkerBorderWidth;
  int getEndpointIndex() {
    return gl_VertexID / ${VERTICES_PER_CIRCLE};
  }
  void setPolyEndpointMarkerSize(float startSize, float endSize) {
    ng_PolyMarkerDiameter = mix(startSize, endSize, float(getEndpointIndex()));
  }
  void setPolyEndpointMarkerBorderWidth(float startSize, float endSize) {
    ng_PolyMarkerBorderWidth = mix(startSize, endSize, float(getEndpointIndex()));
  }
  void setPolyEndpointMarkerColor(vec4 startColor, vec4 endColor) {
    vColor = mix(startColor, endColor, float(getEndpointIndex()));
  }
  void setPolyEndpointMarkerBorderColor(vec4 startColor, vec4 endColor) {
    vBorderColor = mix(startColor, endColor, float(getEndpointIndex()));
  }
  `);
      builder.setVertexMain(`
  float modelPosition[${rank}] = getVertexPosition0();
  float modelPositionB[${rank}] = getVertexPosition1();
  for (int i = 0; i < ${rank}; ++i) {
    modelPosition[i] = mix(modelPosition[i], modelPositionB[i], float(getEndpointIndex()));
  }
  vClipCoefficient = getSubspaceClipCoefficient(modelPosition);
  vColor = vec4(0.0, 0.0, 0.0, 0.0);
  vBorderColor = vec4(0.0, 0.0, 0.0, 1.0);
  ng_PolyMarkerDiameter = 5.0;
  ng_PolyMarkerBorderWidth = 1.0;
  ${this.invokeUserMain}
  emitCircle(uModelViewProjection * vec4(projectModelVectorToSubspace(modelPosition), 1.0), ng_PolyMarkerDiameter, ng_PolyMarkerBorderWidth);
  ${this.setPartIndex(builder, "uint(getEndpointIndex()) + 1u")};
  `);
      builder.setFragmentMain(`
  vec4 color = getCircleColor(vColor, vBorderColor);
  color.a *= vClipCoefficient;
  emitAnnotation(color);
  `);
    },
  );

  enable(
    shaderGetter: AnnotationShaderGetter,
    context: AnnotationRenderContext,
    callback: (shader: ShaderProgram) => void,
  ) {
    super.enable(shaderGetter, context, (shader) => {
      const binder = shader.vertexShaderInputBinders.VertexPosition;
      const countBinder = shader.vertexShaderInputBinders.aPolyLineNumVertices;
      binder.enable(1);
      countBinder.enable(1);
      this.gl.bindBuffer(
        WebGL2RenderingContext.ARRAY_BUFFER,
        context.buffer.buffer,
      );
      binder.bind(this.geometryDataStride, context.bufferOffset);
      countBinder.bind(this.geometryDataStride, context.bufferOffset);
      const { vertexIdHelper } = this;
      vertexIdHelper.enable();
      callback(shader);
      vertexIdHelper.disable();
      binder.disable();
      countBinder.disable();
    });
  }

  drawEdges(context: AnnotationRenderContext) {
    this.enable(this.edgeShaderGetter, context, (shader) => {
      initializeLineShader(
        shader,
        context.renderContext.projectionParameters,
        /*featherWidthInPixels=*/ 1.0,
      );
      drawLines(shader.gl, 1, context.count);
    });
  }

  drawEndpoints(context: AnnotationRenderContext) {
    this.enable(this.endpointShaderGetter, context, (shader) => {
      initializeCircleShader(
        shader,
        context.renderContext.projectionParameters,
        { featherWidthInPixels: 0.5 },
      );
      drawCircles(shader.gl, 2, context.count);
    });
  }

  draw(context: AnnotationRenderContext) {
    this.drawEdges(context);
    this.drawEndpoints(context);
  }
}

// function snapPositionToLine(position: Float32Array, endpoints: Float32Array) {
//   const rank = position.length;
//   projectPointToLineSegment(
//     position,
//     endpoints.subarray(0, rank),
//     endpoints.subarray(rank),
//     position,
//   );
// }

// function snapPositionToEndpoint(
//   position: Float32Array,
//   endpoints: Float32Array,
//   endpointIndex: number,
// ) {
//   const rank = position.length;
//   const startOffset = rank * endpointIndex;
//   for (let i = 0; i < rank; ++i) {
//     position[i] = endpoints[startOffset + i];
//   }
// }

registerAnnotationTypeRenderHandler<PolyLine>(AnnotationType.POLYLINE, {
  sliceViewRenderHelper: RenderHelper,
  perspectiveViewRenderHelper: RenderHelper,
  defineShaderNoOpSetters(builder) {
    defineNoOpEndpointMarkerSetters(builder);
    defineNoOpLineSetters(builder);
  },
  pickIdsPerInstance: PICK_IDS_PER_INSTANCE,
  snapPosition(position, data, offset, partIndex) {
    // TODO (skm) See line for reference, but needs to pick the correct line
    position;
    data;
    offset;
    partIndex;
  },
  getRepresentativePoint(out, ann, partIndex) {
    // TODO (skm) See line for reference
    out;
    ann;
    partIndex;
  },
  updateViaRepresentativePoint(oldAnnotation, position, partIndex) {
    position;
    partIndex;
    return oldAnnotation;
  },
});
