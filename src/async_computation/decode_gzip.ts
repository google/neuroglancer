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

import { decodeGzip } from "#src/async_computation/decode_gzip_request.js";
import { registerAsyncComputation } from "#src/async_computation/handler.js";

registerAsyncComputation(decodeGzip, async (data: Uint8Array) => {
  const result = (await import("pako")).inflate(data);
  return { value: result, transfer: [result.buffer] };
});
