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
import {MeshSource} from 'neuroglancer/mesh/frontend';
import {ChunkLayoutOptions, getChunkDataSizes, getCombinedTransform, getNearIsotropicBlockSize, SliceViewChunkSource, SliceViewChunkSpecification, SliceViewChunkSpecificationBaseOptions, SliceViewSourceOptions} from 'neuroglancer/sliceview/base';
import {ChunkLayout} from 'neuroglancer/sliceview/chunk_layout';
import {partitionArray} from 'neuroglancer/util/array';
import {approxEqual} from 'neuroglancer/util/compare';
import {DATA_TYPE_BYTES, DataType} from 'neuroglancer/util/data_type';
import {effectiveScalingFactorFromMat4, identityMat4, kAxes, kInfinityVec, kZeroVec, mat4, prod3, rectifyTransformMatrixIfAxisAligned, transformVectorByMat4, vec3, vec4} from 'neuroglancer/util/geom';
import {SharedObject} from 'neuroglancer/worker_rpc';

export {DATA_TYPE_BYTES, DataType};

const DEBUG_CHUNK_INTERSECTIONS = false;
const DEBUG_VISIBLE_SOURCES = false;

const tempVec3 = vec3.create();

export interface RenderLayer { sources: VolumeChunkSource[][]|null; }

const tempCorners = [vec3.create(), vec3.create(), vec3.create(), vec3.create()];

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

export interface VolumeSourceOptions extends SliceViewSourceOptions {}

/**
 * Common parameters for the VolumeChunkSpecification constructor and
 * VolumeChunkSpecification.getDefaults.
 */
/**
 * Specifies constructor parameters for VolumeChunkSpecification.
 */
export interface VolumeChunkSpecificationBaseOptions extends
    SliceViewChunkSpecificationBaseOptions {
  numChannels: number;
  dataType: DataType;

  /**
   * If set, indicates that the chunk is in compressed segmentation format with the specified block
   * size.
   */
  compressedSegmentationBlockSize?: vec3;
}

export interface VolumeChunkSpecificationOptions extends VolumeChunkSpecificationBaseOptions {
  /**
   * Chunk size in voxels.
   */
  chunkDataSize: vec3;
}


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
}

/**
 * Specifies parameters for VolumeChunkSpecification.getDefaults.
 */
export interface VolumeChunkSpecificationGetDefaultsOptions extends
    VolumeChunkSpecificationBaseOptions, VolumeChunkSpecificationDefaultCompressionOptions,
    ChunkLayoutOptions, VolumeChunkSpecificationVolumeSourceOptions {}

/**
 * Specifies a chunk layout and voxel size.
 */
export class VolumeChunkSpecification extends SliceViewChunkSpecification {
  numChannels: number;
  dataType: DataType;

  chunkBytes: number;

  compressedSegmentationBlockSize: vec3|undefined;

  constructor(options: VolumeChunkSpecificationOptions) {
    super(options);

    let dataType = this.dataType = options.dataType;
    let numChannels = this.numChannels = options.numChannels;

    this.chunkBytes = prod3(options.chunkDataSize) * DATA_TYPE_BYTES[dataType] * numChannels;

    this.compressedSegmentationBlockSize = options.compressedSegmentationBlockSize;
  }

  static make(options: VolumeChunkSpecificationOptions&
              {volumeSourceOptions: SliceViewSourceOptions}) {
    return new VolumeChunkSpecification(Object.assign(
        {}, options,
        {transform: getCombinedTransform(options.transform, options.volumeSourceOptions)}));
  }

  static fromObject(msg: any) {
    return new VolumeChunkSpecification(msg);
  }
  toObject(): VolumeChunkSpecificationOptions {
    return {
      transform: this.chunkLayout.transform,
      numChannels: this.numChannels,
      chunkDataSize: this.chunkDataSize,
      voxelSize: this.voxelSize,
      dataType: this.dataType,
      lowerVoxelBound: this.lowerVoxelBound,
      upperVoxelBound: this.upperVoxelBound,
      lowerClipBound: this.lowerClipBound,
      upperClipBound: this.upperClipBound,
      baseVoxelOffset: this.baseVoxelOffset,
      compressedSegmentationBlockSize: this.compressedSegmentationBlockSize,
    };
  }

  /**
   * Returns a VolumeChunkSpecification with default compression specified if suitable for the
   * volumeType.
   */
  static withDefaultCompression(options: VolumeChunkSpecificationDefaultCompressionOptions&
                                VolumeChunkSpecificationOptions&
                                VolumeChunkSpecificationVolumeSourceOptions) {
    let {
      compressedSegmentationBlockSize,
      dataType,
      voxelSize,
      transform,
      lowerVoxelBound,
      upperVoxelBound
    } = options;
    transform = getCombinedTransform(transform, options.volumeSourceOptions);
    if (compressedSegmentationBlockSize === undefined &&
        options.volumeType === VolumeType.SEGMENTATION &&
        (dataType === DataType.UINT32 || dataType === DataType.UINT64)) {
      compressedSegmentationBlockSize = getNearIsotropicBlockSize(
          {voxelSize, transform, lowerVoxelBound, upperVoxelBound, maxVoxelsPerChunkLog2: 9});
    }
    return new VolumeChunkSpecification(
        Object.assign({}, options, {compressedSegmentationBlockSize, transform}));
  }

  static getDefaults(options: VolumeChunkSpecificationGetDefaultsOptions) {
    const adjustedOptions = Object.assign(
        {}, options,
        {transform: getCombinedTransform(options.transform, options.volumeSourceOptions)});

    let {chunkDataSizes = getChunkDataSizes(adjustedOptions)} = options;
    return chunkDataSizes.map(
        chunkDataSize => VolumeChunkSpecification.withDefaultCompression(
            Object.assign({}, options, {chunkDataSize})));
  }
};

export interface VolumeChunkSource extends SliceViewChunkSource { spec: VolumeChunkSpecification; }

export const VOLUME_RPC_ID = 'volume';
export const VOLUME_RENDERLAYER_RPC_ID = 'volume/RenderLayer';
