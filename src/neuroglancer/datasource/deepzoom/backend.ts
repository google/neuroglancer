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

import {WithParameters} from 'neuroglancer/chunk_manager/backend';
import {WithSharedCredentialsProviderCounterpart} from 'neuroglancer/credentials_provider/shared_counterpart';
import {VolumeChunkEncoding, VolumeChunkSourceParameters} from 'neuroglancer/datasource/deepzoom/base';
import {ChunkDecoder} from 'neuroglancer/sliceview/backend_chunk_decoders';
import {decodeJpegChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/jpeg';
import {decodePngChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/png';
import {decodeRawChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/raw';
import {VolumeChunk, VolumeChunkSource} from 'neuroglancer/sliceview/volume/backend';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {isNotFoundError, responseArrayBuffer} from 'neuroglancer/util/http_request';
import {cancellableFetchSpecialOk, SpecialProtocolCredentials} from 'neuroglancer/util/special_protocol_request';
import {registerSharedObject} from 'neuroglancer/worker_rpc';

const chunkDecoders = new Map<VolumeChunkEncoding, ChunkDecoder>();
chunkDecoders.set(VolumeChunkEncoding.RAW, decodeRawChunk);
chunkDecoders.set(VolumeChunkEncoding.JPEG, decodeJpegChunk);
chunkDecoders.set(VolumeChunkEncoding.PNG, decodePngChunk);

@registerSharedObject() export class DeepzoomVolumeChunkSource extends
(WithParameters(WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(VolumeChunkSource), VolumeChunkSourceParameters)) {
  chunkDecoder = chunkDecoders.get(this.parameters.encoding)!;
  gridShape = (() => {
    const gridShape = new Uint32Array(3);
    const {upperVoxelBound, chunkDataSize} = this.spec;
    for (let i = 0; i < 3; ++i) {
      gridShape[i] = Math.ceil(upperVoxelBound[i] / chunkDataSize[i]);
    }
    return gridShape;
  })();

  async download(chunk: VolumeChunk, cancellationToken: CancellationToken): Promise<void> {
    const {parameters} = this;

    let response: ArrayBuffer|undefined;
      let url: string;
      {
        // chunkPosition must not be captured, since it will be invalidated by the next call to
        // computeChunkBounds.
        let chunkPosition = this.computeChunkBounds(chunk);
        let chunkDataSize = chunk.chunkDataSize!;
        url = `${parameters.url}/${chunkPosition[0]}-${chunkPosition[0] + chunkDataSize[0]}_` +
            `${chunkPosition[1]}-${chunkPosition[1] + chunkDataSize[1]}_` +
            `${chunkPosition[2]}-${chunkPosition[2] + chunkDataSize[2]}`;
      }
      try {
        response = await cancellableFetchSpecialOk(
            this.credentialsProvider, url, {}, responseArrayBuffer, cancellationToken);
      } catch (e) {
        if (isNotFoundError(e)) {
          response = undefined;
        } else {
          throw e;
        }
      }
    if (response !== undefined) {
      await this.chunkDecoder(chunk, cancellationToken, response);
    }
  }
}
