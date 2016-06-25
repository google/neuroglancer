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
import {ChunkFormatHandler, VolumeChunkSource, registerChunkFormatHandler} from 'neuroglancer/sliceview/frontend';
import {SingleTextureChunkFormat, SingleTextureVolumeChunk} from 'neuroglancer/sliceview/single_texture_chunk_format';
import {TypedArray, TypedArrayConstructor} from 'neuroglancer/util/array';
import {RefCounted} from 'neuroglancer/util/disposable';
import {Vec3, vec3Key} from 'neuroglancer/util/geom';
import {Uint64} from 'neuroglancer/util/uint64';
import {GL} from 'neuroglancer/webgl/context';
import {OneDimensionalTextureAccessHelper, compute3dTextureLayout, setOneDimensionalTextureData} from 'neuroglancer/webgl/one_dimensional_texture_access';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {glsl_float, glsl_uint16, glsl_uint32, glsl_uint64, glsl_uint8} from 'neuroglancer/webgl/shader_lib';

class TextureLayout extends RefCounted {
  textureWidth: number;
  textureHeight: number;
  textureAccessCoefficients: Float32Array;
  channelStride: number;

  constructor(gl: GL, public chunkDataSize: Vec3, texelsPerElement: number, numChannels: number) {
    super();
    const dataPointsPerChannel = chunkDataSize[0] * chunkDataSize[1] * chunkDataSize[2];
    this.channelStride = dataPointsPerChannel;
    compute3dTextureLayout(
        this, gl, texelsPerElement, chunkDataSize[0], chunkDataSize[1],
        chunkDataSize[2] * numChannels);
  }

  static get(gl: GL, chunkDataSize: Vec3, texelsPerElement: number, numChannels: number) {
    return gl.memoize.get(
        `sliceview.UncompressedTextureLayout:${vec3Key(chunkDataSize)},${texelsPerElement},${numChannels}`,
        () => new TextureLayout(gl, chunkDataSize, texelsPerElement, numChannels));
  }
};

export class ChunkFormat extends SingleTextureChunkFormat<TextureLayout> {
  texelsPerElement: number;
  textureFormat: number;
  texelType: number;
  arrayElementsPerTexel: number;
  arrayConstructor: TypedArrayConstructor;
  private textureAccessHelper: OneDimensionalTextureAccessHelper;

  static get(gl: GL, dataType: DataType, numChannels: number) {
    let key = `sliceview.UncompressedChunkFormat:${dataType}:${numChannels}`;
    return gl.memoize.get(key, () => new ChunkFormat(gl, dataType, numChannels, key));
  }

  constructor(gl: GL, public dataType: DataType, public numChannels: number, key: string) {
    super(key);
    switch (dataType) {
      case DataType.UINT8:
        this.texelsPerElement = 1;
        this.textureFormat = gl.LUMINANCE;
        this.texelType = gl.UNSIGNED_BYTE;
        this.arrayElementsPerTexel = 1;
        this.arrayConstructor = Uint8Array;
        break;
      case DataType.UINT16:
        this.texelsPerElement = 1;
        this.textureFormat = gl.LUMINANCE_ALPHA;
        this.texelType = gl.UNSIGNED_BYTE;
        this.arrayElementsPerTexel = 2;
        this.arrayConstructor = Uint8Array;
        break;
      case DataType.UINT64:
        this.texelsPerElement = 2;
        this.textureFormat = gl.RGBA;
        this.texelType = gl.UNSIGNED_BYTE;
        this.arrayElementsPerTexel = 4;
        this.arrayConstructor = Uint8Array;
        break;
      case DataType.UINT32:
        this.texelsPerElement = 1;
        this.textureFormat = gl.RGBA;
        this.texelType = gl.UNSIGNED_BYTE;
        this.arrayElementsPerTexel = 4;
        this.arrayConstructor = Uint8Array;
        break;
      case DataType.FLOAT32:
        this.texelsPerElement = 1;
        this.textureFormat = gl.LUMINANCE;
        this.texelType = gl.FLOAT;
        this.arrayElementsPerTexel = 1;
        this.arrayConstructor = Float32Array;
        break;
      default:
        throw new Error('Unsupported dataType: ' + dataType);
    }
    this.textureAccessHelper =
        new OneDimensionalTextureAccessHelper('chunkData', this.texelsPerElement);
  }

