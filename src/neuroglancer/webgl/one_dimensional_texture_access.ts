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

import {maybePadArray, TypedArray, TypedArrayConstructor} from 'neuroglancer/util/array';
import {DataType} from 'neuroglancer/util/data_type';
import {vec2} from 'neuroglancer/util/geom';
import {GL_FLOAT, GL_LUMINANCE, GL_LUMINANCE_ALPHA, GL_RGB, GL_RGBA, GL_UNPACK_ALIGNMENT, GL_UNSIGNED_BYTE} from 'neuroglancer/webgl/constants';
import {GL} from 'neuroglancer/webgl/context';
import {ShaderBuilder, ShaderCodePart, ShaderProgram} from 'neuroglancer/webgl/shader';
import {getShaderType, glsl_float, glsl_uint16, glsl_uint32, glsl_uint64, glsl_uint8} from 'neuroglancer/webgl/shader_lib';
import {setRawTextureParameters} from 'neuroglancer/webgl/texture';

export class OneDimensionalTextureLayout {
  dataWidth: number;
  textureHeight: number;
  textureAccessCoefficients: vec2;
}

export class OneDimensionalTextureFormat {
  /**
   * Number of texels per multi-channel element.
   */
  texelsPerElement: number;

  /**
   * Texture format to specify when uploading the texture data.
   */
  textureFormat: number;

  /**
   * Texel type to specify when uploading the texture data.
   */
  texelType: number;

  /**
   * Number of typed array elements per texel.
   */
  arrayElementsPerTexel: number;

  /**
   * TypedArray type that must be used when uploading the texture data.
   */
  arrayConstructor: TypedArrayConstructor;
}

export const textureFormatForNumComponents =
    [-1, GL_LUMINANCE, GL_LUMINANCE_ALPHA, GL_RGB, GL_RGBA];
export const textureSelectorForNumComponents = ['', 'r', 'ra', 'rgb', 'rgba'];

/**
 * Fills in a OneDimensionalTextureFormat object with the suitable texture format for the specified
 * DataType and number of components.
 */
export function compute1dTextureFormat(
    format: OneDimensionalTextureFormat, dataType: DataType, numComponents: number = 1) {
  switch (dataType) {
    case DataType.UINT8:
      if (numComponents < 1 || numComponents > 4) {
        break;
      }
      format.texelsPerElement = 1;
      format.textureFormat = textureFormatForNumComponents[numComponents];
      format.texelType = GL_UNSIGNED_BYTE;
      format.arrayElementsPerTexel = numComponents;
      format.arrayConstructor = Uint8Array;
      return format;
    case DataType.UINT16:
      if (numComponents < 1 || numComponents > 2) {
        break;
      }
      format.texelsPerElement = 1;
      format.textureFormat = textureFormatForNumComponents[numComponents * 2];
      format.texelType = GL_UNSIGNED_BYTE;
      format.arrayElementsPerTexel = 2 * numComponents;
      format.arrayConstructor = Uint8Array;
      return format;
    case DataType.UINT64:
      if (numComponents !== 1) {
        break;
      }
      format.texelsPerElement = 2;
      format.textureFormat = GL_RGBA;
      format.texelType = GL_UNSIGNED_BYTE;
      format.arrayElementsPerTexel = 4;
      format.arrayConstructor = Uint8Array;
      return format;
    case DataType.UINT32:
      if (numComponents !== 1) {
        break;
      }
      format.texelsPerElement = 1;
      format.textureFormat = GL_RGBA;
      format.texelType = GL_UNSIGNED_BYTE;
      format.arrayElementsPerTexel = 4;
      format.arrayConstructor = Uint8Array;
      return format;
    case DataType.FLOAT32:
      if (numComponents < 1 || numComponents > 4) {
        break;
      }
      format.texelsPerElement = 1;
      format.textureFormat = textureFormatForNumComponents[numComponents];
      format.texelType = GL_FLOAT;
      format.arrayElementsPerTexel = numComponents;
      format.arrayConstructor = Float32Array;
      return format;
  }
  throw new Error(`No supported texture format for ${DataType[dataType]}[${numComponents}].`);
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
  layout.dataWidth = dataWidth;
  layout.textureHeight = dataHeight;
  layout.textureAccessCoefficients =
      <vec2>Float32Array.of(1.0 / dataWidth, 1.0 / (dataWidth * dataHeight));
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
  layout.dataWidth = dataWidth;
  layout.textureHeight = dataHeight;
  layout.textureAccessCoefficients =
      <vec2>Float32Array.of(1.0 / dataWidth, 1.0 / (dataWidth * dataHeight));
}

