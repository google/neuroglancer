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

import { readSingleChannelValue as readSingleChannelValueUint32 } from "#src/sliceview/compressed_segmentation/decode_uint32.js";
import { readSingleChannelValue as readSingleChannelValueUint64 } from "#src/sliceview/compressed_segmentation/decode_uint64.js";
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
import { RefCounted } from "#src/util/disposable.js";
import { vec3, vec3Key } from "#src/util/geom.js";
import type { GL } from "#src/webgl/context.js";
import type {
  ShaderBuilder,
  ShaderProgram,
  ShaderSamplerType,
} from "#src/webgl/shader.js";
import { textureTargetForSamplerType } from "#src/webgl/shader.js";
import {
  getShaderType,
  glsl_getFortranOrderIndex,
  glsl_uint32,
  glsl_uint64,
} from "#src/webgl/shader_lib.js";
import {
  computeTextureFormat,
  OneDimensionalTextureAccessHelper,
  setOneDimensionalTextureData,
  TextureFormat,
} from "#src/webgl/texture_access.js";

class TextureLayout extends RefCounted {
  subchunkGridSize: vec3;

  // This texture layout represents a special fill value chunk with just a single element.
  singleton: boolean;

  constructor(chunkDataSize: Uint32Array, subchunkSize: vec3) {
    super();
    const subchunkGridSize = (this.subchunkGridSize = vec3.create());
    for (let i = 0; i < 3; ++i) {
      subchunkGridSize[i] = Math.ceil(chunkDataSize[i] / subchunkSize[i]);
    }
    this.singleton = false;
  }

  static get(gl: GL, chunkDataSize: Uint32Array, subchunkSize: vec3) {
    return gl.memoize.get(
      `sliceview.CompressedSegmentationTextureLayout:${vec3Key(
        chunkDataSize,
      )},` + `${vec3Key(subchunkSize)}`,
      () => new TextureLayout(chunkDataSize, subchunkSize),
    );
  }
}

const textureFormat = computeTextureFormat(
  new TextureFormat(),
  DataType.UINT32,
);
let tempStridesUniform = new Uint32Array(4 * 4);

export class ChunkFormat extends SingleTextureChunkFormat<TextureLayout> {
  // numChannels is the number of channels in the compressed segmentation format, which is
  // independent of the channel dimensions presented to the user.
  static get(
    gl: GL,
    dataType: DataType,
    subchunkSize: vec3,
    numChannels: number,
  ) {
    const shaderKey = `sliceview.CompressedSegmentationChunkFormat:${dataType}:${numChannels}`;
    const cacheKey = `${shaderKey}:${vec3Key(subchunkSize)}`;
    return gl.memoize.get(
      cacheKey,
      () => new ChunkFormat(dataType, subchunkSize, numChannels, shaderKey),
    );
  }

  private textureAccessHelper: OneDimensionalTextureAccessHelper;

  get shaderSamplerType(): ShaderSamplerType {
    return "usampler2D";
  }

  constructor(
    dataType: DataType,
    public subchunkSize: vec3,
    public numChannels: number,
    key: string,
  ) {
    super(key, dataType);
    this.textureAccessHelper = new OneDimensionalTextureAccessHelper(
      "chunkData",
    );
  }

  defineShader(builder: ShaderBuilder, numChannelDimensions: number) {
    super.defineShader(builder, numChannelDimensions);
    const stridesLength = 4 * (4 + numChannelDimensions);
    if (tempStridesUniform.length < stridesLength) {
      tempStridesUniform = new Uint32Array(stridesLength);
    }
    const { textureAccessHelper } = this;
    textureAccessHelper.defineShader(builder);
    const local = (x: string) => "compressedSegmentationChunkFormat_" + x;
    builder.addUniform("highp ivec3", "uSubchunkGridSize");
    builder.addUniform("highp ivec3", "uSubchunkSize");
    builder.addUniform(
      "highp ivec4",
      "uVolumeChunkStrides",
      4 + numChannelDimensions,
    );
    builder.addFragmentCode(glsl_getFortranOrderIndex);
    const { dataType } = this;
    const glslType = getShaderType(dataType);

    if (dataType === DataType.UINT64) {
      builder.addFragmentCode(glsl_uint64);
    } else {
      builder.addFragmentCode(glsl_uint32);
    }
    builder.addFragmentCode(
      textureAccessHelper.getAccessor(
        local("readTextureValue"),
        "uVolumeChunkSampler",
        DataType.UINT32,
        1,
      ),
    );
    let fragmentCode = `
uint ${local("getChannelOffset")}(int channelIndex) {
  if (channelIndex == 0) {
    return ${this.numChannels}u;
  }
  return ${local("readTextureValue")}(uint(channelIndex)).value;
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
  chunkPositionFull += channelIndex${channelDim} * uVolumeChunkStrides[${
    4 + channelDim
  }];
`;
    }

