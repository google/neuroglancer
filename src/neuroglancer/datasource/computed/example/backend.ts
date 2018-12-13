import {copyBufferOverlap, VolumeComputationBackend} from 'neuroglancer/datasource/computed/backend';
import {getArrayView} from 'neuroglancer/datasource/computed/base';
import {EXAMPLE_COMPUTATION_RPC_ID, ExampleComputationParameters} from 'neuroglancer/datasource/computed/example/base';
import {DataType} from 'neuroglancer/util/data_type';
import {vec3} from 'neuroglancer/util/geom';
import {registerSharedObject} from 'neuroglancer/worker_rpc';

@registerSharedObject(EXAMPLE_COMPUTATION_RPC_ID)
export class ExampleComputation extends VolumeComputationBackend {
  params: ExampleComputationParameters;

  compute(
      {}, inputDataType: DataType, inputBuffer: ArrayBuffer, {}, outputDataType: DataType,
      outputBuffer: ArrayBuffer, {}) {
    const inputBufferView = getArrayView(inputBuffer, inputDataType);
    const outputBufferView = getArrayView(outputBuffer, outputDataType);

    const {inputSpec, outputSpec} = this.params;

    // const offset = vec3.floor(vec3.create(), vec3.divide(vec3.create(),
    // vec3.subtract(vec3.create(), inputSpec.size, outputSpec.size), [2, 2, 2]));
    const zeros = vec3.create();
    zeros.set([0, 0, 0]);

    copyBufferOverlap(
        zeros, inputSpec.size, inputBufferView, zeros, outputSpec.size, outputBufferView,
        outputSpec.dataType);

    if (inputDataType === DataType.UINT8) {
      for (let i = 0; i < outputBufferView.length; ++i) {
        outputBufferView[i] = 255 - outputBufferView[i];
      }
    }

    return Promise.resolve();
  }
}
