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

import {
  SingleTextureChunkFormat,
  SingleTextureVolumeChunk,
} from "#src/sliceview/single_texture_chunk_format.js";
import type { VolumeChunkSpecification } from "#src/sliceview/volume/base.js";
import { DataType } from "#src/sliceview/volume/base.js";
import type {
  ChunkFormatHandler,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import { registerChunkFormatHandler } from "#src/sliceview/volume/frontend.js";
import type { TypedArray, TypedArrayConstructor } from "#src/util/array.js";
import {
  DATA_TYPE_ARRAY_CONSTRUCTOR,
  DATA_TYPE_JAVASCRIPT_ELEMENTS_PER_ARRAY_ELEMENT,
} from "#src/util/data_type.js";
import { RefCounted } from "#src/util/disposable.js";
import { Uint64 } from "#src/util/uint64.js";
import type { GL } from "#src/webgl/context.js";
import type {
  ShaderBuilder,
  ShaderProgram,
  ShaderSamplerPrefix,
  ShaderSamplerType,
} from "#src/webgl/shader.js";
import { textureTargetForSamplerType } from "#src/webgl/shader.js";
import { getShaderType } from "#src/webgl/shader_lib.js";
import type { TextureFormat } from "#src/webgl/texture_access.js";
import {
  computeTextureFormat,
  setThreeDimensionalTextureData,
  setTwoDimensionalTextureData,
  TextureAccessHelper,
} from "#src/webgl/texture_access.js";

class TextureLayout extends RefCounted {
  strides: Uint32Array;
  textureShape: Uint32Array;
  constructor(
    gl: GL,
    public chunkDataSize: Uint32Array,
    public textureDims: number,
  ) {
    super();
    const rank = chunkDataSize.length;
    let numRemainingDims = 0;
    for (const size of chunkDataSize) {
      if (size !== 1) ++numRemainingDims;
    }
    const strides = (this.strides = new Uint32Array(rank * textureDims));
    const maxTextureSize =
      textureDims === 3 ? gl.max3dTextureSize : gl.maxTextureSize;
    let textureDim = 0;
    let textureDimSize = 1;
    const textureShape = (this.textureShape = new Uint32Array(
      this.textureDims,
    ));
    textureShape.fill(1);
    for (let chunkDim = 0; chunkDim < rank; ++chunkDim) {
      const size = chunkDataSize[chunkDim];
      if (size === 1) continue;
      const newSize = size * textureDimSize;
      let stride: number;
      if (
        newSize > maxTextureSize ||
        (textureDimSize !== 1 && textureDim + numRemainingDims < textureDims)
      ) {
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
      () => new TextureLayout(gl, chunkSizeInVoxels, textureDims),
    );
  }
}

let tempStridesUniform = new Uint32Array(3 * 5);

export class ChunkFormat
  extends SingleTextureChunkFormat<TextureLayout>
  implements TextureFormat
{
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
    return gl.memoize.get(
      key,
      () => new ChunkFormat(gl, dataType, key, textureDims),
    );
  }

  constructor(
    _gl: GL,
    dataType: DataType,
    key: string,
    public textureDims: number,
  ) {
    super(key, dataType);
    computeTextureFormat(this, dataType);
    this.shaderSamplerType =
      `${this.samplerPrefix}sampler${textureDims}D` as ShaderSamplerType;
    this.textureAccessHelper = new TextureAccessHelper(
      "chunkData",
      textureDims,
    );
  }

  defineShader(
    builder: ShaderBuilder,
    numChannelDimensions: number,
    inVertexShader: boolean = false,
  ) {
    super.defineShader(builder, numChannelDimensions);
    const { textureDims } = this;
    const textureVecType = `ivec${this.textureDims}`;
    const { textureAccessHelper } = this;
    const stridesUniformLength = (4 + numChannelDimensions) * textureDims;
    if (tempStridesUniform.length < stridesUniformLength) {
      tempStridesUniform = new Uint32Array(stridesUniformLength);
    }
    builder.addUniform(
      `highp ${textureVecType}`,
      "uVolumeChunkStrides",
      4 + numChannelDimensions,
    );
    const textureSamplerCode = textureAccessHelper.getAccessor(
      "readVolumeData",
      "uVolumeChunkSampler",
      this.dataType,
    );
    const shaderType = getShaderType(this.dataType);
    let dataAccessCode = `
${shaderType} getDataValueAt(highp ivec3 p`;
    for (let channelDim = 0; channelDim < numChannelDimensions; ++channelDim) {
      dataAccessCode += `, highp int channelIndex${channelDim}`;
    }
    dataAccessCode += `) {
  highp ${textureVecType} offset = uVolumeChunkStrides[0]
                     + p.x * uVolumeChunkStrides[1]
                     + p.y * uVolumeChunkStrides[2]
                     + p.z * uVolumeChunkStrides[3];
`;
    for (let channelDim = 0; channelDim < numChannelDimensions; ++channelDim) {
      dataAccessCode += `
  offset += channelIndex${channelDim} * uVolumeChunkStrides[${4 + channelDim}];
`;
    }
    dataAccessCode += `
  return readVolumeData(offset);
}
`;
    if (inVertexShader) {
      builder.addVertexCode(textureSamplerCode);
      builder.addVertexCode(dataAccessCode);
    } else {
      builder.addFragmentCode(textureSamplerCode);
      builder.addFragmentCode(dataAccessCode);
    }
  }

  /**
   * Called each time textureLayout changes while drawing chunks.
   */
  setupTextureLayout(
    gl: GL,
    shader: ShaderProgram,
    textureLayout: TextureLayout,
    fixedChunkPosition: Uint32Array,
    chunkDisplaySubspaceDimensions: readonly number[],
    channelDimensions: readonly number[],
  ) {
    const stridesUniform = tempStridesUniform;
    const numChannelDimensions = channelDimensions.length;
    const { strides } = textureLayout;
    const rank = fixedChunkPosition.length;
    const { textureDims } = this;
    for (let i = 0; i < textureDims; ++i) {
      let sum = 0;
      for (let chunkDim = 0; chunkDim < rank; ++chunkDim) {
        sum +=
          fixedChunkPosition[chunkDim] * strides[chunkDim * textureDims + i];
      }
      stridesUniform[i] = sum;
    }
    for (let i = 0; i < 3; ++i) {
      const chunkDim = chunkDisplaySubspaceDimensions[i];
      if (chunkDim >= rank) continue;
      for (let j = 0; j < textureDims; ++j) {
        stridesUniform[(i + 1) * textureDims + j] =
          strides[chunkDim * textureDims + j];
      }
    }
    for (let channelDim = 0; channelDim < numChannelDimensions; ++channelDim) {
      const chunkDim = channelDimensions[channelDim];
      if (chunkDim === -1) {
        stridesUniform.fill(
          0,
          (4 + channelDim) * textureDims,
          (4 + channelDim + 1) * textureDims,
        );
      } else {
        for (let i = 0; i < textureDims; ++i) {
          stridesUniform[(4 + channelDim) * textureDims + i] =
            strides[chunkDim * textureDims + i];
        }
      }
    }
    const uniformDataSize = (4 + numChannelDimensions) * textureDims;
    if (textureDims === 3) {
      gl.uniform3iv(
        shader.uniform("uVolumeChunkStrides"),
        stridesUniform,
        0,
        uniformDataSize,
      );
    } else {
      gl.uniform2iv(
        shader.uniform("uVolumeChunkStrides"),
        stridesUniform,
        0,
        uniformDataSize,
      );
    }
  }

  getTextureLayout(gl: GL, chunkDataSize: Uint32Array) {
    return TextureLayout.get(gl, chunkDataSize, this.textureDims);
  }

  setTextureData(gl: GL, textureLayout: TextureLayout, data: TypedArray) {
    const { textureShape } = textureLayout;
    (this.textureDims === 3
      ? setThreeDimensionalTextureData
      : setTwoDimensionalTextureData)(
      gl,
      this,
      data,
      textureShape[0],
      textureShape[1],
      textureShape[2],
    );
  }
}

interface Source extends VolumeChunkSource {
  chunkFormatHandler: UncompressedChunkFormatHandler;
}

export class UncompressedVolumeChunk extends SingleTextureVolumeChunk<
  Uint8Array,
  TextureLayout
> {
  declare CHUNK_FORMAT_TYPE: ChunkFormat;
  declare source: Source;

  setTextureData(gl: GL) {
    const { source } = this;
    const { chunkFormatHandler } = source;
    const { chunkFormat } = chunkFormatHandler;

    let textureLayout: TextureLayout;
    if (this.chunkDataSize === source.spec.chunkDataSize) {
      this.textureLayout = textureLayout =
        chunkFormatHandler.textureLayout.addRef();
    } else {
      this.textureLayout = textureLayout = chunkFormat.getTextureLayout(
        gl,
        this.chunkDataSize,
      );
    }
    this.chunkFormat.setTextureData(gl, textureLayout, this.data!);
  }

  getValueAt(dataPosition: Uint32Array): number | Uint64 {
    const { data } = this;
    if (data === null) {
      return this.source.spec.fillValue;
    }
    const { chunkFormat } = this;
    const { chunkDataSize } = this;
    let index = 0;
    let stride = 1;
    const rank = dataPosition.length;
    for (let i = 0; i < rank; ++i) {
      index += stride * dataPosition[i];
      stride *= chunkDataSize[i];
    }
    const dataType = chunkFormat.dataType;
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
        const index2 = index * 2;
        return new Uint64(data[index2], data[index2 + 1]);
      }
    }
  }
}

