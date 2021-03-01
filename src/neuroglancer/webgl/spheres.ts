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
 * @file Facilities for drawing spheres in WebGL
 */

import {RefCounted} from 'neuroglancer/util/disposable';
import {Buffer, getMemoizedBuffer} from 'neuroglancer/webgl/buffer';
import {GL} from 'neuroglancer/webgl/context';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';

export function getSphereVertexArray(latitudeBands: number, longitudeBands: number) {
  const result = new Float32Array((latitudeBands + 1) * (longitudeBands + 1) * 3);
  let i = 0;
  for (let latIndex = 0; latIndex <= latitudeBands; ++latIndex) {
    const theta = latIndex * Math.PI / latitudeBands;
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);
    for (let lonIndex = 0; lonIndex <= longitudeBands; ++lonIndex) {
      const phi = lonIndex * 2 * Math.PI / longitudeBands;
      const sinPhi = Math.sin(phi);
      const cosPhi = Math.cos(phi);
      result[i++] = cosPhi * sinTheta;  // x
      result[i++] = cosTheta;           // y
      result[i++] = sinPhi * sinTheta;  // z
    }
  }
  return result;
}

export function getSphereIndexArray(latitudeBands: number, longitudeBands: number) {
  const result = new Uint16Array(latitudeBands * longitudeBands * 6);
  let i = 0;
  for (let latIndex = 0; latIndex < latitudeBands; latIndex++) {
    for (let lonIndex = 0; lonIndex < longitudeBands; lonIndex++) {
      const first = (latIndex * (longitudeBands + 1)) + lonIndex;
      const second = first + longitudeBands + 1;
      result[i++] = first;
      result[i++] = second;
      result[i++] = first + 1;

      result[i++] = second;
      result[i++] = second + 1;
      result[i++] = first + 1;
    }
  }
  return result;
}

export class SphereRenderHelper extends RefCounted {
  private vertexBuffer: Buffer;
  private indexBuffer: Buffer;
  private numIndices: number;

  constructor(gl: GL, latitudeBands: number, longitudeBands: number) {
    super();
    this.vertexBuffer =
        this.registerDisposer(getMemoizedBuffer(
                                  gl, WebGL2RenderingContext.ARRAY_BUFFER, getSphereVertexArray,
                                  latitudeBands, longitudeBands))
            .value;
    this.indexBuffer =
        this.registerDisposer(getMemoizedBuffer(
                                  gl, WebGL2RenderingContext.ELEMENT_ARRAY_BUFFER,
                                  getSphereIndexArray, latitudeBands, longitudeBands))
            .value;
    this.numIndices = latitudeBands * longitudeBands * 6;
  }

  defineShader(builder: ShaderBuilder) {
    builder.addAttribute('highp vec3', 'aSphereVertex');
    builder.addVarying('highp float', 'vLightingFactor');

    // projectionMatrix = cameraMatrix * modelViewMat
    // normalTransformMatrix = (modelViewMat^{-1})^T

    // eff modelViewMat = modelViewMat * scalMat(radii)
    // normalTransformMatrix =  (modelViewMat * scalMat)^{-1}^T
    // =   (scalMat^{-1} * modelViewMat^{-1})^T
    // =   modelViewMat^{-1}^T * (scalMat^{-1})^T
    builder.addVertexCode(`
void emitSphere(mat4 projectionMatrix, mat4 normalTransformMatrix, vec3 centerPosition, vec3 radii, vec4 lightDirection) {
  vec3 vertexPosition = aSphereVertex * radii + centerPosition;
  gl_Position = projectionMatrix * vec4(vertexPosition, 1.0);
  vec3 normal = normalize((normalTransformMatrix * vec4(aSphereVertex / max(radii, 1e-6), 0.0)).xyz);
  vLightingFactor = abs(dot(normal, uLightDirection.xyz)) + uLightDirection.w;
}
`);
  }

  draw(shader: ShaderProgram, numInstances: number) {
    const aSphereVertex = shader.attribute('aSphereVertex');
    this.vertexBuffer.bindToVertexAttrib(
        aSphereVertex, /*components=*/3, /*attributeType=*/WebGL2RenderingContext.FLOAT,
        /*normalized=*/false);
    this.indexBuffer.bind();
    shader.gl.drawElementsInstanced(
        WebGL2RenderingContext.TRIANGLES, this.numIndices, WebGL2RenderingContext.UNSIGNED_SHORT,
        /*offset=*/0, numInstances);
    shader.gl.disableVertexAttribArray(aSphereVertex);
  }
}
