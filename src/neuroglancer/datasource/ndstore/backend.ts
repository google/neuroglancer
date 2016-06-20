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
import {VolumeChunk, VolumeChunkSource as GenericVolumeChunkSource} from 'neuroglancer/sliceview/backend';
import {ChunkDecoder} from 'neuroglancer/sliceview/backend_chunk_decoders';
import {decodeJpegChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/jpeg';
import {decodeNdstoreNpzChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/ndstoreNpz';
import {decodeRawChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/raw';
import {openShardedHttpRequest, sendHttpRequest} from 'neuroglancer/util/http_request';
import {RPC, registerSharedObject} from 'neuroglancer/worker_rpc';

let chunkDecoders = new Map<string, ChunkDecoder>();
chunkDecoders.set('npz', decodeNdstoreNpzChunk);
chunkDecoders.set('jpeg', decodeJpegChunk);
chunkDecoders.set('raw', decodeRawChunk);

class VolumeChunkSource extends GenericVolumeChunkSource {
  hostnames: string[];
  key: string;
  resolution: string;
  channel: string;
  encoding: string;
  chunkDecoder: ChunkDecoder;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.hostnames = options['hostnames'];
    this.key = options['key'];
    this.channel = options['channel'];
    this.resolution = options['resolution'];
    this.encoding = options['encoding'];

    this.chunkDecoder = chunkDecoders.get(this.encoding);
  }

  download(chunk: VolumeChunk) {
    let path = `/ocp/ca/${this.key}/${this.channel}/${this.encoding}/${this.resolution}`;
    {
      // chunkPosition must not be captured, since it will be invalidated by the next call to
      // computeChunkBounds.
      let chunkPosition = this.computeChunkBounds(chunk);
      let {chunkDataSize} = chunk;
      for (let i = 0; i < 3; ++i) {
        path += `/${chunkPosition[i]},${chunkPosition[i] + chunkDataSize[i]}`;
      }
    }
    path += `/neariso/`;
    handleChunkDownloadPromise(
        chunk, sendHttpRequest(openShardedHttpRequest(this.hostnames, path), 'arraybuffer'),
        this.chunkDecoder);
  }

  toString() {
    return `ndstore:volume:${this.hostnames[0]}/${this.key}/${this.channel}/${this.resolution}/${this.encoding}`;
  }
};
registerSharedObject('ndstore/VolumeChunkSource', VolumeChunkSource);
