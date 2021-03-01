/**
 * @license
 * Copyright 2016 Google Inc.
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
import {RefCounted} from 'neuroglancer/util/disposable';
import {mat4} from 'neuroglancer/util/geom';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {GL} from 'neuroglancer/webgl/context';
import {ShaderProgram} from 'neuroglancer/webgl/shader';
import {trivialColorShader} from 'neuroglancer/webgl/trivial_shaders';

const tempMat = mat4.create();

export function computeAxisLineMatrix(
    projectionParameters: ProjectionParameters, axisLength: number) {
  const mat = mat4.identity(tempMat);
  const {
    globalPosition: position,
    displayDimensionRenderInfo: {canonicalVoxelFactors, displayDimensionIndices}
  } = projectionParameters;
  for (let i = 0; i < 3; ++i) {
    const globalDim = displayDimensionIndices[i];
    mat[12 + i] = globalDim === -1 ? 0 : position[globalDim];
    mat[5 * i] = axisLength / canonicalVoxelFactors[i];
  }
  mat4.multiply(mat, projectionParameters.viewProjectionMat, mat);
  return mat;
}

export class AxesLineHelper extends RefCounted {
  vertexBuffer: Buffer;
  colorBuffer: Buffer;
  trivialColorShader: ShaderProgram;

  constructor(public gl: GL) {
    super();
    this.vertexBuffer = this.registerDisposer(Buffer.fromData(
        gl, new Float32Array([
          0, 0, 0, 1,  //
          1, 0, 0, 1,  //
          0, 0, 0, 1,  //
          0, 1, 0, 1,  //
          0, 0, 0, 1,  //
          0, 0, 1, 1,  //
        ]),
        gl.ARRAY_BUFFER, gl.STATIC_DRAW));

    let alpha = 0.5;
    this.colorBuffer = this.registerDisposer(Buffer.fromData(
        gl, new Float32Array([
          1, 0, 0, alpha,  //
          1, 0, 0, alpha,  //
          0, 1, 0, alpha,  //
          0, 1, 0, alpha,  //
          0, 0, 1, alpha,  //
          0, 0, 1, alpha,  //
        ]),
        gl.ARRAY_BUFFER, gl.STATIC_DRAW));
    this.trivialColorShader = this.registerDisposer(trivialColorShader(gl));
  }

  static get(gl: GL) {
    return gl.memoize.get('SliceViewPanel:AxesLineHelper', () => new AxesLineHelper(gl));
  }

  draw(mat: mat4, blend = true) {
    let shader = this.trivialColorShader;
    let gl = this.gl;
    shader.bind();
    gl.uniformMatrix4fv(shader.uniform('uProjectionMatrix'), false, mat);
    let aVertexPosition = shader.attribute('aVertexPosition');
    this.vertexBuffer.bindToVertexAttrib(aVertexPosition, 4);

    let aColor = shader.attribute('aColor');
    this.colorBuffer.bindToVertexAttrib(aColor, 4);

    if (blend) {
      gl.colorMask(false, false, false, true);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.colorMask(true, true, true, true);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE_MINUS_DST_ALPHA, gl.DST_ALPHA);
    }


    gl.lineWidth(1);
    gl.drawArrays(gl.LINES, 0, 6);

    if (blend) {
      gl.disable(gl.BLEND);
    }

    gl.disableVertexAttribArray(aVertexPosition);
    gl.disableVertexAttribArray(aColor);
  }
}
