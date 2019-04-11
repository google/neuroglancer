/**
 * @license
 * Copyright 2019 Google Inc.
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

import {ComputedVolumeChunk, VolumeComputationBackend} from 'neuroglancer/datasource/computed/backend';
import {getArrayView} from 'neuroglancer/datasource/computed/base';
import {InferenceRequest, InferenceResult, TENSORFLOW_COMPUTATION_RPC_ID, TENSORFLOW_INFERENCE_RPC_ID, TensorflowArray, TensorflowComputationParameters} from 'neuroglancer/datasource/computed/tensorflow/base';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {registerSharedObject} from 'neuroglancer/worker_rpc';

@registerSharedObject(TENSORFLOW_COMPUTATION_RPC_ID)
export class TensorflowComputation extends VolumeComputationBackend {
  params: TensorflowComputationParameters;

  /**
   * Converts an input data buffer into a TF.js-compatible normalized typed
   * array.
   * @param buffer the input data buffer
   * @param dtype TF.js-centric dtype string
   */
  convertInputBuffer_(buffer: ArrayBuffer, dtype: string): TensorflowArray {
    const inputArray = getArrayView(buffer, this.params.inputSpec.dataType);
    let outputArray;
    switch (dtype) {
      case 'float32':
        outputArray = new Float32Array(inputArray.length);
        break;
      case 'int32':
        outputArray = new Int32Array(inputArray.length);
        break;
      default:
        throw new Error(`Unsupported dtype: ${dtype}`);
    }

    for (let i = 0; i < inputArray.length; ++i) {
      outputArray[i] = (inputArray[i] - this.params.mean!) / this.params.stdDev!;
    }

    return outputArray;
  }

  /**
   * Copies a TF.js typed array prediction output into a type-correct data
   * buffer, to be used as computational output in a ComputedVolumeChunk.
   * @param inputArray TF.js prediction output
   */
  convertOutputBuffer_(inputArray: TensorflowArray) {
    const buffer = this.createOutputBuffer();
    const outputArray = getArrayView(buffer, this.params.outputSpec.dataType);
    outputArray.set(inputArray);
    return buffer;
  }

  compute(
      inputBuffer: ArrayBuffer, cancellationToken: CancellationToken, chunk: ComputedVolumeChunk) {
    this.addRef();
    const inferenceRequest: InferenceRequest = {
      inputBuffer: this.convertInputBuffer_(inputBuffer, this.params.inputDType!),
      computationRef: this.rpcId,
      priority: chunk.priority
    };

    return this.rpc!
        .promiseInvoke<InferenceResult>(
            TENSORFLOW_INFERENCE_RPC_ID, {inferenceRequest}, cancellationToken)
        .then((result) => {
          this.dispose();
          return this.convertOutputBuffer_(result.outputBuffer);
        })
        .catch((e) => {
          this.dispose();
          throw e;
        });
  }
}
