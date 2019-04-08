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

import {WithParameters} from 'neuroglancer/chunk_manager/backend';
import {ChunkSourceParametersConstructor} from 'neuroglancer/chunk_manager/base';
import {WithSharedCredentialsProviderCounterpart} from 'neuroglancer/credentials_provider/shared_counterpart';
import {BossToken, HttpCall, HttpHeader, makeRequest} from 'neuroglancer/datasource/boss/api';
import {MeshSourceParameters, VolumeChunkSourceParameters} from 'neuroglancer/datasource/boss/base';
import { decodeJsonManifestChunk, decodeTriangleVertexPositionsAndIndices, FragmentChunk, ManifestChunk, MeshSource, assignMeshFragmentData} from 'neuroglancer/mesh/backend';
import {ChunkDecoder} from 'neuroglancer/sliceview/backend_chunk_decoders';
import {decodeBossNpzChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/bossNpz';
import {decodeJpegChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/jpeg';
import {VolumeChunk, VolumeChunkSource} from 'neuroglancer/sliceview/volume/backend';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {Endianness} from 'neuroglancer/util/endian';
import {openShardedHttpRequest, sendHttpRequest} from 'neuroglancer/util/http_request';
import {registerSharedObject, SharedObject} from 'neuroglancer/worker_rpc';

let chunkDecoders = new Map<string, ChunkDecoder>();
chunkDecoders.set('npz', decodeBossNpzChunk);
chunkDecoders.set('jpeg', decodeJpegChunk);

let acceptHeaders = new Map<string, string>();
acceptHeaders.set('npz', 'application/npygz');
acceptHeaders.set('jpeg', 'image/jpeg');

function BossSource<Parameters, TBase extends {new (...args: any[]): SharedObject}>(
    Base: TBase, parametersConstructor: ChunkSourceParametersConstructor<Parameters>) {
  return WithParameters(
      WithSharedCredentialsProviderCounterpart<BossToken>()(Base), parametersConstructor);
}

@registerSharedObject()
export class BossVolumeChunkSource extends (BossSource(VolumeChunkSource, VolumeChunkSourceParameters)) {
  chunkDecoder = chunkDecoders.get(this.parameters.encoding)!;

  download(chunk: VolumeChunk, cancellationToken: CancellationToken) {
    let {parameters} = this;
    let path = `/latest/cutout/${parameters.collection}/${parameters.experiment}/${
        parameters.channel}/${parameters.resolution}`;
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

    let acceptHeader: HttpHeader = {key: 'Accept', value: acceptHeaders.get(parameters.encoding)!};
    let httpCall: HttpCall = {method: 'GET', path: path, responseType: 'arraybuffer', headers: [acceptHeader]};
    return makeRequest(parameters.baseUrls, this.credentialsProvider, httpCall, cancellationToken)
        .then(response => this.chunkDecoder(chunk, response));
  }
}

function decodeManifestChunk(chunk: ManifestChunk, response: any) {
  return decodeJsonManifestChunk(chunk, response, 'fragments');
}

function decodeFragmentChunk(chunk: FragmentChunk, response: ArrayBuffer) {
  let dv = new DataView(response);
  let numVertices = dv.getUint32(0, true);
  assignMeshFragmentData(
      chunk,
      decodeTriangleVertexPositionsAndIndices(
          response, Endianness.LITTLE, /*vertexByteOffset=*/ 4, numVertices));
}

@registerSharedObject()
export class BossMeshSource extends (BossSource(MeshSource, MeshSourceParameters)) {
  download(chunk: ManifestChunk, cancellationToken: CancellationToken) {
    let {parameters} = this;
    let requestPath = `${chunk.objectId}`;
    return sendHttpRequest(
               openShardedHttpRequest(parameters.baseUrls, requestPath), 'json', cancellationToken)
        .then(response => decodeManifestChunk(chunk, response));
  }

  downloadFragment(chunk: FragmentChunk, cancellationToken: CancellationToken) {
    let {parameters} = this;
    let requestPath = `${chunk.fragmentId}`;
    return sendHttpRequest(
               openShardedHttpRequest(parameters.baseUrls, requestPath), 'arraybuffer',
               cancellationToken)
        .then(response => decodeFragmentChunk(chunk, response));
  }
}
