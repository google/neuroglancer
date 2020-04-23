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
 * Facilities for reading various data types from 2-D and 3-D WebGL textures.
 *
 * WebGL2 only supports 2-D and 3-D textures, and because implementations typically limit the size
 * of each dimension, a large 1-D array has to be fit to a rectangular 2-D texture, which may
 * require padding.
 */

import {maybePadArray, TypedArray, TypedArrayConstructor} from 'neuroglancer/util/array';
import {DATA_TYPE_SIGNED, DataType} from 'neuroglancer/util/data_type';
import {vec3} from 'neuroglancer/util/geom';
import {GL} from 'neuroglancer/webgl/context';
import {ShaderBuilder, ShaderCodePart, ShaderSamplerPrefix} from 'neuroglancer/webgl/shader';
import {getShaderType, glsl_float, glsl_int16, glsl_int32, glsl_int8, glsl_log2Exact, glsl_uint16, glsl_uint32, glsl_uint64, glsl_uint8, glsl_unpackUint64leFromUint32} from 'neuroglancer/webgl/shader_lib';
import {setRawTexture3DParameters, setRawTextureParameters} from 'neuroglancer/webgl/texture';

export type TextureAccessCoefficients = vec3;

export class TextureFormat {
  /**
   * Number of texels per multi-channel element.
   */
  texelsPerElement: number;

  /**
   * Texture internal format to specify when uploading the texture data.
   */
  textureInternalFormat: number;

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

  samplerPrefix: ShaderSamplerPrefix;
}

export const integerTextureFormatForNumComponents = [
  -1,
  WebGL2RenderingContext.RED_INTEGER,
  WebGL2RenderingContext.RG_INTEGER,
  WebGL2RenderingContext.RGB_INTEGER,
  WebGL2RenderingContext.RGBA_INTEGER,
];
export const floatTextureFormatForNumComponents = [
  -1,
  WebGL2RenderingContext.RED,
  WebGL2RenderingContext.RG,
  WebGL2RenderingContext.RGB,
  WebGL2RenderingContext.RGBA,
];
export const textureSelectorForNumComponents = ['', 'r', 'rg', 'rgb', 'rgba'];
export const internalUint8FormatForNumComponents = [
  -1,
  WebGL2RenderingContext.R8UI,
  WebGL2RenderingContext.RG8UI,
  WebGL2RenderingContext.RGB8UI,
  WebGL2RenderingContext.RGBA8UI,
];
export const internalInt8FormatForNumComponents = [
  -1,
  WebGL2RenderingContext.R8I,
  WebGL2RenderingContext.RG8I,
  WebGL2RenderingContext.RGB8I,
  WebGL2RenderingContext.RGBA8I,
];
export const internalUint16FormatForNumComponents = [
  -1,
  WebGL2RenderingContext.R16UI,
  WebGL2RenderingContext.RG16UI,
  WebGL2RenderingContext.RGB16UI,
  WebGL2RenderingContext.RGBA16UI,
];
export const internalInt16FormatForNumComponents = [
  -1,
  WebGL2RenderingContext.R16I,
  WebGL2RenderingContext.RG16I,
  WebGL2RenderingContext.RGB16I,
  WebGL2RenderingContext.RGBA16I,
];
export const internalUint32FormatForNumComponents = [
  -1,
  WebGL2RenderingContext.R32UI,
  WebGL2RenderingContext.RG32UI,
  WebGL2RenderingContext.RGB32UI,
  WebGL2RenderingContext.RGBA32UI,
];
export const internalInt32FormatForNumComponents = [
  -1,
  WebGL2RenderingContext.R32I,
  WebGL2RenderingContext.RG32I,
  WebGL2RenderingContext.RGB32I,
  WebGL2RenderingContext.RGBA32I,
];
export const internalFloatFormatForNumComponents = [
  -1,
  WebGL2RenderingContext.R32F,
  WebGL2RenderingContext.RG32F,
  WebGL2RenderingContext.RGB32F,
  WebGL2RenderingContext.RGBA32F,
];

export function getSamplerPrefixForDataType(dataType: DataType): ShaderSamplerPrefix {
  return dataType === DataType.FLOAT32 ? '' : (DATA_TYPE_SIGNED[dataType] ? 'i' : 'u');
}

