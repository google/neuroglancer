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

import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import type { ChunkChannelAccessParameters } from "#src/render_coordinate_transform.js";
import type { DataType, SliceViewChunkSpecification } from "#src/sliceview/base.js";
import { SLICEVIEW_REQUEST_CHUNK_RPC_ID } from "#src/sliceview/base.js";
import { ChunkFormat as CompressedChunkFormat } from "#src/sliceview/compressed_segmentation/chunk_format.js";
import { decodeChannel as decodeChannelUint32 } from "#src/sliceview/compressed_segmentation/decode_uint32.js";
import { decodeChannel as decodeChannelUint64 } from "#src/sliceview/compressed_segmentation/decode_uint64.js";
import { encodeChannel as encodeChannelUint32 } from "#src/sliceview/compressed_segmentation/encode_uint32.js";
import { encodeChannel as encodeChannelUint64 } from "#src/sliceview/compressed_segmentation/encode_uint64.js";
import type { SliceViewChunk } from "#src/sliceview/frontend.js";
import { MultiscaleSliceViewChunkSource, SliceViewChunkSource } from "#src/sliceview/frontend.js";
import { ChunkFormat as UncompressedChunkFormat } from "#src/sliceview/uncompressed_chunk_format.js";
import type {
  VolumeChunkSource as VolumeChunkSourceInterface,
  VolumeChunkSpecification,
  VolumeSourceOptions,
  VolumeType
} from "#src/sliceview/volume/base.js";
import { VolumeChunk } from "#src/sliceview/volume/chunk.js";
import { getChunkFormatHandler } from "#src/sliceview/volume/registry.js";
import type { TypedArray} from "#src/util/array.js";
import { TypedArrayBuilder } from "#src/util/array.js";
import { DataType as DataTypeUtil } from "#src/util/data_type.js";
import type { Disposable } from "#src/util/disposable.js";
import type { GL } from "#src/webgl/context.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";
import { getShaderType, glsl_mixLinear } from "#src/webgl/shader_lib.js";

export type VolumeChunkKey = string;

export interface ChunkFormat {
  shaderKey: string;

  dataType: DataType;

  /**
   * Called on the ChunkFormat of the first source of a RenderLayer.
   *
   * This should define a fragment shader function:
   *
   *   value_type getDataValueAt(ivec3 position, int channelIndex...);
   *
   * where value_type is `getShaderType(this.dataType)`.
   */
  defineShader: (
    builder: ShaderBuilder,
    numChannelDimensions: number,
    inVertexShader?: boolean,
  ) => void;

  /**
   * Called once per RenderLayer when starting to draw chunks, on the ChunkFormat of the first
   * source.  This is not called before each source is drawn.
   */
  beginDrawing: (gl: GL, shader: ShaderProgram) => void;

  /**
   * Called once after all chunks have been drawn, on the ChunkFormat of the first source.
   */
  endDrawing: (gl: GL, shader: ShaderProgram) => void;

  /**
   * Called just before drawing each chunk, on the ChunkFormat .
   */
  bindChunk: (
    gl: GL,
    shader: ShaderProgram,
    chunk: SliceViewChunk,
    fixedChunkPosition: Uint32Array,
    displayChunkDimensions: readonly number[],
    channelDimensions: readonly number[],
    newSource: boolean,
  ) => void;

  /**
   * Called just before drawing chunks for the source.
   */
  beginSource: (gl: GL, shader: ShaderProgram) => void;
}

export function defineChunkDataShaderAccess(
  builder: ShaderBuilder,
  chunkFormat: ChunkFormat,
  numChannelDimensions: number,
  getPositionWithinChunkExpr: string,
) {
  const { dataType } = chunkFormat;
  chunkFormat.defineShader(builder, numChannelDimensions);
  let dataAccessChannelParams = "";
  let dataAccessChannelArgs = "";
  if (numChannelDimensions === 0) {
    dataAccessChannelParams += "highp int ignoredChannelIndex";
  } else {
    for (let channelDim = 0; channelDim < numChannelDimensions; ++channelDim) {
      if (channelDim !== 0) dataAccessChannelParams += ", ";
      dataAccessChannelParams += `highp int channelIndex${channelDim}`;
      dataAccessChannelArgs += `, channelIndex${channelDim}`;
    }
  }

  builder.addFragmentCode(glsl_mixLinear);
  const dataAccessCode = `
${getShaderType(dataType)} getDataValue(${dataAccessChannelParams}) {
  highp ivec3 p = ivec3(max(vec3(0.0, 0.0, 0.0), min(floor(${getPositionWithinChunkExpr}), uChunkDataSize - 1.0)));
  return getDataValueAt(p${dataAccessChannelArgs});
}
${getShaderType(
  dataType,
)} getInterpolatedDataValue(${dataAccessChannelParams}) {
  highp vec3 positionWithinChunk = ${getPositionWithinChunkExpr};
  highp ivec3[2] points;
  points[0] = ivec3(max(vec3(0.0, 0.0, 0.0), min(floor(positionWithinChunk - 0.5), uChunkDataSize - 1.0)));
  points[1] = ivec3(max(vec3(0.0, 0.0, 0.0), min(ceil(positionWithinChunk - 0.5), uChunkDataSize - 1.0)));
  highp vec3 mixCoeff = fract(positionWithinChunk - 0.5);
  ${getShaderType(dataType)} xvalues[2];
  for (int ix = 0; ix < 2; ++ix) {
    ${getShaderType(dataType)} yvalues[2];
    for (int iy = 0; iy < 2; ++iy) {
      ${getShaderType(dataType)} zvalues[2];
      for (int iz = 0; iz < 2; ++iz) {
        zvalues[iz] = getDataValueAt(ivec3(points[ix].x, points[iy].y, points[iz].z)
                                     ${dataAccessChannelArgs});
      }
      yvalues[iy] = mixLinear(zvalues[0], zvalues[1], mixCoeff.z);
    }
    xvalues[ix] = mixLinear(yvalues[0], yvalues[1], mixCoeff.y);
  }
  return mixLinear(xvalues[0], xvalues[1], mixCoeff.x);
}
`;
  builder.addFragmentCode(dataAccessCode);
  if (numChannelDimensions <= 1) {
    builder.addFragmentCode(`
${getShaderType(dataType)} getDataValue() { return getDataValue(0); }
${getShaderType(
  dataType,
)} getInterpolatedDataValue() { return getInterpolatedDataValue(0); }
`);
  }
}

