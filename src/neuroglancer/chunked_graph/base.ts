/**
 * @license
 * Copyright 2017 The Neuroglancer Authors
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

import {SliceViewChunkSource, SliceViewChunkSpecification, SliceViewChunkSpecificationBaseOptions, SliceViewSourceOptions} from 'neuroglancer/sliceview/base';
import {getCombinedTransform} from 'neuroglancer/sliceview/base';
import {vec3} from 'neuroglancer/util/geom';

export interface ChunkedGraphChunkSpecificationSourceOptions {
  chunkedGraphSourceOptions: ChunkedGraphSourceOptions;
}

export interface ChunkedGraphSourceOptions extends SliceViewSourceOptions {
}

export interface ChunkedGraphSource extends SliceViewChunkSource {
  spec: ChunkedGraphChunkSpecification;
}

export interface ChunkedGraphChunkSpecificationOptions extends
    SliceViewChunkSpecificationBaseOptions {
  chunkDataSize: vec3;
}

export interface ChunkedGraphChunkSpecificationDefaultChunkSizeOptions extends
    SliceViewChunkSpecificationBaseOptions {
  chunkDataSize?: vec3;
}

export interface ChunkedGraphChunkSpecificationGetDefaultsOptions extends
    ChunkedGraphChunkSpecificationDefaultChunkSizeOptions,
    ChunkedGraphChunkSpecificationSourceOptions {}

/**
 * Specifies a chunk layout and voxel size.
 */
export class ChunkedGraphChunkSpecification extends SliceViewChunkSpecification {
  constructor(options: ChunkedGraphChunkSpecificationOptions) {
    super(options);
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

  static withDefaults(options: ChunkedGraphChunkSpecificationGetDefaultsOptions) {
    let {transform, lowerVoxelBound, upperVoxelBound, chunkDataSize} = options;
    transform = getCombinedTransform(transform, options.chunkedGraphSourceOptions);

    if (chunkDataSize === undefined) {
      chunkDataSize = vec3.clone(upperVoxelBound);
      if (lowerVoxelBound !== undefined) {
        for (let i = 0; i < 3; i++) {
          chunkDataSize[i] += Math.abs(lowerVoxelBound[i]);
        }
      }
    }

    return new ChunkedGraphChunkSpecification(
        Object.assign({}, options, {transform, chunkDataSize}));
  }

  toObject(): ChunkedGraphChunkSpecificationOptions {
    return {
      transform: this.chunkLayout.transform,
      chunkDataSize: this.chunkDataSize,
      voxelSize: this.voxelSize,
      lowerVoxelBound: this.lowerVoxelBound,
      upperVoxelBound: this.upperVoxelBound,
      lowerClipBound: this.lowerClipBound,
      upperClipBound: this.upperClipBound,
      baseVoxelOffset: this.baseVoxelOffset,
    };
  }
}

export const CHUNKED_GRAPH_LAYER_RPC_ID = 'ChunkedGraphLayer';