/**
 * Fills in a OneDimensionalTextureFormat object with the suitable texture format for the specified
 * DataType and number of components.
 */
export function computeTextureFormat(
    format: TextureFormat, dataType: DataType, numComponents: number = 1) {
  switch (dataType) {
    case DataType.UINT8:
      if (numComponents < 1 || numComponents > 4) {
        break;
      }
      format.texelsPerElement = 1;
      format.textureInternalFormat = internalUint8FormatForNumComponents[numComponents];
      format.textureFormat = integerTextureFormatForNumComponents[numComponents];
      format.texelType = WebGL2RenderingContext.UNSIGNED_BYTE;
      format.arrayElementsPerTexel = numComponents;
      format.arrayConstructor = Uint8Array;
      format.samplerPrefix = 'u';
      return format;
    case DataType.INT8:
      if (numComponents < 1 || numComponents > 4) {
        break;
      }
      format.texelsPerElement = 1;
      format.textureInternalFormat = internalInt8FormatForNumComponents[numComponents];
      format.textureFormat = integerTextureFormatForNumComponents[numComponents];
      format.texelType = WebGL2RenderingContext.BYTE;
      format.arrayElementsPerTexel = numComponents;
      format.arrayConstructor = Int8Array;
      format.samplerPrefix = 'i';
      return format;
    case DataType.UINT16:
      if (numComponents < 1 || numComponents > 4) {
        break;
      }
      format.texelsPerElement = 1;
      format.textureInternalFormat = internalUint16FormatForNumComponents[numComponents];
      format.textureFormat = integerTextureFormatForNumComponents[numComponents];
      format.texelType = WebGL2RenderingContext.UNSIGNED_SHORT;
      format.arrayElementsPerTexel = numComponents;
      format.arrayConstructor = Uint16Array;
      format.samplerPrefix = 'u';
      return format;
    case DataType.INT16:
      if (numComponents < 1 || numComponents > 4) {
        break;
      }
      format.texelsPerElement = 1;
      format.textureInternalFormat = internalInt16FormatForNumComponents[numComponents];
      format.textureFormat = integerTextureFormatForNumComponents[numComponents];
      format.texelType = WebGL2RenderingContext.SHORT;
      format.arrayElementsPerTexel = numComponents;
      format.arrayConstructor = Int16Array;
      format.samplerPrefix = 'i';
      return format;
    case DataType.UINT32:
      if (numComponents < 1 || numComponents > 4) {
        break;
      }
      format.texelsPerElement = 1;
      format.textureInternalFormat = internalUint32FormatForNumComponents[numComponents];
      format.textureFormat = integerTextureFormatForNumComponents[numComponents];
      format.texelType = WebGL2RenderingContext.UNSIGNED_INT;
      format.arrayElementsPerTexel = 1;
      format.arrayConstructor = Uint32Array;
      format.samplerPrefix = 'u';
      return format;
    case DataType.INT32:
      if (numComponents < 1 || numComponents > 4) {
        break;
      }
      format.texelsPerElement = 1;
      format.textureInternalFormat = internalInt32FormatForNumComponents[numComponents];
      format.textureFormat = integerTextureFormatForNumComponents[numComponents];
      format.texelType = WebGL2RenderingContext.INT;
      format.arrayElementsPerTexel = 1;
      format.arrayConstructor = Int32Array;
      format.samplerPrefix = 'i';
      return format;
    case DataType.UINT64:
      if (numComponents < 1 || numComponents > 2) {
        break;
      }
      format.texelsPerElement = 1;
      format.textureInternalFormat = internalUint32FormatForNumComponents[numComponents * 2];
      format.textureFormat = integerTextureFormatForNumComponents[numComponents * 2];
      format.texelType = WebGL2RenderingContext.UNSIGNED_INT;
      format.arrayElementsPerTexel = 2 * numComponents;
      format.arrayConstructor = Uint32Array;
      format.samplerPrefix = 'u';
      return format;
    case DataType.FLOAT32:
      if (numComponents < 1 || numComponents > 4) {
        break;
      }
      format.texelsPerElement = 1;
      format.textureInternalFormat = internalFloatFormatForNumComponents[numComponents];
      format.textureFormat = floatTextureFormatForNumComponents[numComponents];
      format.texelType = WebGL2RenderingContext.FLOAT;
      format.arrayElementsPerTexel = numComponents;
      format.arrayConstructor = Float32Array;
      format.samplerPrefix = '';
      return format;
  }
  throw new Error(`No supported texture format for ${DataType[dataType]}[${numComponents}].`);
}

