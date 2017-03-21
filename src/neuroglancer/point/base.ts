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

import {SliceViewChunkSource, SliceViewChunkSpecification, SliceViewChunkSpecificationBaseOptions, SliceViewSourceOptions} from 'neuroglancer/sliceview/base';
import {getCombinedTransform} from 'neuroglancer/sliceview/base';
import {ChunkLayout} from 'neuroglancer/sliceview/chunk_layout';
import {partitionArray} from 'neuroglancer/util/array';
import {approxEqual} from 'neuroglancer/util/compare';
import {kAxes, kZeroVec, mat4, rectifyTransformMatrixIfAxisAligned, transformVectorByMat4, vec3} from 'neuroglancer/util/geom';
import {SharedObject} from 'neuroglancer/worker_rpc';

export interface RenderLayer { sources: PointChunkSource[][]|null; }

export interface PointSourceOptions extends SliceViewSourceOptions {}

export interface PointChunkSource extends SliceViewChunkSource { spec: PointChunkSpecification; }
;

export interface PointChunkSpecificationOptions extends SliceViewChunkSpecificationBaseOptions {
  chunkDataSize: vec3;
}

/**
 * Specifies a chunk layout and voxel size.
 */
export class PointChunkSpecification extends SliceViewChunkSpecification {
  chunkBytes: number;

  constructor(options: PointChunkSpecificationOptions) {
    super(options);

    let chunkBytes = 10000;  // TODO!  remove??
  }

  static make(options: PointChunkSpecificationOptions&{pointSourceOptions: PointSourceOptions}) {
    return new PointChunkSpecification(Object.assign(
        {}, options,
        {transform: getCombinedTransform(options.transform, options.pointSourceOptions)}));
  }

  static fromObject(msg: any) {
    return new PointChunkSpecification(msg);
  }

  toObject(): PointChunkSpecificationOptions {
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
};


export const POINT_RPC_ID = 'point';
export const POINT_RENDERLAYER_RPC_ID = 'point/RenderLayer';
