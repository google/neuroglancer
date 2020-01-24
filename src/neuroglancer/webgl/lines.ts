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
 * @file Facilities for drawing anti-aliased lines in WebGL as quads.
 */

import {drawQuads, glsl_getQuadVertexPosition, VERTICES_PER_QUAD} from 'neuroglancer/webgl/quad';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';

export const VERTICES_PER_LINE = VERTICES_PER_QUAD;

export function defineLineShader(builder: ShaderBuilder) {
  builder.addVertexCode(glsl_getQuadVertexPosition);
  // x: 1 / viewportWidth
  // y: 1 / viewportHeight
  // z: featherWidth: Line feather width in pixels
  builder.addUniform('highp vec3', 'uLineParams');
  builder.addVarying('highp float', 'vLineCoord');
  // max(1e-6, featherWidth) / (lineWidth + featherWidth)
  builder.addVarying('highp float', 'vLineFeatherFraction');

  builder.addVertexCode(`
vec2 getLineOffset() { return getQuadVertexPosition(vec2(0.0, -1.0), vec2(1.0, 1.0)); }
float getLineEndpointCoefficient() { return getLineOffset().x; }
uint getLineEndpointIndex() { return uint(getLineEndpointCoefficient()); }
void emitLine(vec4 vertexAClip, vec4 vertexBClip, float lineWidthInPixels) {
  vec2 lineOffset = getLineOffset();
  vec4 vertexPositionClip = mix(vertexAClip, vertexBClip, lineOffset.x);
  vec4 otherVertexPositionClip = mix(vertexBClip, vertexAClip, lineOffset.x);

  vec3 vertexPositionDevice = vertexPositionClip.xyz / vertexPositionClip.w;
  vec3 otherVertexPositionDevice = otherVertexPositionClip.xyz / otherVertexPositionClip.w;

  vec2 lineDirection = normalize(otherVertexPositionDevice.xy - vertexPositionDevice.xy);
  vec2 lineNormal = vec2(lineDirection.y, -lineDirection.x);

  gl_Position = vertexPositionClip;
  float totalLineWidth = lineWidthInPixels + uLineParams.z;
  vLineFeatherFraction = max(1e-6, uLineParams.z) / totalLineWidth;
  gl_Position.xy += lineOffset.y * (2.0 * lineOffset.x - 1.0) * lineNormal * totalLineWidth * uLineParams.xy * gl_Position.w;
  vLineCoord = lineOffset.y;
}
void emitLine(mat4 projection, vec3 vertexA, vec3 vertexB, float lineWidthInPixels) {
  emitLine(projection * vec4(vertexA, 1.0), projection * vec4(vertexB, 1.0), lineWidthInPixels);
}
`);

  builder.addFragmentCode(`
float getLineAlpha() {
  return clamp((1.0 - abs(vLineCoord)) / vLineFeatherFraction, 0.0, 1.0);
}
`);
}

export function drawLines(
    gl: WebGL2RenderingContext, linesPerInstance: number, numInstances: number) {
  drawQuads(gl, linesPerInstance, numInstances);
}

export function initializeLineShader(
    shader: ShaderProgram, projectionParameters: {width: number, height: number},
    featherWidthInPixels: number) {
  const {gl} = shader;
  gl.uniform3f(
      shader.uniform('uLineParams'), 1 / projectionParameters.width,
      1 / projectionParameters.height, featherWidthInPixels);
}
