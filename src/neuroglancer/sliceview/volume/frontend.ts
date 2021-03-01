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

import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {ChunkChannelAccessParameters} from 'neuroglancer/render_coordinate_transform';
import {DataType, SliceViewChunkSpecification} from 'neuroglancer/sliceview/base';
import {MultiscaleSliceViewChunkSource, SliceViewChunk, SliceViewChunkSource} from 'neuroglancer/sliceview/frontend';
import {VolumeChunkSource as VolumeChunkSourceInterface, VolumeChunkSpecification, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {Disposable} from 'neuroglancer/util/disposable';
import {GL} from 'neuroglancer/webgl/context';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {getShaderType, glsl_mixLinear} from 'neuroglancer/webgl/shader_lib';

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
  defineShader: (builder: ShaderBuilder, numChannelDimensions: number) => void;

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
  bindChunk:
      (gl: GL, shader: ShaderProgram, chunk: SliceViewChunk, fixedChunkPosition: Uint32Array,
       displayChunkDimensions: readonly number[], channelDimensions: readonly number[],
       newSource: boolean) => void;

  /**
   * Called just before drawing chunks for the source.
   */
  beginSource: (gl: GL, shader: ShaderProgram) => void;
}

export function defineChunkDataShaderAccess(
    builder: ShaderBuilder, chunkFormat: ChunkFormat, numChannelDimensions: number,
    getPositionWithinChunkExpr: string) {
  const {dataType} = chunkFormat;
  chunkFormat.defineShader(builder, numChannelDimensions);
  let dataAccessChannelParams = ``;
  let dataAccessChannelArgs = ``;
  if (numChannelDimensions === 0) {
    dataAccessChannelParams += `highp int ignoredChannelIndex`;
  } else {
    for (let channelDim = 0; channelDim < numChannelDimensions; ++channelDim) {
      if (channelDim !== 0) dataAccessChannelParams += `, `;
      dataAccessChannelParams += `highp int channelIndex${channelDim}`;
      dataAccessChannelArgs += `, channelIndex${channelDim}`;
    }
  }

  builder.addFragmentCode(glsl_mixLinear);
  let dataAccessCode = `
${getShaderType(dataType)} getDataValue(${dataAccessChannelParams}) {
  highp ivec3 p = ivec3(max(vec3(0.0, 0.0, 0.0), min(floor(${
      getPositionWithinChunkExpr}), uChunkDataSize - 1.0)));
  return getDataValueAt(p${dataAccessChannelArgs});
}
${getShaderType(dataType)} getInterpolatedDataValue(${dataAccessChannelParams}) {
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
${getShaderType(dataType)} getInterpolatedDataValue() { return getInterpolatedDataValue(0); }
`);
  }
}

export interface ChunkFormatHandler extends Disposable {
  chunkFormat: ChunkFormat;
  getChunk(source: SliceViewChunkSource, x: any): SliceViewChunk;
}

export type ChunkFormatHandlerFactory = (gl: GL, spec: VolumeChunkSpecification) =>
    ChunkFormatHandler|null;

var chunkFormatHandlers = new Array<ChunkFormatHandlerFactory>();

export function registerChunkFormatHandler(factory: ChunkFormatHandlerFactory) {
  chunkFormatHandlers.push(factory);
}

export function getChunkFormatHandler(gl: GL, spec: VolumeChunkSpecification) {
  for (let handler of chunkFormatHandlers) {
    let result = handler(gl, spec);
    if (result != null) {
      return result;
    }
  }
  throw new Error('No chunk format handler found.');
}

export class VolumeChunkSource extends SliceViewChunkSource<VolumeChunkSpecification, VolumeChunk>
    implements VolumeChunkSourceInterface {
  chunkFormatHandler: ChunkFormatHandler;
  private tempChunkGridPosition: Float32Array;
  private tempPositionWithinChunk: Uint32Array;

  constructor(chunkManager: ChunkManager, options: {spec: VolumeChunkSpecification}) {
    super(chunkManager, options);
    this.chunkFormatHandler =
        this.registerDisposer(getChunkFormatHandler(chunkManager.chunkQueueManager.gl, this.spec));
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
          s.compressedSegmentationBlockSize && Array.from(s.compressedSegmentationBlockSize),
      baseVoxelOffset: Array.from(s.baseVoxelOffset),
    };
  }

  get chunkFormat() {
    return this.chunkFormatHandler.chunkFormat;
  }

  getValueAt(chunkPosition: Float32Array, channelAccess: ChunkChannelAccessParameters) {
    const rank = this.spec.rank;
    const chunkGridPosition = this.tempChunkGridPosition;
    const positionWithinChunk = this.tempPositionWithinChunk;
    const {spec} = this;
    {
      const {chunkDataSize} = spec;
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
    const {numChannels, chunkChannelCoordinates, chunkChannelDimensionIndices} = channelAccess;
    const chunkChannelRank = chunkChannelDimensionIndices.length;
    let offset = 0;
    const values = new Array<any>(numChannels);
    for (let channelIndex = 0; channelIndex < numChannels; ++channelIndex) {
      for (let i = 0; i < chunkChannelRank; ++i) {
        positionWithinChunk[chunkChannelDimensionIndices[i]] = chunkChannelCoordinates[offset++];
      }
      values[channelIndex] = chunk.getValueAt(positionWithinChunk);
    }
    return values;
  }

  getChunk(x: any): VolumeChunk {
    return <VolumeChunk>this.chunkFormatHandler.getChunk(this, x);
  }
}

export abstract class VolumeChunk extends SliceViewChunk {
  source: VolumeChunkSource;
  chunkDataSize: Uint32Array;
  CHUNK_FORMAT_TYPE: ChunkFormat;

  get chunkFormat(): this['CHUNK_FORMAT_TYPE'] {
    return this.source.chunkFormat;
  }

  constructor(source: VolumeChunkSource, x: any) {
    super(source, x);
    this.chunkDataSize = x['chunkDataSize'] || source.spec.chunkDataSize;
  }
  abstract getValueAt(dataPosition: Uint32Array): any;
}

export abstract class MultiscaleVolumeChunkSource extends
    MultiscaleSliceViewChunkSource<VolumeChunkSource, VolumeSourceOptions> {
  abstract dataType: DataType;
  abstract volumeType: VolumeType;
}
