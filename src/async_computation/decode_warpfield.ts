/**
 * @license
 * Copyright 2026 Google Inc.
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

import { decodeWarpfield } from "#src/async_computation/decode_warpfield_request.js";
import { registerAsyncComputation } from "#src/async_computation/handler.js";
import { getWarpfieldDecoder } from "#src/datasource/zarr/codec/warpfield/wasm.js";

registerAsyncComputation(
  decodeWarpfield,
  async (data, shape, configuration) => {
    const decoder = await getWarpfieldDecoder();
    const result = decoder.decode(data, shape, configuration.json);
    return { value: result, transfer: [result.buffer] };
  },
);
