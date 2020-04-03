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

export enum VolumeChunkEncoding {
  JPEG,
  RAW,
  COMPRESSED_SEGMENTATION,
  COMPRESSED_SEGMENTATIONARRAY
}

export class SWCSourceParameters {
  baseUrl: string;
  nodeKey: string;
  dataInstanceKey: string;
}

export class VolumeChunkSourceParameters extends SWCSourceParameters {
  dataScale: string;
  encoding: VolumeChunkEncoding;
  static RPC_ID = 'swc/VolumeChunkSource';
}

export class SkeletonSourceParameters extends SWCSourceParameters {
  static RPC_ID = 'swc/SkeletonSource';
}

export class MeshSourceParameters extends SWCSourceParameters {
  static RPC_ID = 'swc/MeshSource';
}