export function setOneDimensionalTextureData(gl: GL, format: TextureFormat, data: TypedArray) {
  const {
    arrayConstructor,
    arrayElementsPerTexel,
    textureInternalFormat,
    textureFormat,
    texelsPerElement,
  } = format;
  const {maxTextureSize} = gl;
  const numElements = data.length / arrayElementsPerTexel;
  if (numElements * texelsPerElement > maxTextureSize * maxTextureSize) {
    throw new Error(
        'Number of elements exceeds maximum texture size: ' + texelsPerElement + ' * ' +
        numElements);
  }
  const minX = Math.ceil(numElements / maxTextureSize);
  const textureXBits = Math.ceil(Math.log2(minX));
  const textureWidth = (1 << textureXBits) * texelsPerElement;
  const textureHeight = Math.ceil(numElements / (1 << textureXBits));
  const requiredSize = textureWidth * textureHeight * arrayElementsPerTexel;
  if (data.constructor !== arrayConstructor) {
    data = new arrayConstructor(
        data.buffer, data.byteOffset, data.byteLength / arrayConstructor.BYTES_PER_ELEMENT);
  }
  let padded = maybePadArray(data, requiredSize);
  gl.pixelStorei(WebGL2RenderingContext.UNPACK_ALIGNMENT, 1);
  setRawTextureParameters(gl);
  gl.texImage2D(
      WebGL2RenderingContext.TEXTURE_2D,
      /*level=*/ 0, textureInternalFormat,
      /*width=*/ textureWidth,
      /*height=*/ textureHeight,
      /*border=*/ 0, textureFormat, format.texelType, padded);
}

export function setTwoDimensionalTextureData(
    gl: GL, format: TextureFormat, data: TypedArray, width: number, height: number) {
  const {
    arrayConstructor,
    textureInternalFormat,
    textureFormat,
    texelsPerElement,
  } = format;
  if (data.constructor !== arrayConstructor) {
    data = new arrayConstructor(
        data.buffer, data.byteOffset, data.byteLength / arrayConstructor.BYTES_PER_ELEMENT);
  }
  gl.pixelStorei(WebGL2RenderingContext.UNPACK_ALIGNMENT, 1);
  setRawTextureParameters(gl);
  gl.texImage2D(
      WebGL2RenderingContext.TEXTURE_2D,
      /*level=*/ 0, textureInternalFormat,
      /*width=*/ width * texelsPerElement,
      /*height=*/ height,
      /*border=*/ 0, textureFormat, format.texelType, data);
}

export function setThreeDimensionalTextureData(
    gl: GL, format: TextureFormat, data: TypedArray, width: number, height: number, depth: number) {
  const {
    arrayConstructor,
    textureInternalFormat,
    textureFormat,
    texelsPerElement,
  } = format;
  if (data.constructor !== arrayConstructor) {
    data = new arrayConstructor(
        data.buffer, data.byteOffset, data.byteLength / arrayConstructor.BYTES_PER_ELEMENT);
  }
  gl.pixelStorei(WebGL2RenderingContext.UNPACK_ALIGNMENT, 1);
  setRawTexture3DParameters(gl);
  gl.texImage3D(
      WebGL2RenderingContext.TEXTURE_3D,
      /*level=*/ 0, textureInternalFormat,
      /*width=*/ width * texelsPerElement,
      /*height=*/ height,
      /*depth=*/ depth,
      /*border=*/ 0, textureFormat, format.texelType, data);
}

function getShaderCodeForDataType(dataType: DataType): ShaderCodePart {
  switch (dataType) {
    case DataType.UINT8:
      return glsl_uint8;
    case DataType.INT8:
      return glsl_int8;
    case DataType.UINT16:
      return glsl_uint16;
    case DataType.INT16:
      return glsl_int16;
    case DataType.UINT32:
      return glsl_uint32;
    case DataType.INT32:
      return glsl_int32;
    case DataType.UINT64:
      return glsl_uint64;
    case DataType.FLOAT32:
      return glsl_float;
  }
}

