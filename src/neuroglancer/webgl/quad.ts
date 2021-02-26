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
 * @file Facilities for drawing quads in WebGL as two triangles.
 */

export const VERTICES_PER_QUAD = 6;
export const TRIANGLES_PER_QUAD = 2;

export const glsl_getQuadVertexPosition = `
vec2 getQuadVertexPosition(vec2 lower, vec2 upper) {
  switch (gl_VertexID % 6) {
    case 0:
    case 5:
      return lower;
    case 1:
      return vec2(lower.x, upper.y);
    case 2:
    case 3:
      return vec2(upper.x, upper.y);
    case 4:
      return vec2(upper.x, lower.y);
  }
}
`;

export function drawQuads(gl: WebGL2RenderingContext, quadsPerInstance: number, numInstances: number) {
  gl.drawArraysInstanced(
      WebGL2RenderingContext.TRIANGLES, 0, VERTICES_PER_QUAD * quadsPerInstance, numInstances);
}
