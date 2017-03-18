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

export class ChangeSpec {
  changeStackId: string;
  /**
   * Apply changes prior to this timestamp (in milliseconds since epoch).  If 0, no changes should
   * be applied.  If negative, all changes should be applied.
   */
  timeStamp?: number;
  skipEquivalences?: boolean;

  static stringify(p: ChangeSpec|undefined) {
    if (p === undefined) {
      return '';
    }
    return `${p['changeStackId']}/${p['timeStamp']}/${p['skipEquivalences']}`;
  }
}

export class VolumeSourceParameters {
  instance: BrainmapsInstance;
  volumeId: string;
  scaleIndex: number;
  encoding: VolumeChunkEncoding;
  changeSpec: ChangeSpec|undefined;

  static RPC_ID = 'brainmaps/VolumeChunkSource';

  static stringify(p: VolumeSourceParameters) {
    return `brainmaps-${brainmapsInstanceKey(p['instance'])}:volume/${p['volumeId']}/` +
      `${p['scaleIndex']}/${VolumeChunkEncoding[p['encoding']]}/` +
      `${ChangeSpec.stringify(p['changeSpec'])}`;
  }
}

export class MeshSourceParameters {
  instance: BrainmapsInstance;
  volumeId: string;
  meshName: string;
  changeSpec: ChangeSpec|undefined;

  static stringify(p: MeshSourceParameters) {
    return `brainmaps:${brainmapsInstanceKey(p['instance'])}:mesh/` +
      `${p['volumeId']}/${p['meshName']}/` +
      `${ChangeSpec.stringify(p['changeSpec'])}`;
  }

  static RPC_ID = 'brainmaps/MeshSource';
};

export class SkeletonSourceParameters extends MeshSourceParameters {
  static RPC_ID = 'brainmaps/SkeletonSource';
};
