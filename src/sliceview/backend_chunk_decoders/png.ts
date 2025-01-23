/**
 * @license
 * Copyright 2022 William Silvermsith.
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

import { decodePng } from "#src/async_computation/decode_png_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import { decodeRawChunk } from "#src/sliceview/backend_chunk_decoders/raw.js";
import type { VolumeChunk } from "#src/sliceview/volume/backend.js";
import { DATA_TYPE_BYTES } from "#src/util/data_type.js";

export async function decodePngChunk(
  chunk: VolumeChunk,
  signal: AbortSignal,
  response: ArrayBuffer,
) {
  const chunkDataSize = chunk.chunkDataSize!;
  const dataType = chunk.source!.spec.dataType;
  const { uint8Array: image } = await requestAsyncComputation(
    decodePng,
    signal,
    [response],
    /*buffer=*/ new Uint8Array(response),
    /*width=*/ undefined,
    /*height=*/ undefined,
    /*area=*/ chunkDataSize[0] * chunkDataSize[1] * chunkDataSize[2],
    /*numComponents=*/ chunkDataSize[3] || 1,
    /*bytesPerPixel=*/ DATA_TYPE_BYTES[dataType],
    /*convertToGrayscale=*/ false,
  );

  await decodeRawChunk(chunk, signal, image.buffer);
}
