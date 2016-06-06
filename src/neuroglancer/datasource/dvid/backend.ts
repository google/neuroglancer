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

import {handleChunkDownloadPromise} from 'neuroglancer/chunk_manager/backend';
import {VolumeChunkSourceParameters, volumeSourceToString, TileChunkSourceParameters, tileSourceToString, TileEncoding} from 'neuroglancer/datasource/dvid/base';
import {VolumeChunk, VolumeChunkSource as GenericVolumeChunkSource} from 'neuroglancer/sliceview/backend';
import {ChunkDecoder} from 'neuroglancer/sliceview/backend_chunk_decoders';
import {decodeJpegChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/jpeg';
import {decodeRawChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/raw';
import {sendHttpRequest, openShardedHttpRequest} from 'neuroglancer/util/http_request';
import {RPC, registerSharedObject} from 'neuroglancer/worker_rpc';

const TILE_CHUNK_DECODERS = new Map<TileEncoding, ChunkDecoder>([
  [TileEncoding.JPEG, decodeJpegChunk],
]);

class VolumeChunkSource extends GenericVolumeChunkSource {
  parameters: VolumeChunkSourceParameters;
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.parameters = options['parameters'];
  }

  download(chunk: VolumeChunk) {
    let params = this.parameters;
    let path: string;
    {
      // chunkPosition must not be captured, since it will be invalidated by the next call to
      // computeChunkBounds.
      let chunkPosition = this.computeChunkBounds(chunk);
      let {chunkDataSize} = chunk;
      path = `/api/node/${params['nodeKey']}/${params['dataInstanceKey']}/raw/0_1_2/${chunkDataSize[0]}_${chunkDataSize[1]}_${chunkDataSize[2]}/${chunkPosition[0]}_${chunkPosition[1]}_${chunkPosition[2]}/nd`;
    }
    handleChunkDownloadPromise(
        chunk, sendHttpRequest(openShardedHttpRequest(params.baseUrls, path), 'arraybuffer'),
        decodeRawChunk);
  }
  toString() { return volumeSourceToString(this.parameters); }
};
registerSharedObject('dvid/VolumeChunkSource', VolumeChunkSource);

class TileChunkSource extends GenericVolumeChunkSource {
  parameters: TileChunkSourceParameters;
  chunkDecoder: ChunkDecoder;
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.parameters = options['parameters'];
    this.chunkDecoder = TILE_CHUNK_DECODERS.get(this.parameters['encoding']);
  }

  download(chunk: VolumeChunk) {
    let params = this.parameters;
    let {chunkGridPosition} = chunk;

    // Needed by decoder.
    chunk.chunkDataSize = this.spec.chunkDataSize;
    let path = `/api/node/${params['nodeKey']}/${params['dataInstanceKey']}/tile/${params['dims']}/${params['level']}/${chunkGridPosition[0]}_${chunkGridPosition[1]}_${chunkGridPosition[2]}`;
    handleChunkDownloadPromise(
        chunk, sendHttpRequest(openShardedHttpRequest(params.baseUrls, path), 'arraybuffer'),
      this.chunkDecoder);
  }
  toString() { return tileSourceToString(this.parameters); }
};
registerSharedObject('dvid/TileChunkSource', TileChunkSource);
