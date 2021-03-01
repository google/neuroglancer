/**
 * @license
 * Copyright 2020 Google Inc.
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

import {ProjectionParameters} from 'neuroglancer/projection_parameters';
import {SliceViewProjectionParameters, TransformedSource} from 'neuroglancer/sliceview/base';
import {defineBoundingBoxCrossSectionShader, setBoundingBoxCrossSectionShaderViewportPlane} from 'neuroglancer/sliceview/bounding_box_shader_helper';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {EDGES_PER_BOX} from 'neuroglancer/webgl/bounding_box';
import {defineLineShader, drawLines, initializeLineShader, VERTICES_PER_LINE} from 'neuroglancer/webgl/lines';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';

const tempMat4 = mat4.create();
const tempVec3 = vec3.create();

function defineShaderCommon(builder: ShaderBuilder) {
  // Specifies translation of the current chunk.
  builder.addUniform('highp vec3', 'uTranslation');

  // Matrix by which computed vertices will be transformed.
  builder.addUniform('highp mat4', 'uProjectionMatrix');

  // Chunk size in voxels.
  builder.addUniform('highp vec3', 'uChunkDataSize');

  builder.addUniform('highp vec3', 'uLowerClipBound');
  builder.addUniform('highp vec3', 'uUpperClipBound');

  builder.setFragmentMain(`
emit(vec4(1.0, 1.0, 1.0, getLineAlpha()), 0u);
`);
}

export const projectionViewBoxWireFrameShader = {
  defineShader(builder: ShaderBuilder) {
    defineShaderCommon(builder);
    defineLineShader(builder);
    builder.addVertexCode(`
const vec3[24] boxCornerOffsets = vec3[](
  vec3(0, 0, 0), vec3(0, 0, 1),  // e1
  vec3(1, 0, 0), vec3(1, 0, 1),  // e2
  vec3(0, 1, 0), vec3(0, 1, 1),  // e3
  vec3(1, 1, 0), vec3(1, 1, 1),  // e4
  vec3(0, 0, 0), vec3(0, 1, 0),  // e5
  vec3(0, 0, 1), vec3(0, 1, 1),  // e6
  vec3(1, 0, 0), vec3(1, 1, 0),  // e7
  vec3(1, 0, 1), vec3(1, 1, 1),  // e8
  vec3(0, 0, 0), vec3(1, 0, 0),  // e9
  vec3(0, 0, 1), vec3(1, 0, 1),  // e10
  vec3(0, 1, 0), vec3(1, 1, 0),  // e11
  vec3(0, 1, 1), vec3(1, 1, 1)  // e12
);
`);
    builder.setVertexMain(`
int edgeIndex = gl_VertexID / ${VERTICES_PER_LINE};
vec3 cornerA = max(uLowerClipBound, min(uUpperClipBound, uTranslation));
vec3 cornerB = max(uLowerClipBound, min(uUpperClipBound, uTranslation + uChunkDataSize));
vec3 vertexPosition1 = mix(cornerA, cornerB, boxCornerOffsets[edgeIndex * 2]);
vec3 vertexPosition2 = mix(cornerA, cornerB, boxCornerOffsets[edgeIndex * 2 + 1]);
emitLine(uProjectionMatrix * vec4(vertexPosition1, 1.0),
         uProjectionMatrix * vec4(vertexPosition2, 1.0),
         2.0);
`);
  },

  initialize(shader: ShaderProgram, projectionParameters: ProjectionParameters) {
    initializeLineShader(shader, projectionParameters, /*featherWidthInPixels=*/ 1);
  },

  draw(
      shader: ShaderProgram, tsource: TransformedSource,
      projectionParameters: ProjectionParameters) {
    const {gl} = shader;
    const modelViewProjection = tempMat4;
    const {chunkLayout} = tsource;
    mat4.multiply(
        modelViewProjection, projectionParameters.viewProjectionMat, chunkLayout.transform);
    gl.uniformMatrix4fv(
        shader.uniform('uProjectionMatrix'), /*transpose=*/ false, modelViewProjection);
    gl.uniform3fv(shader.uniform('uChunkDataSize'), chunkLayout.size);
    gl.uniform3fv(shader.uniform('uLowerClipBound'), tsource.lowerClipDisplayBound);
    gl.uniform3fv(shader.uniform('uUpperClipBound'), tsource.upperClipDisplayBound);
    const chunkSize = chunkLayout.size;
    const {curPositionInChunks, chunkDisplayDimensionIndices} = tsource;
    const curPosition = tempVec3;
    for (let i = 0; i < 3; ++i) {
      const chunkDim = chunkDisplayDimensionIndices[i];
      curPosition[i] = (chunkDim === -1 ? 0 : curPositionInChunks[chunkDim]) * chunkSize[i];
    }
    gl.uniform3fv(shader.uniform('uTranslation'), curPosition);
    drawLines(gl, EDGES_PER_BOX, 1);
  },
};

