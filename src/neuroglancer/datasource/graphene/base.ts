/**
 * @license
 * Copyright 2019 The Neuroglancer Authors
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

import {mat4} from 'neuroglancer/util/geom';
import {ShardingParameters} from 'neuroglancer/datasource/precomputed/base';
import {ChunkLayoutOptions, makeSliceViewChunkSpecification, SliceViewChunkSource, SliceViewChunkSpecification, SliceViewChunkSpecificationBaseOptions, SliceViewChunkSpecificationOptions} from 'neuroglancer/sliceview/base';
import {DataType} from 'neuroglancer/sliceview/base';

export const PYCG_APP_VERSION = 1;

export enum VolumeChunkEncoding {
  RAW,
  JPEG,
  COMPRESSED_SEGMENTATION
}

export class VolumeChunkSourceParameters {
  url: string;
  encoding: VolumeChunkEncoding;
  sharding: ShardingParameters|undefined;

  static RPC_ID = 'graphene/VolumeChunkSource';
}


export class ChunkedGraphSourceParameters {
  url: string;

  static RPC_ID = 'graphene/ChunkedGraphSource';
}

export class MeshSourceParameters {
  manifestUrl: string;
  fragmentUrl: string;
  lod: number;
  sharding: Array<ShardingParameters>|undefined;
  nBitsForLayerId: number;

  static RPC_ID = 'graphene/MeshSource';
}

export class MultiscaleMeshMetadata {
  transform: mat4;
  lodScaleMultiplier: number;
  vertexQuantizationBits: number;
  sharding: Array<ShardingParameters>|undefined;
}

import { Uint64 } from 'neuroglancer/util/uint64';

export const responseIdentity = async (x: any) => x;

export function isBaseSegmentId(segmentId: Uint64, nBitsForLayerId: number) {
  const layerId = Uint64.rshift(new Uint64(), segmentId, 64 - nBitsForLayerId);
  return Uint64.equal(layerId, Uint64.ONE);
}

export function getGrapheneFragmentKey(fragmentId: string) {
  const sharded = fragmentId.charAt(0) === '~';

  if (sharded) {
    const parts = fragmentId.substring(1).split(/:(.+)/);
    return {key:parts[0], fragmentId: parts[1]};
  } else {
    return {key:fragmentId, fragmentId: fragmentId};
  }
}

export const CHUNKED_GRAPH_LAYER_RPC_ID = 'ChunkedGraphLayer';
export const CHUNKED_GRAPH_RENDER_LAYER_UPDATE_SOURCES_RPC_ID = 'ChunkedGraphLayer:updateSources'
export const RENDER_RATIO_LIMIT = 5.0;

export interface ChunkedGraphChunkSpecificationBaseOptions extends
    SliceViewChunkSpecificationBaseOptions {
  /**
   * Specifies offset for use by backend.ts:GenericVolumeChunkSource.computeChunkBounds in
   * calculating chunk voxel coordinates.  The calculated chunk coordinates will be equal to the
   * voxel position (in chunkLayout coordinates) plus this value.
   *
   * Defaults to kZeroVec if not specified.
   */
  baseVoxelOffset?: Float32Array;
  dataType: DataType;
}

export interface ChunkedGraphChunkSpecificationOptions extends
    ChunkedGraphChunkSpecificationBaseOptions, SliceViewChunkSpecificationOptions<Uint32Array> {}

/**
 * Specifies parameters for ChunkedGraphChunkSpecification.getDefaults.
 */
export interface ChunkedGraphChunkSpecificationGetDefaultsOptions extends
    ChunkedGraphChunkSpecificationBaseOptions, ChunkLayoutOptions {}

/**
 * Specifies a chunk layout and voxel size.
 */
export interface ChunkedGraphChunkSpecification extends SliceViewChunkSpecification<Uint32Array> {
  baseVoxelOffset: Float32Array;
  dataType: DataType;
}

export function makeChunkedGraphChunkSpecification(options: ChunkedGraphChunkSpecificationOptions): ChunkedGraphChunkSpecification {
  const {rank, dataType} = options;
  const {baseVoxelOffset = new Float32Array(rank)} = options;

  return {
    ...makeSliceViewChunkSpecification(options),
    baseVoxelOffset,
    dataType,
  }
}

export interface ChunkedGraphChunkSource extends SliceViewChunkSource {
  spec: ChunkedGraphChunkSpecification;
}
