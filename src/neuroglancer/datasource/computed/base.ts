/**
 * @license
 * Copyright 2018 Google Inc.
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

import {VolumeType} from 'neuroglancer/sliceview/volume/base';
import {DataType} from 'neuroglancer/util/data_type';
import {vec3} from 'neuroglancer/util/geom';

export class ComputedVolumeChunkSourceParameters {
  computationRef: any;
  sourceRef: any;
  inputSize: vec3;
  scaleFactor: vec3;

  static RPC_ID = 'computed/ComputedVolumeChunkSourceParameters';
}


export interface ComputationBufferSpecification {
  size: Uint32Array;
  dataType: DataType;
  volumeType: VolumeType;
  numChannels: number;
}

// Parameters that specify data type, volume type, and size for the input and
// output buffers relative to a computation. This information will ultimately
// pass to the VolumeComputationBackend that executes the computation. Extend
// this interface to add parameters - any additional parameters should be
// optional to allow direct assignment to work between types.
export class ComputationParameters {
  // Specification for the buffer that is provided to a computation as an
  // input. The DataType, VolumeType and channel count will match that of the
  // origin volume chunk provider. Size is specified per-computation,
  // independently of the origin volume.
  inputSpec: ComputationBufferSpecification;

  // Same, for the output. Size matches the native size for the
  // ComputedVolumeChunkSource.
  outputSpec: ComputationBufferSpecification;
}

export function getArrayView(buffer: ArrayBuffer, type: DataType) {
  switch (type) {
    case DataType.UINT8:
      return new Uint8Array(buffer);
    case DataType.UINT16:
      return new Uint16Array(buffer);
    case DataType.UINT32:
    case DataType.UINT64:
      return new Uint32Array(buffer);
    case DataType.FLOAT32:
      return new Float32Array(buffer);
  }
}