export interface ChunkFormatHandler extends Disposable {
  chunkFormat: ChunkFormat;
  getChunk(source: SliceViewChunkSource, x: any): SliceViewChunk;
}


export class VolumeChunkSource
  extends SliceViewChunkSource<VolumeChunkSpecification, VolumeChunk>
  implements VolumeChunkSourceInterface
{
  chunkFormatHandler: ChunkFormatHandler;
  private tempChunkGridPosition: Float32Array;
  private tempPositionWithinChunk: Uint32Array;

  constructor(
    chunkManager: ChunkManager,
    options: { spec: VolumeChunkSpecification },
  ) {
    super(chunkManager, options);
    this.chunkFormatHandler = this.registerDisposer(
      getChunkFormatHandler(chunkManager.chunkQueueManager.gl, this.spec),
    );
    const rank = this.spec.upperVoxelBound.length;
    this.tempChunkGridPosition = new Float32Array(rank);
    this.tempPositionWithinChunk = new Uint32Array(rank);
  }

  static encodeSpec(spec: SliceViewChunkSpecification) {
    const s = spec as VolumeChunkSpecification;
    return {
      ...super.encodeSpec(spec),
      dataType: s.dataType,
      compressedSegmentationBlockSize:
        s.compressedSegmentationBlockSize &&
        Array.from(s.compressedSegmentationBlockSize),
      baseVoxelOffset: Array.from(s.baseVoxelOffset),
    };
  }

  get chunkFormat() {
    return this.chunkFormatHandler.chunkFormat;
  }

  async getEnsuredValueAt(
    chunkPosition: Float32Array,
    channelAccess: ChunkChannelAccessParameters,
  ): Promise<number | bigint | any[] | null> {
    const initialValue = this.getValueAt(chunkPosition, channelAccess);
    if (initialValue != null) {
      return initialValue;
    }

    const { spec } = this;
    const { rank, chunkDataSize } = spec;
    const chunkGridPosition = this.tempChunkGridPosition;

    for (let chunkDim = 0; chunkDim < rank; ++chunkDim) {
      const voxel = chunkPosition[chunkDim];
      const chunkSize = chunkDataSize[chunkDim];
      chunkGridPosition[chunkDim] = Math.floor(voxel / chunkSize);
    }

    try {
      await this.rpc!.promiseInvoke(SLICEVIEW_REQUEST_CHUNK_RPC_ID, {
        source: this.rpcId,
        chunkGridPosition: chunkGridPosition,
      });
    } catch (e) {
      console.error(`Failed to fetch chunk for position ${chunkPosition.join()}:`, e);
      return null;
    }

    return this.getValueAt(chunkPosition, channelAccess);
  }

  applyLocalEdits(edits: Map<string, {indices: number[], value: number}>): void {
    const chunksToUpdate = new Set<VolumeChunk>();
    for (const [key, edit] of edits.entries()) {
      const chunk = this.chunks.get(key) as VolumeChunk | undefined;
      if (!chunk || !(chunk as any).data) {
        continue;
      }

      const chunkFormat = chunk.chunkFormat;

      if (chunkFormat instanceof UncompressedChunkFormat) {
        const cpuArray = (chunk as any).data as TypedArray;
        for (const index of edit.indices) {
          cpuArray[index] = edit.value;
        }
        chunksToUpdate.add(chunk);
      } else if (chunkFormat instanceof CompressedChunkFormat) {
        // using an idiotic logic to handle compressed chunks: uncompress -> edit -> recompress
        // TODO: rework this
        const compressedData = (chunk as any).data as Uint32Array;
        const { chunkDataSize } = chunk;
        const numElements = chunkDataSize[0] * chunkDataSize[1] * chunkDataSize[2];
        const { dataType, subchunkSize } = chunkFormat;

        // Note: Assuming single-channel for simplicity. Multi-channel would require handling offsets.
        const baseOffset = compressedData[0];

        const outputBuilder = new TypedArrayBuilder(Uint32Array, compressedData.length);
        // Write multi-channel header (for single channel)
        outputBuilder.resize(1);
        outputBuilder.data[0] = 1;

        if (dataType === DataTypeUtil.UINT32) {
          const uncompressedData = new Uint32Array(numElements);
          decodeChannelUint32(uncompressedData, compressedData, baseOffset, chunkDataSize, subchunkSize);

          for (const index of edit.indices) {
            uncompressedData[index] = edit.value;
          }

          encodeChannelUint32(outputBuilder, subchunkSize, uncompressedData, chunkDataSize);
        } else { // Assumes UINT64
          const uncompressedData = new BigUint64Array(numElements);
          decodeChannelUint64(uncompressedData, compressedData, baseOffset, chunkDataSize, subchunkSize);

          for (const index of edit.indices) {
            uncompressedData[index] = BigInt(edit.value);
          }

          encodeChannelUint64(outputBuilder, subchunkSize, uncompressedData, chunkDataSize);
        }

        (chunk as any).data = outputBuilder.view;
        chunksToUpdate.add(chunk);
      }
    }
    this.invalidateGpuData(chunksToUpdate);
  }

  private invalidateGpuData(chunks: Set<VolumeChunk>): void {
    if (chunks.size === 0) return;
    for (const chunk of chunks) {
      chunk.updateFromCpuData(this.chunkManager.chunkQueueManager.gl);
    }
    this.chunkManager.chunkQueueManager.visibleChunksChanged.dispatch();
  }

  computeChunkIndices(voxelCoord: Float32Array): {
    chunkGridPosition: Float32Array;
    positionWithinChunk: Uint32Array;
  } {
    const { spec } = this;
    const { rank, chunkDataSize } = spec;
    const chunkGridPosition = this.tempChunkGridPosition;
    const positionWithinChunk = this.tempPositionWithinChunk;

    for (let chunkDim = 0; chunkDim < rank; ++chunkDim) {
      const voxel = voxelCoord[chunkDim];
      const chunkSize = chunkDataSize[chunkDim];
      const chunkIndex = Math.floor(voxel / chunkSize);
      chunkGridPosition[chunkDim] = chunkIndex;
      positionWithinChunk[chunkDim] = Math.floor(voxel - chunkSize * chunkIndex);
    }
    return { chunkGridPosition, positionWithinChunk };
  }

  getValueAt(
    chunkPosition: Float32Array,
    channelAccess: ChunkChannelAccessParameters,
  ) {
    const rank = this.spec.rank;
    const chunkGridPosition = this.tempChunkGridPosition;
    const positionWithinChunk = this.tempPositionWithinChunk;
    const { spec } = this;
    {
      const { chunkDataSize } = spec;
      for (let chunkDim = 0; chunkDim < rank; ++chunkDim) {
        const voxel = chunkPosition[chunkDim];
        const chunkSize = chunkDataSize[chunkDim];
        const chunk = Math.floor(voxel / chunkSize);
        chunkGridPosition[chunkDim] = chunk;
        positionWithinChunk[chunkDim] = Math.floor(voxel - chunkSize * chunk);
      }
    }
    const chunk = this.chunks.get(chunkGridPosition.join()) as VolumeChunk;
    if (chunk === undefined) {
      return null;
    }
    const chunkDataSize = chunk.chunkDataSize;
    for (let i = 0; i < 3; ++i) {
      if (positionWithinChunk[i] >= chunkDataSize[i]) {
        return undefined;
      }
    }
    if (channelAccess.channelSpaceShape.length === 0) {
      // Return a single value.
      return chunk.getValueAt(positionWithinChunk);
    }
    const {
      numChannels,
      chunkChannelCoordinates,
      chunkChannelDimensionIndices,
    } = channelAccess;
    const chunkChannelRank = chunkChannelDimensionIndices.length;
    let offset = 0;
    const values = new Array<any>(numChannels);
    for (let channelIndex = 0; channelIndex < numChannels; ++channelIndex) {
      for (let i = 0; i < chunkChannelRank; ++i) {
        positionWithinChunk[chunkChannelDimensionIndices[i]] =
          chunkChannelCoordinates[offset++];
      }
      values[channelIndex] = chunk.getValueAt(positionWithinChunk);
    }
    return values;
  }

  getChunk(x: any): VolumeChunk {
    return <VolumeChunk>this.chunkFormatHandler.getChunk(this, x);
  }
}

// VolumeChunk moved to src/sliceview/volume/chunk.ts

export abstract class MultiscaleVolumeChunkSource extends MultiscaleSliceViewChunkSource<
  VolumeChunkSource,
  VolumeSourceOptions
> {
  abstract dataType: DataType;
  abstract volumeType: VolumeType;
}

export { VolumeChunk };
