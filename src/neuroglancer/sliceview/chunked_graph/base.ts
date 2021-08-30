/**
 * @license
 * Copyright 2018 The Neuroglancer Authors
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

import {ChunkLayoutOptions, makeSliceViewChunkSpecification, SliceViewChunkSource, SliceViewChunkSpecification, SliceViewChunkSpecificationBaseOptions, SliceViewChunkSpecificationOptions} from 'neuroglancer/sliceview/base';
import {DataType} from 'neuroglancer/sliceview/base';

export const CHUNKED_GRAPH_LAYER_RPC_ID = 'ChunkedGraphLayer';
export const CHUNKED_GRAPH_SOURCE_UPDATE_ROOT_SEGMENTS_RPC_ID =
    'ChunkedGraphSourceUpdateRootSegments';
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

  /**
   * If set, indicates that the chunk is in compressed segmentation format with the specified block
   * size.
   */
  // compressedSegmentationBlockSize?: vec3;
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
  baseVoxelOffset: Float32Array; //vec3;
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
