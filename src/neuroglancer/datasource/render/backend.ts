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

import {decodeJpeg} from 'neuroglancer/async_computation/decode_jpeg_request';
import {requestAsyncComputation} from 'neuroglancer/async_computation/request';
import {WithParameters} from 'neuroglancer/chunk_manager/backend';
import {TileChunkSourceParameters} from 'neuroglancer/datasource/render/base';
import {ChunkDecoder} from 'neuroglancer/sliceview/backend_chunk_decoders';
import {postProcessRawData} from 'neuroglancer/sliceview/backend_chunk_decoders/postprocess';
import {decodeRawChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/raw';
import {VolumeChunk, VolumeChunkSource} from 'neuroglancer/sliceview/volume/backend';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {Endianness} from 'neuroglancer/util/endian';
import {vec3} from 'neuroglancer/util/geom';
import {cancellableFetchOk, responseArrayBuffer} from 'neuroglancer/util/http_request';
import {registerSharedObject} from 'neuroglancer/worker_rpc';

const chunkDecoders = new Map<string, ChunkDecoder>();
chunkDecoders.set(
    'jpg',
    async (chunk: VolumeChunk, cancellationToken: CancellationToken, response: ArrayBuffer) => {
      const chunkDataSize = chunk.chunkDataSize!;
      const decoded = await requestAsyncComputation(
          decodeJpeg, cancellationToken, [response], new Uint8Array(response), chunkDataSize[0],
          chunkDataSize[1] * chunkDataSize[2], 3, true);
      await postProcessRawData(chunk, cancellationToken, decoded);
    });
chunkDecoders.set('raw16', (chunk, cancellationToken, response) => {
  return decodeRawChunk(chunk, cancellationToken, response, Endianness.BIG);
});

@registerSharedObject() export class TileChunkSource extends
(WithParameters(VolumeChunkSource, TileChunkSourceParameters)) {
  chunkDecoder = chunkDecoders.get(this.parameters.encoding)!;

  queryString = (() => {
    let {parameters} = this;
    let query_params: string[] = [];
    if (parameters.channel !== undefined) {
      query_params.push('channels=' + parameters.channel);
    }
    if (parameters.minIntensity !== undefined) {
      query_params.push(`minIntensity=${JSON.stringify(parameters.minIntensity)}`);
    }
    if (parameters.maxIntensity !== undefined) {
      query_params.push(`maxIntensity=${JSON.stringify(parameters.maxIntensity)}`);
    }
    if (parameters.maxTileSpecsToRender !== undefined) {
      query_params.push(`maxTileSpecsToRender=${JSON.stringify(parameters.maxTileSpecsToRender)}`);
    }
    if (parameters.filter !== undefined) {
      query_params.push(`filter=${JSON.stringify(parameters.filter)}`);
    }
    return query_params.join('&');
  })();

  async download(chunk: VolumeChunk, cancellationToken: CancellationToken) {
    let {parameters} = this;
    let {chunkGridPosition} = chunk;

    // Calculate scale.
    let scale = 1.0 / Math.pow(2, parameters.level);

    // Needed by JPEG decoder.
    chunk.chunkDataSize = this.spec.chunkDataSize;

    let xTileSize = chunk.chunkDataSize[0] * Math.pow(2, parameters.level);
    let yTileSize = chunk.chunkDataSize[1] * Math.pow(2, parameters.level);

    // Convert grid position to global coordinates position.
    let chunkPosition = vec3.create();

    chunkPosition[0] = chunkGridPosition[0] * xTileSize;
    chunkPosition[1] = chunkGridPosition[1] * yTileSize;
    chunkPosition[2] = chunkGridPosition[2];

    // GET
    // /v1/owner/{owner}/project/{project}/stack/{stack}/z/{z}/box/{x},{y},{width},{height},{scale}/jpeg-image
    let imageMethod: string;
    if (parameters.encoding === 'raw16') {
      imageMethod = 'raw16-image';
    } else {
      imageMethod = 'jpeg-image';
    }
    let path = `/render-ws/v1/owner/${parameters.owner}/project/${parameters.project}/stack/${
        parameters.stack}/z/${chunkPosition[2]}/box/${chunkPosition[0]},${chunkPosition[1]},${
        xTileSize},${yTileSize},${scale}/${imageMethod}`;
    const response = await cancellableFetchOk(
        `${parameters.baseUrl}${path}?${this.queryString}`, {}, responseArrayBuffer,
        cancellationToken);
    await this.chunkDecoder(chunk, cancellationToken, response);
  }
}
