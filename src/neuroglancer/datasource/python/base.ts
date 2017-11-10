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

export class PythonSourceParameters {
  key: string;
}

export class VolumeChunkSourceParameters extends PythonSourceParameters {
  scaleKey: string;
  encoding: VolumeChunkEncoding;

  static RPC_ID = 'python/VolumeChunkSource';
}

export class MeshSourceParameters extends PythonSourceParameters {
  static RPC_ID = 'python/MeshSource';
}

export class SkeletonSourceParameters extends PythonSourceParameters {
  vertexAttributes: Map<string, VertexAttributeInfo>;

  static RPC_ID = 'python/SkeletonSource';
}
