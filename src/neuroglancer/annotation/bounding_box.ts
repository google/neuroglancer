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
import {AnnotationRenderContext, AnnotationRenderHelper, AnnotationShaderGetter, registerAnnotationTypeRenderHandler} from 'neuroglancer/annotation/type_handler';
import {defineBoundingBoxCrossSectionShader, setBoundingBoxCrossSectionShaderViewportPlane, vertexBasePositions} from 'neuroglancer/sliceview/bounding_box_shader_helper';
import {SliceViewPanelRenderContext} from 'neuroglancer/sliceview/renderlayer';
import {tile2dArray} from 'neuroglancer/util/array';
import {getViewFrustrumWorldBounds, mat4} from 'neuroglancer/util/geom';
import {CORNERS_PER_BOX, EDGES_PER_BOX} from 'neuroglancer/webgl/bounding_box';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {defineCircleShader, drawCircles, initializeCircleShader, VERTICES_PER_CIRCLE} from 'neuroglancer/webgl/circles';
import {defineLineShader, drawLines, initializeLineShader, VERTICES_PER_LINE} from 'neuroglancer/webgl/lines';
import {drawArraysInstanced, ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {defineVectorArrayVertexShaderInput} from 'neuroglancer/webgl/shader_lib';
import {defineVertexId, VertexIdHelper} from 'neuroglancer/webgl/vertex_id';

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

const tempInvModelViewProjectionMatrix = mat4.create();
const tempWorldBounds = new Float32Array(6);

abstract class RenderHelper extends AnnotationRenderHelper {
  defineShader(builder: ShaderBuilder) {
    defineVertexId(builder);
    // Position of lower/upper in model coordinates.
    const {rank} = this;
    defineVectorArrayVertexShaderInput(
        builder, 'float', WebGL2RenderingContext.FLOAT, /*normalized=*/ false, 'Bounds', rank, 2);
    builder.addUniform('vec3', 'uModelSpaceBoundOffsets', 2);
  }

  private vertexIdHelper = this.registerDisposer(VertexIdHelper.get(this.gl));

  enable(
      shaderGetter: AnnotationShaderGetter, context: AnnotationRenderContext,
      callback: (shader: ShaderProgram) => void) {
    mat4.invert(tempInvModelViewProjectionMatrix, context.modelViewProjectionMatrix);
    getViewFrustrumWorldBounds(tempInvModelViewProjectionMatrix, tempWorldBounds);
    const {numChunkDisplayDims} = context.chunkDisplayTransform;
    for (let i = 0; i < numChunkDisplayDims; ++i) {
      tempWorldBounds[i] = 0;
      tempWorldBounds[i + 3] = 0;
    }
    for (let i = numChunkDisplayDims; i < 3; ++i) {
      const delta = Math.abs(tempWorldBounds[i + 3] - tempWorldBounds[i]);
      tempWorldBounds[i] -= delta;
      tempWorldBounds[i + 3] += delta;
    }
    super.enable(shaderGetter, context, shader => {
      const binder = shader.vertexShaderInputBinders['Bounds'];
      binder.enable(1);
      const {gl} = this;
      gl.uniform3fv(shader.uniform('uModelSpaceBoundOffsets'), tempWorldBounds);
      gl.bindBuffer(WebGL2RenderingContext.ARRAY_BUFFER, context.buffer.buffer);
      binder.bind(this.geometryDataStride, context.bufferOffset);
      const {vertexIdHelper} = this;
      vertexIdHelper.enable();
      callback(shader);
      vertexIdHelper.disable();
      binder.disable();
    });
  }
}

function addBorderNoOpSetters(builder: ShaderBuilder) {
  builder.addVertexCode(`
void setBoundingBoxBorderWidth(float width) {}
void setBoundingBoxBorderColor(vec4 color) {}
`);
}

function addFaceNoOpSetters(builder: ShaderBuilder) {
  builder.addVertexCode(`
void setBoundingBoxFillColor(vec4 color) {}
`);
}

function addBorderSetters(builder: ShaderBuilder) {
  addFaceNoOpSetters(builder);
  builder.addVertexCode(`
float ng_lineWidth;
void setBoundingBoxBorderWidth(float size) {
  ng_lineWidth = size;
}
void setBoundingBoxBorderColor(vec4 color) {
  vColor = color;
}
`);
}

function addFaceSetters(builder: ShaderBuilder) {
  addBorderNoOpSetters(builder);
  builder.addVertexCode(`
void setBoundingBoxFillColor(vec4 color) {
  vColor = color;
}
`);
}

class PerspectiveViewRenderHelper extends RenderHelper {
  private edgeBoxCornerOffsetsBuffer = this.registerDisposer(Buffer.fromData(
      this.gl,
      tile2dArray(
          edgeBoxCornerOffsetData, /*majorDimension=*/ 7, /*minorTiles=*/ 1,
          /*majorTiles=*/ VERTICES_PER_LINE)));

  private edgeShaderGetter = this.getDependentShader(
      'annotation/boundingBox/projection/border', (builder: ShaderBuilder) => {
        const {rank} = this;
        this.defineShader(builder);
        defineLineShader(builder);

        // XYZ corners of box ranging from [0, 0, 0] to [1, 1, 1].
        builder.addAttribute('highp vec3', 'aBoxCornerOffset1');

        // Last component of aBoxCornerOffset2 is the edge index.
        builder.addAttribute('highp vec4', 'aBoxCornerOffset2');

        builder.addVarying('highp float', 'vClipCoefficient');

        addBorderSetters(builder);
        builder.setVertexMain(`
float modelPositionA[${rank}] = getBounds0();
float modelPositionB[${rank}] = getBounds1();
vec3 subspacePositionA = projectModelVectorToSubspace(modelPositionA) + uModelSpaceBoundOffsets[0];
vec3 subspacePositionB = projectModelVectorToSubspace(modelPositionB) + uModelSpaceBoundOffsets[1];
vec3 endpointA = mix(subspacePositionA, subspacePositionB, aBoxCornerOffset1);
vec3 endpointB = mix(subspacePositionA, subspacePositionB, aBoxCornerOffset2.xyz);
vClipCoefficient = getMaxSubspaceClipCoefficient(modelPositionA, modelPositionB);
if (vClipCoefficient == 0.0) {
  gl_Position = vec4(2.0, 0.0, 0.0, 1.0);
  return;
}
ng_lineWidth = 1.0;
${this.invokeUserMain}
emitLine(uModelViewProjection * vec4(endpointA, 1.0),
         uModelViewProjection * vec4(endpointB, 1.0),
         ng_lineWidth);
${this.setPartIndex(builder, 'uint(aBoxCornerOffset2.w)')};
`);
        builder.setFragmentMain(`
emitAnnotation(vec4(vColor.rgb, getLineAlpha() * vClipCoefficient));
`);
      });

  private boxCornerOffsetsBuffer = this.registerDisposer(Buffer.fromData(
      this.gl,
      tile2dArray(
          vertexBasePositions, /*majorDimension=*/ 3, /*minorTiles=*/ 1,
          /*majorTiles=*/ VERTICES_PER_CIRCLE)));

  private cornerShaderGetter = this.getDependentShader(
      'annotation/boundingBox/projection/corner', (builder: ShaderBuilder) => {
        const {rank} = this;
        this.defineShader(builder);
        defineCircleShader(builder, this.targetIsSliceView);

        // XYZ corners of box ranging from [0, 0, 0] to [1, 1, 1].
        builder.addAttribute('highp vec3', 'aBoxCornerOffset');

        builder.addVarying('highp float', 'vClipCoefficient');
        addBorderSetters(builder);
        builder.setVertexMain(`
float modelPositionA[${rank}] = getBounds0();
float modelPositionB[${rank}] = getBounds1();
vClipCoefficient = getMaxEndpointSubspaceClipCoefficient(modelPositionA, modelPositionB);
if (vClipCoefficient == 0.0) {
  gl_Position = vec4(2.0, 0.0, 0.0, 1.0);
  return;
}
vec3 subspacePositionA = projectModelVectorToSubspace(modelPositionA) + uModelSpaceBoundOffsets[0];
vec3 subspacePositionB = projectModelVectorToSubspace(modelPositionB) + uModelSpaceBoundOffsets[1];
vec3 vertexPosition = mix(subspacePositionA, subspacePositionB, aBoxCornerOffset);
emitCircle(uModelViewProjection * vec4(vertexPosition, 1.0), ng_lineWidth, 0.0);
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
    const {gl} = this;
    this.enable(this.edgeShaderGetter, context, shader => {
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

      initializeLineShader(
          shader, context.renderContext.projectionParameters, /*featherWidthInPixels=*/ 1);
      drawLines(gl, EDGES_PER_BOX, context.count);
      gl.disableVertexAttribArray(aBoxCornerOffset1);
      gl.disableVertexAttribArray(aBoxCornerOffset2);
    });
  }

  drawCorners(context: AnnotationRenderContext) {
    const {gl} = this;
    this.enable(this.cornerShaderGetter, context, shader => {
      const aBoxCornerOffset = shader.attribute('aBoxCornerOffset');
      this.boxCornerOffsetsBuffer.bindToVertexAttrib(
          aBoxCornerOffset, /*components=*/ 3, /*attributeType=*/ WebGL2RenderingContext.FLOAT,
          /*normalized=*/ false);
      initializeCircleShader(
          shader, context.renderContext.projectionParameters, {featherWidthInPixels: 0});
      drawCircles(shader.gl, CORNERS_PER_BOX, context.count);
      gl.disableVertexAttribArray(aBoxCornerOffset);
    });
  }

  draw(context: AnnotationRenderContext) {
    this.drawEdges(context);
    this.drawCorners(context);
  }
}

class SliceViewRenderHelper extends RenderHelper {
  private faceShaderGetter = this.getDependentShader(
      'annotation/boundingBox/crossSection/face', (builder: ShaderBuilder) => {
        const {rank} = this;
        super.defineShader(builder);
        defineBoundingBoxCrossSectionShader(builder);
        defineLineShader(builder);

        builder.addVarying('highp float', 'vClipCoefficient');
        addBorderSetters(builder);
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
vec3 subspacePositionA = projectModelVectorToSubspace(modelPositionA) + uModelSpaceBoundOffsets[0];
vec3 subspacePositionB = projectModelVectorToSubspace(modelPositionB) + uModelSpaceBoundOffsets[1];
int vertexIndex1 = gl_VertexID / ${VERTICES_PER_LINE};
int vertexIndex2 = vertexIndex1 == 5 ? 0 : vertexIndex1 + 1;
vec3 vertexPosition1 = getBoundingBoxPlaneIntersectionVertexPosition(subspacePositionB - subspacePositionA, subspacePositionA, subspacePositionA, subspacePositionB, vertexIndex1);
vec3 vertexPosition2 = getBoundingBoxPlaneIntersectionVertexPosition(subspacePositionB - subspacePositionA, subspacePositionA, subspacePositionA, subspacePositionB, vertexIndex2);
ng_lineWidth = 1.0;
${this.invokeUserMain}
emitLine(uModelViewProjection * vec4(vertexPosition1, 1.0),
         uModelViewProjection * vec4(vertexPosition2, 1.0),
         ng_lineWidth);
${this.setPartIndex(builder)};
`);
        builder.setFragmentMain(`
emitAnnotation(vec4(vColor.rgb, vColor.a * getLineAlpha() * vClipCoefficient));
`);
      });

  private fillShaderGetter = this.getDependentShader(
      'annotation/boundingBox/crossSection/fill', (builder: ShaderBuilder) => {
        const {rank} = this;
        super.defineShader(builder);
        defineBoundingBoxCrossSectionShader(builder);
        builder.addVarying('highp float', 'vClipCoefficient');
        addFaceSetters(builder);
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
vec3 subspacePositionA = projectModelVectorToSubspace(modelPositionA) + uModelSpaceBoundOffsets[0];
vec3 subspacePositionB = projectModelVectorToSubspace(modelPositionB) + uModelSpaceBoundOffsets[1];
int vertexIndex = gl_VertexID;
vec3 vertexPosition = getBoundingBoxPlaneIntersectionVertexPosition(subspacePositionB - subspacePositionA, subspacePositionA, subspacePositionA, subspacePositionB, vertexIndex);
gl_Position = uModelViewProjection * vec4(vertexPosition, 1);
${this.invokeUserMain}
${this.setPartIndex(builder)};
`);
        builder.setFragmentMain(`
emitAnnotation(vec4(vColor.rgb, vColor.a * vClipCoefficient));
`);
      });

  enableForBoundingBox(
      shaderGetter: AnnotationShaderGetter,
      context: AnnotationRenderContext&{renderContext: SliceViewPanelRenderContext},
      callback: (shader: ShaderProgram) => void) {
    super.enable(shaderGetter, context, shader => {
      const projectionParameters = context.renderContext.sliceView.projectionParameters.value;
      setBoundingBoxCrossSectionShaderViewportPlane(
          shader, projectionParameters.viewportNormalInGlobalCoordinates,
          projectionParameters.centerDataPosition, context.renderSubspaceModelMatrix,
          context.renderSubspaceInvModelMatrix);
      callback(shader);
    });
  }

  draw(context: AnnotationRenderContext&{renderContext: SliceViewPanelRenderContext}) {
    if (this.shaderControlState.parseResult.value.code.match(/\bsetBoundingBoxFillColor\b/)) {
      this.enableForBoundingBox(this.fillShaderGetter, context, () => {
        drawArraysInstanced(this.gl, WebGL2RenderingContext.TRIANGLE_FAN, 0, 6, context.count);
      });
    }
    this.enableForBoundingBox(this.faceShaderGetter, context, shader => {
      initializeLineShader(
          shader, context.renderContext.projectionParameters, /*featherWidthInPixels=*/ 1.0);
      drawLines(shader.gl, 6, context.count);
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
      defineShaderNoOpSetters(builder) {
        addFaceNoOpSetters(builder);
        addBorderNoOpSetters(builder);
      },
      pickIdsPerInstance: PICK_IDS_PER_INSTANCE,
      snapPosition(position, data, offset, partIndex) {
        const rank = position.length;
        const corners = new Float32Array(data, offset, rank * 2);
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
