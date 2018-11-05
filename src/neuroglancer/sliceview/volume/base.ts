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

import {ChunkLayoutOptions, getChunkDataSizes, getCombinedTransform, getNearIsotropicBlockSize, SliceViewChunkSource, SliceViewChunkSpecification, SliceViewChunkSpecificationBaseOptions, SliceViewChunkSpecificationOptions, SliceViewSourceOptions} from 'neuroglancer/sliceview/base';
import {DATA_TYPE_BYTES, DataType} from 'neuroglancer/util/data_type';
import {kInfinityVec, kZeroVec, prod3, vec3} from 'neuroglancer/util/geom';

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
  /**
   * Lower clipping bound (in nanometers), relative to chunkLayout coordinates.  If not specified,
   * defaults to lowerVoxelBound * voxelSize.
   *
   * Both lowerClipBound and upperClipBound are applied during rendering but do not affect which
   * chunks/voxels are actually retrieved.  That is determined by lowerVoxelBound and
   * upperVoxelBound.
   */
  lowerClipBound?: vec3;

  /**
   * Upper clipping bound (in nanometers), relative to chunkLayout coordinates.  If not specified,
   * defaults to upperVoxelBound * voxelSize.
   */
  upperClipBound?: vec3;

  /**
   * If not specified, defaults to (0, 0, 0).  This determines lowerChunkBound.  If this is not a
   * multiple of chunkDataSize, then voxels at lower positions may still be requested.
   */
  lowerVoxelBound?: vec3;

  /**
   * Upper voxel bound, relative to chunkLayout coordinates.  This determines upperChunkBound.
   */
  upperVoxelBound: vec3;

  /**
   * Specifies offset for use by backend.ts:GenericVolumeChunkSource.computeChunkBounds in
   * calculating chunk voxel coordinates.  The calculated chunk coordinates will be equal to the
   * voxel position (in chunkLayout coordinates) plus this value.
   *
   * Defaults to kZeroVec if not specified.
   */
  baseVoxelOffset?: vec3;
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
  maxCompressedSegmentationBlockSize?: vec3;
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
  lowerClipBound: vec3;
  upperClipBound: vec3;

  lowerVoxelBound: vec3;
  upperVoxelBound: vec3;

  baseVoxelOffset: vec3;
  chunkDataSize: vec3;
  numChannels: number;
  dataType: DataType;

  chunkBytes: number;

  compressedSegmentationBlockSize: vec3|undefined;

  constructor(options: VolumeChunkSpecificationOptions) {
    let {
      lowerVoxelBound = kZeroVec,
      upperVoxelBound,
      chunkDataSize,
      voxelSize,
      transform,
      baseVoxelOffset = kZeroVec
    } = options;
    let {
      lowerClipBound = vec3.multiply(vec3.create(), voxelSize, lowerVoxelBound),
      upperClipBound = vec3.multiply(vec3.create(), voxelSize, upperVoxelBound)
    } = options;
    const chunkSize = vec3.multiply(vec3.create(), chunkDataSize, voxelSize);
    let lowerChunkBound = vec3.create();
    let upperChunkBound = vec3.create();
    for (let i = 0; i < 3; ++i) {
      lowerChunkBound[i] = Math.floor(lowerVoxelBound[i] / chunkDataSize[i]);
      upperChunkBound[i] = Math.floor((upperVoxelBound[i] - 1) / chunkDataSize[i] + 1);
    }
    super({voxelSize, transform, lowerChunkBound, upperChunkBound, chunkSize});
    this.baseVoxelOffset = baseVoxelOffset;
    this.lowerClipBound = lowerClipBound;
    this.upperClipBound = upperClipBound;
    this.lowerVoxelBound = lowerVoxelBound;
    this.upperVoxelBound = upperVoxelBound;
    this.chunkDataSize = chunkDataSize;

    let dataType = this.dataType = options.dataType;
    let numChannels = this.numChannels = options.numChannels;

    this.chunkBytes = prod3(chunkDataSize) * DATA_TYPE_BYTES[dataType] * numChannels;

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
  toObject(): VolumeChunkSpecificationOptions&SliceViewChunkSpecificationOptions {
    return {
      ...super.toObject(),
      numChannels: this.numChannels,
      chunkDataSize: this.chunkDataSize,
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
      compressedSegmentationBlockSize = getNearIsotropicBlockSize({
        voxelSize,
        transform,
        lowerVoxelBound,
        upperVoxelBound,
        maxVoxelsPerChunkLog2: 9,
        maxBlockSize: vec3.min(
            vec3.create(), options.chunkDataSize,
            options.maxCompressedSegmentationBlockSize || kInfinityVec),
      });
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
}

export interface VolumeChunkSource extends SliceViewChunkSource {
  spec: VolumeChunkSpecification;
}

export const VOLUME_RPC_ID = 'volume';
