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
import {vec3, vec3Key} from 'neuroglancer/util/geom';
import {Uint64} from 'neuroglancer/util/uint64';
import {GL} from 'neuroglancer/webgl/context';
import {ShaderBuilder, ShaderProgram, ShaderSamplerPrefix, ShaderSamplerType} from 'neuroglancer/webgl/shader';
import {getShaderType} from 'neuroglancer/webgl/shader_lib';
import {computeTextureFormat, setThreeDimensionalTextureData, TextureFormat, ThreeDimensionalTextureAccessHelper} from 'neuroglancer/webgl/texture_access';

class TextureLayout extends RefCounted {
  constructor(public chunkDataSize: vec3, public numChannels: number) {
    super();
  }

  static get(gl: GL, chunkDataSize: vec3, numChannels: number) {
    return gl.memoize.get(
        `sliceview.UncompressedTextureLayout:${vec3Key(chunkDataSize)},${numChannels}`,
        () => new TextureLayout(chunkDataSize, numChannels));
  }
}

export class ChunkFormat extends SingleTextureChunkFormat<TextureLayout> implements TextureFormat {
  texelsPerElement: number;
  textureInternalFormat: number;
  textureFormat: number;
  texelType: number;
  arrayElementsPerTexel: number;
  arrayConstructor: TypedArrayConstructor;
  samplerPrefix: ShaderSamplerPrefix;
  get shaderSamplerType() {
    return `${this.samplerPrefix}sampler3D` as ShaderSamplerType;
  }
  private textureAccessHelper: ThreeDimensionalTextureAccessHelper;

  static get(gl: GL, dataType: DataType, numChannels: number) {
    let key = `sliceview.UncompressedChunkFormat:${dataType}:${numChannels}`;
    return gl.memoize.get(key, () => new ChunkFormat(gl, dataType, numChannels, key));
  }

  constructor(_gl: GL, public dataType: DataType, public numChannels: number, key: string) {
    super(key);
    computeTextureFormat(this, dataType);
    this.textureAccessHelper = new ThreeDimensionalTextureAccessHelper('chunkData');
  }

  defineShader(builder: ShaderBuilder) {
    super.defineShader(builder);
    let {textureAccessHelper} = this;
    builder.addFragmentCode(
        textureAccessHelper.getAccessor('readVolumeData', 'uVolumeChunkSampler', this.dataType));

    let {numChannels} = this;
    if (numChannels > 1) {
      builder.addUniform('highp int', 'uChannelStride');
      builder.addFragmentCode(`
highp int getChannelOffset(highp int channelIndex) {
  return channelIndex * uChannelStride;
}
`);
    } else {
      builder.addFragmentCode(`highp int getChannelOffset(highp int channelIndex) { return 0; }`);
    }
    const shaderType = getShaderType(this.dataType);
    builder.addFragmentCode(`
${shaderType} getDataValue (highp int channelIndex) {
  highp ivec3 p = getPositionWithinChunk();
  return readVolumeData(ivec3(p.x, p.y, p.z + getChannelOffset(channelIndex)));
}
`);
  }

  /**
   * Called each time textureLayout changes while drawing chunks.
   */
  setupTextureLayout(gl: GL, shader: ShaderProgram, textureLayout: TextureLayout) {
    if (this.numChannels > 1) {
      gl.uniform1i(shader.uniform('uChannelStride'), textureLayout.chunkDataSize[2]);
    }
  }

  getTextureLayout(gl: GL, chunkDataSize: vec3) {
    return TextureLayout.get(gl, chunkDataSize, this.numChannels);
  }

  setTextureData(gl: GL, textureLayout: TextureLayout, data: TypedArray) {
    const {chunkDataSize} = textureLayout;
    setThreeDimensionalTextureData(
        gl, this, data, chunkDataSize[0], chunkDataSize[1], chunkDataSize[2] * this.numChannels);
  }
}

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

  getChannelValueAt(dataPosition: vec3, channel: number): number|Uint64 {
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
}

export class UncompressedChunkFormatHandler extends RefCounted implements ChunkFormatHandler {
  chunkFormat: ChunkFormat;
  textureLayout: TextureLayout;

  constructor(gl: GL, spec: VolumeChunkSpecification) {
    super();
    this.chunkFormat = this.registerDisposer(ChunkFormat.get(gl, spec.dataType, spec.numChannels));
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
