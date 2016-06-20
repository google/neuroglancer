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
import {TypedArray, TypedArrayConstructor, maybePadArray} from 'neuroglancer/util/array';
import {RefCounted} from 'neuroglancer/util/disposable';
import {Vec3, vec3Key} from 'neuroglancer/util/geom';
import {Uint64} from 'neuroglancer/util/uint64';
import {GL} from 'neuroglancer/webgl/context';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {glsl_float, glsl_uint16, glsl_uint32, glsl_uint64, glsl_uint8} from 'neuroglancer/webgl/shader_lib';

class TextureLayout extends RefCounted {
  textureWidth: number;
  textureHeight: number;
  textureAccessCoefficients: Float32Array;
  channelStride: number;

  constructor(gl: GL, public chunkDataSize: Vec3, texelsPerElement: number, numChannels: number) {
    super();
    let {maxTextureSize} = gl;

    const dataPointsPerChannel = chunkDataSize[0] * chunkDataSize[1] * chunkDataSize[2];

    this.channelStride = dataPointsPerChannel;

    let numDataPoints = dataPointsPerChannel * numChannels;
    let dataWidth: number;

    this.chunkDataSize = chunkDataSize;

    if (texelsPerElement * chunkDataSize[0] <= maxTextureSize &&
        chunkDataSize[1] * chunkDataSize[2] * numChannels <= maxTextureSize) {
      // [X, YZ]
      dataWidth = chunkDataSize[0];
    } else if (
        texelsPerElement * chunkDataSize[0] * chunkDataSize[1] <= maxTextureSize &&
        chunkDataSize[2] * numChannels <= maxTextureSize) {
      // [XY, Z]
      dataWidth = chunkDataSize[0] * chunkDataSize[1];
    } else {
      // Use arbitrary layout.
      dataWidth = Math.ceil(numDataPoints / maxTextureSize);
      if (dataWidth * texelsPerElement > maxTextureSize) {
        throw new Error(
            'Chunk data size exceeds maximum texture size: ' + texelsPerElement + ' * ' +
            numDataPoints);
      }
    }
    let dataHeight = Math.ceil(numDataPoints / dataWidth);
    this.textureWidth = dataWidth * texelsPerElement;
    this.textureHeight = dataHeight;
    this.textureAccessCoefficients =
        Float32Array.of(1.0 / dataWidth, 1.0 / (dataWidth * dataHeight));
  }

  static get(gl: GL, chunkDataSize: Vec3, texelsPerElement: number, numChannels: number) {
    return gl.memoize.get(
        `sliceview.UncompressedTextureLayout:${vec3Key(chunkDataSize)},${texelsPerElement},${numChannels}`,
        () => new TextureLayout(gl, chunkDataSize, texelsPerElement, numChannels));
  }
};

class ChunkFormat extends SingleTextureChunkFormat<TextureLayout> {
  texelsPerElement: number;
  textureFormat: number;
  texelType: number;
  arrayElementsPerTexel: number;
  arrayConstructor: TypedArrayConstructor;

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
  }

  defineShader(builder: ShaderBuilder) {
    super.defineShader(builder);
    builder.addUniform('highp vec3', 'uChunkDataSize');

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

    // [ 1.0/dataPointsPerTextureWidth, 1.0/numDataPoints ]
    builder.addUniform('highp vec2', 'uUncompressedTextureAccessCoefficients');
    builder.addFragmentCode(`
vec3 getPositionWithinChunk () {
  return floor(min(vChunkPosition * uChunkDataSize, uChunkDataSize - 1.0));
}
vec2 getDataTextureCoords (int channelIndex) {
  vec3 chunkDataPosition = getPositionWithinChunk();
  float offset = chunkDataPosition.x + uChunkDataSize.x * (chunkDataPosition.y + uChunkDataSize.y * chunkDataPosition.z) + getChannelOffset(channelIndex);
  return vec2(fract(offset * uUncompressedTextureAccessCoefficients.x),
              offset * uUncompressedTextureAccessCoefficients.y);
}
`);
    switch (this.dataType) {
      case DataType.UINT8:
        builder.addFragmentCode(glsl_uint8);
        builder.addFragmentCode(`
uint8_t getDataValue (int channelIndex) {
  uint8_t result;
  result.value = texture2D(uVolumeChunkSampler, getDataTextureCoords(channelIndex)).x;
  return result;
}
`);
        break;
      case DataType.FLOAT32:
        builder.addFragmentCode(glsl_float);
        builder.addFragmentCode(`
float getDataValue (int channelIndex) {
  return texture2D(uVolumeChunkSampler, getDataTextureCoords(channelIndex)).x;
}
`);
        break;
      case DataType.UINT16:
        builder.addFragmentCode(glsl_uint16);
        builder.addFragmentCode(`
uint16_t getDataValue (int channelIndex) {
  uint16_t result;
  vec2 texCoords = getDataTextureCoords(channelIndex);
  result.value = texture2D(uVolumeChunkSampler, texCoords).xw;
  return result;
}
`);
        break;
      case DataType.UINT32:
        builder.addFragmentCode(glsl_uint32);
        builder.addFragmentCode(`
uint32_t getDataValue (int channelIndex) {
  uint32_t result;
  vec2 texCoords = getDataTextureCoords(channelIndex);
  result.value = texture2D(uVolumeChunkSampler, texCoords);
  return result;
}
`);
        break;
      case DataType.UINT64:
        builder.addFragmentCode(glsl_uint64);
        builder.addFragmentCode(`
uint64_t getDataValue (int channelIndex) {
  uint64_t value;
  vec2 texCoords = getDataTextureCoords(channelIndex);
  value.low = texture2D(uVolumeChunkSampler, texCoords);
  value.high = texture2D(uVolumeChunkSampler, vec2(texCoords.x + 0.5 * uUncompressedTextureAccessCoefficients.x, texCoords.y));
  return value;
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
    gl.uniform3fv(shader.uniform('uChunkDataSize'), textureLayout.chunkDataSize);
    gl.uniform2fv(
        shader.uniform('uUncompressedTextureAccessCoefficients'),
        textureLayout.textureAccessCoefficients);
  }

  getTextureLayout(gl: GL, chunkDataSize: Vec3) {
    return TextureLayout.get(gl, chunkDataSize, this.texelsPerElement, this.numChannels);
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

    let requiredSize = textureLayout.textureWidth * textureLayout.textureHeight *
        chunkFormat.arrayElementsPerTexel;
    let {arrayConstructor} = chunkFormat;
    let data: TypedArray = this.data;
    if (data.constructor !== arrayConstructor) {
      data = new arrayConstructor(
          data.buffer, data.byteOffset, data.byteLength / arrayConstructor.BYTES_PER_ELEMENT);
    }
    let padded = maybePadArray(data, requiredSize);
    gl.texImage2D(
        gl.TEXTURE_2D,
        /*level=*/0, chunkFormat.textureFormat,
        /*width=*/textureLayout.textureWidth,
        /*height=*/textureLayout.textureHeight,
        /*border=*/0, chunkFormat.textureFormat, chunkFormat.texelType, padded);
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
