/**
 * @license
 * Copyright 2017 Google Inc.
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
 * @file Facilities for computing the intersection points between an axis-aligned bounding box and a
 * plane in a vertex shader.
 *
 * We use the approach described in the following paper to determine the
 * intersection between the
 * viewport plane and a given 3-D chunk inside of a WebGL vertex shader:
 *
 * A Vertex Program for Efficient Box-Plane Intersection
 * Christof Rezk Salama and Adreas Kolb
 * VMV 2005.
 * http://www.cg.informatik.uni-siegen.de/data/Publications/2005/rezksalamaVMV2005.pdf
 *
 */

import {mat4, transformVectorByMat4Transpose, vec3, vec3Key} from 'neuroglancer/util/geom';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';

const tempVec3 = vec3.create();
const tempVec3b = vec3.create();

/**
 * Amount by which a computed intersection point may lie outside the [0, 1] range and still be
 * considered valid.  This needs to be non-zero in order to avoid vertex placement artifacts.
 */
const LAMBDA_EPSILON = 1e-3;

/**
 * If the absolute value of the dot product of a cube edge direction and the viewport plane normal
 * is less than this value, intersections along that cube edge will be exluded.  This needs to be
 * non-zero in order to avoid vertex placement artifacts.
 */
const ORTHOGONAL_EPSILON = 1e-3;

function findFrontVertexIndex(planeNormal: vec3) {
  // Determine which vertex is front.
  let frontVertexIndex = 0;
  for (var axis_i = 0; axis_i < 3; ++axis_i) {
    // If plane normal is negative in axis direction, then choose the vertex
    // with the maximum axis_i-coordinate.
    if (planeNormal[axis_i] < 0) {
      frontVertexIndex += (1 << axis_i);
    }
  }
  return frontVertexIndex;
}

// Specifies the positions of the 8 corners.
export const vertexBasePositions = new Float32Array([
  0, 0, 0,  //
  1, 0, 0,  //
  0, 1, 0,  //
  1, 1, 0,  //
  0, 0, 1,  //
  1, 0, 1,  //
  0, 1, 1,  //
  1, 1, 1,  //
]);

export const boundingBoxCrossSectionVertexIndices = (() => {
  // This specifies the original, "uncorrected" vertex positions.
  // var vertexBasePositions = [
  //   0, 0, 0,
  //   1, 0, 0,
  //   0, 1, 0,
  //   0, 0, 1,
  //   1, 0, 1,
  //   1, 1, 0,
  //   0, 1, 1,
  //   1, 1, 1,
  // ];

  // correct_index, vertex_position, uncorrected_index
  // 0:  0, 0, 0   0
  // 1:  1, 0, 0   1
  // 2:  0, 1, 0   2
  // 4:  0, 0, 1   3
  // 5:  1, 0, 1   4
  // 3:  1, 1, 0   5
  // 6:  0, 1, 1   6
  // 7:  1, 1, 1   7

  // This maps uncorrected vertex indices to corrected vertex indices.
  const vertexUncorrectedToCorrected = [0, 1, 2, 4, 5, 3, 6, 7];

  // This maps corrected vertex indices to uncorrected vertex indices.
  const vertexCorrectedToUncorrected = [0, 1, 2, 5, 3, 4, 6, 7];


  // Page 666
  const vertexBaseIndices = [
    0, 1, 1, 4, 4, 7, 4, 7,  //
    1, 5, 0, 1, 1, 4, 4, 7,  //
    0, 2, 2, 5, 5, 7, 5, 7,  //
    2, 6, 0, 2, 2, 5, 5, 7,  //
    0, 3, 3, 6, 6, 7, 6, 7,  //
    3, 4, 0, 3, 3, 6, 6, 7,  //
  ];

  // Determined by looking at the figure and determining the corresponding
  // vertex order for each possible front vertex.
  const vertexPermutation = [
    0, 1, 2, 3, 4, 5, 6, 7,  //
    1, 4, 5, 0, 3, 7, 2, 6,  //
    2, 6, 0, 5, 7, 3, 1, 4,  //
    3, 0, 6, 4, 1, 2, 7, 5,  //
    4, 3, 7, 1, 0, 6, 5, 2,  //
    5, 2, 1, 7, 6, 0, 4, 3,  //
    6, 7, 3, 2, 5, 4, 0, 1,  //
    7, 5, 4, 6, 2, 1, 3, 0,  //
  ];

  const vertexIndices = new Int32Array(8 * 8 * 6);
  for (let p = 0; p < 8; ++p) {
    for (let i = 0; i < vertexBaseIndices.length; ++i) {
      const vertexPermutationIndex = vertexCorrectedToUncorrected[p] * 8 + vertexBaseIndices[i];
      vertexIndices[p * 8 * 6 + i] =
          vertexUncorrectedToCorrected[vertexPermutation[vertexPermutationIndex]];
    }
  }
  return vertexIndices;
})();

