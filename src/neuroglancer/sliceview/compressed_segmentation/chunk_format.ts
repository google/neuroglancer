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

import {DataType, VolumeChunkSpecification} from 'neuroglancer/sliceview/base';
import {readSingleChannelValue as readSingleChannelValueUint32} from 'neuroglancer/sliceview/compressed_segmentation/decode_uint32';
import {readSingleChannelValue as readSingleChannelValueUint64} from 'neuroglancer/sliceview/compressed_segmentation/decode_uint64';
import {ChunkFormatHandler, registerChunkFormatHandler, VolumeChunkSource} from 'neuroglancer/sliceview/frontend';
import {SingleTextureChunkFormat, SingleTextureVolumeChunk} from 'neuroglancer/sliceview/single_texture_chunk_format';
import {RefCounted} from 'neuroglancer/util/disposable';
import {vec2, vec3, vec3Key} from 'neuroglancer/util/geom';
import {Uint64} from 'neuroglancer/util/uint64';
import {GL} from 'neuroglancer/webgl/context';
import {compute1dTextureFormat, compute1dTextureLayout, OneDimensionalTextureAccessHelper, OneDimensionalTextureFormat, setOneDimensionalTextureData} from 'neuroglancer/webgl/one_dimensional_texture_access';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {getShaderType, glsl_getFortranOrderIndexFromNormalized, glsl_uint64, glsl_unnormalizeUint8, glsl_uintleToFloat} from 'neuroglancer/webgl/shader_lib';

class TextureLayout extends RefCounted {
  dataWidth: number;
  textureHeight: number;
  textureAccessCoefficients: vec2;
  subchunkGridSize: vec3;

  constructor(gl: GL, public chunkDataSize: vec3, public subchunkSize: vec3, dataLength: number) {
    super();
    compute1dTextureLayout(this, gl, /*texelsPerElement=*/1, dataLength);
    let subchunkGridSize = this.subchunkGridSize = vec3.create();
    for (let i = 0; i < 3; ++i) {
      subchunkGridSize[i] = Math.ceil(chunkDataSize[i] / subchunkSize[i]);
    }
  }

  static get(gl: GL, chunkDataSize: vec3, subchunkSize: vec3, dataLength: number) {
    return gl.memoize.get(
        `sliceview.CompressedSegmentationTextureLayout:${vec3Key(chunkDataSize)},${vec3Key(subchunkSize)},${dataLength}`,
        () => new TextureLayout(gl, chunkDataSize, subchunkSize, dataLength));
  }
}

const textureFormat = compute1dTextureFormat(new OneDimensionalTextureFormat(), DataType.UINT32);

export class ChunkFormat extends SingleTextureChunkFormat<TextureLayout> {
  static get(gl: GL, dataType: DataType, subchunkSize: vec3, numChannels: number) {
    let shaderKey = `sliceview.CompressedSegmentationChunkFormat:${dataType}:${numChannels}`;
    let cacheKey = `${shaderKey}:${vec3Key(subchunkSize)}`;
    return gl.memoize.get(
        cacheKey, () => new ChunkFormat(dataType, subchunkSize, numChannels, shaderKey));
  }

  private textureAccessHelper: OneDimensionalTextureAccessHelper;

  constructor(
      public dataType: DataType, public subchunkSize: vec3, public numChannels: number,
      key: string) {
    super(key);
    this.textureAccessHelper = new OneDimensionalTextureAccessHelper('chunkData');
  }

