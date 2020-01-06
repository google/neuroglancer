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
import {BoundingBoxCrossSectionRenderHelper, getIntersectionVertexIndexArrayForLines} from 'neuroglancer/sliceview/bounding_box_shader_helper';
import {tile2dArray} from 'neuroglancer/util/array';
import {RefCounted} from 'neuroglancer/util/disposable';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {EDGES_PER_BOX} from 'neuroglancer/webgl/bounding_box';
import {Buffer, getMemoizedBuffer} from 'neuroglancer/webgl/buffer';
import {GL} from 'neuroglancer/webgl/context';
import {LineShader, VERTICES_PER_LINE} from 'neuroglancer/webgl/lines';
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

const edgeBoxCornerOffsetData = Float32Array.from([
  // a1
  0,
  0,
  0,
  // b1
  0,
  0,
  1,

  // a2
  1,
  0,
  0,
  // b2
  1,
  0,
  1,

  // a3
  0,
  1,
  0,
  // b3
  0,
  1,
  1,

  // a4
  1,
  1,
  0,
  // b4
  1,
  1,
  1,

  // a5
  0,
  0,
  0,
  // b5
  0,
  1,
  0,

  // a6
  0,
  0,
  1,
  // b6
  0,
  1,
  1,

  // a7
  1,
  0,
  0,
  // b7
  1,
  1,
  0,

  // a8
  1,
  0,
  1,
  // b8
  1,
  1,
  1,

  // a9
  0,
  0,
  0,
  // b9
  1,
  0,
  0,

  // a10
  0,
  0,
  1,
  // b10
  1,
  0,
  1,

  // a11
  0,
  1,
  0,
  // b11
  1,
  1,
  0,

  // a12
  0,
  1,
  1,
  // b12
  1,
  1,
  1,
]);


export class ProjectionViewWireFrameRenderHelper extends RefCounted {
  static get(gl: GL) {
    return gl.memoize.get(
        'sliceView.ProjectionWireFrameRenderHelper',
        () => new ProjectionViewWireFrameRenderHelper(gl));
  }

  private lineShader = this.registerDisposer(new LineShader(this.gl, EDGES_PER_BOX));

  private edgeBoxCornerOffsetsBuffer = this.registerDisposer(Buffer.fromData(
      this.gl,
      tile2dArray(
          edgeBoxCornerOffsetData, /*majorDimension=*/ 6, /*minorTiles=*/ 1,
          /*majorTiles=*/ VERTICES_PER_LINE)));


  constructor(public gl: GL) {
    super();
  }

  defineShader(builder: ShaderBuilder) {
    defineShaderCommon(builder);
    this.lineShader.defineShader(builder);

    // XYZ corners of box ranging from [0, 0, 0] to [1, 1, 1].
    builder.addAttribute('highp vec3', 'aBoxCornerOffset1');
    builder.addAttribute('highp vec3', 'aBoxCornerOffset2');

    builder.setVertexMain(`
vec3 cornerA = max(uLowerClipBound, min(uUpperClipBound, uTranslation));
vec3 cornerB = max(uLowerClipBound, min(uUpperClipBound, uTranslation + uChunkDataSize));
vec3 vertexPosition1 = mix(cornerA, cornerB, aBoxCornerOffset1);
vec3 vertexPosition2 = mix(cornerA, cornerB, aBoxCornerOffset2);
emitLine(uProjectionMatrix * vec4(vertexPosition1, 1.0),
         uProjectionMatrix * vec4(vertexPosition2, 1.0),
         2.0);
`);
  }

  enable(shader: ShaderProgram, projectionParameters: ProjectionParameters) {
    const aBoxCornerOffset1 = shader.attribute('aBoxCornerOffset1');
    const aBoxCornerOffset2 = shader.attribute('aBoxCornerOffset2');

    this.edgeBoxCornerOffsetsBuffer.bindToVertexAttrib(
        aBoxCornerOffset1, /*components=*/ 3, /*attributeType=*/ WebGL2RenderingContext.FLOAT,
        /*normalized=*/ false,
        /*stride=*/ 4 * 6, /*offset=*/ 0);

    this.edgeBoxCornerOffsetsBuffer.bindToVertexAttrib(
        aBoxCornerOffset2, /*components=*/ 3, /*attributeType=*/ WebGL2RenderingContext.FLOAT,
        /*normalized=*/ false,
        /*stride=*/ 4 * 6, /*offset=*/ 4 * 3);
    this.lineShader.enable(shader, projectionParameters, /*featherWidthInPixels=*/ 1);
  }

  draw(
      shader: ShaderProgram, tsource: TransformedSource,
      projectionParameters: ProjectionParameters) {
    const {gl} = this;
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
    this.lineShader.draw(gl, 1);
  }

  disable(shader: ShaderProgram) {
    const {gl} = shader;
    gl.disableVertexAttribArray(shader.attribute('aBoxCornerOffset1'));
    gl.disableVertexAttribArray(shader.attribute('aBoxCornerOffset2'));
  }
}

export class SliceViewWireFrameRenderHelper extends BoundingBoxCrossSectionRenderHelper {
  static get(gl: GL) {
    return gl.memoize.get(
        'sliceView.WireFrameRenderHelper', () => new SliceViewWireFrameRenderHelper(gl));
  }

  private lineShader = new LineShader(this.gl, 6);
  private intersectionVertexIndexBuffer =
      getMemoizedBuffer(
          this.gl, WebGL2RenderingContext.ARRAY_BUFFER, getIntersectionVertexIndexArrayForLines)
          .value;

  defineShader(builder: ShaderBuilder) {
    super.defineShader(builder);
    defineShaderCommon(builder);
    // A number in [0, 6) specifying which vertex to compute.
    builder.addAttribute('highp float', 'aVertexIndexFloat');
    this.lineShader.defineShader(builder);
    builder.setVertexMain(`
int vertexIndex1 = int(aVertexIndexFloat);
int vertexIndex2 = vertexIndex1 == 5 ? 0 : vertexIndex1 + 1;
vec3 vertexPosition1 = getBoundingBoxPlaneIntersectionVertexPosition(uChunkDataSize, uTranslation, uLowerClipBound, uUpperClipBound, vertexIndex1);
vec3 vertexPosition2 = getBoundingBoxPlaneIntersectionVertexPosition(uChunkDataSize, uTranslation, uLowerClipBound, uUpperClipBound, vertexIndex2);
emitLine(uProjectionMatrix * vec4(vertexPosition1, 1.0),
         uProjectionMatrix * vec4(vertexPosition2, 1.0),
         2.0);
`);
  }

  enable(shader: ShaderProgram, projectionParameters: SliceViewProjectionParameters) {
    this.intersectionVertexIndexBuffer.bindToVertexAttrib(shader.attribute('aVertexIndexFloat'), 1);
    this.lineShader.enable(shader, projectionParameters, /*featherWidthInPixels=*/ 1);
  }

  draw(
      shader: ShaderProgram, tsource: TransformedSource,
      projectionParameters: SliceViewProjectionParameters) {
    const {gl} = this;
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
    this.setViewportPlane(
        shader, projectionParameters.viewportNormalInGlobalCoordinates,
        projectionParameters.centerDataPosition, chunkLayout.transform, chunkLayout.invTransform);
    this.lineShader.draw(gl, 1);
  }

  disable(shader: ShaderProgram) {
    this.gl.disableVertexAttribArray(shader.attribute('aVertexIndexFloat'));
  }
}
