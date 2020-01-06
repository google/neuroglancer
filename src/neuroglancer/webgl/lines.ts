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

import {RefCounted} from 'neuroglancer/util/disposable';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {GL} from 'neuroglancer/webgl/context';
import {QuadRenderHelper, VERTICES_PER_QUAD} from 'neuroglancer/webgl/quad';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {getSquareCornersBuffer} from 'neuroglancer/webgl/square_corners_buffer';

export const VERTICES_PER_LINE = VERTICES_PER_QUAD;

export class LineShader extends RefCounted {
  private lineOffsetsBuffer: Buffer;
  private quadHelper: QuadRenderHelper;

  constructor(gl: GL, public linesPerInstance: number = 1) {
    super();
    this.lineOffsetsBuffer = getSquareCornersBuffer(
        gl, 0, -1, 1, 1, /*minorTiles=*/ linesPerInstance, /*majorTiles=*/ 1);
    this.quadHelper = this.registerDisposer(new QuadRenderHelper(gl, linesPerInstance));
  }

  defineShader(builder: ShaderBuilder) {
    builder.addAttribute('highp vec2', 'aLineOffset');

    // x: 1 / viewportWidth
    // y: 1 / viewportHeight
    // z: featherWidth: Line feather width in pixels
    builder.addUniform('highp vec3', 'uLineParams');
    builder.addVarying('highp float', 'vLineCoord');
    // max(1e-6, featherWidth) / (lineWidth + featherWidth)
    builder.addVarying('highp float', 'vLineFeatherFraction');

    builder.addVertexCode(`
uint getLineEndpointIndex() { return uint(aLineOffset.x); }
float getLineEndpointCoefficient() { return aLineOffset.x; }
`);

    builder.addVertexCode(`
void emitLine(vec4 vertexAClip, vec4 vertexBClip, float lineWidthInPixels) {
  vec4 vertexPositionClip = mix(vertexAClip, vertexBClip, aLineOffset.x);
  vec4 otherVertexPositionClip = mix(vertexBClip, vertexAClip, aLineOffset.x);

  vec3 vertexPositionDevice = vertexPositionClip.xyz / vertexPositionClip.w;
  vec3 otherVertexPositionDevice = otherVertexPositionClip.xyz / otherVertexPositionClip.w;

  vec2 lineDirection = normalize(otherVertexPositionDevice.xy - vertexPositionDevice.xy);
  vec2 lineNormal = vec2(lineDirection.y, -lineDirection.x);

  gl_Position = vertexPositionClip;
  float totalLineWidth = lineWidthInPixels + uLineParams.z;
  vLineFeatherFraction = max(1e-6, uLineParams.z) / totalLineWidth;
  gl_Position.xy += aLineOffset.y * (2.0 * aLineOffset.x - 1.0) * lineNormal * totalLineWidth * uLineParams.xy * 0.5 * gl_Position.w;
  vLineCoord = aLineOffset.y;
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

  enable(
      shader: ShaderProgram, projectionParameters: {width: number, height: number},
      featherWidthInPixels: number) {
    const aLineOffset = shader.attribute('aLineOffset');
    this.lineOffsetsBuffer.bindToVertexAttrib(aLineOffset, /*components=*/ 2);

    const {gl} = shader;
    gl.uniform3f(
        shader.uniform('uLineParams'), 1 / projectionParameters.width,
        1 / projectionParameters.height, featherWidthInPixels);
  }

  disable(shader: ShaderProgram) {
    const aLineOffset = shader.attribute('aLineOffset');
    shader.gl.disableVertexAttribArray(aLineOffset);
  }

  draw(gl: GL, numInstances: number) {
    this.quadHelper.draw(gl, numInstances);
  }

  enableAndDraw(
      shader: ShaderProgram, projectionParameters: {width: number, height: number},
      featherWidthInPixels: number, numInstances: number) {
    this.enable(shader, projectionParameters, featherWidthInPixels);
    this.draw(shader.gl, numInstances);
    this.disable(shader);
  }
}
