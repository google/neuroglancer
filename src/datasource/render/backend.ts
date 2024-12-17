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

import { decodeJpeg } from "#src/async_computation/decode_jpeg_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import { WithParameters } from "#src/chunk_manager/backend.js";
import { TileChunkSourceParameters } from "#src/datasource/render/base.js";
import type { ChunkDecoder } from "#src/sliceview/backend_chunk_decoders/index.js";
import { postProcessRawData } from "#src/sliceview/backend_chunk_decoders/postprocess.js";
import { decodeRawChunk } from "#src/sliceview/backend_chunk_decoders/raw.js";
import type { VolumeChunk } from "#src/sliceview/volume/backend.js";
import { VolumeChunkSource } from "#src/sliceview/volume/backend.js";
import { Endianness } from "#src/util/endian.js";
import { vec3 } from "#src/util/geom.js";
import { fetchOk } from "#src/util/http_request.js";
import { registerSharedObject } from "#src/worker_rpc.js";

const chunkDecoders = new Map<string, ChunkDecoder>();
chunkDecoders.set(
  "jpg",
  async (
    chunk: VolumeChunk,
    abortSignal: AbortSignal,
    response: ArrayBuffer,
  ) => {
    const chunkDataSize = chunk.chunkDataSize!;
    const { uint8Array: decoded } = await requestAsyncComputation(
      decodeJpeg,
      abortSignal,
      [response],
      new Uint8Array(response),
      undefined,
      undefined,
      chunkDataSize[0] * chunkDataSize[1] * chunkDataSize[2],
      3,
      true,
    );
    await postProcessRawData(chunk, abortSignal, decoded);
  },
);
chunkDecoders.set("raw16", (chunk, abortSignal, response) => {
  return decodeRawChunk(chunk, abortSignal, response, Endianness.BIG);
});

@registerSharedObject()
export class TileChunkSource extends WithParameters(
  VolumeChunkSource,
  TileChunkSourceParameters,
) {
  chunkDecoder = chunkDecoders.get(this.parameters.encoding)!;

  queryString = (() => {
    const { parameters } = this;
    const query_params: string[] = [];
    if (parameters.channel !== undefined) {
      query_params.push("channels=" + parameters.channel);
    }
    if (parameters.minIntensity !== undefined) {
      query_params.push(
        `minIntensity=${JSON.stringify(parameters.minIntensity)}`,
      );
    }
    if (parameters.maxIntensity !== undefined) {
      query_params.push(
        `maxIntensity=${JSON.stringify(parameters.maxIntensity)}`,
      );
    }
    if (parameters.maxTileSpecsToRender !== undefined) {
      query_params.push(
        `maxTileSpecsToRender=${JSON.stringify(
          parameters.maxTileSpecsToRender,
        )}`,
      );
    }
    if (parameters.filter !== undefined) {
      query_params.push(`filter=${JSON.stringify(parameters.filter)}`);
    }
    return query_params.join("&");
  })();

  async download(chunk: VolumeChunk, abortSignal: AbortSignal) {
    const { parameters } = this;
    const { chunkGridPosition } = chunk;

    // Calculate scale.
    const scale = 1.0 / 2 ** parameters.level;

    // Needed by JPEG decoder.
    chunk.chunkDataSize = this.spec.chunkDataSize;

    const xTileSize = chunk.chunkDataSize[0] * 2 ** parameters.level;
    const yTileSize = chunk.chunkDataSize[1] * 2 ** parameters.level;

    // Convert grid position to global coordinates position.
    const chunkPosition = vec3.create();

    chunkPosition[0] = chunkGridPosition[0] * xTileSize;
    chunkPosition[1] = chunkGridPosition[1] * yTileSize;
    chunkPosition[2] = chunkGridPosition[2];

    // GET
    // /v1/owner/{owner}/project/{project}/stack/{stack}/z/{z}/box/{x},{y},{width},{height},{scale}/jpeg-image
    let imageMethod: string;
    if (parameters.encoding === "raw16") {
      imageMethod = "raw16-image";
    } else {
      imageMethod = "jpeg-image";
    }
    const path = `/render-ws/v1/owner/${parameters.owner}/project/${parameters.project}/stack/${parameters.stack}/z/${chunkPosition[2]}/box/${chunkPosition[0]},${chunkPosition[1]},${xTileSize},${yTileSize},${scale}/${imageMethod}`;
    const response = await fetchOk(
      `${parameters.baseUrl}${path}?${this.queryString}`,
      { signal: abortSignal },
    );
    await this.chunkDecoder(chunk, abortSignal, await response.arrayBuffer());
  }
}
