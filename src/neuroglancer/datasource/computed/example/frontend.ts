import {EXAMPLE_COMPUTATION_RPC_ID, ExampleComputationParameters} from 'neuroglancer/datasource/computed/example/base';
import {ComputedVolumeDataSourceParameters, VolumeComputationFrontend, VolumeComputationFrontendProvider} from 'neuroglancer/datasource/computed/frontend';
import {registerSharedObjectOwner} from 'neuroglancer/worker_rpc';

@registerSharedObjectOwner(EXAMPLE_COMPUTATION_RPC_ID)
export class ExampleComputation extends VolumeComputationFrontend<ExampleComputationParameters> {
  initialize(config: string, {}, params: ComputedVolumeDataSourceParameters) {
    const offset = parseFloat(config);
    if (isNaN(offset)) {
      return Promise.reject();
    }
    const computeParams: ExampleComputationParameters = params.computationParameters;
    computeParams.offset = offset;
    computeParams.inputSpec.size.set([36, 36, 32]);
    computeParams.outputSpec.size.set([32, 32, 32]);

    return Promise.resolve(computeParams);
  }
}

export class ExampleComputationProvider implements
    VolumeComputationFrontendProvider<ExampleComputationParameters> {
  makeComputation() {
    return new ExampleComputation();
  }
}
