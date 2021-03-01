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

import {DataType} from 'neuroglancer/sliceview/volume/base';

export const GET_NIFTI_VOLUME_INFO_RPC_ID = 'nifti/getNiftiVolumeInfo';

export interface NiftiVolumeInfo {
  rank: number;
  sourceNames: string[];
  viewNames: string[];
  viewScales: Float64Array;
  sourceScales: Float64Array;
  units: string[];
  dataType: DataType;
  transform: Float64Array;
  description: string;
  volumeSize: Uint32Array;
}

export class VolumeSourceParameters {
  url: string;

  static RPC_ID = 'nifti/VolumeChunkSource';
}
