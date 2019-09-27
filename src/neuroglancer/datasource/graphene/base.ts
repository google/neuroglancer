/**
 * @license
 * Copyright 2019 The Neuroglancer Authors
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
import {mat4} from 'neuroglancer/util/geom';

export const PYCG_APP_VERSION = 0;

export enum VolumeChunkEncoding {
  RAW,
  JPEG,
  COMPRESSED_SEGMENTATION
}

export class VolumeChunkSourceParameters {
  url: string;
  encoding: VolumeChunkEncoding;
  sharding: ShardingParameters|undefined;

  static RPC_ID = 'graphene/VolumeChunkSource';
}

export class ChunkedGraphSourceParameters {
  url: string;

  static RPC_ID = 'graphene/ChunkedGraphSource';
}

export class MeshSourceParameters {
  manifestUrl: string;
  fragmentUrl: string;
  lod: number;

  static RPC_ID = 'graphene/MeshSource';
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

  static RPC_ID = 'graphene/MultiscaleMeshSource';
}

export interface SkeletonMetadata {
  transform: mat4;
  vertexAttributes: Map<string, VertexAttributeInfo>;
  sharding: ShardingParameters|undefined;
}

export class SkeletonSourceParameters {
  url: string;
  metadata: SkeletonMetadata;

  static RPC_ID = 'graphene/SkeletonSource';
}
