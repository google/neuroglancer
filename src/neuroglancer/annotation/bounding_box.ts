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
 * @file Support for rendering bounding box annotations.
 */

import {AnnotationType, AxisAlignedBoundingBox} from 'neuroglancer/annotation';
import {AnnotationRenderContext, AnnotationRenderHelper, registerAnnotationTypeRenderHandler} from 'neuroglancer/annotation/type_handler';
import {BoundingBoxCrossSectionRenderHelper, vertexBasePositions} from 'neuroglancer/sliceview/bounding_box_shader_helper';
import {SliceViewPanelRenderContext} from 'neuroglancer/sliceview/panel';
import {tile2dArray} from 'neuroglancer/util/array';
import {mat4, projectPointToLineSegment, vec3} from 'neuroglancer/util/geom';
import {Buffer, getMemoizedBuffer} from 'neuroglancer/webgl/buffer';
import {CircleShader, VERTICES_PER_CIRCLE} from 'neuroglancer/webgl/circles';
import {GL} from 'neuroglancer/webgl/context';
import {LineShader, VERTICES_PER_LINE} from 'neuroglancer/webgl/lines';
import {emitterDependentShaderGetter, ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';

const EDGES_PER_BOX = 12;
const CORNERS_PER_BOX = 8;

const FULL_OBJECT_PICK_OFFSET = 0;
const CORNERS_PICK_OFFSET = FULL_OBJECT_PICK_OFFSET + 1;
const EDGES_PICK_OFFSET = CORNERS_PICK_OFFSET + CORNERS_PER_BOX;
const FACES_PICK_OFFSET = EDGES_PICK_OFFSET + EDGES_PER_BOX;
const PICK_IDS_PER_INSTANCE = FACES_PICK_OFFSET + 6;

const edgeBoxCornerOffsetData = Float32Array.from([
  // a1
  0, 0, 0,
  // b1
  0, 0, 1,
  // c1
  EDGES_PICK_OFFSET + 0,

  // a2
  1, 0, 0,
  // b2
  1, 0, 1,
  // c2
  EDGES_PICK_OFFSET + 1,

  // a3
  0, 1, 0,
  // b3
  0, 1, 1,
  // c3
  EDGES_PICK_OFFSET + 2,

  // a4
  1, 1, 0,
  // b4
  1, 1, 1,
  // c4
  EDGES_PICK_OFFSET + 3,

  // a5
  0, 0, 0,
  // b5
  0, 1, 0,
  // c5
  EDGES_PICK_OFFSET + 4,

  // a6
  0, 0, 1,
  // b6
  0, 1, 1,
  // c6
  EDGES_PICK_OFFSET + 5,

  // a7
  1, 0, 0,
  // b7
  1, 1, 0,
  // c7
  EDGES_PICK_OFFSET + 6,

  // a8
  1, 0, 1,
  // b8
  1, 1, 1,
  // c8
  EDGES_PICK_OFFSET + 7,

  // a9
  0, 0, 0,
  // b9
  1, 0, 0,
  // c9
  EDGES_PICK_OFFSET + 8,

  // a10
  0, 0, 1,
  // b10
  1, 0, 1,
  // c10
  EDGES_PICK_OFFSET + 9,

  // a11
  0, 1, 0,
  // b11
  1, 1, 0,
  // c11
  EDGES_PICK_OFFSET + 10,

  // a12
  0, 1, 1,
  // b12
  1, 1, 1,
  // c12
  EDGES_PICK_OFFSET + 11
]);

abstract class RenderHelper extends AnnotationRenderHelper {
  defineShader(builder: ShaderBuilder) {
    super.defineShader(builder);
    // Position of point in camera coordinates.
    builder.addAttribute('highp vec3', 'aLower');
    builder.addAttribute('highp vec3', 'aUpper');
  }

  enable(shader: ShaderProgram, context: AnnotationRenderContext, callback: () => void) {
    super.enable(shader, context, () => {
      const {gl} = shader;
      const aLower = shader.attribute('aLower');
      const aUpper = shader.attribute('aUpper');
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
}

class PerspectiveViewRenderHelper extends RenderHelper {
  private lineShader = this.registerDisposer(new LineShader(this.gl, EDGES_PER_BOX));

  private edgeBoxCornerOffsetsBuffer = this.registerDisposer(Buffer.fromData(
      this.gl,
      tile2dArray(
          edgeBoxCornerOffsetData, /*majorDimension=*/ 7, /*minorTiles=*/ 1,
          /*majorTiles=*/ VERTICES_PER_LINE)));

  private edgeShaderGetter =
      emitterDependentShaderGetter(this, this.gl, (builder: ShaderBuilder) => {
        this.defineShader(builder);
        this.lineShader.defineShader(builder);

        // XYZ corners of box ranging from [0, 0, 0] to [1, 1, 1].
        builder.addAttribute('highp vec3', 'aBoxCornerOffset1');

        // Last component of aBoxCornerOffset2 is the edge index.
        builder.addAttribute('highp vec4', 'aBoxCornerOffset2');
        builder.setVertexMain(`
vec3 vertexPosition1 = mix(aLower, aUpper, aBoxCornerOffset1);
vec3 vertexPosition2 = mix(aLower, aUpper, aBoxCornerOffset2.xyz);
emitLine(uProjection, vertexPosition1, vertexPosition2);
${this.setPartIndex(builder, 'uint(aBoxCornerOffset2.w)')};
`);
        builder.setFragmentMain(`
emitAnnotation(vec4(vColor.rgb, getLineAlpha()));
`);
      });

  private circleShader = this.registerDisposer(new CircleShader(this.gl, CORNERS_PER_BOX));

  private boxCornerOffsetsBuffer = this.registerDisposer(Buffer.fromData(
      this.gl,
      tile2dArray(
          vertexBasePositions, /*majorDimension=*/ 3, /*minorTiles=*/ 1,
          /*majorTiles=*/ VERTICES_PER_CIRCLE)));

  private cornerShaderGetter =
      emitterDependentShaderGetter(this, this.gl, (builder: ShaderBuilder) => {
        this.defineShader(builder);
        this.circleShader.defineShader(builder, this.targetIsSliceView);

        // XYZ corners of box ranging from [0, 0, 0] to [1, 1, 1].
        builder.addAttribute('highp vec3', 'aBoxCornerOffset');

        builder.setVertexMain(`
vec3 vertexPosition = mix(aLower, aUpper, aBoxCornerOffset);
emitCircle(uProjection * vec4(vertexPosition, 1.0));
uint cornerIndex = uint(aBoxCornerOffset.x + aBoxCornerOffset.y * 2.0 + aBoxCornerOffset.z * 4.0);
uint cornerPickOffset = ${CORNERS_PICK_OFFSET}u + cornerIndex;
${this.setPartIndex(builder, 'cornerPickOffset')};
`);
        builder.setFragmentMain(`
vec4 borderColor = vec4(0.0, 0.0, 0.0, 1.0);
emitAnnotation(getCircleColor(vColor, borderColor));
`);
      });

  drawEdges(context: AnnotationRenderContext) {
    const shader = this.edgeShaderGetter(context.renderContext.emitter);
    const {gl} = this;
    this.enable(shader, context, () => {
      const aBoxCornerOffset1 = shader.attribute('aBoxCornerOffset1');
      const aBoxCornerOffset2 = shader.attribute('aBoxCornerOffset2');

      this.edgeBoxCornerOffsetsBuffer.bindToVertexAttrib(
          aBoxCornerOffset1, /*components=*/ 3, /*attributeType=*/ WebGL2RenderingContext.FLOAT,
          /*normalized=*/ false,
          /*stride=*/ 4 * 7, /*offset=*/ 0);

      this.edgeBoxCornerOffsetsBuffer.bindToVertexAttrib(
          aBoxCornerOffset2, /*components=*/ 4, /*attributeType=*/ WebGL2RenderingContext.FLOAT,
          /*normalized=*/ false,
          /*stride=*/ 4 * 7, /*offset=*/ 4 * 3);

      this.lineShader.draw(shader, context.renderContext, /*lineWidth=*/ 1, 1, context.count);
      gl.disableVertexAttribArray(aBoxCornerOffset1);
      gl.disableVertexAttribArray(aBoxCornerOffset2);
    });
  }

  drawCorners(context: AnnotationRenderContext) {
    const shader = this.cornerShaderGetter(context.renderContext.emitter);
    const {gl} = this;
    this.enable(shader, context, () => {
      const aBoxCornerOffset = shader.attribute('aBoxCornerOffset');
      this.boxCornerOffsetsBuffer.bindToVertexAttrib(
          aBoxCornerOffset, /*components=*/ 3, /*attributeType=*/ WebGL2RenderingContext.FLOAT,
          /*normalized=*/ false);
      this.circleShader.draw(
          shader, context.renderContext,
          {interiorRadiusInPixels: 1, borderWidthInPixels: 0, featherWidthInPixels: 1},
          context.count);
      gl.disableVertexAttribArray(aBoxCornerOffset);
    });
  }

  draw(context: AnnotationRenderContext) {
    this.drawEdges(context);
    this.drawCorners(context);
  }
}

function getBaseIntersectionVertexIndexArray() {
  return new Float32Array([0, 1, 2, 3, 4, 5]);
}

function getIntersectionVertexIndexArray() {
  return tile2dArray(
      getBaseIntersectionVertexIndexArray(),
      /*majorDimension=*/ 1,
      /*minorTiles=*/ 1,
      /*majorTiles=*/ VERTICES_PER_LINE);
}


class SliceViewRenderHelper extends RenderHelper {
  private lineShader = new LineShader(this.gl, 6);
  private intersectionVertexIndexBuffer =
      getMemoizedBuffer(
          this.gl, WebGL2RenderingContext.ARRAY_BUFFER, getIntersectionVertexIndexArray)
          .value;
  private filledIntersectionVertexIndexBuffer =
      getMemoizedBuffer(
          this.gl, WebGL2RenderingContext.ARRAY_BUFFER, getBaseIntersectionVertexIndexArray)
          .value;
  private boundingBoxCrossSectionHelper =
      this.registerDisposer(new BoundingBoxCrossSectionRenderHelper(this.gl));

  constructor(public gl: GL) {
    super(gl);
  }

  private faceShaderGetter =
      emitterDependentShaderGetter(this, this.gl, (builder: ShaderBuilder) => {
        super.defineShader(builder);
        this.boundingBoxCrossSectionHelper.defineShader(builder);
        this.lineShader.defineShader(builder);

        builder.addAttribute('highp float', 'aVertexIndexFloat');
        builder.setVertexMain(`
int vertexIndex1 = int(aVertexIndexFloat);
int vertexIndex2 = vertexIndex1 == 5 ? 0 : vertexIndex1 + 1;
vec3 vertexPosition1 = getBoundingBoxPlaneIntersectionVertexPosition(aUpper - aLower, aLower, aLower, aUpper, vertexIndex1);
vec3 vertexPosition2 = getBoundingBoxPlaneIntersectionVertexPosition(aUpper - aLower, aLower, aLower, aUpper, vertexIndex2);
emitLine(uProjection, vertexPosition1, vertexPosition2);
${this.setPartIndex(builder)};
`);
        builder.setFragmentMain(`
emitAnnotation(vec4(vColor.rgb, vColor.a * getLineAlpha()));
`);
      });

  private fillShaderGetter =
      emitterDependentShaderGetter(this, this.gl, (builder: ShaderBuilder) => {
        super.defineShader(builder);
        this.boundingBoxCrossSectionHelper.defineShader(builder);
        builder.addAttribute('highp float', 'aVertexIndexFloat');
        builder.addUniform('highp float', 'uFillOpacity');
        builder.setVertexMain(`
int vertexIndex = int(aVertexIndexFloat);
vec3 vertexPosition = getBoundingBoxPlaneIntersectionVertexPosition(aUpper - aLower, aLower, aLower, aUpper, vertexIndex);
gl_Position = uProjection * vec4(vertexPosition, 1);
${this.setPartIndex(builder)};
`);
        builder.setFragmentMain(`
emitAnnotation(vec4(vColor.rgb, uFillOpacity));
`);
      });

  draw(context: AnnotationRenderContext&{renderContext: SliceViewPanelRenderContext}) {
    const fillOpacity = context.annotationLayer.state.fillOpacity.value;
    const shader = (fillOpacity ? this.fillShaderGetter : this.faceShaderGetter)(
        context.renderContext.emitter);
    let {gl} = this;
    this.enable(shader, context, () => {
      this.boundingBoxCrossSectionHelper.setViewportPlane(
          shader, context.renderContext.sliceView.viewportAxes[2],
          context.renderContext.sliceView.centerDataPosition,
          context.annotationLayer.state.globalToObject);
      const aVertexIndexFloat = shader.attribute('aVertexIndexFloat');

      (fillOpacity ? this.filledIntersectionVertexIndexBuffer : this.intersectionVertexIndexBuffer)
          .bindToVertexAttrib(
              aVertexIndexFloat, /*components=*/ 1, /*attributeType=*/ WebGL2RenderingContext.FLOAT,
              /*normalized=*/ false);

      if (fillOpacity) {
        gl.uniform1f(shader.uniform('uFillOpacity'), fillOpacity);
        gl.drawArraysInstanced(WebGL2RenderingContext.TRIANGLE_FAN, 0, 6, context.count);
      } else {
        const lineWidth = context.renderContext.emitColor ? 1 : 5;
        this.lineShader.draw(shader, context.renderContext, lineWidth, 1.0, context.count);
      }
      gl.disableVertexAttribArray(aVertexIndexFloat);
    });
  }
}
function getEdgeCorners(corners: Float32Array, edgeIndex: number) {
  const i = edgeIndex * 7;
  const cA = vec3.create(), cB = vec3.create();
  for (let j = 0; j < 3; ++j) {
    const ma = edgeBoxCornerOffsetData[i + j];
    const mb = edgeBoxCornerOffsetData[i + j + 3];
    const a = Math.min(corners[j], corners[j + 3]), b = Math.max(corners[j], corners[j + 3]);
    cA[j] = (1 - ma) * a + ma * b;
    cB[j] = (1 - mb) * a + mb * b;
  }

  return {cornerA: cA, cornerB: cB};
}
function snapPositionToEdge(
    position: vec3, objectToData: mat4, corners: Float32Array, edgeIndex: number) {
  let edgeCorners = getEdgeCorners(corners, edgeIndex);
  vec3.transformMat4(edgeCorners.cornerA, edgeCorners.cornerA, objectToData);
  vec3.transformMat4(edgeCorners.cornerB, edgeCorners.cornerB, objectToData);

  projectPointToLineSegment(position, edgeCorners.cornerA, edgeCorners.cornerB, position);
}

function snapPositionToCorner(
    position: vec3, objectToData: mat4, corners: Float32Array, cornerIndex: number) {
  const i = cornerIndex * 3;
  for (let j = 0; j < 3; ++j) {
    const m = vertexBasePositions[i + j];
    const a = Math.min(corners[j], corners[j + 3]), b = Math.max(corners[j], corners[j + 3]);
    position[j] = (1 - m) * a + m * b;
  }
  vec3.transformMat4(position, position, objectToData);
}

registerAnnotationTypeRenderHandler(AnnotationType.AXIS_ALIGNED_BOUNDING_BOX, {
  bytes: 6 * 4,
  serializer: (buffer: ArrayBuffer, offset: number, numAnnotations: number) => {
    const coordinates = new Float32Array(buffer, offset, numAnnotations * 6);
    return (annotation: AxisAlignedBoundingBox, index: number) => {
      const {pointA, pointB} = annotation;
      const coordinateOffset = index * 6;
      coordinates[coordinateOffset] = Math.min(pointA[0], pointB[0]);
      coordinates[coordinateOffset + 1] = Math.min(pointA[1], pointB[1]);
      coordinates[coordinateOffset + 2] = Math.min(pointA[2], pointB[2]);
      coordinates[coordinateOffset + 3] = Math.max(pointA[0], pointB[0]);
      coordinates[coordinateOffset + 4] = Math.max(pointA[1], pointB[1]);
      coordinates[coordinateOffset + 5] = Math.max(pointA[2], pointB[2]);
    };
  },
  sliceViewRenderHelper: SliceViewRenderHelper,
  perspectiveViewRenderHelper: PerspectiveViewRenderHelper,
  pickIdsPerInstance: PICK_IDS_PER_INSTANCE,
  snapPosition: (position, objectToData, data, offset, partIndex) => {
    const corners = new Float32Array(data, offset, 6);
    if (partIndex >= CORNERS_PICK_OFFSET && partIndex < EDGES_PICK_OFFSET) {
      snapPositionToCorner(position, objectToData, corners, partIndex - CORNERS_PICK_OFFSET);
    } else if (partIndex >= EDGES_PICK_OFFSET && partIndex < FACES_PICK_OFFSET) {
      snapPositionToEdge(position, objectToData, corners, partIndex - EDGES_PICK_OFFSET);
    } else {
      // vec3.transformMat4(position, annotation.point, objectToData);
    }
  },
  getRepresentativePoint: (objectToData, ann, partIndex) => {
    let repPoint = vec3.create();
    // if the full object is selected pick the first corner as representative
    if (partIndex === FULL_OBJECT_PICK_OFFSET) {
      vec3.transformMat4(repPoint, ann.pointA, objectToData);
    } else if (partIndex >= CORNERS_PICK_OFFSET && partIndex < EDGES_PICK_OFFSET) {
      // picked a corner
      // FIXME: figure out how to return corner point
      vec3.transformMat4(repPoint, ann.pointA, objectToData);
    } else if (partIndex >= EDGES_PICK_OFFSET && partIndex < FACES_PICK_OFFSET) {
      // FIXME: can't figure out how to resize based upon edge grabbed
      vec3.transformMat4(repPoint, ann.pointA, objectToData);
      // snapPositionToCorner(repPoint, objectToData, corners, 5);
    } else {  // for now faces will move the whole object so pick the first corner
      vec3.transformMat4(repPoint, ann.pointA, objectToData);
    }
    return repPoint;
  },

  updateViaRepresentativePoint:
      (oldAnnotation: AxisAlignedBoundingBox, position: vec3, dataToObject: mat4,
       partIndex: number) => {
        let newPt = vec3.transformMat4(vec3.create(), position, dataToObject);
        let baseBox = {...oldAnnotation};
        // if the full object is selected pick the first corner as representative
        let delta = vec3.sub(vec3.create(), oldAnnotation.pointB, oldAnnotation.pointA);
        if (partIndex === FULL_OBJECT_PICK_OFFSET) {
          baseBox.pointA = newPt;
          baseBox.pointB = vec3.add(vec3.create(), newPt, delta);
        } else if (partIndex >= CORNERS_PICK_OFFSET && partIndex < EDGES_PICK_OFFSET) {
          // picked a corner
          baseBox.pointA = newPt;
          baseBox.pointB = vec3.add(vec3.create(), newPt, delta);
        } else if (partIndex >= EDGES_PICK_OFFSET && partIndex < FACES_PICK_OFFSET) {
          baseBox.pointA = newPt;
          baseBox.pointB = vec3.add(vec3.create(), newPt, delta);
        } else {  // for now faces will move the whole object so pick the first corner
          baseBox.pointA = newPt;
          baseBox.pointB = vec3.add(vec3.create(), newPt, delta);
        }
        return baseBox;
      }
});
