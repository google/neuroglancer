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

import {VertexAttributeInfo} from 'neuroglancer/skeleton/base';

export enum VolumeChunkEncoding {
  RAW,
  JPEG,
  COMPRESSED_SEGMENTATION
}

export class VolumeChunkSourceParameters {
  baseUrls: string[];
  path: string;
  encoding: VolumeChunkEncoding;

  static RPC_ID = 'graphene/VolumeChunkSource';
}

export class ChunkedGraphSourceParameters {
  baseUrls: string[];
  path: string;

  static RPC_ID = 'graphene/ChunkedGraphSource';
}


export class MeshSourceParameters {
  meshManifestBaseUrls: string[];
  meshFragmentBaseUrls: string[];
  meshFragmentPath: string;
  lod: number;

  static RPC_ID = 'graphene/MeshSource';
}


export class SkeletonSourceParameters {
  baseUrls: string[];
  path: string;
  vertexAttributes: Map<string, VertexAttributeInfo>;

  static RPC_ID = 'graphene/SkeletonSource';
}
