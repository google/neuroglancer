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
import {copyBufferOverlap, VolumeComputationBackend} from 'neuroglancer/datasource/computed/backend';
import {getArrayView} from 'neuroglancer/datasource/computed/base';
import {EXAMPLE_COMPUTATION_RPC_ID, ExampleComputationParameters} from 'neuroglancer/datasource/computed/example/base';
import {DataType} from 'neuroglancer/util/data_type';
import {vec3} from 'neuroglancer/util/geom';
import {registerSharedObject} from 'neuroglancer/worker_rpc';

@registerSharedObject(EXAMPLE_COMPUTATION_RPC_ID)
export class ExampleComputation extends VolumeComputationBackend {
  params: ExampleComputationParameters;

  compute(inputBuffer: ArrayBuffer) {
    const {inputSpec, outputSpec} = this.params;
    const inputBufferView = getArrayView(inputBuffer, inputSpec.dataType);
    const outputBuffer = this.createOutputBuffer();
    const outputBufferView = getArrayView(outputBuffer, outputSpec.dataType);

    // const offset = vec3.floor(vec3.create(), vec3.divide(vec3.create(),
    // vec3.subtract(vec3.create(), inputSpec.size, outputSpec.size), [2, 2, 2]));
    const zeros = vec3.create();
    zeros.set([0, 0, 0]);

    copyBufferOverlap(
        zeros, inputSpec.size, inputBufferView, zeros, outputSpec.size, outputBufferView,
        outputSpec.dataType);

    if (inputSpec.dataType === DataType.UINT8) {
      for (let i = 0; i < outputBufferView.length; ++i) {
        outputBufferView[i] = 255 - outputBufferView[i];
      }
    }

    return Promise.resolve(outputBuffer);
  }
}
