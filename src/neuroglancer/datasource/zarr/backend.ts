/**
 * @license
 * Copyright 2020 Google Inc.
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

import {decodeBlosc} from 'neuroglancer/async_computation/decode_blosc_request';
import {decodeGzip} from 'neuroglancer/async_computation/decode_gzip_request';
import {requestAsyncComputation} from 'neuroglancer/async_computation/request';
import {WithParameters} from 'neuroglancer/chunk_manager/backend';
import {WithSharedCredentialsProviderCounterpart} from 'neuroglancer/credentials_provider/shared_counterpart';
import {VolumeChunkSourceParameters, ZarrCompressor, ZarrEncoding} from 'neuroglancer/datasource/zarr/base';
import {decodeRawChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/raw';
import {VolumeChunk, VolumeChunkSource} from 'neuroglancer/sliceview/volume/backend';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {responseArrayBuffer} from 'neuroglancer/util/http_request';
import {cancellableFetchSpecialOk, SpecialProtocolCredentials} from 'neuroglancer/util/special_protocol_request';
import {registerSharedObject} from 'neuroglancer/worker_rpc';

async function decodeChunk(
    chunk: VolumeChunk, cancellationToken: CancellationToken, response: ArrayBuffer,
    encoding: ZarrEncoding) {
  let buffer = new Uint8Array(response);
  switch (encoding.compressor) {
    case ZarrCompressor.GZIP:
      buffer =
          await requestAsyncComputation(decodeGzip, cancellationToken, [buffer.buffer], buffer);
      break;
    case ZarrCompressor.RAW:
      break;
    case ZarrCompressor.BLOSC:
      buffer =
          await requestAsyncComputation(decodeBlosc, cancellationToken, [buffer.buffer], buffer);
  }
  await decodeRawChunk(chunk, cancellationToken, buffer.buffer, encoding.endianness);
}


@registerSharedObject() export class PrecomputedVolumeChunkSource extends
(WithParameters(WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(VolumeChunkSource), VolumeChunkSourceParameters)) {
  async download(chunk: VolumeChunk, cancellationToken: CancellationToken) {
    chunk.chunkDataSize = this.spec.chunkDataSize;
    const {parameters} = this;
    const {chunkGridPosition} = chunk;
    let {url, separator} = parameters;
    const rank = this.spec.rank;
    for (let i = rank; i > 0; --i) {
      url += `${i == rank ? '/' : separator}${chunkGridPosition[i - 1]}`;
    }
    const response = await cancellableFetchSpecialOk(
        this.credentialsProvider, url, {}, responseArrayBuffer, cancellationToken);
    await decodeChunk(chunk, cancellationToken, response, parameters.encoding);
  }
}
