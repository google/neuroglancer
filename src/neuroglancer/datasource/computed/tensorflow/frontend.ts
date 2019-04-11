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

import * as tfjsModule from '@tensorflow/tfjs';
import {InferenceModel, Tensor} from '@tensorflow/tfjs';
import {ComputedVolumeDataSourceParameters, VolumeComputationFrontend, VolumeComputationFrontendProvider} from 'neuroglancer/datasource/computed/frontend';
import {InferenceRequest, InferenceResult, TENSORFLOW_COMPUTATION_RPC_ID, TENSORFLOW_INFERENCE_RPC_ID, TensorflowArray, TensorflowComputationParameters} from 'neuroglancer/datasource/computed/tensorflow/base';
import {DataType, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {CANCELED, CancellationToken} from 'neuroglancer/util/cancellation';
import {verifyFloat, verifyString} from 'neuroglancer/util/json';
import {registerPromiseRPC, registerSharedObjectOwner, RPCPromise} from 'neuroglancer/worker_rpc';

let tfjs: null|typeof tfjsModule = null;

export function loadTFjs() {
  if (tfjs) {
    return Promise.resolve();
  }
  return import(/* webpackChunkName: "tfjs-library" */ '@tensorflow/tfjs').then((module) => {
    tfjs = module;
  });
}

/**
 * Dict-style object that represents a pending inference request.
 */
interface PendingInference {
  // TF.js-compatible typed array, to be used as input.
  array: TensorflowArray;
  // If cancelled, reject(CANCELED) is called instead of performing inference.
  cancellationToken: CancellationToken;
  // The priority of the output chunk. Requests are handled in priority order.
  priority: number;
  // Resolve/Reject lambdas for the Promise awaiting inference.
  reject: (message: any) => void;
  resolve: (inferenceResult: InferenceResult) => void;
}

@registerSharedObjectOwner(TENSORFLOW_COMPUTATION_RPC_ID)
export class TensorflowComputation extends VolumeComputationFrontend {
  params: TensorflowComputationParameters;

  // The queue of pending inference requests. Maintained in order of increasing
  // priority, so that pop() always returns the next appropriate request.
  private inferenceQueue_: PendingInference[] = [];
  // True iff the inference loop is in operation.
  private running_ = false;

  constructor(params: TensorflowComputationParameters, private model_: InferenceModel) {
    super(params);
  }

  /**
   * Adds a TF.js-compatible typed array to the inference queue and starts the
   * inference loop, if it isn't already running. Returns a promise that
   * resolves with the prediction output.
   *
   * Creates a PendingInference object and inserts it into the correct position
   * in the inference queue, which is guaranteed to be less than the length of
   * the backend computation queue in length. As such, it is most likely
   * faster to simply iterate the queue to insert the request rather than using
   * a more sophisticated method like binary insertion or a tree-based queue.
   * @param array the input data to run inference over
   * @param priority
   * @param cancellationToken
   */
  predict(array: TensorflowArray, priority: number, cancellationToken: CancellationToken):
      RPCPromise<InferenceResult> {
    return new Promise((resolve, reject) => {
             let i;
             const queue = this.inferenceQueue_;
             for (i = 0; i < queue.length && queue[i].priority < priority; ++i) {
             }
             queue.splice(i, 0, {array, cancellationToken, priority, resolve, reject});
             this.startInference();
           })
        .then((result: InferenceResult) => {
          return {value: result, transfers: [result.outputBuffer.buffer]};
        });
  }

  /**
   * Start the inference loop, if it isn't already running.
   */
  startInference() {
    if (this.running_) {
      return;
    }
    this.running_ = true;
    setTimeout(() => this.runInference_(), 0);
  }

  /**
   * Run the inference loop recursively.
   */
  private runInference_() {
    if (this.inferenceQueue_.length === 0) {
      this.running_ = false;
      return;
    }

    const pendingInference = this.inferenceQueue_.pop()!;

    if (pendingInference.cancellationToken.isCanceled) {
      pendingInference.reject(CANCELED);
      this.runInference_();
      return;
    }

    this.modelInference_(pendingInference).then(() => this.runInference_());
  }

  /**
   * Executes tf.js prediction, resolving or rejecting the pending request's
   * promise, as appropriate.
   * @param inferenceRequest  the request to infer.
   */
  private modelInference_(inferenceRequest: PendingInference): Promise<void> {
    const inputLength = inferenceRequest.array.length;
    const expectedLength = this.params.inputTensorNumElements!;
    if (inputLength !== expectedLength) {
      inferenceRequest.reject(
          new Error(`Input array has ${inputLength} elements. Expected ${expectedLength}`));
      return Promise.resolve();
    }

    const prediction = tfjs!.tidy(() => {
      const modelInput =
          tfjs!.tensor(inferenceRequest.array).reshape(this.params.inputTensorShape!);
      const model = this.model_!;
      return <Tensor>model.predict(modelInput, {});
    });

    return prediction.data()
        .then((outputBuffer: TensorflowArray) => {
          prediction.dispose();
          const result: InferenceResult = {outputBuffer};
          inferenceRequest.resolve(result);
        })
        .then(() => {
          return new Promise<void>((resolve) => {
            setTimeout(() => resolve(), 10);
          });
        });
  }
}

export class TensorflowComputationProvider implements VolumeComputationFrontendProvider {
  getComputation(config: any, {}, params: ComputedVolumeDataSourceParameters) {
    let modelPath = verifyString(config['modelPath']);
    if (!modelPath.endsWith('/')) {
      modelPath += '/';
    }

    let model: InferenceModel;
    let stdDev = 1.0;
    let mean = 0.0;
    let outputType = VolumeType.SEGMENTATION;

    if (config['stdDev'] !== undefined) {
      stdDev = verifyFloat(config['stdDev']);
    }
    if (config['mean'] !== undefined) {
      mean = verifyFloat(config['mean']);
    }
    if (config['atype'] !== undefined) {
      const atype = verifyString(config['atype']);
      switch (atype) {
        case 'classifier':
          break;
        case 'regressor':
          outputType = VolumeType.IMAGE;
          break;
        default:
          throw new Error(`Unknown algorithm type ${atype}. Must be "classifier" or "regressor"`);
      }
    }

    // Load the model, then do a dummy inference run. This allows us to
    // explicitly discover the output dimensions, and to compile the
    // model on the gpu.
    return loadTFjs()
        .then(() => {
          return tfjs!.loadFrozenModel(
              modelPath + 'tensorflowjs_model.pb', modelPath + 'weights_manifest.json');
        })
        .then((tfModel: InferenceModel) => {
          model = tfModel;
          if (model.inputs.length !== 1) {
            throw new Error('Only models with exactly one input are supported');
          }
          if (model.outputs.length !== 1) {
            // Todo: support for multiple-output models.
            throw new Error('Only models with exactly one output are supported');
          }

          // Create a blank tensor, run prediction, check output size
          const dummyOutput = tfjs!.tidy(() => {
            const dummyInput: Tensor = tfjs!.ones(<number[]>model.inputs[0].shape);
            return <Tensor>model.predict(dummyInput, {});
          });

          return dummyOutput.data().then(() => {
            return dummyOutput;
          });
        })
        .then((outputTensor: Tensor) => {
          const inputShape = [1, 1, 1];
          const outputShape = [1, 1, 1];
          const inputTensor = model.inputs[0];
          const inputDType = inputTensor.dtype;

          let idx = 0;
          for (let dim of inputTensor.shape!) {
            if (dim > 1) {
              inputShape[idx] = dim;
              ++idx;
            }

            if (idx >= 3) {
              throw new Error(
                  `Cannot support tensorflow model with input ndim > 3: ${inputTensor.shape!}`);
            }
          }

          idx = 0;
          for (let dim of outputTensor.shape!) {
            if (dim > 1) {
              outputShape[idx] = dim;
              ++idx;
            }

            if (idx >= 3) {
              throw new Error(
                  `Cannot support tensorflow model with output ndim > 3: ${outputTensor.shape!}`);
            }
          }
          outputTensor.dispose();

          let numElements = 1.0;
          for (const dim of inputTensor.shape!) {
            numElements *= dim;
          }

          const tfParams: TensorflowComputationParameters = params.computationParameters;
          tfParams.inputSpec.size.set(inputShape);
          tfParams.outputSpec.size.set(outputShape);
          tfParams.outputSpec.dataType = DataType.UINT32;
          tfParams.outputSpec.volumeType = outputType;
          tfParams.inputDType = inputDType;
          tfParams.mean = mean;
          tfParams.stdDev = stdDev;
          tfParams.inputTensorShape = inputTensor.shape;
          tfParams.inputTensorNumElements = numElements;

          return new TensorflowComputation(tfParams, model);
        });
  }
}

registerPromiseRPC(
    TENSORFLOW_INFERENCE_RPC_ID, function(x, cancellationToken): RPCPromise<InferenceResult> {
      const request = <InferenceRequest>x.inferenceRequest;
      const computation = <TensorflowComputation>this.get(request.computationRef);
      return computation.predict(request.inputBuffer, request.priority, cancellationToken);
    });
