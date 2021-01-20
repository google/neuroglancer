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

import {SingleTextureChunkFormat, SingleTextureVolumeChunk} from 'neuroglancer/sliceview/single_texture_chunk_format';
import {DataType, VolumeChunkSpecification} from 'neuroglancer/sliceview/volume/base';
import {VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {ChunkFormatHandler, registerChunkFormatHandler} from 'neuroglancer/sliceview/volume/frontend';
import {TypedArray, TypedArrayConstructor} from 'neuroglancer/util/array';
import {RefCounted} from 'neuroglancer/util/disposable';
import {Uint64} from 'neuroglancer/util/uint64';
import {GL} from 'neuroglancer/webgl/context';
import {ShaderBuilder, ShaderProgram, ShaderSamplerPrefix, ShaderSamplerType} from 'neuroglancer/webgl/shader';
import {getShaderType} from 'neuroglancer/webgl/shader_lib';
import {computeTextureFormat, setThreeDimensionalTextureData, setTwoDimensionalTextureData, TextureAccessHelper, TextureFormat} from 'neuroglancer/webgl/texture_access';

class TextureLayout extends RefCounted {
  strides: Uint32Array;
  textureShape = new Uint32Array(this.textureDims);
  constructor(gl: GL, public chunkDataSize: Uint32Array, public textureDims: number) {
    super();
    const rank = chunkDataSize.length;
    let numRemainingDims = 0;
    for (const size of chunkDataSize) {
      if (size !== 1) ++numRemainingDims;
    }
    const strides = this.strides = new Uint32Array(rank * textureDims);
    const maxTextureSize = textureDims === 3 ? gl.max3dTextureSize : gl.maxTextureSize;
    let textureDim = 0;
    let textureDimSize = 1;
    const {textureShape} = this;
    textureShape.fill(1);
    for (let chunkDim = 0; chunkDim < rank; ++chunkDim) {
      const size = chunkDataSize[chunkDim];
      if (size === 1) continue;
      const newSize = size * textureDimSize;
      let stride: number;
      if (newSize > maxTextureSize ||
          (textureDimSize !== 1 && textureDim + numRemainingDims < textureDims)) {
        ++textureDim;
        textureDimSize = size;
        stride = 1;
      } else {
        stride = textureDimSize;
        textureDimSize = newSize;
      }
      strides[textureDims * chunkDim + textureDim] = stride;
      textureShape[textureDim] = textureDimSize;
    }
  }

  static get(gl: GL, chunkSizeInVoxels: Uint32Array, textureDims: number) {
    return gl.memoize.get(
        `sliceview.UncompressedTextureLayout:${chunkSizeInVoxels.join()}:${textureDims}`,
        () => new TextureLayout(gl, chunkSizeInVoxels, textureDims));
  }
}

let tempStridesUniform = new Uint32Array(3 * 5);

export class ChunkFormat extends SingleTextureChunkFormat<TextureLayout> implements TextureFormat {
  texelsPerElement: number;
  textureInternalFormat: number;
  textureFormat: number;
  texelType: number;
  arrayElementsPerTexel: number;
  arrayConstructor: TypedArrayConstructor;
  samplerPrefix: ShaderSamplerPrefix;
  shaderSamplerType: ShaderSamplerType;
  private textureAccessHelper: TextureAccessHelper;

  static get(gl: GL, dataType: DataType, textureDims: number) {
    const key = `sliceview.UncompressedChunkFormat:${dataType}:${textureDims}`;
    return gl.memoize.get(key, () => new ChunkFormat(gl, dataType, key, textureDims));
  }

  constructor(_gl: GL, dataType: DataType, key: string, public textureDims: number) {
    super(key, dataType);
    computeTextureFormat(this, dataType);
    this.shaderSamplerType = `${this.samplerPrefix}sampler${textureDims}D` as ShaderSamplerType;
    this.textureAccessHelper = new TextureAccessHelper('chunkData', textureDims);
  }

  defineShader(builder: ShaderBuilder, numChannelDimensions: number) {
    super.defineShader(builder, numChannelDimensions);
    const {textureDims} = this;
    const textureVecType = `ivec${this.textureDims}`;
    let {textureAccessHelper} = this;
    const stridesUniformLength = (4 + numChannelDimensions) * textureDims;
    if (tempStridesUniform.length < stridesUniformLength) {
      tempStridesUniform = new Uint32Array(stridesUniformLength);
    }
    builder.addUniform(`highp ${textureVecType}`, 'uVolumeChunkStrides', 4 + numChannelDimensions);
    builder.addFragmentCode(
        textureAccessHelper.getAccessor('readVolumeData', 'uVolumeChunkSampler', this.dataType));
    const shaderType = getShaderType(this.dataType);
    let code = `
${shaderType} getDataValueAt(highp ivec3 p`;
    for (let channelDim = 0; channelDim < numChannelDimensions; ++channelDim) {
      code += `, highp int channelIndex${channelDim}`;
    }
    code += `) {
  highp ${textureVecType} offset = uVolumeChunkStrides[0]
                     + p.x * uVolumeChunkStrides[1]
                     + p.y * uVolumeChunkStrides[2]
                     + p.z * uVolumeChunkStrides[3];
`;
    for (let channelDim = 0; channelDim < numChannelDimensions; ++channelDim) {
      code += `
  offset += channelIndex${channelDim} * uVolumeChunkStrides[${4 + channelDim}];
`;
    }
    code += `
  return readVolumeData(offset);
}
`;
    builder.addFragmentCode(code);
  }

  /**
   * Called each time textureLayout changes while drawing chunks.
   */
  setupTextureLayout(
      gl: GL, shader: ShaderProgram, textureLayout: TextureLayout, fixedChunkPosition: Uint32Array,
      chunkDisplaySubspaceDimensions: readonly number[], channelDimensions: readonly number[]) {
    const stridesUniform = tempStridesUniform;
    const numChannelDimensions = channelDimensions.length;
    const {strides} = textureLayout;
    const rank = fixedChunkPosition.length;
    const {textureDims} = this;
    for (let i = 0; i < textureDims; ++i) {
      let sum = 0;
      for (let chunkDim = 0; chunkDim < rank; ++chunkDim) {
        sum += fixedChunkPosition[chunkDim] * strides[chunkDim * textureDims + i];
      }
      stridesUniform[i] = sum;
    }
    for (let i = 0; i < 3; ++i) {
      const chunkDim = chunkDisplaySubspaceDimensions[i];
      if (chunkDim >= rank) continue;
      for (let j = 0; j < textureDims; ++j) {
        stridesUniform[(i + 1) * textureDims + j] = strides[chunkDim * textureDims + j];
      }
    }
    for (let channelDim = 0; channelDim < numChannelDimensions; ++channelDim) {
      const chunkDim = channelDimensions[channelDim];
      if (chunkDim === -1) {
        stridesUniform.fill(0, (4 + channelDim) * textureDims, (4 + channelDim + 1) * textureDims);
      } else {
        for (let i = 0; i < textureDims; ++i) {
          stridesUniform[(4 + channelDim) * textureDims + i] = strides[chunkDim * textureDims + i];
        }
      }
    }
    const uniformDataSize = (4 + numChannelDimensions) * textureDims;
    if (textureDims === 3) {
      gl.uniform3iv(shader.uniform('uVolumeChunkStrides'), stridesUniform, 0, uniformDataSize);
    } else {
      gl.uniform2iv(shader.uniform('uVolumeChunkStrides'), stridesUniform, 0, uniformDataSize);
    }
  }

  getTextureLayout(gl: GL, chunkDataSize: Uint32Array) {
    return TextureLayout.get(gl, chunkDataSize, this.textureDims);
  }

  setTextureData(gl: GL, textureLayout: TextureLayout, data: TypedArray) {
    const {textureShape} = textureLayout;
    (this.textureDims === 3 ? setThreeDimensionalTextureData : setTwoDimensionalTextureData)(
        gl, this, data, textureShape[0], textureShape[1], textureShape[2]);
  }
}

interface Source extends VolumeChunkSource {
  chunkFormatHandler: UncompressedChunkFormatHandler;
}

export class UncompressedVolumeChunk extends SingleTextureVolumeChunk<Uint8Array, TextureLayout> {
  CHUNK_FORMAT_TYPE: ChunkFormat;
  source: Source;

  setTextureData(gl: GL) {
    let {source} = this;
    let {chunkFormatHandler} = source;
    let {chunkFormat} = chunkFormatHandler;

    let textureLayout: TextureLayout;
    if (this.chunkDataSize === source.spec.chunkDataSize) {
      this.textureLayout = textureLayout = chunkFormatHandler.textureLayout.addRef();
    } else {
      this.textureLayout = textureLayout = chunkFormat.getTextureLayout(gl, this.chunkDataSize);
    }

    this.chunkFormat.setTextureData(gl, textureLayout, this.data);
  }

  getValueAt(dataPosition: Uint32Array): number|Uint64 {
    let {chunkFormat} = this;
    const {chunkDataSize} = this;
    let index = 0;
    let stride = 1;
    const rank = dataPosition.length;
    for (let i = 0; i < rank; ++i) {
      index += stride * dataPosition[i];
      stride *= chunkDataSize[i];
    }
    let dataType = chunkFormat.dataType;
    let data = this.data;
    switch (dataType) {
      case DataType.UINT8:
      case DataType.INT8:
      case DataType.FLOAT32:
      case DataType.UINT16:
      case DataType.INT16:
      case DataType.UINT32:
      case DataType.INT32:
        return data[index];
      case DataType.UINT64: {
        let index2 = index * 2;
        return new Uint64(data[index2], data[index2 + 1]);
      }
    }
  }
}

export class UncompressedChunkFormatHandler extends RefCounted implements ChunkFormatHandler {
  chunkFormat: ChunkFormat;
  textureLayout: TextureLayout;

  constructor(gl: GL, spec: VolumeChunkSpecification) {
    super();
    let numDims = 0;
    for (const x of spec.chunkDataSize) {
      if (x > 1) ++numDims;
    }
    this.chunkFormat =
        this.registerDisposer(ChunkFormat.get(gl, spec.dataType, numDims >= 3 ? 3 : 2));
    this.textureLayout =
        this.registerDisposer(this.chunkFormat.getTextureLayout(gl, spec.chunkDataSize));
  }

  getChunk(source: VolumeChunkSource, x: any) {
    return new UncompressedVolumeChunk(source, x);
  }
}

registerChunkFormatHandler((gl: GL, spec: VolumeChunkSpecification) => {
  if (spec.compressedSegmentationBlockSize == null) {
    return new UncompressedChunkFormatHandler(gl, spec);
  }
  return null;
});