class FillValueChunk extends RefCounted {
  textureLayout: TextureLayout;
  texture: WebGLTexture | null;
}

export function getFillValueArray(
  dataType: DataType,
  fillValue: number | Uint64,
) {
  const array = new (DATA_TYPE_ARRAY_CONSTRUCTOR[
    dataType
  ] as TypedArrayConstructor<ArrayBuffer>)(
    DATA_TYPE_JAVASCRIPT_ELEMENTS_PER_ARRAY_ELEMENT[dataType],
  );
  if (dataType === DataType.UINT64) {
    array[0] = (fillValue as Uint64).low;
    array[1] = (fillValue as Uint64).high;
  } else {
    array[0] = fillValue as number;
  }
  return array;
}

function getFillValueChunk(
  gl: GL,
  chunkFormat: ChunkFormat,
  fillValue: number | Uint64,
  rank: number,
  textureDims: number,
): FillValueChunk {
  const { dataType } = chunkFormat;
  const array = getFillValueArray(dataType, fillValue);
  const chunkSizeInVoxels = new Uint32Array(rank);
  chunkSizeInVoxels.fill(1);
  const textureLayout = new TextureLayout(gl, chunkSizeInVoxels, textureDims);
  textureLayout.strides.fill(0);
  const texture = gl.createTexture();
  const textureTarget =
    textureTargetForSamplerType[chunkFormat.shaderSamplerType];
  gl.bindTexture(textureTarget, texture);
  chunkFormat.setTextureData(gl, textureLayout, array);
  gl.bindTexture(textureTarget, null);
  const chunk = new FillValueChunk();
  chunk.textureLayout = textureLayout;
  chunk.texture = texture;
  return chunk;
}

