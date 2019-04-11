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
import { decodeTriangleVertexPositionsAndIndices, FragmentChunk, ManifestChunk, MeshSource, assignMeshFragmentData} from 'neuroglancer/mesh/backend';
import {decodeSkeletonVertexPositionsAndIndices, SkeletonChunk, SkeletonSource} from 'neuroglancer/skeleton/backend';
import {VertexAttributeInfo} from 'neuroglancer/skeleton/base';
import {ChunkDecoder} from 'neuroglancer/sliceview/backend_chunk_decoders';
import {decodeJpegChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/jpeg';
import {decodeNdstoreNpzChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/ndstoreNpz';
import {decodeRawChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/raw';
import {VolumeChunk, VolumeChunkSource} from 'neuroglancer/sliceview/volume/backend';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {DATA_TYPE_BYTES} from 'neuroglancer/util/data_type';
import {convertEndian16, convertEndian32, Endianness} from 'neuroglancer/util/endian';
import {openHttpRequest, sendHttpRequest} from 'neuroglancer/util/http_request';
import {registerSharedObject} from 'neuroglancer/worker_rpc';

let chunkDecoders = new Map<VolumeChunkEncoding, ChunkDecoder>();
chunkDecoders.set(VolumeChunkEncoding.NPZ, decodeNdstoreNpzChunk);
chunkDecoders.set(VolumeChunkEncoding.JPEG, decodeJpegChunk);
chunkDecoders.set(VolumeChunkEncoding.RAW, decodeRawChunk);

@registerSharedObject() export class PythonVolumeChunkSource extends
(WithParameters(VolumeChunkSource, VolumeChunkSourceParameters)) {
  chunkDecoder = chunkDecoders.get(this.parameters['encoding'])!;
  encoding = VolumeChunkEncoding[this.parameters.encoding].toLowerCase();

  download(chunk: VolumeChunk, cancellationToken: CancellationToken) {
    let {parameters} = this;
    let path = `/neuroglancer/${this.encoding}/${parameters.key}/${parameters.scaleKey}`;
    {
      // chunkPosition must not be captured, since it will be invalidated by the next call to
      // computeChunkBounds.
      let chunkPosition = this.computeChunkBounds(chunk);
      let {chunkDataSize} = chunk;
      for (let i = 0; i < 3; ++i) {
        path += `/${chunkPosition[i]},${chunkPosition[i] + chunkDataSize![i]}`;
      }
    }
    return sendHttpRequest(openHttpRequest(path), 'arraybuffer', cancellationToken)
        .then(response => this.chunkDecoder(chunk, response));
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
    let requestPath = `/neuroglancer/mesh/${parameters.key}/${chunk.manifestChunk!.objectId}`;
    return sendHttpRequest(openHttpRequest(requestPath), 'arraybuffer', cancellationToken)
        .then(response => decodeFragmentChunk(chunk, response));
  }
}

function decodeSkeletonChunk(
    chunk: SkeletonChunk, response: ArrayBuffer,
    vertexAttributes: Map<string, VertexAttributeInfo>) {
  let dv = new DataView(response);
  let numVertices = dv.getUint32(0, true);
  let numEdges = dv.getUint32(4, true);

  const vertexPositionsStartOffset = 8;

  let curOffset = 8 + numVertices * 4 * 3;
  let attributes: Uint8Array[] = [];
  for (let info of vertexAttributes.values()) {
    const bytesPerVertex = DATA_TYPE_BYTES[info.dataType] * info.numComponents;
    const totalBytes = bytesPerVertex * numVertices;
    const attribute = new Uint8Array(response, curOffset, totalBytes);
    switch (bytesPerVertex) {
      case 2:
        convertEndian16(attribute, Endianness.LITTLE);
        break;
      case 4:
      case 8:
        convertEndian32(attribute, Endianness.LITTLE);
        break;
    }
    attributes.push(attribute);
    curOffset += totalBytes;
  }
  chunk.vertexAttributes = attributes;
  decodeSkeletonVertexPositionsAndIndices(
      chunk, response, Endianness.LITTLE, /*vertexByteOffset=*/vertexPositionsStartOffset,
      numVertices,
      /*indexByteOffset=*/curOffset, /*numEdges=*/numEdges);
}

@registerSharedObject() export class PythonSkeletonSource extends
(WithParameters(SkeletonSource, SkeletonSourceParameters)) {
  download(chunk: SkeletonChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;
    let requestPath = `/neuroglancer/skeleton/${parameters.key}/${chunk.objectId}`;
    return sendHttpRequest(openHttpRequest(requestPath), 'arraybuffer', cancellationToken)
        .then(response => decodeSkeletonChunk(chunk, response, parameters.vertexAttributes));
  }
}
