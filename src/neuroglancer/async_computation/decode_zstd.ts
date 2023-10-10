/**
 * @license
 * Copyright 2023 Google Inc.
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

import {decodeZstd} from 'neuroglancer/async_computation/decode_zstd_request';
import {registerAsyncComputation} from 'neuroglancer/async_computation/handler';

registerAsyncComputation(decodeZstd, async function(data: Uint8Array) {
  const {default: Zstd} = await import(/*webpackChunkName: "zstd" */ 'numcodecs/zstd');
  const codec = Zstd.fromConfig({id: 'blosc'});
  const result = await codec.decode(data);
  return {value: result, transfer: [result.buffer]};
});
