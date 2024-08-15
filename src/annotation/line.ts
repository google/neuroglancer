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
 * 
 * @modifcations
 * MIT modified this file. For more information see the NOTICES.txt file
 */

/**
 * @file Support for rendering line annotations.
 */

import type { Line } from "#src/annotation/index.js";
import { AnnotationType } from "#src/annotation/index.js";
import type {
  AnnotationRenderContext,
  AnnotationShaderGetter,
} from "#src/annotation/type_handler.js";
import {
  AnnotationRenderHelper,
  registerAnnotationTypeRenderHandler,
} from "#src/annotation/type_handler.js";
import type { MouseSelectionState } from "#src/layer/index.js";
import { projectPointToLineSegment } from "#src/util/geom.js";
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
void setEndpointMarkerSize(float startSize, float endSize) {}
void setEndpointMarkerBorderWidth(float startSize, float endSize) {}
void setEndpointMarkerColor(vec4 startColor, vec4 endColor) {}
void setEndpointMarkerBorderColor(vec4 startColor, vec4 endColor) {}
`);
}

function defineNoOpLineSetters(builder: ShaderBuilder) {
  builder.addVertexCode(`
void setLineWidth(float width) {}
void setLineColor(vec4 startColor, vec4 endColor) {}
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
  }

  private vertexIdHelper = this.registerDisposer(VertexIdHelper.get(this.gl));

  private edgeShaderGetter = this.getDependentShader(
    "annotation/line/edge",
    (builder: ShaderBuilder) => {
      const { rank } = this;
      this.defineShader(builder);
      defineLineShader(builder);
      builder.addVarying(`highp float[${rank}]`, "vModelPosition");
      builder.addVertexCode(`
float ng_LineWidth;
`);
      defineNoOpEndpointMarkerSetters(builder);
      builder.addVertexCode(`
void setLineWidth(float width) {
  ng_LineWidth = width;
}
void setLineColor(vec4 startColor, vec4 endColor) {
  vColor = mix(startColor, endColor, getLineEndpointCoefficient());
}
`);
      builder.setVertexMain(`
float modelPositionA[${rank}] = getVertexPosition0();
float modelPositionB[${rank}] = getVertexPosition1();
for (int i = 0; i < ${rank}; ++i) {
  vModelPosition[i] = mix(modelPositionA[i], modelPositionB[i], getLineEndpointCoefficient());
}
ng_LineWidth = 1.0;
vColor = vec4(0.0, 0.0, 0.0, 0.0);
${this.invokeUserMain}
emitLine(uModelViewProjection * vec4(projectModelVectorToSubspace(modelPositionA), 1.0),
         uModelViewProjection * vec4(projectModelVectorToSubspace(modelPositionB), 1.0),
         ng_LineWidth);
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
    "annotation/line/endpoint",
    (builder: ShaderBuilder) => {
      const { rank } = this;
      this.defineShader(builder);
      defineCircleShader(builder, this.targetIsSliceView);
      builder.addVarying("highp float", "vClipCoefficient");
      builder.addVarying("highp vec4", "vBorderColor");
      defineNoOpLineSetters(builder);
      builder.addVertexCode(`
float ng_markerDiameter;
float ng_markerBorderWidth;
int getEndpointIndex() {
  return gl_VertexID / ${VERTICES_PER_CIRCLE};
}
void setEndpointMarkerSize(float startSize, float endSize) {
  ng_markerDiameter = mix(startSize, endSize, float(getEndpointIndex()));
}
void setEndpointMarkerBorderWidth(float startSize, float endSize) {
  ng_markerBorderWidth = mix(startSize, endSize, float(getEndpointIndex()));
}
void setEndpointMarkerColor(vec4 startColor, vec4 endColor) {
  vColor = mix(startColor, endColor, float(getEndpointIndex()));
}
void setEndpointMarkerBorderColor(vec4 startColor, vec4 endColor) {
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
ng_markerDiameter = 5.0;
ng_markerBorderWidth = 1.0;
${this.invokeUserMain}
emitCircle(uModelViewProjection * vec4(projectModelVectorToSubspace(modelPosition), 1.0), ng_markerDiameter, ng_markerBorderWidth);
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
      binder.enable(1);
      this.gl.bindBuffer(
        WebGL2RenderingContext.ARRAY_BUFFER,
        context.buffer.buffer,
      );
      binder.bind(this.geometryDataStride, context.bufferOffset);
      const { vertexIdHelper } = this;
      vertexIdHelper.enable();
      callback(shader);
      vertexIdHelper.disable();
      binder.disable();
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

function snapPositionToLine(position: Float32Array, endpoints: Float32Array) {
  const rank = position.length;
  projectPointToLineSegment(
    position,
    endpoints.subarray(0, rank),
    endpoints.subarray(rank),
    position,
  );
}

function snapPositionToEndpoint(
  position: Float32Array,
  endpoints: Float32Array,
  endpointIndex: number,
) {
  const rank = position.length;
  const startOffset = rank * endpointIndex;
  for (let i = 0; i < rank; ++i) {
    position[i] = endpoints[startOffset + i];
  }
}

registerAnnotationTypeRenderHandler<Line>(AnnotationType.LINE, {
  bytes: () => 6 * 4,
  sliceViewRenderHelper: RenderHelper,
  perspectiveViewRenderHelper: RenderHelper,
  defineShaderNoOpSetters(builder) {
    defineNoOpEndpointMarkerSetters(builder);
    defineNoOpLineSetters(builder);
  },
  staticPickIdsPerInstance: PICK_IDS_PER_INSTANCE,
  pickIdsPerInstance: (annotations) => Array(annotations.length).fill(PICK_IDS_PER_INSTANCE),
  assignPickingInformation(mouseState:MouseSelectionState, pickIds: number[], pickedOffset:number) {
    mouseState.pickedAnnotationIndex = Math.floor(pickedOffset / pickIds[0]);
    mouseState.pickedOffset = pickedOffset % pickIds[0];
  },
  snapPosition(position, data, offset, partIndex) {
    const rank = position.length;
    const endpoints = new Float32Array(data, offset, rank * 2);
    if (partIndex === FULL_OBJECT_PICK_OFFSET) {
      snapPositionToLine(position, endpoints);
    } else {
      snapPositionToEndpoint(
        position,
        endpoints,
        partIndex - ENDPOINTS_PICK_OFFSET,
      );
    }
  },
  getRepresentativePoint(out, ann, partIndex) {
    // if the full object is selected just pick the first point as representative
    out.set(
      partIndex === FULL_OBJECT_PICK_OFFSET ||
        partIndex === ENDPOINTS_PICK_OFFSET
        ? ann.pointA
        : ann.pointB,
    );
  },
  updateViaRepresentativePoint(oldAnnotation, position, partIndex) {
    const baseLine = { ...oldAnnotation };
    const rank = position.length;
    switch (partIndex) {
      case FULL_OBJECT_PICK_OFFSET: {
        const { pointA, pointB } = oldAnnotation;
        const newPointA = new Float32Array(rank);
        const newPointB = new Float32Array(rank);
        for (let i = 0; i < rank; ++i) {
          const pos = (newPointA[i] = position[i]);
          newPointB[i] = pointB[i] + (pos - pointA[i]);
        }
        return { ...oldAnnotation, pointA: newPointA, pointB: newPointB };
      }
      case FULL_OBJECT_PICK_OFFSET + 1:
        return { ...oldAnnotation, pointA: new Float32Array(position) };
      case FULL_OBJECT_PICK_OFFSET + 2:
        return { ...oldAnnotation, pointB: new Float32Array(position) };
    }
    return baseLine;
  },
});