function getAccessorFunction(
    functionName: string, readTextureValue: string, samplerName: string, indexType: string,
    dataType: DataType, numComponents: number): ShaderCodePart[] {
  const shaderType = getShaderType(dataType, numComponents);
  let parts: ShaderCodePart[] = [getShaderCodeForDataType(dataType)];
  let code = `
${shaderType} ${functionName}(${indexType} index) {
`;
  switch (dataType) {
    case DataType.UINT8:
    case DataType.UINT16:
    case DataType.UINT32:
      code += `
  ${shaderType} result;
  highp uvec4 temp;
  ${readTextureValue}(${samplerName}, index, temp);
  result.value = temp.${textureSelectorForNumComponents[numComponents]};
  return result;
`;
      break;
    case DataType.INT8:
    case DataType.INT16:
    case DataType.INT32:
      code += `
  ${shaderType} result;
  highp ivec4 temp;
  ${readTextureValue}(${samplerName}, index, temp);
  result.value = temp.${textureSelectorForNumComponents[numComponents]};
  return result;
`;
      break;
    case DataType.UINT64:
      parts.push(glsl_unpackUint64leFromUint32);
      code += `
  highp uvec4 temp;
  ${readTextureValue}(${samplerName}, index, temp);
  return unpackUint64leFromUint32(temp.${textureSelectorForNumComponents[numComponents * 2]});
`;
      break;
    case DataType.FLOAT32:
      parts.push(glsl_float);
      code += `
  highp vec4 temp;
  ${readTextureValue}(${samplerName}, index, temp);
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

export class OneDimensionalTextureAccessHelper {
  readTextureValue = `readTextureValue_${this.key}`;
  constructor(public key: string) {}
  defineShader(builder: ShaderBuilder) {
    builder;
  }

  getReadTextureValueCode(texelsPerElement: number, samplerPrefix: ShaderSamplerPrefix) {
    let code = `
void ${this.readTextureValue}(highp ${samplerPrefix}sampler2D sampler, highp uint index`;
    for (let i = 0; i < texelsPerElement; ++i) {
      code += `, out ${samplerPrefix}vec4 output${i}`;
    }
    code += `) {
  highp int width = textureSize(sampler, 0).x / ${texelsPerElement};
  highp uint log2width = log2Exact(uint(width));
  highp int y = int(index >> log2width);
  highp int x = int((index - (uint(y) << log2width)) * ${texelsPerElement}u);
`;
    for (let i = 0; i < texelsPerElement; ++i) {
      code += `
  output${i} = texelFetch(sampler, ivec2(x + ${i}, y), 0);
`;
    }
    code += `
}
`;
    return [glsl_log2Exact, code];
  }

  getAccessor(
      functionName: string, samplerName: string, dataType: DataType, numComponents: number = 1) {
    const samplerPrefix = getSamplerPrefixForDataType(dataType);
    return [
      this.getReadTextureValueCode(1, samplerPrefix),
      ...getAccessorFunction(
          functionName, this.readTextureValue, samplerName, 'highp uint', dataType, numComponents)
    ];
  }
}

export class TextureAccessHelper {
  readTextureValue = `readTextureValue_${this.key}`;
  constructor(public key: string, public textureDims: number) {}
  getReadTextureValueCode(texelsPerElement: number, samplerPrefix: ShaderSamplerPrefix) {
    const {textureDims} = this;
    let code = `
void ${this.readTextureValue}(highp ${samplerPrefix}sampler${
        this.textureDims}D sampler, highp ivec${textureDims} p`;
    for (let i = 0; i < texelsPerElement; ++i) {
      code += `, out ${samplerPrefix}vec4 output${i}`;
    }
    code += `) {
`;
    for (let i = 0; i < texelsPerElement; ++i) {
      code += `
  output${i} = texelFetch(sampler, ivec${textureDims}(p.x * ${texelsPerElement} + ${i}, p.y
                                         ${textureDims === 3 ? ', p.z' : ''}), 0);
`;
    }
    code += `
}
`;
    return code;
  }

  getAccessor(
      functionName: string, samplerName: string, dataType: DataType, numComponents: number = 1) {
    const samplerPrefix = getSamplerPrefixForDataType(dataType);
    return [
      this.getReadTextureValueCode(1, samplerPrefix),
      ...getAccessorFunction(
          functionName, this.readTextureValue, samplerName, `highp ivec${this.textureDims}`,
          dataType, numComponents)
    ];
  }
}
