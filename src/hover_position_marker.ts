/**
 * @license
 * Copyright 2024 Google Inc.
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
 * @file Draws a small reticle marker at the mouse-hover position within a
 * cross-section slice panel.  Used to display the position currently hovered in
 * one panel as a marker in the other panels (see
 * `showCrossSectionHoverPosition`).
 */

import type { ProjectionParameters } from "#src/projection_parameters.js";
import { RefCounted } from "#src/util/disposable.js";
import { mat4, type vec4 } from "#src/util/geom.js";
import { GLBuffer } from "#src/webgl/buffer.js";
import type { GL } from "#src/webgl/context.js";
import type { ShaderProgram } from "#src/webgl/shader.js";
import { trivialUniformColorShader } from "#src/webgl/trivial_shaders.js";

const tempMat = mat4.create();

/**
 * Computes the transform that places a fixed-size marker centered at the
 * specified global `position`, projected into the viewport described by
 * `projectionParameters`.  This mirrors `computeAxisLineMatrix` but uses an
 * arbitrary position (the mouse-hover position) rather than the navigation
 * center.
 */
export function computeHoverMarkerMatrix(
  projectionParameters: ProjectionParameters,
  markerSize: number,
  position: Float32Array,
) {
  const mat = mat4.identity(tempMat);
  const {
    displayDimensionRenderInfo: {
      canonicalVoxelFactors,
      displayDimensionIndices,
    },
  } = projectionParameters;
  for (let i = 0; i < 3; ++i) {
    const globalDim = displayDimensionIndices[i];
    mat[12 + i] =
      globalDim === -1 || globalDim >= position.length
        ? 0
        : position[globalDim];
    mat[5 * i] = markerSize / canonicalVoxelFactors[i];
  }
  mat4.multiply(mat, projectionParameters.viewProjectionMat, mat);
  return mat;
}

export class HoverPositionMarker extends RefCounted {
  vertexBuffer: GLBuffer;
  shader: ShaderProgram;

  constructor(public gl: GL) {
    super();
    // Two line segments forming a "+" reticle in the local X/Y plane.
    this.vertexBuffer = this.registerDisposer(
      GLBuffer.fromData(
        gl,
        new Float32Array([
          -1,
          0,
          0,
          1, //
          1,
          0,
          0,
          1, //
          0,
          -1,
          0,
          1, //
          0,
          1,
          0,
          1, //
        ]),
        gl.ARRAY_BUFFER,
        gl.STATIC_DRAW,
      ),
    );
    this.shader = trivialUniformColorShader(gl);
  }

  static get(gl: GL) {
    return gl.memoize.get(
      "SliceViewPanel:HoverPositionMarker",
      () => new HoverPositionMarker(gl),
    );
  }

  draw(mat: mat4, color: vec4) {
    const { shader, gl } = this;
    shader.bind();
    gl.uniformMatrix4fv(shader.uniform("uProjectionMatrix"), false, mat);
    gl.uniform4fv(shader.uniform("uColor"), color);
    const aVertexPosition = shader.attribute("aVertexPosition");
    this.vertexBuffer.bindToVertexAttrib(aVertexPosition, 4);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.lineWidth(1);
    gl.drawArrays(gl.LINES, 0, 4);
    gl.disable(gl.BLEND);

    gl.disableVertexAttribArray(aVertexPosition);
  }
}
