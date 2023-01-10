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

import {decodeBlosc} from 'neuroglancer/async_computation/decode_blosc_request';
import {decodeGzip} from 'neuroglancer/async_computation/decode_gzip_request';
import {requestAsyncComputation} from 'neuroglancer/async_computation/request';
import {WithParameters} from 'neuroglancer/chunk_manager/backend';
import {WithSharedCredentialsProviderCounterpart} from 'neuroglancer/credentials_provider/shared_counterpart';
import {VolumeChunkEncoding, VolumeChunkSourceParameters} from 'neuroglancer/datasource/n5/base';
import {decodeRawChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/raw';
import {VolumeChunk, VolumeChunkSource} from 'neuroglancer/sliceview/volume/backend';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {Endianness} from 'neuroglancer/util/endian';
import {isNotFoundError, responseArrayBuffer} from 'neuroglancer/util/http_request';
import {cancellableFetchSpecialOk, SpecialProtocolCredentials} from 'neuroglancer/util/special_protocol_request';
import {registerSharedObject} from 'neuroglancer/worker_rpc';

async function decodeChunk(
    chunk: VolumeChunk, cancellationToken: CancellationToken, response: ArrayBuffer,
    encoding: VolumeChunkEncoding) {
  const dv = new DataView(response);
  const mode = dv.getUint16(0, /*littleEndian=*/ false);
  if (mode !== 0) {
    throw new Error(`Unsupported mode: ${mode}.`);
  }
  const numDimensions = dv.getUint16(2, /*littleEndian=*/ false);
  if (numDimensions !== chunk.source!.spec.rank) {
    throw new Error(`Number of dimensions must be 3.`);
  }
  let offset = 4;
  const shape = new Uint32Array(numDimensions);
  for (let i = 0; i < numDimensions; ++i) {
    shape[i] = dv.getUint32(offset, /*littleEndian=*/ false);
    offset += 4;
  }
  chunk.chunkDataSize = shape;
  let buffer = new Uint8Array(response, offset);
  switch (encoding) {
    case VolumeChunkEncoding.GZIP:
      buffer =
          await requestAsyncComputation(decodeGzip, cancellationToken, [buffer.buffer], buffer);
      break;
    case VolumeChunkEncoding.BLOSC:
      buffer =
          await requestAsyncComputation(decodeBlosc, cancellationToken, [buffer.buffer], buffer);
      break;
  }
  await decodeRawChunk(
      chunk, cancellationToken, buffer.buffer, Endianness.BIG, buffer.byteOffset,
      buffer.byteLength);
}


@registerSharedObject() export class PrecomputedVolumeChunkSource extends
(WithParameters(WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(VolumeChunkSource), VolumeChunkSourceParameters)) {
  async download(chunk: VolumeChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;
    const {chunkGridPosition} = chunk;
    let url = parameters.url;
    const rank = this.spec.rank;
    for (let i = 0; i < rank; ++i) {
      url += `/${chunkGridPosition[i]}`;
    }
    try {
      const response = await cancellableFetchSpecialOk(
          this.credentialsProvider, url, {}, responseArrayBuffer, cancellationToken);
      await decodeChunk(chunk, cancellationToken, response, parameters.encoding);
    } catch (e) {
      if (!isNotFoundError(e)) throw e;
    }
  }
}