  defineShader(builder: ShaderBuilder) {
    super.defineShader(builder);
    let {textureAccessHelper} = this;
    textureAccessHelper.defineShader(builder);
    let local = (x: string) => 'compressedSegmentationChunkFormat_' + x;
    builder.addUniform('highp vec3', 'uSubchunkGridSize');
    builder.addUniform('highp vec3', 'uSubchunkSize');
    builder.addFragmentCode(glsl_getFortranOrderIndexFromNormalized);
    const {dataType} = this;
    const glslType = getShaderType(dataType);

    if (dataType === DataType.UINT64) {
      builder.addFragmentCode(glsl_uint64);
    }
    builder.addFragmentCode(textureAccessHelper.getAccessor(
        local('readTextureValue'), 'uVolumeChunkSampler', DataType.UINT32));
    builder.addFragmentCode(glsl_unnormalizeUint8);
    builder.addFragmentCode(glsl_uintleToFloat);

    let fragmentCode = `
float ${local('getChannelOffset')}(int channelIndex) {
  if (channelIndex == 0) {
    return ${this.numChannels}.0;
  }
  vec4 v = ${local('readTextureValue')}(float(channelIndex)).value;
  return uintleToFloat(v.xyz);
}
${glslType} getDataValue (int channelIndex) {
  vec3 chunkPosition = getPositionWithinChunk();

  // TODO: maybe premultiply this and store as uniform.
  vec3 subchunkGridPosition = floor(chunkPosition / uSubchunkSize);
  float subchunkGridOffset = getFortranOrderIndex(subchunkGridPosition, uSubchunkGridSize);

  float channelOffset = ${local('getChannelOffset')}(channelIndex);

  // TODO: Maybe just combine this offset into subchunkGridStrides.
  float subchunkHeaderOffset = subchunkGridOffset * 2.0 + channelOffset;

  vec4 subchunkHeader0 = ${local('readTextureValue')}(subchunkHeaderOffset).value;
  vec4 subchunkHeader1 = ${local('readTextureValue')}(subchunkHeaderOffset + 1.0).value;

  float outputValueOffset = uintleToFloat(subchunkHeader0.xyz) + channelOffset;
  float encodingBits = unnormalizeUint8(subchunkHeader0[3]);
  if (encodingBits > 0.0) {
    vec3 subchunkPosition = floor(min(chunkPosition - subchunkGridPosition * uSubchunkSize, uSubchunkSize - 1.0));
    float subchunkOffset = getFortranOrderIndex(subchunkPosition, uSubchunkSize);
    highp float encodedValueBaseOffset = uintleToFloat(subchunkHeader1.xyz) + channelOffset;
    highp float encodedValueOffset = floor(encodedValueBaseOffset + subchunkOffset * encodingBits / 32.0);
    vec4 encodedValue = ${local('readTextureValue')}(encodedValueOffset).value;
    float wordOffset = mod(subchunkOffset * encodingBits, 32.0);
    // If the value is in the first byte, then 0 <= wordOffset < 8.
    // We need to mod by 2**encodedBits
    float wordShifter = pow(2.0, -wordOffset);
    float encodedValueMod = pow(2.0, encodingBits);
    float encodedValueShifted;
    if (wordOffset < 16.0) {
      encodedValueShifted = dot(unnormalizeUint8(encodedValue.xy), vec2(1.0, 256.0));
    } else {
      encodedValueShifted = dot(unnormalizeUint8(encodedValue.zw), vec2(256.0 * 256.0, 256.0 * 256.0 * 256.0));
    }
    encodedValueShifted = floor(encodedValueShifted * wordShifter);
    float decodedValue = mod(encodedValueShifted, encodedValueMod);
    outputValueOffset += decodedValue * ${this.dataType === DataType.UINT64 ? '2.0' : '1.0'};
  }
  ${glslType} result;
`;
    if (dataType === DataType.UINT64) {
      fragmentCode += `
  result.low = ${local('readTextureValue')}(outputValueOffset).value;
  result.high = ${local('readTextureValue')}(outputValueOffset+1.0).value;
`;
    } else {
      fragmentCode += `
  result.value = ${local('readTextureValue')}(outputValueOffset).value;
`;
    }
    fragmentCode += `
  return result;
}
`;
    builder.addFragmentCode(fragmentCode);
  }

  /**
   * Called each time textureLayout changes while drawing chunks.
   */
  setupTextureLayout(gl: GL, shader: ShaderProgram, textureLayout: TextureLayout) {
    gl.uniform3fv(shader.uniform('uSubchunkGridSize'), textureLayout.subchunkGridSize);
    this.textureAccessHelper.setupTextureLayout(gl, shader, textureLayout);
  }

  setTextureData(gl: GL, textureLayout: TextureLayout, data: Uint32Array) {
    setOneDimensionalTextureData(gl, textureLayout, textureFormat, data);
  }

  getTextureLayout(gl: GL, chunkDataSize: vec3, dataLength: number) {
    return TextureLayout.get(gl, chunkDataSize, this.subchunkSize, dataLength);
  }

  beginSource(gl: GL, shader: ShaderProgram) {
    super.beginSource(gl, shader);
    gl.uniform3fv(shader.uniform('uSubchunkSize'), this.subchunkSize);
  }
}

export class CompressedSegmentationVolumeChunk extends
    SingleTextureVolumeChunk<Uint32Array, TextureLayout> {
  chunkFormat: ChunkFormat;

  setTextureData(gl: GL) {
    let {data} = this;
    let {chunkFormat} = this;
    let textureLayout = this.textureLayout =
        chunkFormat.getTextureLayout(gl, this.chunkDataSize, data.length);
    chunkFormat.setTextureData(gl, textureLayout, data);
  }

  getChannelValueAt(dataPosition: vec3, channel: number): Uint64|number {
    let {chunkDataSize, chunkFormat} = this;
    let {data} = this;
    let offset = data[channel];
    if (chunkFormat.dataType === DataType.UINT64) {
      let result = new Uint64();
      readSingleChannelValueUint64(
          result, data, /*baseOffset=*/offset, chunkDataSize, chunkFormat.subchunkSize,
          dataPosition);
      return result;
    } else {
      return readSingleChannelValueUint32(
          data, /*baseOffset=*/offset, chunkDataSize, chunkFormat.subchunkSize, dataPosition);
    }
  }
}

export class CompressedSegmentationChunkFormatHandler extends RefCounted implements
    ChunkFormatHandler {
  chunkFormat: ChunkFormat;

  constructor(gl: GL, spec: VolumeChunkSpecification) {
    super();
    let {dataType} = spec;
    if (dataType !== DataType.UINT64 && dataType !== DataType.UINT32) {
      throw new Error(`Unsupported compressed segmentation data type: ${DataType[dataType]}`);
    }
    this.chunkFormat = this.registerDisposer(ChunkFormat.get(
        gl, spec.dataType, spec.compressedSegmentationBlockSize!, spec.numChannels));
  }

  getChunk(source: VolumeChunkSource, x: any) {
    return new CompressedSegmentationVolumeChunk(source, x);
  }
}

registerChunkFormatHandler((gl: GL, spec: VolumeChunkSpecification) => {
  if (spec.compressedSegmentationBlockSize != null) {
    return new CompressedSegmentationChunkFormatHandler(gl, spec);
  }
  return null;
});