export function defineBoundingBoxCrossSectionShader(builder: ShaderBuilder) {
  // Slice plane normal.
  builder.addUniform('highp vec3', 'uPlaneNormal');

  // Distance from the origin to the slice plane.
  builder.addUniform('highp float', 'uPlaneDistance');

  // Two-dimensional array of dimensions [6x4], specifying the first and
  // second vertex index for each of the 4 candidate edges to test for each
  // computed vertex.
  builder.addUniform('highp ivec2', 'uVertexIndex', 24);

  // Base vertex positions.
  builder.addUniform('highp vec3', 'uVertexBasePosition', 8);
  builder.addInitializer(shader => {
    shader.gl.uniform3fv(shader.uniform('uVertexBasePosition'), vertexBasePositions);
  });

  builder.addVertexCode(`
vec3 getBoundingBoxPlaneIntersectionVertexPosition(vec3 chunkSize, vec3 boxLower, vec3 lowerClipBound, vec3 upperClipBound, int vertexIndex, float planeDistance) {
  for (int e = 0; e < 4; ++e) {
    highp ivec2 vidx = uVertexIndex[vertexIndex*4 + e];
    highp vec3 v1 = max(lowerClipBound, min(upperClipBound, chunkSize * uVertexBasePosition[vidx.x] + boxLower));
    highp vec3 v2 = max(lowerClipBound, min(upperClipBound, chunkSize * uVertexBasePosition[vidx.y] + boxLower));
    highp vec3 vDir = v2 - v1;
    highp float denom = dot(vDir, uPlaneNormal);
    if (abs(denom) > ${ORTHOGONAL_EPSILON}) {
      highp float lambda = (planeDistance - dot(v1, uPlaneNormal)) / denom;
      if ((lambda >= -${LAMBDA_EPSILON}) && (lambda <= (1.0 + ${LAMBDA_EPSILON}))) {
        lambda = clamp(lambda, 0.0, 1.0);
        highp vec3 position = v1 + lambda * vDir;
        return position;
      }
    }
  }
  return vec3(0, 0, 0);
}
vec3 getBoundingBoxPlaneIntersectionVertexPosition(vec3 chunkSize, vec3 boxLower, vec3 lowerClipBound, vec3 upperClipBound, int vertexIndex) {
  return getBoundingBoxPlaneIntersectionVertexPosition(chunkSize, boxLower, lowerClipBound, upperClipBound, vertexIndex, uPlaneDistance);
}
`);
}

