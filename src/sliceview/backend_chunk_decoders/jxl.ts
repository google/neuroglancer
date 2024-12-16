/**
 * @license
 * Copyright 2016 Google Inc.
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

import { decodeJxl } from "#src/async_computation/decode_jxl_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import { postProcessRawData } from "#src/sliceview/backend_chunk_decoders/postprocess.js";
import type { VolumeChunk } from "#src/sliceview/volume/backend.js";

export async function decodeJxlChunk(
  chunk: VolumeChunk,
  abortSignal: AbortSignal,
  response: ArrayBuffer,
) {
  const chunkDataSize = chunk.chunkDataSize!;
  const { uint8Array: decoded } = await requestAsyncComputation(
    decodeJxl,
    abortSignal,
    [response],
    new Uint8Array(response),
    chunkDataSize[0] * chunkDataSize[1] * chunkDataSize[2],
    chunkDataSize[3] || 1,
    1, // bytesPerPixel
  );
  await postProcessRawData(chunk, abortSignal, decoded);
}