export function setOneDimensionalTextureData(
    gl: GL, textureLayout: OneDimensionalTextureLayout, format: OneDimensionalTextureFormat,
    data: TypedArray) {
  const {arrayConstructor, arrayElementsPerTexel, textureFormat, texelsPerElement} = format;
  const {dataWidth, textureHeight} = textureLayout;
  const requiredSize = dataWidth * textureHeight * arrayElementsPerTexel * texelsPerElement;
  if (data.constructor !== arrayConstructor) {
    data = new arrayConstructor(
        data.buffer, data.byteOffset, data.byteLength / arrayConstructor.BYTES_PER_ELEMENT);
  }
  let padded = maybePadArray(data, requiredSize);
  gl.pixelStorei(GL_UNPACK_ALIGNMENT, 1);
  setRawTextureParameters(gl);
  gl.texImage2D(
      gl.TEXTURE_2D,
      /*level=*/0, textureFormat,
      /*width=*/dataWidth * texelsPerElement,
      /*height=*/textureHeight,
      /*border=*/0, textureFormat, format.texelType, padded);
}

export class OneDimensionalTextureAccessHelper {
  uniformName = `uTextureAccessCoefficients_${this.key}`;
  readTextureValue = `readTextureValue_${this.key}`;
  constructor(public key: string) {}
  defineShader(builder: ShaderBuilder) {
    let {uniformName} = this;
    builder.addUniform('highp vec2', uniformName);
  }

  getReadTextureValueCode(texelsPerElement: number) {
    let {uniformName} = this;
    let code = `
void ${this.readTextureValue}(highp sampler2D sampler, float index`;
    for (let i = 0; i < texelsPerElement; ++i) {
      code += `, out vec4 output${i}`;
    }
    code += `) {
  index += ${0.5 / texelsPerElement};
  vec2 texCoords = vec2(fract(index * ${uniformName}.x),
                        index * ${uniformName}.y);
`;
    for (let i = 0; i < texelsPerElement; ++i) {
      code += `
  output${i} = texture2D(sampler, vec2(texCoords.x + ${uniformName}.x * ${(i / texelsPerElement).toFixed(8)}, texCoords.y));
`;
    }
    code += `
}
`;
    return code;
  }

  getAccessor(
      functionName: string, samplerName: string, dataType: DataType, numComponents: number = 1) {
    const shaderType = getShaderType(dataType, numComponents);
    let parts: ShaderCodePart[] = [];
    let texelsPerElement = dataType === DataType.UINT64 ? 2 : 1;
    parts.push(this.getReadTextureValueCode(texelsPerElement));
    let code = `
${shaderType} ${functionName}(float index) {
`;
    switch (dataType) {
      case DataType.UINT8:
        parts.push(glsl_uint8);
        code += `
  ${shaderType} result;
  vec4 temp;
  ${this.readTextureValue}(${samplerName}, index, temp);
  result.value = temp.${textureSelectorForNumComponents[numComponents]};
  return result;
`;
        break;
      case DataType.UINT16:
        parts.push(glsl_uint16);
        code += `
  ${shaderType} result;
  vec4 temp;
  ${this.readTextureValue}(${samplerName}, index, temp);
  result.value = temp.${textureSelectorForNumComponents[numComponents * 2]};
  return result;
`;
        break;
      case DataType.UINT32:
        parts.push(glsl_uint32);
        code += `
  ${shaderType} result;
  ${this.readTextureValue}(${samplerName}, index, result.value);
  return result;
`;
        break;
      case DataType.UINT64:
        parts.push(glsl_uint64);
        code += `
  ${shaderType} result;
  ${this.readTextureValue}(${samplerName}, index, result.low, result.high);
  return result;
`;
        break;
      case DataType.FLOAT32:
        parts.push(glsl_float);
        code += `
  vec4 temp;
  ${this.readTextureValue}(${samplerName}, index, temp);
  return temp.${textureSelectorForNumComponents[numComponents]};
`;
        break;
    }
    code += `
}
`;
    parts.push(code);
    return parts;
  }

  setupTextureLayout(gl: GL, shader: ShaderProgram, textureLayout: OneDimensionalTextureLayout) {
    gl.uniform2fv(shader.uniform(this.uniformName), textureLayout.textureAccessCoefficients);
  }
}
