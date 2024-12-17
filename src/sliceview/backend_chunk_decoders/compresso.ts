/**
 * @license
 * Copyright 2021 William Silvermsith.
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

import { decodeCompresso } from "#src/async_computation/decode_compresso_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import { decodeRawChunk } from "#src/sliceview/backend_chunk_decoders/raw.js";
import type { VolumeChunk } from "#src/sliceview/volume/backend.js";

export async function decodeCompressoChunk(
  chunk: VolumeChunk,
  abortSignal: AbortSignal,
  response: ArrayBuffer,
) {
  const image = await requestAsyncComputation(
    decodeCompresso,
    abortSignal,
    [response],
    new Uint8Array(response),
  );

  await decodeRawChunk(chunk, abortSignal, image.buffer);
}
