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
import {AnnotationRenderContext, AnnotationRenderHelper, registerAnnotationTypeRenderHandler} from 'neuroglancer/annotation/type_handler';
import {tile2dArray} from 'neuroglancer/util/array';
import {mat4, projectPointToLineSegment, vec3} from 'neuroglancer/util/geom';
import {getMemoizedBuffer} from 'neuroglancer/webgl/buffer';
import {CircleShader, VERTICES_PER_CIRCLE} from 'neuroglancer/webgl/circles';
import {LineShader} from 'neuroglancer/webgl/lines';
import {emitterDependentShaderGetter, ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';

const FULL_OBJECT_PICK_OFFSET = 0;
const ENDPOINTS_PICK_OFFSET = FULL_OBJECT_PICK_OFFSET + 1;
const PICK_IDS_PER_INSTANCE = ENDPOINTS_PICK_OFFSET + 2;

function getEndpointIndexArray() {
  return tile2dArray(
      new Uint8Array([0, 1]), /*majorDimension=*/ 1, /*minorTiles=*/ 1,
      /*majorTiles=*/ VERTICES_PER_CIRCLE);
}

class RenderHelper extends AnnotationRenderHelper {
  private lineShader = this.registerDisposer(new LineShader(this.gl, 1));
  private circleShader = this.registerDisposer(new CircleShader(this.gl, 2));

  defineShader(builder: ShaderBuilder) {
    super.defineShader(builder);
    // Position of endpoints in camera coordinates.
    builder.addAttribute('highp vec3', 'aEndpointA');
    builder.addAttribute('highp vec3', 'aEndpointB');
  }

  private edgeShaderGetter =
      emitterDependentShaderGetter(this, this.gl, (builder: ShaderBuilder) => {
        this.defineShader(builder);
        this.lineShader.defineShader(builder);
        builder.setVertexMain(`
emitLine(uProjection, aEndpointA, aEndpointB);
${this.setPartIndex(builder)};
`);
        builder.setFragmentMain(`
emitAnnotation(vec4(vColor.rgb, vColor.a * getLineAlpha() * ${this.getCrossSectionFadeFactor()}));
`);
      });

  private endpointIndexBuffer =
      this
          .registerDisposer(getMemoizedBuffer(
              this.gl, WebGL2RenderingContext.ARRAY_BUFFER, getEndpointIndexArray))
          .value;

  private endpointShaderGetter =
      emitterDependentShaderGetter(this, this.gl, (builder: ShaderBuilder) => {
        this.defineShader(builder);
        this.circleShader.defineShader(builder, this.targetIsSliceView);
        builder.addAttribute('highp uint', 'aEndpointIndex');
        builder.setVertexMain(`
vec3 vertexPosition = mix(aEndpointA, aEndpointB, float(aEndpointIndex));
emitCircle(uProjection * vec4(vertexPosition, 1.0));
${this.setPartIndex(builder, 'aEndpointIndex + 1u')};
`);
        builder.setFragmentMain(`
vec4 borderColor = vec4(0.0, 0.0, 0.0, 1.0);
emitAnnotation(getCircleColor(vColor, borderColor));
`);
      });

  enable(shader: ShaderProgram, context: AnnotationRenderContext, callback: () => void) {
    super.enable(shader, context, () => {
      const {gl} = shader;
      const aLower = shader.attribute('aEndpointA');
      const aUpper = shader.attribute('aEndpointB');

      context.buffer.bindToVertexAttrib(
          aLower, /*components=*/ 3, /*attributeType=*/ WebGL2RenderingContext.FLOAT,
          /*normalized=*/ false,
          /*stride=*/ 4 * 6, /*offset=*/ context.bufferOffset);
      context.buffer.bindToVertexAttrib(
          aUpper, /*components=*/ 3, /*attributeType=*/ WebGL2RenderingContext.FLOAT,
          /*normalized=*/ false,
          /*stride=*/ 4 * 6, /*offset=*/ context.bufferOffset + 4 * 3);

      gl.vertexAttribDivisor(aLower, 1);
      gl.vertexAttribDivisor(aUpper, 1);
      callback();
      gl.vertexAttribDivisor(aLower, 0);
      gl.vertexAttribDivisor(aUpper, 0);
      gl.disableVertexAttribArray(aLower);
      gl.disableVertexAttribArray(aUpper);
    });
  }

  drawEdges(context: AnnotationRenderContext) {
    const shader = this.edgeShaderGetter(context.renderContext.emitter);
    this.enable(shader, context, () => {
      this.lineShader.draw(shader, context.renderContext, /*lineWidth=*/ 1, 1.0, context.count);
    });
  }

  drawEndpoints(context: AnnotationRenderContext) {
    const shader = this.endpointShaderGetter(context.renderContext.emitter);
    this.enable(shader, context, () => {
      const aEndpointIndex = shader.attribute('aEndpointIndex');
      this.endpointIndexBuffer.bindToVertexAttribI(
          aEndpointIndex, /*components=*/ 1,
          /*attributeType=*/ WebGL2RenderingContext.UNSIGNED_BYTE);
      this.circleShader.draw(
          shader, context.renderContext,
          {interiorRadiusInPixels: 6, borderWidthInPixels: 2, featherWidthInPixels: 1},
          context.count);
      shader.gl.disableVertexAttribArray(aEndpointIndex);
    });
  }

  draw(context: AnnotationRenderContext) {
    this.drawEdges(context);
    this.drawEndpoints(context);
  }
}

function snapPositionToLine(position: vec3, objectToData: mat4, endpoints: Float32Array) {
  const cornerA = vec3.transformMat4(vec3.create(), <vec3>endpoints.subarray(0, 3), objectToData);
  const cornerB = vec3.transformMat4(vec3.create(), <vec3>endpoints.subarray(3, 6), objectToData);
  projectPointToLineSegment(position, cornerA, cornerB, position);
}

function snapPositionToEndpoint(
    position: vec3, objectToData: mat4, endpoints: Float32Array, endpointIndex: number) {
  const startOffset = 3 * endpointIndex;
  const point = <vec3>endpoints.subarray(startOffset, startOffset + 3);
  vec3.transformMat4(position, point, objectToData);
}

registerAnnotationTypeRenderHandler(AnnotationType.LINE, {
  bytes: 6 * 4,
  serializer: (buffer: ArrayBuffer, offset: number, numAnnotations: number) => {
    const coordinates = new Float32Array(buffer, offset, numAnnotations * 6);
    return (annotation: Line, index: number) => {
      const {pointA, pointB} = annotation;
      const coordinateOffset = index * 6;
      coordinates[coordinateOffset] = pointA[0];
      coordinates[coordinateOffset + 1] = pointA[1];
      coordinates[coordinateOffset + 2] = pointA[2];
      coordinates[coordinateOffset + 3] = pointB[0];
      coordinates[coordinateOffset + 4] = pointB[1];
      coordinates[coordinateOffset + 5] = pointB[2];
    };
  },
  sliceViewRenderHelper: RenderHelper,
  perspectiveViewRenderHelper: RenderHelper,
  pickIdsPerInstance: PICK_IDS_PER_INSTANCE,
  snapPosition: (position, objectToData, data, offset, partIndex) => {
    const endpoints = new Float32Array(data, offset, 6);
    if (partIndex === FULL_OBJECT_PICK_OFFSET) {
      snapPositionToLine(position, objectToData, endpoints);
    } else {
      snapPositionToEndpoint(position, objectToData, endpoints, partIndex - ENDPOINTS_PICK_OFFSET);
    }
  },
  getRepresentativePoint: (objectToData, ann, partIndex) => {
    let repPoint = vec3.create();
    // if the full object is selected just pick the first point as representative
    if (partIndex === FULL_OBJECT_PICK_OFFSET) {
      vec3.transformMat4(repPoint, ann.pointA, objectToData);
    } else {
      if ((partIndex - ENDPOINTS_PICK_OFFSET) === 0) {
        vec3.transformMat4(repPoint, ann.pointA, objectToData);
      } else {
        vec3.transformMat4(repPoint, ann.pointB, objectToData);
      }
    }
    return repPoint;
  },
  updateViaRepresentativePoint: (oldAnnotation, position, dataToObject, partIndex) => {
    let newPt = vec3.transformMat4(vec3.create(), position, dataToObject);
    let baseLine = {...oldAnnotation};
    switch (partIndex) {
      case FULL_OBJECT_PICK_OFFSET:
        let delta = vec3.sub(vec3.create(), oldAnnotation.pointB, oldAnnotation.pointA);
        baseLine.pointA = newPt;
        baseLine.pointB = vec3.add(vec3.create(), newPt, delta);
        break;
      case FULL_OBJECT_PICK_OFFSET + 1:
        baseLine.pointA = newPt;
        baseLine.pointB = oldAnnotation.pointB;
        break;
      case FULL_OBJECT_PICK_OFFSET + 2:
        baseLine.pointA = oldAnnotation.pointA;
        baseLine.pointB = newPt;
    }
    return baseLine;
  }
});
