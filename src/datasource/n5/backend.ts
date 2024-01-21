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

import { decodeBlosc } from "#src/async_computation/decode_blosc_request.js";
import { decodeGzip } from "#src/async_computation/decode_gzip_request.js";
import { decodeZstd } from "#src/async_computation/decode_zstd_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import { WithParameters } from "#src/chunk_manager/backend.js";
import { WithSharedCredentialsProviderCounterpart } from "#src/credentials_provider/shared_counterpart.js";
import {
  VolumeChunkEncoding,
  VolumeChunkSourceParameters,
} from "#src/datasource/n5/base.js";
import { decodeRawChunk } from "#src/sliceview/backend_chunk_decoders/raw.js";
import type { VolumeChunk } from "#src/sliceview/volume/backend.js";
import { VolumeChunkSource } from "#src/sliceview/volume/backend.js";
import type { CancellationToken } from "#src/util/cancellation.js";
import { Endianness } from "#src/util/endian.js";
import {
  isNotFoundError,
  responseArrayBuffer,
} from "#src/util/http_request.js";
import type { SpecialProtocolCredentials } from "#src/util/special_protocol_request.js";
import { cancellableFetchSpecialOk } from "#src/util/special_protocol_request.js";
import { registerSharedObject } from "#src/worker_rpc.js";

async function decodeChunk(
  chunk: VolumeChunk,
  cancellationToken: CancellationToken,
  response: ArrayBuffer,
  encoding: VolumeChunkEncoding,
) {
  const dv = new DataView(response);
  const mode = dv.getUint16(0, /*littleEndian=*/ false);
  if (mode !== 0) {
    throw new Error(`Unsupported mode: ${mode}.`);
  }
  const numDimensions = dv.getUint16(2, /*littleEndian=*/ false);
  if (numDimensions !== chunk.source!.spec.rank) {
    throw new Error("Number of dimensions must be 3.");
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
      buffer = await requestAsyncComputation(
        decodeGzip,
        cancellationToken,
        [buffer.buffer],
        buffer,
      );
      break;
    case VolumeChunkEncoding.BLOSC:
      buffer = await requestAsyncComputation(
        decodeBlosc,
        cancellationToken,
        [buffer.buffer],
        buffer,
      );
      break;
    case VolumeChunkEncoding.ZSTD:
      buffer = await requestAsyncComputation(
        decodeZstd,
        cancellationToken,
        [buffer.buffer],
        buffer,
      );
      break;
  }
  await decodeRawChunk(
    chunk,
    cancellationToken,
    buffer.buffer,
    Endianness.BIG,
    buffer.byteOffset,
    buffer.byteLength,
  );
}

@registerSharedObject()
export class PrecomputedVolumeChunkSource extends WithParameters(
  WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(
    VolumeChunkSource,
  ),
  VolumeChunkSourceParameters,
) {
  async download(chunk: VolumeChunk, cancellationToken: CancellationToken) {
    const { parameters } = this;
    const { chunkGridPosition } = chunk;
    let url = parameters.url;
    const rank = this.spec.rank;
    for (let i = 0; i < rank; ++i) {
      url += `/${chunkGridPosition[i]}`;
    }
    try {
      const response = await cancellableFetchSpecialOk(
        this.credentialsProvider,
        url,
        {},
        responseArrayBuffer,
        cancellationToken,
      );
      await decodeChunk(
        chunk,
        cancellationToken,
        response,
        parameters.encoding,
      );
    } catch (e) {
      if (!isNotFoundError(e)) throw e;
    }
  }
}