    fragmentCode += `
  highp ivec3 chunkPosition = chunkPositionFull.xyz;

  // TODO: maybe premultiply this and store as uniform.
  ivec3 subchunkGridPosition = chunkPosition / uSubchunkSize;
  int subchunkGridOffset = getFortranOrderIndex(subchunkGridPosition, uSubchunkGridSize);

  int channelOffset = int(${local("getChannelOffset")}(chunkPositionFull[3]));

  // TODO: Maybe just combine this offset into subchunkGridStrides.
  int subchunkHeaderOffset = subchunkGridOffset * 2 + channelOffset;

  highp uint subchunkHeader0 = ${local(
    "readTextureValue",
  )}(uint(subchunkHeaderOffset)).value;
  highp uint subchunkHeader1 = ${local(
    "readTextureValue",
  )}(uint(subchunkHeaderOffset + 1)).value;
  highp uint outputValueOffset = (subchunkHeader0 & 0xFFFFFFu) + uint(channelOffset);
  highp uint encodingBits = subchunkHeader0 >> 24u;
  if (encodingBits > 0u) {
    ivec3 subchunkPosition = chunkPosition - subchunkGridPosition * uSubchunkSize;
    int subchunkOffset = getFortranOrderIndex(subchunkPosition, uSubchunkSize);
    uint encodedValueBaseOffset = subchunkHeader1 + uint(channelOffset);
    uint encodedValueOffset = encodedValueBaseOffset + uint(subchunkOffset) * encodingBits / 32u;
    uint encodedValue = ${local("readTextureValue")}(encodedValueOffset).value;
    uint wordOffset = uint(subchunkOffset) * encodingBits % 32u;
    uint encodedValueShifted = encodedValue >> wordOffset;
    uint decodedValue = encodedValueShifted - (encodedValueShifted >> encodingBits << encodingBits);
    outputValueOffset += decodedValue * ${
      this.dataType === DataType.UINT64 ? "2u" : "1u"
    };
  }
  ${glslType} result;
`;
    if (dataType === DataType.UINT64) {
      fragmentCode += `
  result.value[0] = ${local("readTextureValue")}(outputValueOffset).value;
  result.value[1] = ${local("readTextureValue")}(outputValueOffset+1u).value;
`;
    } else {
      fragmentCode += `
  result.value = ${local("readTextureValue")}(outputValueOffset).value;
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
    gl: GL,
    shader: ShaderProgram,
    textureLayout: TextureLayout,
    fixedChunkPosition: Uint32Array,
    chunkDisplaySubspaceDimensions: readonly number[],
    channelDimensions: readonly number[],
  ) {
    const { subchunkGridSize } = textureLayout;
    gl.uniform3i(
      shader.uniform("uSubchunkGridSize"),
      subchunkGridSize[0],
      subchunkGridSize[1],
      subchunkGridSize[2],
    );
    const stridesUniform = tempStridesUniform;
    const numChannelDimensions = channelDimensions.length;
    stridesUniform.fill(0);
    if (!textureLayout.singleton) {
      for (let i = 0; i < 3; ++i) {
        stridesUniform[i] = fixedChunkPosition[i];
        const chunkDim = chunkDisplaySubspaceDimensions[i];
        if (chunkDim === -1) continue;
        stridesUniform[4 * (i + 1) + chunkDim] = 1;
      }
      for (
        let channelDim = 0;
        channelDim < numChannelDimensions;
        ++channelDim
      ) {
        const chunkDim = channelDimensions[channelDim];
        if (chunkDim === -1) continue;
        stridesUniform[4 * (4 + channelDim) + chunkDim] = 1;
      }
    }
    gl.uniform4iv(
      shader.uniform("uVolumeChunkStrides"),
      stridesUniform,
      0,
      (numChannelDimensions + 4) * 4,
    );
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
    const { subchunkSize } = this;
    gl.uniform3i(
      shader.uniform("uSubchunkSize"),
      subchunkSize[0],
      subchunkSize[1],
      subchunkSize[2],
    );
  }
}

export class CompressedSegmentationVolumeChunk extends SingleTextureVolumeChunk<
  Uint32Array,
  TextureLayout
> {
  declare CHUNK_FORMAT_TYPE: ChunkFormat;

  setTextureData(gl: GL) {
    const { data } = this;
    const { chunkFormat } = this;
    const textureLayout = (this.textureLayout = chunkFormat.getTextureLayout(
      gl,
      this.chunkDataSize,
    ));
    chunkFormat.setTextureData(gl, textureLayout, data!);
  }

  getValueAt(dataPosition: Uint32Array): bigint | number {
    const { chunkDataSize, chunkFormat } = this;
    const { data } = this;
    if (data === null) {
      return this.source.spec.fillValue;
    }
    const offset = data[dataPosition[3] || 0];
    if (chunkFormat.dataType === DataType.UINT64) {
      return readSingleChannelValueUint64(
        data,
        /*baseOffset=*/ offset,
        chunkDataSize,
        chunkFormat.subchunkSize,
        dataPosition,
      );
    }
    return readSingleChannelValueUint32(
      data,
      /*baseOffset=*/ offset,
      chunkDataSize,
      chunkFormat.subchunkSize,
      dataPosition,
    );
  }
}

class FillValueChunk extends RefCounted {
  textureLayout: TextureLayout;
  texture: WebGLTexture | null;
}

function getFillValueChunk(
  gl: GL,
  chunkFormat: ChunkFormat,
  fillValue: number | bigint,
): FillValueChunk {
  const { dataType, numChannels } = chunkFormat;
  const array = new Uint32Array(
    numChannels + 2 + (dataType === DataType.UINT64 ? 2 : 1),
  );
  array[0] = numChannels;
  array[numChannels] = 2;
  if (dataType === DataType.UINT64) {
    array[numChannels + 2] = Number((fillValue as bigint) & 0xffffffffn);
    array[numChannels + 3] = Number((fillValue as bigint) >> 32n);
  } else {
    array[numChannels + 2] = fillValue as number;
  }
  const textureLayout = new TextureLayout(
    Uint32Array.of(1, 1, 1),
    vec3.fromValues(1, 1, 1),
  );
  textureLayout.singleton = true;
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

export class CompressedSegmentationChunkFormatHandler
  extends RefCounted
  implements ChunkFormatHandler
{
  chunkFormat: ChunkFormat;
  fillValueChunk: FillValueChunk;

  constructor(gl: GL, spec: VolumeChunkSpecification) {
    super();
    const { dataType } = spec;
    if (dataType !== DataType.UINT64 && dataType !== DataType.UINT32) {
      throw new Error(
        `Unsupported compressed segmentation data type: ${DataType[dataType]}`,
      );
    }
    this.chunkFormat = this.registerDisposer(
      ChunkFormat.get(
        gl,
        spec.dataType,
        spec.compressedSegmentationBlockSize!,
        spec.chunkDataSize[3] || 1,
      ),
    );
    this.fillValueChunk = this.registerDisposer(
      gl.memoize.get(
        "sliceview.CompressedSegmentationChunkFormat.fillValue:" +
          `${spec.dataType}:${spec.fillValue}:${this.chunkFormat.numChannels}`,
        () => getFillValueChunk(gl, this.chunkFormat, spec.fillValue),
      ),
    );
  }

  getChunk(source: VolumeChunkSource, x: any) {
    const chunk = new CompressedSegmentationVolumeChunk(source, x);
    if (chunk.data === null) {
      chunk.texture = this.fillValueChunk.texture;
      chunk.textureLayout = this.fillValueChunk.textureLayout;
    }
    return chunk;
  }
}

registerChunkFormatHandler((gl: GL, spec: VolumeChunkSpecification) => {
  if (spec.compressedSegmentationBlockSize != null) {
    return new CompressedSegmentationChunkFormatHandler(gl, spec);
  }
  return null;
});
