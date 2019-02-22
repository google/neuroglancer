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
import {EXAMPLE_COMPUTATION_RPC_ID, ExampleComputationParameters} from 'neuroglancer/datasource/computed/example/base';
import {ComputedVolumeDataSourceParameters, VolumeComputationFrontend, VolumeComputationFrontendProvider} from 'neuroglancer/datasource/computed/frontend';
import {verify3dVec} from 'neuroglancer/util/json';
import {registerSharedObjectOwner} from 'neuroglancer/worker_rpc';

@registerSharedObjectOwner(EXAMPLE_COMPUTATION_RPC_ID)
export class ExampleComputation extends VolumeComputationFrontend {
  params: ExampleComputationParameters;
}

export class ExampleComputationProvider implements VolumeComputationFrontendProvider {
  getComputation(config: any, {}, params: ComputedVolumeDataSourceParameters) {
    const computeParams: ExampleComputationParameters = params.computationParameters;

    if (config['inputSize'] !== undefined) {
      const inputSize = verify3dVec(config['inputSize']);
      computeParams.inputSpec.size.set(inputSize);
    }

    if (config['outputSize'] !== undefined) {
      const outputSize = verify3dVec(config['outputSize']);
      computeParams.outputSpec.size.set(outputSize);
    }

    return Promise.resolve(new ExampleComputation(computeParams));
  }
}
