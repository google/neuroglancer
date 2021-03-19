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

import {readSingleChannelValue as readSingleChannelValueUint32} from 'neuroglancer/sliceview/compressed_segmentation/decode_uint32';
import {readSingleChannelValue as readSingleChannelValueUint64} from 'neuroglancer/sliceview/compressed_segmentation/decode_uint64';
import {SingleTextureChunkFormat, SingleTextureVolumeChunk} from 'neuroglancer/sliceview/single_texture_chunk_format';
import {DataType, VolumeChunkSpecification} from 'neuroglancer/sliceview/volume/base';
import {ChunkFormatHandler, registerChunkFormatHandler} from 'neuroglancer/sliceview/volume/frontend';
import {VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {RefCounted} from 'neuroglancer/util/disposable';
import {vec3, vec3Key} from 'neuroglancer/util/geom';
import {Uint64} from 'neuroglancer/util/uint64';
import {GL} from 'neuroglancer/webgl/context';
import {ShaderBuilder, ShaderProgram, ShaderSamplerType} from 'neuroglancer/webgl/shader';
import {getShaderType, glsl_getFortranOrderIndex, glsl_uint32, glsl_uint64} from 'neuroglancer/webgl/shader_lib';
import {computeTextureFormat, OneDimensionalTextureAccessHelper, setOneDimensionalTextureData, TextureFormat} from 'neuroglancer/webgl/texture_access';

class TextureLayout extends RefCounted {
  subchunkGridSize: vec3;

  constructor(public chunkDataSize: Uint32Array, public subchunkSize: vec3) {
    super();
    const subchunkGridSize = this.subchunkGridSize = vec3.create();
    for (let i = 0; i < 3; ++i) {
      subchunkGridSize[i] = Math.ceil(chunkDataSize[i] / subchunkSize[i]);
    }
  }

  static get(gl: GL, chunkDataSize: Uint32Array, subchunkSize: vec3) {
    return gl.memoize.get(
        `sliceview.CompressedSegmentationTextureLayout:${vec3Key(chunkDataSize)},` +
            `${vec3Key(subchunkSize)}`,
        () => new TextureLayout(chunkDataSize, subchunkSize));
  }
}

const textureFormat = computeTextureFormat(new TextureFormat(), DataType.UINT32);
let tempStridesUniform = new Uint32Array(4 * 4);

export class ChunkFormat extends SingleTextureChunkFormat<TextureLayout> {
  // numChannels is the number of channels in the compressed segmentation format, which is
  // independent of the channel dimensions presented to the user.
  static get(gl: GL, dataType: DataType, subchunkSize: vec3, numChannels: number) {
    let shaderKey = `sliceview.CompressedSegmentationChunkFormat:${dataType}:${numChannels}`;
    let cacheKey = `${shaderKey}:${vec3Key(subchunkSize)}`;
    return gl.memoize.get(
        cacheKey, () => new ChunkFormat(dataType, subchunkSize, numChannels, shaderKey));
  }

  private textureAccessHelper: OneDimensionalTextureAccessHelper;

  get shaderSamplerType(): ShaderSamplerType {
    return 'usampler2D';
  }

  constructor(
      dataType: DataType, public subchunkSize: vec3, public numChannels: number, key: string) {
    super(key, dataType);
    this.textureAccessHelper = new OneDimensionalTextureAccessHelper('chunkData');
  }

  defineShader(builder: ShaderBuilder, numChannelDimensions: number) {
    super.defineShader(builder, numChannelDimensions);
    const stridesLength = 4 * (4 + numChannelDimensions);
    if (tempStridesUniform.length < stridesLength) {
      tempStridesUniform = new Uint32Array(stridesLength);
    }
    let {textureAccessHelper} = this;
    textureAccessHelper.defineShader(builder);
    let local = (x: string) => 'compressedSegmentationChunkFormat_' + x;
    builder.addUniform('highp ivec3', 'uSubchunkGridSize');
    builder.addUniform('highp ivec3', 'uSubchunkSize');
    builder.addUniform('highp ivec4', 'uVolumeChunkStrides', 4 + numChannelDimensions);
    builder.addFragmentCode(glsl_getFortranOrderIndex);
    const {dataType} = this;
    const glslType = getShaderType(dataType);

    if (dataType === DataType.UINT64) {
      builder.addFragmentCode(glsl_uint64);
    } else {
      builder.addFragmentCode(glsl_uint32);
    }
    builder.addFragmentCode(textureAccessHelper.getAccessor(
        local('readTextureValue'), 'uVolumeChunkSampler', DataType.UINT32, 1));
    let fragmentCode = `
uint ${local('getChannelOffset')}(int channelIndex) {
  if (channelIndex == 0) {
    return ${this.numChannels}u;
  }
  return ${local('readTextureValue')}(uint(channelIndex)).value;
}
${glslType} getDataValueAt(highp ivec3 p`;
    for (let channelDim = 0; channelDim < numChannelDimensions; ++channelDim) {
      fragmentCode += `, highp int channelIndex${channelDim}`;
    }
    fragmentCode += `) {
  highp ivec4 chunkPositionFull = uVolumeChunkStrides[0] +
                     + p.x * uVolumeChunkStrides[1]
                     + p.y * uVolumeChunkStrides[2]
                     + p.z * uVolumeChunkStrides[3];
`;
    for (let channelDim = 0; channelDim < numChannelDimensions; ++channelDim) {
      fragmentCode += `
  chunkPositionFull += channelIndex${channelDim} * uVolumeChunkStrides[${4 + channelDim}];
`;
    }

      fragmentCode += `
  highp ivec3 chunkPosition = chunkPositionFull.xyz;

  // TODO: maybe premultiply this and store as uniform.
  ivec3 subchunkGridPosition = chunkPosition / uSubchunkSize;
  int subchunkGridOffset = getFortranOrderIndex(subchunkGridPosition, uSubchunkGridSize);

  int channelOffset = int(${local('getChannelOffset')}(chunkPositionFull[3]));

  // TODO: Maybe just combine this offset into subchunkGridStrides.
  int subchunkHeaderOffset = subchunkGridOffset * 2 + channelOffset;

  highp uint subchunkHeader0 = ${local('readTextureValue')}(uint(subchunkHeaderOffset)).value;
  highp uint subchunkHeader1 = ${local('readTextureValue')}(uint(subchunkHeaderOffset + 1)).value;
  highp uint outputValueOffset = (subchunkHeader0 & 0xFFFFFFu) + uint(channelOffset);
  highp uint encodingBits = subchunkHeader0 >> 24u;
  if (encodingBits > 0u) {
    ivec3 subchunkPosition = chunkPosition - subchunkGridPosition * uSubchunkSize;
    int subchunkOffset = getFortranOrderIndex(subchunkPosition, uSubchunkSize);
    uint encodedValueBaseOffset = subchunkHeader1 + uint(channelOffset);
    uint encodedValueOffset = encodedValueBaseOffset + uint(subchunkOffset) * encodingBits / 32u;
    uint encodedValue = ${local('readTextureValue')}(encodedValueOffset).value;
    uint wordOffset = uint(subchunkOffset) * encodingBits % 32u;
    uint encodedValueShifted = encodedValue >> wordOffset;
    uint decodedValue = encodedValueShifted - (encodedValueShifted >> encodingBits << encodingBits);
    outputValueOffset += decodedValue * ${this.dataType === DataType.UINT64 ? '2u' : '1u'};
  }
  ${glslType} result;
`;
    if (dataType === DataType.UINT64) {
      fragmentCode += `
  result.value[0] = ${local('readTextureValue')}(outputValueOffset).value;
  result.value[1] = ${local('readTextureValue')}(outputValueOffset+1u).value;
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
   *
   * @param channelDimensions The user-specified channel dimensions, independent of the compressed
   * segmentation channels.
   */
  setupTextureLayout(
      gl: GL, shader: ShaderProgram, textureLayout: TextureLayout, fixedChunkPosition: Uint32Array,
      chunkDisplaySubspaceDimensions: readonly number[], channelDimensions: readonly number[]) {
    const {subchunkGridSize} = textureLayout;
    gl.uniform3i(
        shader.uniform('uSubchunkGridSize'), subchunkGridSize[0], subchunkGridSize[1],
        subchunkGridSize[2]);
    const stridesUniform = tempStridesUniform;
    const numChannelDimensions = channelDimensions.length;
    stridesUniform.fill(0);
    for (let i = 0; i < 3; ++i) {
      stridesUniform[i] = fixedChunkPosition[i];
      const chunkDim = chunkDisplaySubspaceDimensions[i];
      if (chunkDim === -1) continue;
      stridesUniform[4 * (i + 1) + chunkDim] = 1;
    }
    for (let channelDim = 0; channelDim < numChannelDimensions; ++channelDim) {
      const chunkDim = channelDimensions[channelDim];
      if (chunkDim === -1) continue;
      stridesUniform[4 * (4 + channelDim) + chunkDim] = 1;
    }
    gl.uniform4iv(
        shader.uniform('uVolumeChunkStrides'), stridesUniform, 0, (numChannelDimensions + 4) * 4);
  }

  setTextureData(gl: GL, textureLayout: TextureLayout, data: Uint32Array) {
    textureLayout;
    setOneDimensionalTextureData(gl, textureFormat, data);
  }

  getTextureLayout(gl: GL, chunkDataSize: Uint32Array) {
    return TextureLayout.get(gl, chunkDataSize, this.subchunkSize);
  }

  beginSource(gl: GL, shader: ShaderProgram) {
    super.beginSource(gl, shader);
    const {subchunkSize} = this;
    gl.uniform3i(
        shader.uniform('uSubchunkSize'), subchunkSize[0], subchunkSize[1], subchunkSize[2]);
  }
}

export class CompressedSegmentationVolumeChunk extends
    SingleTextureVolumeChunk<Uint32Array, TextureLayout> {
  CHUNK_FORMAT_TYPE: ChunkFormat;

  setTextureData(gl: GL) {
    let {data} = this;
    let {chunkFormat} = this;
    let textureLayout = this.textureLayout = chunkFormat.getTextureLayout(gl, this.chunkDataSize);
    chunkFormat.setTextureData(gl, textureLayout, data);
  }

  getValueAt(dataPosition: Uint32Array): Uint64|number {
    let {chunkDataSize, chunkFormat} = this;
    let {data} = this;
    let offset = data[dataPosition[3] || 0];
    if (chunkFormat.dataType === DataType.UINT64) {
      let result = new Uint64();
      readSingleChannelValueUint64(
          result, data, /*baseOffset=*/ offset, chunkDataSize, chunkFormat.subchunkSize,
          dataPosition);
      return result;
    } else {
      return readSingleChannelValueUint32(
          data, /*baseOffset=*/ offset, chunkDataSize, chunkFormat.subchunkSize, dataPosition);
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
        gl, spec.dataType, spec.compressedSegmentationBlockSize!, spec.chunkDataSize[3] || 1));
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
