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
import {ComputationParameters} from 'neuroglancer/datasource/computed/base';

export const TENSORFLOW_COMPUTATION_RPC_ID = 'Computation.Tensorflow';
export const TENSORFLOW_INFERENCE_RPC_ID = 'Computation.Tensorflow.Inference';

export class TensorflowComputationParameters extends ComputationParameters {
  inputDType?: string;
  mean?: number;
  stdDev?: number;
  inputTensorShape?: number[];
  inputTensorNumElements?: number;
}

export type TensorflowArray = Int32Array|Float32Array;

export interface InferenceRequest {
  inputBuffer: TensorflowArray;
  computationRef: any;
  priority: number;
}

export interface InferenceResult {
  outputBuffer: TensorflowArray;
}
