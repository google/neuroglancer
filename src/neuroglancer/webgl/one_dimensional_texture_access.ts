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

/**
 * @file
 * Facilities for treating a 2-D WebGL texture as a 1-D array.
 *
 * WebGL 1.0 only supports 2-D textures, and because implementations typically limit the size of
 * each dimension, a large 1-D array has to be fit to a rectangular 2-D texture, which may require
 * padding.
 */

import {TypedArray, TypedArrayConstructor, maybePadArray} from 'neuroglancer/util/array';
import {Vec2} from 'neuroglancer/util/geom';
import {GL} from 'neuroglancer/webgl/context';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';

export interface OneDimensionalTextureLayout {
  textureWidth: number;
  textureHeight: number;
  textureAccessCoefficients: Vec2;
}

/**
 * Computes a texture layout with [width, height] equal to [x, y*z] or [x*y, z] if possible.  This
 * makes 3-d access more likely to be friendly to the texture cache.  If not possible, just uses
 * an arbitrary layout.
 */
export function compute3dTextureLayout(
    layout: OneDimensionalTextureLayout, gl: GL, texelsPerElement: number, x: number, y: number,
    z: number) {
  let {maxTextureSize} = gl;
  let dataWidth: number;
  let numElements = x * y * z;
  if (texelsPerElement * x <= maxTextureSize && y * z <= maxTextureSize) {
    // [X, YZ]
    dataWidth = x;
  } else if (texelsPerElement * x * y <= maxTextureSize && z <= maxTextureSize) {
    // [XY, Z]
    dataWidth = x * y;
  } else {
    // Use arbitrary layout.
    dataWidth = Math.ceil(numElements / maxTextureSize);
    if (dataWidth * texelsPerElement > maxTextureSize) {
      throw new Error(
          'Chunk data size exceeds maximum texture size: ' + texelsPerElement + ' * ' +
          numElements);
    }
  }
  let dataHeight = Math.ceil(numElements / dataWidth);
  layout.textureWidth = dataWidth * texelsPerElement;
  layout.textureHeight = dataHeight;
  layout.textureAccessCoefficients =
      Float32Array.of(1.0 / dataWidth, 1.0 / (dataWidth * dataHeight));
}

export function compute1dTextureLayout(
    layout: OneDimensionalTextureLayout, gl: GL, texelsPerElement: number, numElements: number) {
  let {maxTextureSize} = gl;
  let dataWidth = Math.ceil(numElements / maxTextureSize);
  if (dataWidth * texelsPerElement > maxTextureSize) {
    throw new Error(
        'Number of elements exceeds maximum texture size: ' + texelsPerElement + ' * ' +
        numElements);
  }
  let dataHeight = Math.ceil(numElements / dataWidth);
  layout.textureWidth = dataWidth * texelsPerElement;
  layout.textureHeight = dataHeight;
  layout.textureAccessCoefficients =
      Float32Array.of(1.0 / dataWidth, 1.0 / (dataWidth * dataHeight));
}

export function setOneDimensionalTextureData(
    gl: GL, textureLayout: OneDimensionalTextureLayout, data: TypedArray,
    arrayElementsPerTexel: number, textureFormat: number, texelType: number,
    arrayConstructor: TypedArrayConstructor) {
  let requiredSize =
      textureLayout.textureWidth * textureLayout.textureHeight * arrayElementsPerTexel;
  if (data.constructor !== arrayConstructor) {
    data = new arrayConstructor(
        data.buffer, data.byteOffset, data.byteLength / arrayConstructor.BYTES_PER_ELEMENT);
  }
  let padded = maybePadArray(data, requiredSize);
  gl.texImage2D(
      gl.TEXTURE_2D,
      /*level=*/0, textureFormat,
      /*width=*/textureLayout.textureWidth,
      /*height=*/textureLayout.textureHeight,
      /*border=*/0, textureFormat, texelType, padded);
}

export class OneDimensionalTextureAccessHelper {
  uniformName = `uTextureAccessCoefficients_${this.key}`;
  readTextureValue = `readTextureValue_${this.key}`;
  constructor(public key: string, public texelsPerElement: number) {}
  defineShader(builder: ShaderBuilder) {
    let {texelsPerElement, uniformName} = this;
    builder.addUniform('highp vec2', uniformName);
    let fragmentCode = `
void ${this.readTextureValue}(highp sampler2D sampler, float index`;
    for (let i = 0; i < texelsPerElement; ++i) {
      fragmentCode += `, out vec4 output${i}`;
    }
    fragmentCode += `) {
  index += ${0.5 / this.texelsPerElement};
  vec2 texCoords = vec2(fract(index * ${uniformName}.x),
                        index * ${uniformName}.y);
`;
    for (let i = 0; i < texelsPerElement; ++i) {
      fragmentCode += `
  output${i} = texture2D(sampler, vec2(texCoords.x + ${uniformName}.x * ${(i / texelsPerElement).toFixed(8)}, texCoords.y));
`;
    }
    fragmentCode += `
}
`;
    builder.addFragmentCode(fragmentCode);
  }
  setupTextureLayout(gl: GL, shader: ShaderProgram, textureLayout: OneDimensionalTextureLayout) {
    gl.uniform2fv(shader.uniform(this.uniformName), textureLayout.textureAccessCoefficients);
  }
};
