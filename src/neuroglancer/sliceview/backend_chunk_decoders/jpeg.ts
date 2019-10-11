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

import {postProcessRawData} from 'neuroglancer/sliceview/backend_chunk_decoders/postprocess';
import {VolumeChunk} from 'neuroglancer/sliceview/volume/backend';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {decodeJpeg} from 'neuroglancer/async_computation/decode_jpeg_request';
import {requestAsyncComputation} from 'neuroglancer/async_computation/request';

export async function decodeJpegChunk(
    chunk: VolumeChunk, cancellationToken: CancellationToken, response: ArrayBuffer) {
  const chunkDataSize = chunk.chunkDataSize!;
  const decoded = await requestAsyncComputation(
      decodeJpeg, cancellationToken, [response], new Uint8Array(response), chunkDataSize[0],
      chunkDataSize[1] * chunkDataSize[2], chunkDataSize[3] || 1, false);
  await postProcessRawData(chunk, cancellationToken, decoded);
}
