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
import {VolumeChunkEncoding} from 'neuroglancer/datasource/precomputed/base';
import {ManifestChunk, FragmentChunk, MeshSource as GenericMeshSource, decodeJsonManifestChunk, decodeVertexPositionsAndIndices} from 'neuroglancer/mesh/backend';
import {VolumeChunk, VolumeChunkSource as GenericVolumeChunkSource} from 'neuroglancer/sliceview/backend';
import {ChunkDecoder} from 'neuroglancer/sliceview/backend_chunk_decoders';
import {decodeCompressedSegmentationChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/compressed_segmentation';
import {decodeJpegChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/jpeg';
import {decodeRawChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/raw';
import {Endianness} from 'neuroglancer/util/endian';
import {openShardedHttpRequest, sendHttpRequest} from 'neuroglancer/util/http_request';
import {RPC, registerSharedObject} from 'neuroglancer/worker_rpc';

const chunkDecoders = new Map<VolumeChunkEncoding, ChunkDecoder>();
chunkDecoders.set(VolumeChunkEncoding.RAW, decodeRawChunk);
chunkDecoders.set(VolumeChunkEncoding.JPEG, decodeJpegChunk);
chunkDecoders.set(VolumeChunkEncoding.COMPRESSED_SEGMENTATION, decodeCompressedSegmentationChunk);

class VolumeChunkSource extends GenericVolumeChunkSource {
  baseUrls: string[];
  path: string;
  encoding: VolumeChunkEncoding;
  chunkDecoder: ChunkDecoder;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.baseUrls = options['baseUrls'];
    this.path = options['path'];
    this.encoding = options['encoding'];
    this.chunkDecoder = chunkDecoders.get(this.encoding);
  }

  download(chunk: VolumeChunk) {
    let path: string;
    {
      // chunkPosition must not be captured, since it will be invalidated by the next call to
      // computeChunkBounds.
      let chunkPosition = this.computeChunkBounds(chunk);
      let {chunkDataSize} = chunk;
      path =
          `${this.path}/${chunkPosition[0]}-${chunkPosition[0] + chunkDataSize[0]}_${chunkPosition[1]}-${chunkPosition[1] + chunkDataSize[1]}_${chunkPosition[2]}-${chunkPosition[2] + chunkDataSize[2]}`;
    }
    handleChunkDownloadPromise(
        chunk, sendHttpRequest(openShardedHttpRequest(this.baseUrls, path), 'arraybuffer'),
        this.chunkDecoder);
  }
  toString () {
    return `precomputed:volume:${this.baseUrls[0]}/${this.path}`;
  }
};
registerSharedObject('precomputed/VolumeChunkSource', VolumeChunkSource);

export function decodeManifestChunk(chunk: ManifestChunk, response: any) {
  return decodeJsonManifestChunk(chunk, response, 'fragments');
}

export function decodeFragmentChunk(chunk: FragmentChunk, response: ArrayBuffer) {
  let dv = new DataView(response);
  let numVertices = dv.getUint32(0, true);
  decodeVertexPositionsAndIndices(
      chunk, response, Endianness.LITTLE, /*vertexByteOffset=*/4, numVertices);
}

export class MeshSource extends GenericMeshSource {
  baseUrls: string[];
  path: string;
  lod: number;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.baseUrls = options['baseUrls'];
    this.path = options['path'];
    this.lod = options['lod'];
  }

  download(chunk: ManifestChunk) {
    let requestPath = `${this.path}/${chunk.objectId}:${this.lod}`;
    handleChunkDownloadPromise(
        chunk, sendHttpRequest(openShardedHttpRequest(this.baseUrls, requestPath), 'json'),
        decodeManifestChunk);
  }

  downloadFragment(chunk: FragmentChunk) {
    let requestPath = `${this.path}/${chunk.fragmentId}`;
    handleChunkDownloadPromise(
        chunk, sendHttpRequest(openShardedHttpRequest(this.baseUrls, requestPath), 'arraybuffer'),
        decodeFragmentChunk);
  }
  toString () {
    return `precomputed:mesh:${this.baseUrls[0]}/${this.path}`;
  }
};
registerSharedObject('precomputed/MeshSource', MeshSource);
