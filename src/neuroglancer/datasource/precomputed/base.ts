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

import {AnnotationPropertySpec, AnnotationType} from 'neuroglancer/annotation';
import {VertexAttributeInfo} from 'neuroglancer/skeleton/base';
import {mat4} from 'neuroglancer/util/geom';

export enum VolumeChunkEncoding {
  RAW,
  JPEG,
  COMPRESSED_SEGMENTATION,
  COMPRESSO
}

export class VolumeChunkSourceParameters {
  url: string;
  encoding: VolumeChunkEncoding;
  sharding: ShardingParameters|undefined;

  static RPC_ID = 'precomputed/VolumeChunkSource';
}


export class MeshSourceParameters {
  url: string;
  lod: number;

  static RPC_ID = 'precomputed/MeshSource';
}

export enum DataEncoding {
  RAW = 0,
  GZIP = 1,
}

export enum ShardingHashFunction {
  IDENTITY = 0,
  MURMURHASH3_X86_128 = 1,
}

export interface ShardingParameters {
  hash: ShardingHashFunction;
  preshiftBits: number;
  minishardBits: number;
  shardBits: number;
  minishardIndexEncoding: DataEncoding;
  dataEncoding: DataEncoding;
}

export class MultiscaleMeshMetadata {
  transform: mat4;
  lodScaleMultiplier: number;
  vertexQuantizationBits: number;
  sharding: ShardingParameters|undefined;
}

export class MultiscaleMeshSourceParameters {
  url: string;
  metadata: MultiscaleMeshMetadata;

  static RPC_ID = 'precomputed/MultiscaleMeshSource';
}

export interface SkeletonMetadata {
  transform: mat4;
  vertexAttributes: Map<string, VertexAttributeInfo>;
  sharding: ShardingParameters|undefined;
}

export class SkeletonSourceParameters {
  url: string;
  metadata: SkeletonMetadata;

  static RPC_ID = 'precomputed/SkeletonSource';
}

export class AnnotationSpatialIndexSourceParameters {
  url: string;
  sharding: ShardingParameters|undefined;
  static RPC_ID = 'precomputed/AnnotationSpatialIndexSource';
}

export class AnnotationSourceParameters {
  rank: number;
  relationships: {url: string; name: string; sharding: ShardingParameters | undefined;}[];
  properties: AnnotationPropertySpec[];
  byId: {url: string; sharding: ShardingParameters | undefined;};
  type: AnnotationType;
  static RPC_ID = 'precomputed/AnnotationSource';
}

export class IndexedSegmentPropertySourceParameters {
  url: string;
  sharding: ShardingParameters|undefined;
  static RPC_ID = 'precomputed/IndexedSegmentPropertySource';
}
