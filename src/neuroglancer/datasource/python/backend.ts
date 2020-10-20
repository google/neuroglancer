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
import {MeshSourceParameters, SkeletonSourceParameters, VolumeChunkEncoding, VolumeChunkSourceParameters} from 'neuroglancer/datasource/python/base';
import {assignMeshFragmentData, decodeTriangleVertexPositionsAndIndices, FragmentChunk, ManifestChunk, MeshSource} from 'neuroglancer/mesh/backend';
import {SkeletonChunk, SkeletonSource} from 'neuroglancer/skeleton/backend';
import {decodeSkeletonChunk} from 'neuroglancer/skeleton/decode_precomputed_skeleton';
import {ChunkDecoder} from 'neuroglancer/sliceview/backend_chunk_decoders';
import {decodeJpegChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/jpeg';
import {decodeNdstoreNpzChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/ndstoreNpz';
import {decodeRawChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/raw';
import {VolumeChunk, VolumeChunkSource} from 'neuroglancer/sliceview/volume/backend';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {Endianness} from 'neuroglancer/util/endian';
import {cancellableFetchOk, responseArrayBuffer} from 'neuroglancer/util/http_request';
import {registerSharedObject} from 'neuroglancer/worker_rpc';

let chunkDecoders = new Map<VolumeChunkEncoding, ChunkDecoder>();
chunkDecoders.set(VolumeChunkEncoding.NPZ, decodeNdstoreNpzChunk);
chunkDecoders.set(VolumeChunkEncoding.JPEG, decodeJpegChunk);
chunkDecoders.set(VolumeChunkEncoding.RAW, decodeRawChunk);

@registerSharedObject() export class PythonVolumeChunkSource extends
(WithParameters(VolumeChunkSource, VolumeChunkSourceParameters)) {
  chunkDecoder = chunkDecoders.get(this.parameters['encoding'])!;
  encoding = VolumeChunkEncoding[this.parameters.encoding].toLowerCase();

  async download(chunk: VolumeChunk, cancellationToken: CancellationToken) {
    let {parameters} = this;
    let path = `../../neuroglancer/${this.encoding}/${parameters.key}/${parameters.scaleKey}`;
    {
      // chunkPosition must not be captured, since it will be invalidated by the next call to
      // computeChunkBounds.
      let chunkPosition = this.computeChunkBounds(chunk);
      const chunkDataSize = chunk.chunkDataSize!;
      const length = chunkPosition.length;
      path += `/${chunkPosition.join()}/`;
      for (let i = 0; i < length; ++i) {
        if (i !== 0) path += ',';
        path += (chunkPosition[i] + chunkDataSize[i]).toString();
      }
      
    }
    const response = await cancellableFetchOk(path, {}, responseArrayBuffer, cancellationToken);
    await this.chunkDecoder(chunk, cancellationToken, response);
  }
}

export function decodeFragmentChunk(chunk: FragmentChunk, response: ArrayBuffer) {
  let dv = new DataView(response);
  let numVertices = dv.getUint32(0, true);
  assignMeshFragmentData(
      chunk,
      decodeTriangleVertexPositionsAndIndices(
          response, Endianness.LITTLE, /*vertexByteOffset=*/ 4, numVertices));
}

@registerSharedObject() export class PythonMeshSource extends
(WithParameters(MeshSource, MeshSourceParameters)) {
  download(chunk: ManifestChunk) {
    // No manifest chunk to download, as there is always only a single fragment.
    chunk.fragmentIds = [''];
    return Promise.resolve(undefined);
  }

  downloadFragment(chunk: FragmentChunk, cancellationToken: CancellationToken) {
    let {parameters} = this;
    let requestPath = `../../neuroglancer/mesh/${parameters.key}/${chunk.manifestChunk!.objectId}`;
    return cancellableFetchOk(requestPath, {}, responseArrayBuffer, cancellationToken)
        .then(response => decodeFragmentChunk(chunk, response));
  }
}

@registerSharedObject() export class PythonSkeletonSource extends
(WithParameters(SkeletonSource, SkeletonSourceParameters)) {
  download(chunk: SkeletonChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;
    let requestPath = `../../neuroglancer/skeleton/${parameters.key}/${chunk.objectId}`;
    return cancellableFetchOk(requestPath, {}, responseArrayBuffer, cancellationToken)
        .then(response => decodeSkeletonChunk(chunk, response, parameters.vertexAttributes));
  }
}