export class UncompressedChunkFormatHandler
  extends RefCounted
  implements ChunkFormatHandler
{
  chunkFormat: ChunkFormat;
  textureLayout: TextureLayout;
  fillValueChunk: FillValueChunk;

  constructor(gl: GL, spec: VolumeChunkSpecification) {
    super();
    let numDims = 0;
    for (const x of spec.chunkDataSize) {
      if (x > 1) ++numDims;
    }
    const textureDims = numDims >= 3 ? 3 : 2;
    this.chunkFormat = this.registerDisposer(
      ChunkFormat.get(gl, spec.dataType, textureDims),
    );
    this.textureLayout = this.registerDisposer(
      this.chunkFormat.getTextureLayout(gl, spec.chunkDataSize),
    );
    this.fillValueChunk = this.registerDisposer(
      gl.memoize.get(
        `sliceview.UncompressedChunkFormat.fillValue:${spec.chunkDataSize.length}:` +
          `${spec.dataType}:${spec.fillValue}:${textureDims}`,
        () =>
          getFillValueChunk(
            gl,
            this.chunkFormat,
            spec.fillValue,
            spec.chunkDataSize.length,
            textureDims,
          ),
      ),
    );
  }

  getChunk(source: VolumeChunkSource, x: any) {
    const chunk = new UncompressedVolumeChunk(source, x);
    if (chunk.data === null) {
      chunk.texture = this.fillValueChunk.texture;
      chunk.textureLayout = this.fillValueChunk.textureLayout;
    }
    return chunk;
  }
}

registerChunkFormatHandler((gl: GL, spec: VolumeChunkSpecification) => {
  if (spec.compressedSegmentationBlockSize == null) {
    return new UncompressedChunkFormatHandler(gl, spec);
  }
  return null;
});
