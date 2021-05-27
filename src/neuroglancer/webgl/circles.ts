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
 * @file Facilities for drawing circles in WebGL as quads (triangle fan).
 */

import {drawQuads, glsl_getQuadVertexPosition, VERTICES_PER_QUAD} from 'neuroglancer/webgl/quad';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';

export const VERTICES_PER_CIRCLE = VERTICES_PER_QUAD;

export function defineCircleShader(builder: ShaderBuilder, crossSectionFade: boolean) {
  builder.addVertexCode(glsl_getQuadVertexPosition);
  // x and y components: The x and y radii of the point in normalized device coordinates.
  // z component: Starting point of border from [0, 1]..
  // w component: Fraction of total radius that is feathered.
  builder.addUniform('highp vec3', 'uCircleParams');

  // 2-D position within circle quad, ranging from [-1, -1] to [1, 1].
  builder.addVarying('highp vec4', 'vCircleCoord');
  builder.addVertexCode(`
void emitCircle(vec4 position, float diameter, float borderWidth) {
  gl_Position = position;
  float totalDiameter = diameter + 2.0 * (borderWidth + uCircleParams.z);
  if (diameter == 0.0) totalDiameter = 0.0;
  vec2 circleCornerOffset = getQuadVertexPosition(vec2(-1.0, -1.0), vec2(1.0, 1.0));
  gl_Position.xy += circleCornerOffset * uCircleParams.xy * gl_Position.w * totalDiameter;
  vCircleCoord.xy = circleCornerOffset;
  if (borderWidth == 0.0) {
    vCircleCoord.z = totalDiameter;
    vCircleCoord.w = 1e-6;
  } else {
    vCircleCoord.z = diameter / totalDiameter;
    vCircleCoord.w = uCircleParams.z / totalDiameter;
  }
}
`);
  if (crossSectionFade) {
    builder.addFragmentCode(`
float getCircleAlphaMultiplier() {
  return 1.0 - 2.0 * abs(0.5 - gl_FragCoord.z);
}
`);
  } else {
    builder.addFragmentCode(`
float getCircleAlphaMultiplier() {
  return 1.0;
}
`);
  }
  builder.addFragmentCode(`
vec4 getCircleColor(vec4 interiorColor, vec4 borderColor) {
  float radius = length(vCircleCoord.xy);
  if (radius > 1.0) {
    discard;
  }

  float borderColorFraction = clamp((radius - vCircleCoord.z) / vCircleCoord.w, 0.0, 1.0);
  float feather = clamp((1.0 - radius) / vCircleCoord.w, 0.0, 1.0);
  vec4 color = mix(interiorColor, borderColor, borderColorFraction);

  return vec4(color.rgb, color.a * feather * getCircleAlphaMultiplier());
}
`);
}

export function initializeCircleShader(
    shader: ShaderProgram, projectionParameters: {width: number, height: number},
    options: {featherWidthInPixels: number}) {
  const {gl} = shader;
  gl.uniform3f(
      shader.uniform('uCircleParams'), 1 / projectionParameters.width,
      1 / projectionParameters.height, Math.max(1e-6, options.featherWidthInPixels));
}

export function drawCircles(
    gl: WebGL2RenderingContext, circlesPerInstance: number, numInstances: number) {
  drawQuads(gl, circlesPerInstance, numInstances);
}
