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

import {ChunkLayoutOptions, getChunkDataSizes, SliceViewChunkSource, SliceViewChunkSpecification, SliceViewChunkSpecificationBaseOptions, SliceViewChunkSpecificationOptions, SliceViewSourceOptions} from 'neuroglancer/sliceview/base';
import {getCombinedTransform} from 'neuroglancer/sliceview/base';
import {kZeroVec, vec3} from 'neuroglancer/util/geom';

export const CHUNKED_GRAPH_LAYER_RPC_ID = 'ChunkedGraphLayer';


export interface ChunkedGraphSourceOptions extends SliceViewSourceOptions {
  rootUri: string;
}

export interface ChunkedGraphChunkSpecificationBaseOptions extends
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
}

export interface ChunkedGraphChunkSpecificationOptions extends
    ChunkedGraphChunkSpecificationBaseOptions {
  /**
   * Chunk size in voxels.
   */
  chunkDataSize: vec3;
}

export interface ChunkedGraphChunkSpecificationSourceOptions {
  chunkedGraphSourceOptions: ChunkedGraphSourceOptions;
}

/**
 * Specifies parameters for ChunkedGraphChunkSpecification.getDefaults.
 */
export interface ChunkedGraphChunkSpecificationGetDefaultsOptions extends
    ChunkedGraphChunkSpecificationBaseOptions, ChunkLayoutOptions,
    ChunkedGraphChunkSpecificationSourceOptions {}

/**
 * Specifies a chunk layout and voxel size.
 */
export class ChunkedGraphChunkSpecification extends SliceViewChunkSpecification {
  lowerClipBound: vec3;
  upperClipBound: vec3;

  lowerVoxelBound: vec3;
  upperVoxelBound: vec3;

  baseVoxelOffset: vec3;
  chunkDataSize: vec3;

  constructor(options: ChunkedGraphChunkSpecificationOptions) {
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
  }

  static make(options: ChunkedGraphChunkSpecificationOptions&
              {chunkedGraphSourceOptions: ChunkedGraphSourceOptions}) {
    return new ChunkedGraphChunkSpecification(Object.assign(
        {}, options,
        {transform: getCombinedTransform(options.transform, options.chunkedGraphSourceOptions)}));
  }

  static fromObject(msg: any) {
    return new ChunkedGraphChunkSpecification(msg);
  }

  toObject(): ChunkedGraphChunkSpecificationOptions&SliceViewChunkSpecificationOptions {
    return {
      ...super.toObject(),
      chunkDataSize: this.chunkDataSize,
      lowerVoxelBound: this.lowerVoxelBound,
      upperVoxelBound: this.upperVoxelBound,
      lowerClipBound: this.lowerClipBound,
      upperClipBound: this.upperClipBound,
      baseVoxelOffset: this.baseVoxelOffset
    };
  }

  static getDefaults(options: ChunkedGraphChunkSpecificationGetDefaultsOptions) {
    const adjustedOptions = Object.assign(
        {}, options,
        {transform: getCombinedTransform(options.transform, options.chunkedGraphSourceOptions)});

    let {chunkDataSizes = getChunkDataSizes(adjustedOptions)} = options;
    return new ChunkedGraphChunkSpecification(
        Object.assign({}, options, {chunkDataSize: chunkDataSizes[0]}));
  }
}

export interface ChunkedGraphChunkSource extends SliceViewChunkSource {
  spec: ChunkedGraphChunkSpecification;
}
