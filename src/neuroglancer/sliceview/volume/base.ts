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

import {ChunkLayoutOptions, getChunkDataSizes, getNearIsotropicBlockSize, makeSliceViewChunkSpecification, SliceViewChunkSource, SliceViewChunkSpecification, SliceViewChunkSpecificationBaseOptions, SliceViewChunkSpecificationOptions, SliceViewSourceOptions} from 'neuroglancer/sliceview/base';
import {DATA_TYPE_BYTES, DataType} from 'neuroglancer/util/data_type';
import {getDependentTransformInputDimensions, vec3} from 'neuroglancer/util/geom';
import * as matrix from 'neuroglancer/util/matrix';
import {Uint64} from 'neuroglancer/util/uint64';
import * as vector from 'neuroglancer/util/vector';

export {DATA_TYPE_BYTES, DataType};

export interface RenderLayer {
  sources: VolumeChunkSource[][]|null;
}

/**
 * Specifies the interpretation of volumetric data.
 */
export enum VolumeType {
  UNKNOWN,
  IMAGE,
  SEGMENTATION,
}

/**
 * By default, choose a chunk size with at most 2^18 = 262144 voxels.
 */
export const DEFAULT_MAX_VOXELS_PER_CHUNK_LOG2 = 18;

export interface VolumeSourceOptions extends SliceViewSourceOptions {
  discreteValues?: boolean;
}

/**
 * Common parameters for the VolumeChunkSpecification constructor and
 * VolumeChunkSpecification.getDefaults.
 */
/**
 * Specifies constructor parameters for VolumeChunkSpecification.
 */
export interface VolumeChunkSpecificationBaseOptions extends
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
  fillValue?: number|Uint64;

  /**
   * If set, indicates that the chunk is in compressed segmentation format with the specified block
   * size.
   */
  compressedSegmentationBlockSize?: vec3;
}

export interface VolumeChunkSpecificationOptions extends
    VolumeChunkSpecificationBaseOptions, SliceViewChunkSpecificationOptions<Uint32Array> {}


export interface VolumeChunkSpecificationVolumeSourceOptions {
  volumeSourceOptions: VolumeSourceOptions;
}

/**
 * Specifies additional parameters for VolumeChunkSpecification.withDefaultCompression.
 */
export interface VolumeChunkSpecificationDefaultCompressionOptions {
  /**
   * Volume type.
   */
  volumeType: VolumeType;
  maxCompressedSegmentationBlockSize?: vec3;
  minBlockSize?: Uint32Array;
  maxBlockSize?: Uint32Array;

  /**
   * Transform from chunk space to the multiscale volume space.
   * Homogeneous `(rank + 1) * (rank + 1)` matrix in column-major order.
   */
  chunkToMultiscaleTransform: Float32Array;

  /**
   * If specified, must be equal to the product of `chunkToMultiscaleTransform` and
   * `multiscaleToViewTransform`.
   */
  chunkToViewTransform?: Float32Array;
}

/**
 * Specifies parameters for `makeDefaultVolumeChunkSpecifications`.
 */
export interface VolumeChunkSpecificationGetDefaultsOptions extends
    VolumeChunkSpecificationBaseOptions, VolumeChunkSpecificationDefaultCompressionOptions,
    ChunkLayoutOptions, VolumeChunkSpecificationVolumeSourceOptions {}

export interface VolumeChunkSpecification extends SliceViewChunkSpecification<Uint32Array> {
  baseVoxelOffset: Float32Array;
  dataType: DataType;
  compressedSegmentationBlockSize: vec3|undefined;
  fillValue: number|Uint64;
}

export function makeVolumeChunkSpecification(options: VolumeChunkSpecificationOptions):
    VolumeChunkSpecification {
  const {
    rank,
    dataType,
    fillValue = (dataType === DataType.UINT64 ? Uint64.ZERO : 0),
    compressedSegmentationBlockSize
  } = options;
  const {baseVoxelOffset = new Float32Array(rank)} = options;
  return {
    ...makeSliceViewChunkSpecification(options),
    compressedSegmentationBlockSize,
    baseVoxelOffset,
    dataType,
    fillValue,
  };
}

