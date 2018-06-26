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

import {SliceViewChunkSource, SliceViewChunkSpecification, SliceViewChunkSpecificationBaseOptions, SliceViewChunkSpecificationOptions, SliceViewSourceOptions} from 'neuroglancer/sliceview/base';
import {getCombinedTransform} from 'neuroglancer/sliceview/base';

export enum VectorGraphicsType {
  LINE,
  POINT
}

export interface RenderLayer {
  sources: VectorGraphicsChunkSource[][]|null;
}

export interface VectorGraphicsChunkSpecificationSourceOptions {
  vectorGraphicsSourceOptions: VectorGraphicsSourceOptions;
}

export interface VectorGraphicsSourceOptions extends SliceViewSourceOptions {}

export interface VectorGraphicsChunkSource extends SliceViewChunkSource {
  spec: VectorGraphicsChunkSpecification;
}

export type VectorGraphicsChunkSpecificationOptions = SliceViewChunkSpecificationOptions;

export interface VectorGraphicsChunkSpecificationDefaultChunkSizeOptions extends
    SliceViewChunkSpecificationBaseOptions {}

/**
 * Specifies a chunk layout and voxel size.
 */
export class VectorGraphicsChunkSpecification extends SliceViewChunkSpecification {
  constructor(options: VectorGraphicsChunkSpecificationOptions) {
    super(options);
  }

  static make(options: VectorGraphicsChunkSpecificationOptions&
              {vectorGraphicsSourceOptions: VectorGraphicsSourceOptions}) {
    return new VectorGraphicsChunkSpecification(Object.assign(
        {}, options,
        {transform: getCombinedTransform(options.transform, options.vectorGraphicsSourceOptions)}));
  }

  static fromObject(msg: any) {
    return new VectorGraphicsChunkSpecification(msg);
  }

  toObject(): SliceViewChunkSpecificationOptions {
    return super.toObject();
  }
}

export const VECTOR_GRAPHICS_RPC_ID = 'vectorgraphics';
export const VECTOR_GRAPHICS_RENDERLAYER_RPC_ID = 'vectorgraphics/RenderLayer';