  defineShader(builder: ShaderBuilder) {
    super.defineShader(builder);
    this.textureAccessHelper.defineShader(builder);

    let {numChannels} = this;
    if (numChannels > 1) {
      builder.addUniform('highp float', 'uChannelStride');
      builder.addFragmentCode(`
float getChannelOffset(int channelIndex) {
  return float(channelIndex) * uChannelStride;
}
`);
    } else {
      builder.addFragmentCode(`float getChannelOffset(int channelIndex) { return 0.0; }`);
    }

    builder.addFragmentCode(`
float getIndexIntoChunk (int channelIndex) {
  vec3 chunkDataPosition = getPositionWithinChunk();
  return chunkDataPosition.x + uChunkDataSize.x * (chunkDataPosition.y + uChunkDataSize.y * chunkDataPosition.z) + getChannelOffset(channelIndex);
}
`);
    switch (this.dataType) {
      case DataType.UINT8:
        builder.addFragmentCode(glsl_uint8);
        builder.addFragmentCode(`
uint8_t getDataValue (int channelIndex) {
  uint8_t result;
  vec4 temp;
  ${this.textureAccessHelper.readTextureValue}(uVolumeChunkSampler, getIndexIntoChunk(channelIndex), temp);
  result.value = temp.x;
  return result;
}
`);
        break;
      case DataType.FLOAT32:
        builder.addFragmentCode(glsl_float);
        builder.addFragmentCode(`
float getDataValue (int channelIndex) {
  vec4 temp;
  ${this.textureAccessHelper.readTextureValue}(uVolumeChunkSampler, getIndexIntoChunk(channelIndex), temp);
  return temp.x;
}
`);
        break;
      case DataType.UINT16:
        builder.addFragmentCode(glsl_uint16);
        builder.addFragmentCode(`
uint16_t getDataValue (int channelIndex) {
  uint16_t result;
  vec4 temp;
  ${this.textureAccessHelper.readTextureValue}(uVolumeChunkSampler, getIndexIntoChunk(channelIndex), temp);
  result.value = temp.xw;
  return result;
}
`);
        break;
      case DataType.UINT32:
        builder.addFragmentCode(glsl_uint32);
        builder.addFragmentCode(`
uint32_t getDataValue (int channelIndex) {
  uint32_t result;
  ${this.textureAccessHelper.readTextureValue}(uVolumeChunkSampler, getIndexIntoChunk(channelIndex), result.value);
  return result;
}
`);
        break;
      case DataType.UINT64:
        builder.addFragmentCode(glsl_uint64);
        builder.addFragmentCode(`
uint64_t getDataValue (int channelIndex) {
  uint64_t result;
  ${this.textureAccessHelper.readTextureValue}(uVolumeChunkSampler, getIndexIntoChunk(channelIndex), result.low, result.high);
  return result;
}
`);
        break;
    }
  }

  /**
   * Called each time textureLayout changes while drawing chunks.
   */
  setupTextureLayout(gl: GL, shader: ShaderProgram, textureLayout: TextureLayout) {
    if (this.numChannels > 1) {
      gl.uniform1f(shader.uniform('uChannelStride'), textureLayout.channelStride);
    }
    this.textureAccessHelper.setupTextureLayout(gl, shader, textureLayout);
  }

  getTextureLayout(gl: GL, chunkDataSize: Vec3) {
    return TextureLayout.get(gl, chunkDataSize, this.texelsPerElement, this.numChannels);
  }

  setTextureData(gl: GL, textureLayout: TextureLayout, data: TypedArray) {
    setOneDimensionalTextureData(
        gl, textureLayout, data, this.arrayElementsPerTexel, this.textureFormat, this.texelType,
        this.arrayConstructor);
  }
};

interface Source extends VolumeChunkSource {
  chunkFormatHandler: UncompressedChunkFormatHandler;
}

export class UncompressedVolumeChunk extends SingleTextureVolumeChunk<Uint8Array, TextureLayout> {
  chunkFormat: ChunkFormat;
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

  getChannelValueAt(dataPosition: Vec3, channel: number): number|Uint64 {
    let {chunkFormat} = this;
    let chunkDataSize = this.chunkDataSize;
    let index = dataPosition[0] +
        chunkDataSize[0] *
            (dataPosition[1] + chunkDataSize[1] * (dataPosition[2] + chunkDataSize[2] * channel));
    let dataType = chunkFormat.dataType;
    let data = this.data;
    switch (dataType) {
      case DataType.UINT8:
      case DataType.FLOAT32:
      case DataType.UINT16:
      case DataType.UINT32:
        return data[index];
      case DataType.UINT64: {
        let index2 = index * 2;
        return new Uint64(data[index2], data[index2 + 1]);
      }
    }
    throw new Error('Invalid data type: ' + dataType);
  }
};

export class UncompressedChunkFormatHandler extends RefCounted implements ChunkFormatHandler {
  chunkFormat: ChunkFormat;
  textureLayout: TextureLayout;

  constructor(gl: GL, spec: VolumeChunkSpecification) {
    super();
    this.chunkFormat = this.registerDisposer(ChunkFormat.get(gl, spec.dataType, spec.numChannels));
    this.textureLayout =
        this.registerDisposer(this.chunkFormat.getTextureLayout(gl, spec.chunkDataSize));
  }

  getChunk(source: VolumeChunkSource, x: any) { return new UncompressedVolumeChunk(source, x); }
};

registerChunkFormatHandler((gl: GL, spec: VolumeChunkSpecification) => {
  if (spec.compressedSegmentationBlockSize == null) {
    return new UncompressedChunkFormatHandler(gl, spec);
  }
  return null;
});
