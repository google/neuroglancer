/**
 * @license
 * Copyright 2023 William Silversmith
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

import { decodeCrackle } from "#src/async_computation/decode_crackle_request.js";
import { registerAsyncComputation } from "#src/async_computation/handler.js";
import { decompressCrackle } from "#src/sliceview/crackle/index.js";

registerAsyncComputation(decodeCrackle, async function (data: Uint8Array<ArrayBuffer>) {
  const result = await decompressCrackle(data);
  return { value: result, transfer: [result.buffer] };
});
