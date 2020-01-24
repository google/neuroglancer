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

export const EDGES_PER_BOX = 12;
export const CORNERS_PER_BOX = 8;
export const FACES_PER_BOX = 6;

export const glsl_getBoxFaceVertexPosition = `
vec3 getBoxFaceVertexPosition(int vertexIndex) {
  const vec3 vertexPositions[] = vec3[](
  // Front face
  vec3(0.0, 0.0,  1.0), // 0
  vec3(1.0, 0.0,  1.0), // 1
  vec3(1.0,  1.0,  1.0), // 2
  vec3(0.0,  1.0,  1.0), // 3

  // Back face
  vec3(0.0, 0.0, 0.0), // 4
  vec3(0.0,  1.0, 0.0), // 5
  vec3(1.0,  1.0, 0.0), // 6
  vec3(1.0, 0.0, 0.0), // 7

  // Top face
  vec3(0.0,  1.0, 0.0), // 8
  vec3(0.0,  1.0,  1.0), // 9
  vec3(1.0,  1.0,  1.0), // 10
  vec3(1.0,  1.0, 0.0), // 11

  // Bottom face
  vec3(0.0, 0.0, 0.0), // 12
  vec3( 1.0, 0.0, 0.0), // 13
  vec3( 1.0, 0.0,  1.0), // 14
  vec3(0.0, 0.0,  1.0), // 15

  // Right face
  vec3( 1.0, 0.0, 0.0), // 16
  vec3( 1.0,  1.0, 0.0), // 17
  vec3( 1.0,  1.0,  1.0), // 18
  vec3( 1.0, 0.0,  1.0), // 19

  // Left face
  vec3(0.0, 0.0, 0.0), // 20
  vec3(0.0, 0.0,  1.0), // 21
  vec3(0.0,  1.0,  1.0), // 22
  vec3(0.0,  1.0, 0.0) // 23
  );
  const int indices[] = int[](
    0,  1,  2,      0,  2,  3,    // front
    4,  5,  6,      4,  6,  7,    // back
    8,  9,  10,     8,  10, 11,   // top
    12, 13, 14,     12, 14, 15,   // bottom
    16, 17, 18,     16, 18, 19,   // right
    20, 21, 22,     20, 22, 23   // left
  );
  return vertexPositions[indices[vertexIndex]];
}
`;

export function drawBoxes(
    gl: WebGL2RenderingContext, boxesPerInstance: number, numInstances: number) {
  gl.drawArraysInstanced(
      WebGL2RenderingContext.TRIANGLES, 0, 6 * FACES_PER_BOX * boxesPerInstance, numInstances);
}