export const crossSectionBoxWireFrameShader = {
  defineShader(builder: ShaderBuilder) {
    defineBoundingBoxCrossSectionShader(builder);
    defineShaderCommon(builder);
    defineLineShader(builder);
    builder.setVertexMain(`
int vertexIndex1 = gl_VertexID / ${VERTICES_PER_LINE};
int vertexIndex2 = vertexIndex1 == 5 ? 0 : vertexIndex1 + 1;
vec3 vertexPosition1 = getBoundingBoxPlaneIntersectionVertexPosition(uChunkDataSize, uTranslation, uLowerClipBound, uUpperClipBound, vertexIndex1);
vec3 vertexPosition2 = getBoundingBoxPlaneIntersectionVertexPosition(uChunkDataSize, uTranslation, uLowerClipBound, uUpperClipBound, vertexIndex2);
emitLine(uProjectionMatrix * vec4(vertexPosition1, 1.0),
         uProjectionMatrix * vec4(vertexPosition2, 1.0),
         2.0);
`);
  },

  initialize(shader: ShaderProgram, projectionParameters: SliceViewProjectionParameters) {
    initializeLineShader(shader, projectionParameters, /*featherWidthInPixels=*/ 1);
  },

  draw(
      shader: ShaderProgram, tsource: TransformedSource,
      projectionParameters: SliceViewProjectionParameters) {
    const {gl} = shader;
    const modelViewProjection = tempMat4;
    const {chunkLayout} = tsource;
    mat4.multiply(
        modelViewProjection, projectionParameters.viewProjectionMat, chunkLayout.transform);
    gl.uniformMatrix4fv(
        shader.uniform('uProjectionMatrix'), /*transpose=*/ false, modelViewProjection);
    gl.uniform3fv(shader.uniform('uChunkDataSize'), chunkLayout.size);
    gl.uniform3fv(shader.uniform('uLowerClipBound'), tsource.lowerClipDisplayBound);
    gl.uniform3fv(shader.uniform('uUpperClipBound'), tsource.upperClipDisplayBound);
    const chunkSize = chunkLayout.size;
    const {curPositionInChunks, chunkDisplayDimensionIndices} = tsource;
    const curPosition = tempVec3;
    for (let i = 0; i < 3; ++i) {
      const chunkDim = chunkDisplayDimensionIndices[i];
      curPosition[i] = (chunkDim === -1 ? 0 : curPositionInChunks[chunkDim]) * chunkSize[i];
    }
    gl.uniform3fv(shader.uniform('uTranslation'), curPosition);
    setBoundingBoxCrossSectionShaderViewportPlane(
        shader, projectionParameters.viewportNormalInGlobalCoordinates,
        projectionParameters.centerDataPosition, chunkLayout.transform, chunkLayout.invTransform);
    drawLines(gl, 6, 1);
  },
};
