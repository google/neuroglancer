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
 * @file Support for rendering line annotations.
 */

import {AnnotationType, Line} from 'neuroglancer/annotation';
import {AnnotationRenderContext, AnnotationRenderHelper, AnnotationShaderGetter, registerAnnotationTypeRenderHandler} from 'neuroglancer/annotation/type_handler';
import {tile2dArray} from 'neuroglancer/util/array';
import {projectPointToLineSegment} from 'neuroglancer/util/geom';
import {getMemoizedBuffer} from 'neuroglancer/webgl/buffer';
import {CircleShader, VERTICES_PER_CIRCLE} from 'neuroglancer/webgl/circles';
import {LineShader} from 'neuroglancer/webgl/lines';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {defineVectorArrayVertexShaderInput} from 'neuroglancer/webgl/shader_lib';

const FULL_OBJECT_PICK_OFFSET = 0;
const ENDPOINTS_PICK_OFFSET = FULL_OBJECT_PICK_OFFSET + 1;
const PICK_IDS_PER_INSTANCE = ENDPOINTS_PICK_OFFSET + 2;

function getEndpointIndexArray() {
  return tile2dArray(
      new Uint8Array([0, 1]), /*majorDimension=*/ 1, /*minorTiles=*/ 1,
      /*majorTiles=*/ VERTICES_PER_CIRCLE);
}

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
  private lineShader = this.registerDisposer(new LineShader(this.gl, 1));
  private circleShader = this.registerDisposer(new CircleShader(this.gl, 2));

  defineShader(builder: ShaderBuilder) {
    // Position of endpoints in model coordinates.
    const {rank} = this;
    defineVectorArrayVertexShaderInput(
        builder, 'float', WebGL2RenderingContext.FLOAT, /*normalized=*/ false, 'VertexPosition',
        rank, 2);
  }

  private edgeShaderGetter =
      this.getDependentShader('annotation/line/edge', (builder: ShaderBuilder) => {
        const {rank} = this;
        this.defineShader(builder);
        this.lineShader.defineShader(builder);
        builder.addVarying(`highp float[${rank}]`, 'vModelPosition');
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
      });

  private endpointIndexBuffer =
      this
          .registerDisposer(getMemoizedBuffer(
              this.gl, WebGL2RenderingContext.ARRAY_BUFFER, getEndpointIndexArray))
          .value;

  private endpointShaderGetter =
      this.getDependentShader('annotation/line/endpoint', (builder: ShaderBuilder) => {
        const {rank} = this;
        this.defineShader(builder);
        this.circleShader.defineShader(builder, this.targetIsSliceView);
        builder.addAttribute('highp uint', 'aEndpointIndex');
        builder.addVarying('highp float', 'vClipCoefficient');
        builder.addVarying('highp vec4', 'vBorderColor');
        defineNoOpLineSetters(builder);
        builder.addVertexCode(`
float ng_markerDiameter;
float ng_markerBorderWidth;
void setEndpointMarkerSize(float startSize, float endSize) {
  ng_markerDiameter = mix(startSize, endSize, float(aEndpointIndex));
}
void setEndpointMarkerBorderWidth(float startSize, float endSize) {
  ng_markerBorderWidth = mix(startSize, endSize, float(aEndpointIndex));
}
void setEndpointMarkerColor(vec4 startColor, vec4 endColor) {
  vColor = mix(startColor, endColor, float(aEndpointIndex));
}
void setEndpointMarkerBorderColor(vec4 startColor, vec4 endColor) {
  vBorderColor = mix(startColor, endColor, float(aEndpointIndex));
}
`);
        builder.setVertexMain(`
float modelPosition[${rank}] = getVertexPosition0();
float modelPositionB[${rank}] = getVertexPosition1();
for (int i = 0; i < ${rank}; ++i) {
  modelPosition[i] = mix(modelPosition[i], modelPositionB[i], float(aEndpointIndex));
}
vClipCoefficient = getSubspaceClipCoefficient(modelPosition);
vColor = vec4(0.0, 0.0, 0.0, 0.0);
vBorderColor = vec4(0.0, 0.0, 0.0, 1.0);
ng_markerDiameter = 5.0;
ng_markerBorderWidth = 1.0;
${this.invokeUserMain}
emitCircle(uModelViewProjection * vec4(projectModelVectorToSubspace(modelPosition), 1.0), ng_markerDiameter, ng_markerBorderWidth);
${this.setPartIndex(builder, 'aEndpointIndex + 1u')};
`);
        builder.setFragmentMain(`
vec4 color = getCircleColor(vColor, vBorderColor);
color.a *= vClipCoefficient;
emitAnnotation(color);
`);
      });

  enable(
      shaderGetter: AnnotationShaderGetter, context: AnnotationRenderContext,
      callback: (shader: ShaderProgram) => void) {
    super.enable(shaderGetter, context, shader => {
      const binder = shader.vertexShaderInputBinders['VertexPosition'];
      binder.enable(1);
      this.gl.bindBuffer(WebGL2RenderingContext.ARRAY_BUFFER, context.buffer.buffer);
      binder.bind(this.serializedBytesPerAnnotation, context.bufferOffset);
      callback(shader);
      binder.disable();
    });
  }

  drawEdges(context: AnnotationRenderContext) {
    this.enable(this.edgeShaderGetter, context, shader => {
      this.lineShader.enableAndDraw(
          shader, context.renderContext.projectionParameters, /*featherWidthInPixels=*/ 1.0,
          context.count);
    });
  }

  drawEndpoints(context: AnnotationRenderContext) {
    this.enable(this.endpointShaderGetter, context, shader => {
      const aEndpointIndex = shader.attribute('aEndpointIndex');
      this.endpointIndexBuffer.bindToVertexAttribI(
          aEndpointIndex, /*components=*/ 1,
          /*attributeType=*/ WebGL2RenderingContext.UNSIGNED_BYTE);
      this.circleShader.draw(
          shader, context.renderContext.projectionParameters, {featherWidthInPixels: 0.5},
          context.count);
      shader.gl.disableVertexAttribArray(aEndpointIndex);
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
      position, endpoints.subarray(0, rank), endpoints.subarray(rank), position);
}

function snapPositionToEndpoint(
    position: Float32Array, endpoints: Float32Array, endpointIndex: number) {
  const rank = position.length;
  const startOffset = rank * endpointIndex;
  for (let i = 0; i < rank; ++i) {
    position[i] = endpoints[startOffset + i];
  }
}

registerAnnotationTypeRenderHandler<Line>(AnnotationType.LINE, {
  sliceViewRenderHelper: RenderHelper,
  perspectiveViewRenderHelper: RenderHelper,
  defineShaderNoOpSetters(builder) {
    defineNoOpEndpointMarkerSetters(builder);
    defineNoOpLineSetters(builder);
  },
  pickIdsPerInstance: PICK_IDS_PER_INSTANCE,
  snapPosition(position, data, offset, partIndex) {
    const rank = position.length;
    const endpoints = new Float32Array(data, offset, rank * 2);
    if (partIndex === FULL_OBJECT_PICK_OFFSET) {
      snapPositionToLine(position, endpoints);
    } else {
      snapPositionToEndpoint(position, endpoints, partIndex - ENDPOINTS_PICK_OFFSET);
    }
  },
  getRepresentativePoint(out, ann, partIndex) {
    // if the full object is selected just pick the first point as representative
    out.set(
        (partIndex === FULL_OBJECT_PICK_OFFSET || partIndex === ENDPOINTS_PICK_OFFSET) ?
            ann.pointA :
            ann.pointB);
  },
  updateViaRepresentativePoint(oldAnnotation, position, partIndex) {
    let baseLine = {...oldAnnotation};
    const rank = position.length;
    switch (partIndex) {
      case FULL_OBJECT_PICK_OFFSET: {
        const {pointA, pointB} = oldAnnotation;
        const newPointA = new Float32Array(rank);
        const newPointB = new Float32Array(rank);
        for (let i = 0; i < rank; ++i) {
          const pos = newPointA[i] = position[i];
          newPointB[i] = pointB[i] + (pos - pointA[i]);
        }
        return {...oldAnnotation, pointA: newPointA, pointB: newPointB};
      }
      case FULL_OBJECT_PICK_OFFSET + 1:
        return {...oldAnnotation, pointA: new Float32Array(position)};
      case FULL_OBJECT_PICK_OFFSET + 2:
        return {...oldAnnotation, pointB: new Float32Array(position)};
    }
    return baseLine;
  }
});
