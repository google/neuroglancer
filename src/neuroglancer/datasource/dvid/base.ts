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

export class DVIDSourceParameters {
  baseUrl: string;
  nodeKey: string;
  dataInstanceKey: string;
  authServer?: string;
  user?: string;
}

export class VolumeChunkSourceParameters extends DVIDSourceParameters {
  dataScale: string;
  encoding: VolumeChunkEncoding;
  static RPC_ID = 'dvid/VolumeChunkSource';
}

export class SkeletonSourceParameters extends DVIDSourceParameters {
  static RPC_ID = 'dvid/SkeletonSource';
}

export class MeshSourceParameters extends DVIDSourceParameters {
  static RPC_ID = 'dvid/MeshSource';
}
