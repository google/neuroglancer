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

import {VertexAttributeInfo} from 'neuroglancer/skeleton/base';

export enum VolumeChunkEncoding {
  JPEG,
  NPZ,
  RAW
}

export class VolumeChunkSourceParameters {
  baseUrls: string[];
  key: string;
  encoding: VolumeChunkEncoding;

  static RPC_ID = 'python/VolumeChunkSource';

  static stringify(parameters: VolumeChunkSourceParameters) {
    return `python:volume:${parameters['baseUrls'][0]}/${parameters['key']}/${VolumeChunkEncoding[parameters['encoding']]}`;
  }
}

export class MeshSourceParameters {
  baseUrls: string[];
  key: string;

  static RPC_ID = 'python/MeshSource';

  static stringify(parameters: MeshSourceParameters) {
    return `python:mesh:${parameters['baseUrls'][0]}/${parameters['key']}`;
  }
}

export class SkeletonSourceParameters {
  baseUrls: string[];
  key: string;
  vertexAttributes: Map<string, VertexAttributeInfo>;

  static RPC_ID = 'python/SkeletonSource';

  static stringify(parameters: SkeletonSourceParameters) {
    return `python:skeleton:${parameters['baseUrls'][0]}/${parameters['key']}`;
  }
}
