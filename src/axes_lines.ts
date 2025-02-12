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

import type { ProjectionParameters } from "#src/projection_parameters.js";
import { RefCounted } from "#src/util/disposable.js";
import { mat4 } from "#src/util/geom.js";
import { GLBuffer } from "#src/webgl/buffer.js";
import type { GL } from "#src/webgl/context.js";
import type { ShaderProgram } from "#src/webgl/shader.js";
import { trivialColorShader } from "#src/webgl/trivial_shaders.js";

const tempMat = mat4.create();

export function computeAxisLineMatrix(
  projectionParameters: ProjectionParameters,
  axisLength: number,
) {
  const mat = mat4.identity(tempMat);
  const {
    globalPosition: position,
    displayDimensionRenderInfo: {
      canonicalVoxelFactors,
      displayDimensionIndices,
    },
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
  vertexBuffer: GLBuffer;
  colorBuffer: GLBuffer;
  trivialColorShader: ShaderProgram;

  constructor(public gl: GL) {
    super();
    this.vertexBuffer = this.registerDisposer(
      GLBuffer.fromData(
        gl,
        new Float32Array([
          0,
          0,
          0,
          1, //
          1,
          0,
          0,
          1, //
          0,
          0,
          0,
          1, //
          0,
          1,
          0,
          1, //
          0,
          0,
          0,
          1, //
          0,
          0,
          1,
          1, //
        ]),
        gl.ARRAY_BUFFER,
        gl.STATIC_DRAW,
      ),
    );

    const alpha = 0.5;
    this.colorBuffer = this.registerDisposer(
      GLBuffer.fromData(
        gl,
        new Float32Array([
          1,
          0,
          0,
          alpha, //
          1,
          0,
          0,
          alpha, //
          0,
          1,
          0,
          alpha, //
          0,
          1,
          0,
          alpha, //
          0,
          0,
          1,
          alpha, //
          0,
          0,
          1,
          alpha, //
        ]),
        gl.ARRAY_BUFFER,
        gl.STATIC_DRAW,
      ),
    );
    this.trivialColorShader = this.registerDisposer(trivialColorShader(gl));
  }

  static get(gl: GL) {
    return gl.memoize.get(
      "SliceViewPanel:AxesLineHelper",
      () => new AxesLineHelper(gl),
    );
  }

  draw(mat: mat4, blend = true) {
    const shader = this.trivialColorShader;
    const gl = this.gl;
    shader.bind();
    gl.uniformMatrix4fv(shader.uniform("uProjectionMatrix"), false, mat);
    const aVertexPosition = shader.attribute("aVertexPosition");
    this.vertexBuffer.bindToVertexAttrib(aVertexPosition, 4);

    const aColor = shader.attribute("aColor");
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
