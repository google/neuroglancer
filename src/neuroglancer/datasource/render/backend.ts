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

import {handleChunkDownloadPromise, registerChunkSource} from 'neuroglancer/chunk_manager/backend';
import {TileChunkSourceParameters} from 'neuroglancer/datasource/render/base';
import {ParameterizedVolumeChunkSource, VolumeChunk} from 'neuroglancer/sliceview/backend';
import {ChunkDecoder} from 'neuroglancer/sliceview/backend_chunk_decoders';
import {decodeJpegChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/jpeg';
import {openShardedHttpRequest, sendHttpRequest} from 'neuroglancer/util/http_request';

let chunkDecoders = new Map<string, ChunkDecoder>();
chunkDecoders.set('jpg', decodeJpegChunk);

@registerChunkSource(TileChunkSourceParameters)
class TileChunkSource extends ParameterizedVolumeChunkSource<TileChunkSourceParameters> {
  chunkDecoder = chunkDecoders.get(this.parameters.encoding)!;

  download(chunk: VolumeChunk) {
    let {parameters} = this;
    let {chunkGridPosition} = chunk;

    // Needed by JPEG decoder.
    chunk.chunkDataSize = this.spec.chunkDataSize;

    // calculate scale
    let scale = 1.0 / Math.pow(2, parameters.level);

    let xTile = chunkGridPosition[0] * chunk.chunkDataSize[0];
    let yTile = chunkGridPosition[1] * chunk.chunkDataSize[1];

    // GET
    // /v1/owner/{owner}/project/{project}/stack/{stack}/z/{z}/box/{x},{y},{width},{height},{scale}/png-image
    let path =
        `/render-ws/v1/owner/${parameters.owner}/project/${parameters.project
        }/stack/${parameters.stack}/z/${chunkGridPosition[2]}/box/${xTile},${yTile},${chunk
            .chunkDataSize[0]},${chunk.chunkDataSize[1]},${scale}/jpeg-image`;

    handleChunkDownloadPromise(
        chunk, sendHttpRequest(openShardedHttpRequest(parameters.baseUrls, path), 'arraybuffer'),
        this.chunkDecoder);
  }
};