function shouldTranscodeToCompressedSegmentation(
    options: VolumeChunkSpecificationDefaultCompressionOptions&VolumeChunkSpecificationOptions&
    VolumeChunkSpecificationVolumeSourceOptions) {
  if (options.compressedSegmentationBlockSize !== undefined) return false;
  if (options.volumeType !== VolumeType.SEGMENTATION &&
      !options.volumeSourceOptions.discreteValues) {
    return false;
  }
  switch (options.dataType) {
    case DataType.UINT32:
    case DataType.UINT64:
      break;
    default:
      return false;
  }
  switch (options.rank) {
    case 3:
      return true;
    case 4: {
      // precomputed format always uses 4-d chunks, even if there is a single channel.  We still
      // want to allow transcoding in that case.  In fact the compressed_segmentation format
      // supports transcoding even for arbitrary 4-d chunks, but it is not clear it would be a good
      // default encoding in that case.
      const {chunkDataSize} = options;
      if (chunkDataSize[3] !== 1) return false;
      return true;
    }
    default:
      return false;
  }
}

/**
 * Returns a VolumeChunkSpecification with default compression specified if suitable for the
 * volumeType.
 */
export function makeVolumeChunkSpecificationWithDefaultCompression(
    options: VolumeChunkSpecificationDefaultCompressionOptions&VolumeChunkSpecificationOptions&
    VolumeChunkSpecificationVolumeSourceOptions) {
  let {
    rank,
    lowerVoxelBound,
    upperVoxelBound,
  } = options;
  if (!shouldTranscodeToCompressedSegmentation(options)) {
    return makeVolumeChunkSpecification(options);
  }
  let {
    volumeSourceOptions: {displayRank, multiscaleToViewTransform},
    chunkToMultiscaleTransform,
    chunkToViewTransform,
  } = options;
  if (chunkToViewTransform === undefined) {
    chunkToViewTransform = matrix.multiply(
        new Float32Array(rank * displayRank), displayRank,  //
        multiscaleToViewTransform, displayRank,             //
        chunkToMultiscaleTransform, rank + 1,               //
        displayRank, rank, rank);
  }
  const {maxCompressedSegmentationBlockSize, chunkDataSize} = options;
  return makeVolumeChunkSpecification({
    ...options,
    compressedSegmentationBlockSize: Float32Array.from(getNearIsotropicBlockSize({
      rank,
      chunkToViewTransform,
      displayRank,
      lowerVoxelBound,
      upperVoxelBound,
      maxVoxelsPerChunkLog2: 9,
      maxBlockSize: maxCompressedSegmentationBlockSize === undefined ?
          chunkDataSize :
          vector.min(new Uint32Array(rank), chunkDataSize, maxCompressedSegmentationBlockSize),
    })) as vec3
  });
}

export function makeDefaultVolumeChunkSpecifications(
    options: VolumeChunkSpecificationGetDefaultsOptions): VolumeChunkSpecification[] {
  const {rank} = options;
  const {
    volumeSourceOptions: {displayRank, multiscaleToViewTransform, modelChannelDimensionIndices},
    chunkToMultiscaleTransform
  } = options;
  const chunkToViewTransform = matrix.multiply(
      new Float32Array(displayRank * rank), displayRank,  //
      multiscaleToViewTransform, displayRank,             //
      chunkToMultiscaleTransform, rank + 1,               //
      displayRank, rank, rank);
  let {minBlockSize} = options;
  if (minBlockSize === undefined) {
    minBlockSize = new Uint32Array(rank);
    minBlockSize.fill(1);
  } else {
    minBlockSize = new Uint32Array(minBlockSize);
  }
  const {lowerVoxelBound, upperVoxelBound} = options;
  if (modelChannelDimensionIndices.length !== 0) {
    for (const chunkDim of getDependentTransformInputDimensions(
             chunkToMultiscaleTransform, rank, modelChannelDimensionIndices)) {
      let size = upperVoxelBound[chunkDim];
      if (lowerVoxelBound !== undefined) {
        size -= lowerVoxelBound[chunkDim];
      }
      minBlockSize[chunkDim] = size;
    }
  }
  const {chunkDataSizes = getChunkDataSizes({
           ...options,
           minBlockSize,
           chunkToViewTransform,
           displayRank,
         })} = options;
  return chunkDataSizes.map(
      chunkDataSize => makeVolumeChunkSpecificationWithDefaultCompression(
          {...options, chunkDataSize: chunkDataSize, chunkToViewTransform}));
}

export interface VolumeChunkSource extends SliceViewChunkSource {
  spec: VolumeChunkSpecification;
}

export const VOLUME_RPC_ID = 'volume';
