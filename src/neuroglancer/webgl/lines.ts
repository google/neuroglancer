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
import {glsl_clipLineToDepthRange} from 'neuroglancer/webgl/shader_lib';

export const VERTICES_PER_LINE = VERTICES_PER_QUAD;

export function defineLineShader(builder: ShaderBuilder, rounded = false) {
  builder.addVertexCode(glsl_getQuadVertexPosition);
  // x: 1 / viewportWidth
  // y: 1 / viewportHeight
  // z: featherWidth: Line feather width in pixels
  builder.addUniform('highp vec3', 'uLineParams');
  builder.addVarying('highp float', 'vLineCoord');
  // max(1e-6, featherWidth) / (lineWidth + featherWidth)
  builder.addVarying('highp float', 'vLineFeatherFraction');
  if (rounded) {
    // Fraction of total line length used by each endpoint.
    builder.addVarying('highp float', 'vEndpointFraction');
    builder.addVarying('highp float', 'vLineCoordT');
    // Starting point of border from [0, 1].
    builder.addVarying('highp float', 'vLineBorderStartFraction');
  }
  builder.addVertexCode(glsl_clipLineToDepthRange);
  builder.addVertexCode(`
vec2 getLineOffset() { return getQuadVertexPosition(vec2(0.0, -1.0), vec2(1.0, 1.0)); }
float getLineEndpointCoefficient() { return getLineOffset().x; }
uint getLineEndpointIndex() { return uint(getLineEndpointCoefficient()); }
void emitLine(vec4 vertexAClip, vec4 vertexBClip, float lineWidthInPixels
              ${rounded ? ', float borderWidth' : ''}) {
  if (!clipLineToDepthRange(vertexAClip, vertexBClip)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec3 vertexADevice = vertexAClip.xyz / vertexAClip.w;
  vec3 vertexBDevice = vertexBClip.xyz / vertexBClip.w;

  vec2 lineDirectionUnnormalized = vertexBDevice.xy - vertexADevice.xy;
  vec2 lineDirection;
  float linePixelLength = length(lineDirectionUnnormalized / uLineParams.xy * 0.5);

  if (linePixelLength < 1e-3) {
    lineDirection = vec2(1.0, 0.0);
    vertexADevice.z = vertexBDevice.z = 0.0;
  } else {
    lineDirection = normalize(lineDirectionUnnormalized);
  }
  vec2 lineNormal = normalize(vec2(lineDirection.y, -lineDirection.x) / uLineParams.yx * uLineParams.xy);

  vec2 lineOffset = getLineOffset();
  gl_Position = vec4(mix(vertexADevice, vertexBDevice, lineOffset.x), 1.0);
  float totalLineWidth = lineWidthInPixels + 2.0 * uLineParams.z ${rounded ? ' + 2.0 * borderWidth' : ''};
  if (lineWidthInPixels == 0.0) totalLineWidth = 0.0;
  vLineFeatherFraction = max(1e-6, uLineParams.z) / totalLineWidth;
  gl_Position.xy += (lineOffset.y * lineNormal
                     ${rounded ? '+ lineDirection * (2.0 * lineOffset.x - 1.0)' : ''})
                  * totalLineWidth * uLineParams.xy;
  vLineCoord = lineOffset.y;
  ${rounded ? 'vEndpointFraction = totalLineWidth / (linePixelLength + totalLineWidth * 2.0);' : ''}
  ${rounded ? 'vLineCoordT = lineOffset.x; vLineBorderStartFraction = lineWidthInPixels / totalLineWidth;' : ''}
}
void emitLine(mat4 projection, vec3 vertexA, vec3 vertexB, float lineWidthInPixels
              ${rounded ? ', float borderWidth' : ''}) {
  emitLine(projection * vec4(vertexA, 1.0), projection * vec4(vertexB, 1.0),
           lineWidthInPixels
           ${rounded ? ', borderWidth' : ''});
}
`);
  if (rounded) {
    builder.addFragmentCode(`
vec4 getRoundedLineColor(vec4 interiorColor, vec4 borderColor) {
  float radius;
  if (vLineCoordT < vEndpointFraction || vLineCoordT > 1.0 - vEndpointFraction) {
    radius = length(vec2(1.0 - min(vLineCoordT, 1.0 - vLineCoordT) / vEndpointFraction,
                         vLineCoord));
    if (radius > 1.0) {
      discard;
    }
  } else {
    radius = abs(vLineCoord);
  }
  float borderColorFraction = clamp((radius - vLineBorderStartFraction) / vLineFeatherFraction, 0.0, 1.0);
  float feather = clamp((1.0 - radius) / vLineFeatherFraction, 0.0, 1.0);
  vec4 color = mix(interiorColor, borderColor, borderColorFraction);
  return vec4(color.rgb, color.a * feather);
}
`);
  }

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
