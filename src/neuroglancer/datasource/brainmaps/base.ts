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

import {BrainmapsInstance, brainmapsInstanceKey} from 'neuroglancer/datasource/brainmaps/api';

export enum VolumeChunkEncoding {
  RAW,
  JPEG,
  COMPRESSED_SEGMENTATION
}

export class VolumeSourceParameters {
  instance: BrainmapsInstance;
  volume_id: string;
  scaleIndex: number;
  encoding: VolumeChunkEncoding;

  static RPC_ID = 'brainmaps/VolumeChunkSource';

  static stringify(p: VolumeSourceParameters) {
    return `brainmaps-${brainmapsInstanceKey(p['instance'])}:volume/${p['volume_id']}/${p['scaleIndex']}/${VolumeChunkEncoding[p['encoding']]}`;
  }
};

export class MeshSourceParameters {
  instance: BrainmapsInstance;
  volume_id: string;
  mesh_name: string;

  static stringify(p: MeshSourceParameters) {
    return `brainmaps:${brainmapsInstanceKey(p['instance'])}:mesh/${p['volume_id']}/${p['mesh_name']}`;
  }

  static RPC_ID = 'brainmaps/MeshSource';
};
