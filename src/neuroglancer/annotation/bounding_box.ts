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
import {SliceViewPanelRenderContext} from 'neuroglancer/sliceview/renderlayer';
import {tile2dArray} from 'neuroglancer/util/array';
import {Buffer, getMemoizedBuffer} from 'neuroglancer/webgl/buffer';
import {CircleShader, VERTICES_PER_CIRCLE} from 'neuroglancer/webgl/circles';
import {LineShader, VERTICES_PER_LINE} from 'neuroglancer/webgl/lines';
import {emitterDependentShaderGetter, ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {defineVectorArrayVertexShaderInput} from 'neuroglancer/webgl/shader_lib';

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
    // Position of lower/upper in model coordinates.
    const {rank} = this;
    defineVectorArrayVertexShaderInput(builder, 'float', 'Bounds', rank, 2);
  }

  enable(shader: ShaderProgram, context: AnnotationRenderContext, callback: () => void) {
    super.enable(shader, context, () => {
      const binder = shader.vertexShaderInputBinders['Bounds'];
      binder.enable(1);
      binder.bind(
          context.buffer.buffer!, WebGL2RenderingContext.FLOAT, /*normalized=*/ false,
          /*stride=*/ 0, context.bufferOffset);
      callback();
      binder.disable();
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
        const {rank} = this;
        this.defineShader(builder);
        this.lineShader.defineShader(builder);

        // XYZ corners of box ranging from [0, 0, 0] to [1, 1, 1].
        builder.addAttribute('highp vec3', 'aBoxCornerOffset1');

        // Last component of aBoxCornerOffset2 is the edge index.
        builder.addAttribute('highp vec4', 'aBoxCornerOffset2');

        builder.addVarying('highp float', 'vClipCoefficient');

        builder.setVertexMain(`
float modelPositionA[${rank}] = getBounds0();
float modelPositionB[${rank}] = getBounds1();
vec3 subspacePositionA = projectModelVectorToSubspace(modelPositionA);
vec3 subspacePositionB = projectModelVectorToSubspace(modelPositionB);
vec3 endpointA = mix(subspacePositionA, subspacePositionB, aBoxCornerOffset1);
vec3 endpointB = mix(subspacePositionA, subspacePositionB, aBoxCornerOffset2.xyz);
vClipCoefficient = getMaxSubspaceClipCoefficient(modelPositionA, modelPositionB);
if (vClipCoefficient == 0.0) {
  gl_Position = vec4(2.0, 0.0, 0.0, 1.0);
  return;
}
emitLine(uModelViewProjection * vec4(endpointA, 1.0),
         uModelViewProjection * vec4(endpointB, 1.0));
${this.setPartIndex(builder, 'uint(aBoxCornerOffset2.w)')};
`);
        builder.setFragmentMain(`
emitAnnotation(vec4(vColor.rgb, getLineAlpha() * vClipCoefficient));
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
        const {rank} = this;
        this.defineShader(builder);
        this.circleShader.defineShader(builder, this.targetIsSliceView);

        // XYZ corners of box ranging from [0, 0, 0] to [1, 1, 1].
        builder.addAttribute('highp vec3', 'aBoxCornerOffset');

        builder.addVarying('highp float', 'vClipCoefficient');

        builder.setVertexMain(`
float modelPositionA[${rank}] = getBounds0();
float modelPositionB[${rank}] = getBounds1();
vClipCoefficient = getMaxEndpointSubspaceClipCoefficient(modelPositionA, modelPositionB);
if (vClipCoefficient == 0.0) {
  gl_Position = vec4(2.0, 0.0, 0.0, 1.0);
  return;
}
vec3 subspacePositionA = projectModelVectorToSubspace(modelPositionA);
vec3 subspacePositionB = projectModelVectorToSubspace(modelPositionB);
vec3 vertexPosition = mix(subspacePositionA, subspacePositionB, aBoxCornerOffset);
emitCircle(uModelViewProjection * vec4(vertexPosition, 1.0));
uint cornerIndex = uint(aBoxCornerOffset.x + aBoxCornerOffset.y * 2.0 + aBoxCornerOffset.z * 4.0);
uint cornerPickOffset = ${CORNERS_PICK_OFFSET}u + cornerIndex;
${this.setPartIndex(builder, 'cornerPickOffset')};
`);
        builder.setFragmentMain(`
vec4 borderColor = vec4(0.0, 0.0, 0.0, 1.0);
vec4 color = getCircleColor(vColor, borderColor);
color.a *= vClipCoefficient;
emitAnnotation(color);
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

      this.lineShader.draw(shader, context.renderContext, /*lineWidth=*/ 2, 1, context.count);
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

  private faceShaderGetter =
      emitterDependentShaderGetter(this, this.gl, (builder: ShaderBuilder) => {
        const {rank} = this;
        super.defineShader(builder);
        this.boundingBoxCrossSectionHelper.defineShader(builder);
        this.lineShader.defineShader(builder);

        builder.addAttribute('highp float', 'aVertexIndexFloat');
        builder.addVarying('highp float', 'vClipCoefficient');
        builder.setVertexMain(`
float modelPositionA[${rank}] = getBounds0();
float modelPositionB[${rank}] = getBounds1();
for (int i = 0; i < ${rank}; ++i) {
  float a = modelPositionA[i];
  float b = modelPositionB[i];
  modelPositionA[i] = min(a, b);
  modelPositionB[i] = max(a, b);
}
vClipCoefficient = getMaxSubspaceClipCoefficient(modelPositionA, modelPositionB);
if (vClipCoefficient == 0.0) {
  gl_Position = vec4(2.0, 0.0, 0.0, 1.0);
  return;
}
vec3 subspacePositionA = projectModelVectorToSubspace(modelPositionA);
vec3 subspacePositionB = projectModelVectorToSubspace(modelPositionB);
int vertexIndex1 = int(aVertexIndexFloat);
int vertexIndex2 = vertexIndex1 == 5 ? 0 : vertexIndex1 + 1;
vec3 vertexPosition1 = getBoundingBoxPlaneIntersectionVertexPosition(subspacePositionB - subspacePositionA, subspacePositionA, subspacePositionA, subspacePositionB, vertexIndex1);
vec3 vertexPosition2 = getBoundingBoxPlaneIntersectionVertexPosition(subspacePositionB - subspacePositionA, subspacePositionA, subspacePositionA, subspacePositionB, vertexIndex2);
emitLine(uModelViewProjection * vec4(vertexPosition1, 1.0),
         uModelViewProjection * vec4(vertexPosition2, 1.0));
${this.setPartIndex(builder)};
`);
        builder.setFragmentMain(`
emitAnnotation(vec4(vColor.rgb, vColor.a * getLineAlpha() * vClipCoefficient));
`);
      });

  private fillShaderGetter =
      emitterDependentShaderGetter(this, this.gl, (builder: ShaderBuilder) => {
        const {rank} = this;
        super.defineShader(builder);
        this.boundingBoxCrossSectionHelper.defineShader(builder);
        builder.addAttribute('highp float', 'aVertexIndexFloat');
        builder.addUniform('highp float', 'uFillOpacity');
        builder.addVarying('highp float', 'vClipCoefficient');
        builder.setVertexMain(`
float modelPositionA[${rank}] = getBounds0();
float modelPositionB[${rank}] = getBounds1();
for (int i = 0; i < ${rank}; ++i) {
  float a = modelPositionA[i];
  float b = modelPositionB[i];
  modelPositionA[i] = min(a, b);
  modelPositionB[i] = max(a, b);
}
vClipCoefficient = getMaxSubspaceClipCoefficient(modelPositionA, modelPositionB);
if (vClipCoefficient == 0.0) {
  gl_Position = vec4(2.0, 0.0, 0.0, 1.0);
  return;
}
vec3 subspacePositionA = projectModelVectorToSubspace(modelPositionA);
vec3 subspacePositionB = projectModelVectorToSubspace(modelPositionB);
int vertexIndex = int(aVertexIndexFloat);
vec3 vertexPosition = getBoundingBoxPlaneIntersectionVertexPosition(subspacePositionB - subspacePositionA, subspacePositionA, subspacePositionA, subspacePositionB, vertexIndex);
gl_Position = uModelViewProjection * vec4(vertexPosition, 1);
${this.setPartIndex(builder)};
`);
        builder.setFragmentMain(`
emitAnnotation(vec4(vColor.rgb, uFillOpacity * vClipCoefficient));
`);
      });

  draw(context: AnnotationRenderContext&{renderContext: SliceViewPanelRenderContext}) {
    const fillOpacity = context.annotationLayer.state.displayState.fillOpacity.value;
    const shader = (fillOpacity ? this.fillShaderGetter : this.faceShaderGetter)(
        context.renderContext.emitter);
    let {gl} = this;
    this.enable(shader, context, () => {
      this.boundingBoxCrossSectionHelper.setViewportPlane(
          shader, context.renderContext.sliceView.viewportNormalInGlobalCoordinates,
          context.renderContext.sliceView.centerDataPosition, context.renderSubspaceModelMatrix,
          context.renderSubspaceInvModelMatrix);
      const aVertexIndexFloat = shader.attribute('aVertexIndexFloat');

      (fillOpacity ? this.filledIntersectionVertexIndexBuffer : this.intersectionVertexIndexBuffer)
          .bindToVertexAttrib(
              aVertexIndexFloat, /*components=*/ 1, /*attributeType=*/ WebGL2RenderingContext.FLOAT,
              /*normalized=*/ false);

      if (fillOpacity) {
        gl.uniform1f(shader.uniform('uFillOpacity'), fillOpacity);
        gl.drawArraysInstanced(WebGL2RenderingContext.TRIANGLE_FAN, 0, 6, context.count);
      } else {
        this.lineShader.draw(
            shader, context.renderContext, context.renderContext.emitColor ? 2 : 5, 1.0,
            context.count);
      }
      gl.disableVertexAttribArray(aVertexIndexFloat);
    });
  }
}
// function getEdgeCorners(corners: Float32Array, edgeIndex: number) {
//   const i = edgeIndex * 7;
//   const cA = vec3.create(), cB = vec3.create();
//   for (let j = 0; j < 3; ++j) {
//     const ma = edgeBoxCornerOffsetData[i + j];
//     const mb = edgeBoxCornerOffsetData[i + j + 3];
//     const a = Math.min(corners[j], corners[j + 3]), b = Math.max(corners[j], corners[j + 3]);
//     cA[j] = (1 - ma) * a + ma * b;
//     cB[j] = (1 - mb) * a + mb * b;
//   }

//   return {cornerA: cA, cornerB: cB};
// }
// function snapPositionToEdge(position: Float32Array, corners: Float32Array) {
//   let edgeCorners = getEdgeCorners(corners, edgeIndex);
//   vec3.transformMat4(edgeCorners.cornerA, edgeCorners.cornerA, objectToData);
//   vec3.transformMat4(edgeCorners.cornerB, edgeCorners.cornerB, objectToData);

//   projectPointToLineSegment(position, edgeCorners.cornerA, edgeCorners.cornerB, position);
// }

function snapPositionToCorner(position: Float32Array, corners: Float32Array) {
  const rank = position.length;
  for (let i = 0; i < rank; ++i) {
    const v0 = corners[i], v1 = corners[i + rank];
    const x = position[i];
    position[i] = Math.abs(v0 - x) < Math.abs(v1 - x) ? v0 : v1;
  }
}

registerAnnotationTypeRenderHandler<AxisAlignedBoundingBox>(
    AnnotationType.AXIS_ALIGNED_BOUNDING_BOX, {
      sliceViewRenderHelper: SliceViewRenderHelper,
      perspectiveViewRenderHelper: PerspectiveViewRenderHelper,
      pickIdsPerInstance: PICK_IDS_PER_INSTANCE,
      snapPosition(position, data, offset, partIndex) {
        const corners = new Float32Array(data, offset, 6);
        if (partIndex >= CORNERS_PICK_OFFSET && partIndex < EDGES_PICK_OFFSET) {
          snapPositionToCorner(position, corners);
        } else if (partIndex >= EDGES_PICK_OFFSET && partIndex < FACES_PICK_OFFSET) {
          // snapPositionToEdge(position, objectToData, corners, partIndex - EDGES_PICK_OFFSET);
        } else {
          // vec3.transformMat4(position, annotation.point, objectToData);
        }
      },
      getRepresentativePoint(out: Float32Array, ann, partIndex) {
        // if the full object is selected pick the first corner as representative
        if (partIndex === FULL_OBJECT_PICK_OFFSET) {
          out.set(ann.pointA);
        } else if (partIndex >= CORNERS_PICK_OFFSET && partIndex < EDGES_PICK_OFFSET) {
          // picked a corner
          // FIXME: figure out how to return corner point
          out.set(ann.pointA);
        } else if (partIndex >= EDGES_PICK_OFFSET && partIndex < FACES_PICK_OFFSET) {
          // FIXME: can't figure out how to resize based upon edge grabbed
          out.set(ann.pointA);
          // snapPositionToCorner(repPoint, objectToData, corners, 5);
        } else {  // for now faces will move the whole object so pick the first corner
          out.set(ann.pointA);
        }
      },

      updateViaRepresentativePoint(
          oldAnnotation: AxisAlignedBoundingBox, position: Float32Array, partIndex: number) {
        partIndex;
        const rank = position.length;
        const {pointA, pointB} = oldAnnotation;
        const newPointA = new Float32Array(rank);
        const newPointB = new Float32Array(rank);
        for (let i = 0; i < rank; ++i) {
          const x = newPointA[i] = position[i];
          newPointB[i] = pointB[i] + (x - pointA[i]);
        }
        return {...oldAnnotation, pointA: newPointA, pointB: newPointB};
        // let newPt = vec3.transformMat4(vec3.create(), position, dataToObject);
        // let baseBox = {...oldAnnotation};
        // // if the full object is selected pick the first corner as representative
        // let delta = vec3.sub(vec3.create(), oldAnnotation.pointB, oldAnnotation.pointA);
        // if (partIndex === FULL_OBJECT_PICK_OFFSET) {
        //   baseBox.pointA = newPt;
        //   baseBox.pointB = vec3.add(vec3.create(), newPt, delta);
        // } else if (partIndex >= CORNERS_PICK_OFFSET && partIndex < EDGES_PICK_OFFSET) {
        //   // picked a corner
        //   baseBox.pointA = newPt;
        //   baseBox.pointB = vec3.add(vec3.create(), newPt, delta);
        // } else if (partIndex >= EDGES_PICK_OFFSET && partIndex < FACES_PICK_OFFSET) {
        //   baseBox.pointA = newPt;
        //   baseBox.pointB = vec3.add(vec3.create(), newPt, delta);
        // } else {  // for now faces will move the whole object so pick the first corner
        //   baseBox.pointA = newPt;
        //   baseBox.pointB = vec3.add(vec3.create(), newPt, delta);
        // }
        // return baseBox;
      }
    });
