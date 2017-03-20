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

import {DataType, VolumeChunkSpecification} from 'neuroglancer/sliceview/volume/base';
import {VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {ChunkFormatHandler, registerChunkFormatHandler} from 'neuroglancer/sliceview/volume/frontend';
import {SingleTextureChunkFormat, SingleTextureVolumeChunk} from 'neuroglancer/sliceview/single_texture_chunk_format';
import {TypedArray, TypedArrayConstructor} from 'neuroglancer/util/array';
import {RefCounted} from 'neuroglancer/util/disposable';
import {vec2, vec3, vec3Key} from 'neuroglancer/util/geom';
import {Uint64} from 'neuroglancer/util/uint64';
import {GL} from 'neuroglancer/webgl/context';
import {compute1dTextureFormat, compute3dTextureLayout, OneDimensionalTextureAccessHelper, setOneDimensionalTextureData} from 'neuroglancer/webgl/one_dimensional_texture_access';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {getShaderType} from 'neuroglancer/webgl/shader_lib';

class TextureLayout extends RefCounted {
  dataWidth: number;
  textureHeight: number;
  textureAccessCoefficients: vec2;
  channelStride: number;

  constructor(gl: GL, public chunkDataSize: vec3, texelsPerElement: number, numChannels: number) {
    super();
    const dataPointsPerChannel = chunkDataSize[0] * chunkDataSize[1] * chunkDataSize[2];
    this.channelStride = dataPointsPerChannel;
    compute3dTextureLayout(
        this, gl, texelsPerElement, chunkDataSize[0], chunkDataSize[1],
        chunkDataSize[2] * numChannels);
  }

  static get(gl: GL, chunkDataSize: vec3, texelsPerElement: number, numChannels: number) {
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

  constructor(_gl: GL, public dataType: DataType, public numChannels: number, key: string) {
    super(key);
    compute1dTextureFormat(this, dataType);
    this.textureAccessHelper = new OneDimensionalTextureAccessHelper('chunkData');
  }

  defineShader(builder: ShaderBuilder) {
    super.defineShader(builder);
    let {textureAccessHelper} = this;
    textureAccessHelper.defineShader(builder);
    builder.addFragmentCode(
        textureAccessHelper.getAccessor('readVolumeData', 'uVolumeChunkSampler', this.dataType));

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
    const shaderType = getShaderType(this.dataType);
    builder.addFragmentCode(`
${shaderType} getDataValue (int channelIndex) {
  return readVolumeData(getIndexIntoChunk(channelIndex));
}
`);
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

  getTextureLayout(gl: GL, chunkDataSize: vec3) {
    return TextureLayout.get(gl, chunkDataSize, this.texelsPerElement, this.numChannels);
  }

  setTextureData(gl: GL, textureLayout: TextureLayout, data: TypedArray) {
    setOneDimensionalTextureData(gl, textureLayout, this, data);
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
