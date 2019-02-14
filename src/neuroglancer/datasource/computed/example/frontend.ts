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
