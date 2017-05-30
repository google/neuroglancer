/**
 * @license
 * Copyright 2017 Google Inc.
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

import 'neuroglancer/datasource/boss/api_backend';

import {registerChunkSource} from 'neuroglancer/chunk_manager/backend';
import {makeRequest, HttpHeader, HttpCall} from 'neuroglancer/datasource/boss/api';
import {VolumeChunkSourceParameters, MeshSourceParameters} from 'neuroglancer/datasource/boss/base';
import {ParameterizedVolumeChunkSource, VolumeChunk} from 'neuroglancer/sliceview/volume/backend';
import {decodeJsonManifestChunk, decodeTriangleVertexPositionsAndIndices, FragmentChunk, ManifestChunk, ParameterizedMeshSource} from 'neuroglancer/mesh/backend';
import {ChunkDecoder} from 'neuroglancer/sliceview/backend_chunk_decoders';
import {decodeJpegChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/jpeg';
import {decodeBossNpzChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/bossNpz';
import {openShardedHttpRequest, sendHttpRequest} from 'neuroglancer/util/http_request';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {Endianness} from 'neuroglancer/util/endian';

let chunkDecoders = new Map<string, ChunkDecoder>();
chunkDecoders.set('npz', decodeBossNpzChunk);
chunkDecoders.set('jpeg', decodeJpegChunk);

let acceptHeaders = new Map<string, string>();
acceptHeaders.set('npz', 'application/npygz');
acceptHeaders.set('jpeg', 'image/jpeg');

@registerChunkSource(VolumeChunkSourceParameters)
export class VolumeChunkSource extends ParameterizedVolumeChunkSource<VolumeChunkSourceParameters> {
  chunkDecoder = chunkDecoders.get(this.parameters.encoding)!;

  download(chunk: VolumeChunk, cancellationToken: CancellationToken) {
    let {parameters} = this;
    let path = 
      `/latest/cutout/${parameters.collection}/${parameters.experiment}/${parameters.channel}/${parameters.resolution}`;
    {
      // chunkPosition must not be captured, since it will be invalidated by the next call to
      // computeChunkBounds.
      let chunkPosition = this.computeChunkBounds(chunk);
      let chunkDataSize = chunk.chunkDataSize!;
      for (let i = 0; i < 3; ++i) {
        path += `/${chunkPosition[i]}:${chunkPosition[i] + chunkDataSize[i]}`;
      }
    }
    path += '/';

    if (parameters.window !== undefined) {
      path += `?window=${parameters.window[0]},${parameters.window[1]}`;
    }

    let acceptHeader: HttpHeader = {
        key: 'Accept',
        value: acceptHeaders.get(parameters.encoding)!
    }; 
    let httpCall: HttpCall = {
        method: 'GET',
        path: path,
        responseType: 'arraybuffer',
        headers: [acceptHeader]
    };
    return makeRequest(parameters.baseUrls, parameters.authServer, httpCall, cancellationToken)
      .then(response => this.chunkDecoder(chunk, response));
  }
};

function decodeManifestChunk(chunk: ManifestChunk, response: any) {
  return decodeJsonManifestChunk(chunk, response, 'fragments');
}

function decodeFragmentChunk(chunk: FragmentChunk, response: ArrayBuffer) {
  let dv = new DataView(response);
  let numVertices = dv.getUint32(0, true);
  let numVerticesHigh = dv.getUint32(4, true);
  if (numVerticesHigh !== 0) {
    throw new Error(`The number of vertices should not exceed 2^32-1.`);
  }
  decodeTriangleVertexPositionsAndIndices(
      chunk, response, Endianness.LITTLE, /*vertexByteOffset=*/8, numVertices);
}

@registerChunkSource(MeshSourceParameters)
export class MeshSource extends ParameterizedMeshSource<MeshSourceParameters> {
  download(chunk: ManifestChunk, cancellationToken: CancellationToken)
  {
    let {parameters} = this;
    let requestPath = `${parameters.path}/${chunk.objectId}`;
    return sendHttpRequest(
      openShardedHttpRequest(parameters.baseUrls, requestPath), 'json', cancellationToken)
      .then(response => decodeManifestChunk(chunk, response));
  }
  
  downloadFragment(chunk: FragmentChunk, cancellationToken: CancellationToken) {
    let {parameters} = this; 
    let requestPath = `${parameters.path}/${chunk.fragmentId}`;
    return sendHttpRequest(
      openShardedHttpRequest(parameters.baseUrls, requestPath), 'arraybuffer', cancellationToken)
      .then(response => decodeFragmentChunk(chunk, response)); 
  }
}