export function computeVertexPositionDebug(
    chunkSize: vec3, uLowerClipBound: vec3, uUpperClipBound: vec3, uPlaneDistance: number,
    uPlaneNormal: vec3, uTranslation: vec3, vertexIndex: number, print = true): vec3|undefined {
  let frontVertexIndex = findFrontVertexIndex(uPlaneNormal);
  let uVertexIndex = boundingBoxCrossSectionVertexIndices.subarray(
      frontVertexIndex * 48, (frontVertexIndex + 1) * 48);
  let vidx = [0, 0];
  let v = [vec3.create(), vec3.create()];
  let vDir = vec3.create(), position = vec3.create();
  let uVertexBasePosition = (i: number) => <vec3>vertexBasePositions.subarray(i * 3, i * 3 + 3);
  for (let e = 0; e < 4; ++e) {
    for (let j = 0; j < 2; ++j) {
      vidx[j] = uVertexIndex[2 * (vertexIndex * 4 + e) + j];
      vec3.multiply(v[j], chunkSize, uVertexBasePosition(vidx[j]));
      vec3.add(v[j], v[j], uTranslation);
      vec3.min(v[j], v[j], uUpperClipBound);
      vec3.max(v[j], v[j], uLowerClipBound);
    }
    vec3.subtract(vDir, v[1], v[0]);
    let denom = vec3.dot(vDir, uPlaneNormal);
    if (Math.abs(denom) > ORTHOGONAL_EPSILON) {
      let lambda = (uPlaneDistance - vec3.dot(v[0], uPlaneNormal)) / denom;
      if ((lambda >= -LAMBDA_EPSILON) && (lambda <= 1.0 + LAMBDA_EPSILON)) {
        if (print) {
          console.log(`vertex ${vertexIndex}, e = ${e}, good, lambda=${lambda}, denom=${
              denom}, v0=${v[0].join()}, vDir=${vDir.join()}`);
        }
        lambda = Math.max(0, Math.min(1, lambda));
        vec3.scaleAndAdd(position, v[0], vDir, lambda);
        return position;
      } else {
        if (print) {
          console.log(
              `vertex ${vertexIndex}, e = ${e}, skipped, denom = ${denom}, ` +
              `vDir = ${vDir.join()}, v0=${v[0].join()}, v1=${v[1].join()}` +
              `uPlaneNormal = ${vec3Key(uPlaneNormal)}, ` +
              `lambda=${lambda}`);
        }
      }
    } else {
      if (print) {
        console.log(
            `vertex ${vertexIndex}, e = ${e}, skipped, deom = ${denom}, ` +
            `vDir = ${vec3Key(vDir)}, uPlaneNormal = ${vec3Key(uPlaneNormal)}, ` +
            `uLowerClipBound=${uLowerClipBound.join()}, uUpperClipBound=${
                uUpperClipBound.join()}, ` +
            `chunkSize=${chunkSize}, uVertexBasePosition(v0)=${
                uVertexBasePosition(vidx[0]).join()}, ` +
            `uVertexBasePosition(v1)=${uVertexBasePosition(vidx[1]).join()}, ` +
            `uTranslation=${uTranslation.join()}`);
      }
    }
  }
  return undefined;
}

export function computeVertexPositionsDebug(
    chunkSize: vec3, uLowerClipBound: vec3, uUpperClipBound: vec3, uPlaneDistance: number,
    uPlaneNormal: vec3, uTranslation: vec3) {
  const vertices: vec3[] = [];
  for (let vertexIndex = 0; vertexIndex < 6; ++vertexIndex) {
    const v = computeVertexPositionDebug(
        chunkSize, uLowerClipBound, uUpperClipBound, uPlaneDistance, uPlaneNormal, uTranslation,
        vertexIndex, false);
    if (v !== undefined) vertices.push(v);
  }
  return vertices;
}

export function setBoundingBoxCrossSectionShaderPlane(
    shader: ShaderProgram, planeNormal: vec3, planeDistanceToOrigin: number) {
  const {gl} = shader;
  gl.uniform3fv(shader.uniform('uPlaneNormal'), planeNormal);
  gl.uniform1f(shader.uniform('uPlaneDistance'), planeDistanceToOrigin);

  const frontVertexIndex = findFrontVertexIndex(planeNormal);
  gl.uniform2iv(
      shader.uniform('uVertexIndex'),
      boundingBoxCrossSectionVertexIndices.subarray(
          frontVertexIndex * 48, (frontVertexIndex + 1) * 48));
}

export function setBoundingBoxCrossSectionShaderViewportPlane(
    shader: ShaderProgram, viewportNormalInGlobalCoordinates: vec3, viewportCenterPosition: vec3,
    modelMatrix: mat4, invModelMatrix: mat4) {
  const localPlaneNormal =
      transformVectorByMat4Transpose(tempVec3, viewportNormalInGlobalCoordinates, modelMatrix);
  vec3.normalize(localPlaneNormal, localPlaneNormal);
  const planeDistanceToOrigin = vec3.dot(
      vec3.transformMat4(tempVec3b, viewportCenterPosition, invModelMatrix), localPlaneNormal);
  setBoundingBoxCrossSectionShaderPlane(shader, localPlaneNormal, planeDistanceToOrigin);
}
