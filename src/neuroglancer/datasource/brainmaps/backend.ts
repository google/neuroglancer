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

import 'neuroglancer/datasource/brainmaps/api_backend';

import {handleChunkDownloadPromise, registerChunkSource} from 'neuroglancer/chunk_manager/backend';
import {makeRequest} from 'neuroglancer/datasource/brainmaps/api';
import {MeshSourceParameters, SkeletonSourceParameters, VolumeChunkEncoding, VolumeSourceParameters} from 'neuroglancer/datasource/brainmaps/base';
import {FragmentChunk, ManifestChunk, ParameterizedMeshSource, decodeJsonManifestChunk, decodeTriangleVertexPositionsAndIndices} from 'neuroglancer/mesh/backend';
import {ParameterizedSkeletonSource, SkeletonChunk, decodeSkeletonVertexPositionsAndIndices} from 'neuroglancer/skeleton/backend';
import {ParameterizedVolumeChunkSource, VolumeChunk} from 'neuroglancer/sliceview/backend';
import {decodeCompressedSegmentationChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/compressed_segmentation';
import {decodeJpegChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/jpeg';
import {decodeRawChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/raw';
import {Endianness} from 'neuroglancer/util/endian';
import {vec3Key} from 'neuroglancer/util/geom';
import {inflate} from 'pako';

export function decodeGzippedRawChunk(chunk: VolumeChunk, response: ArrayBuffer) {
  decodeRawChunk(chunk, inflate(new Uint8Array(response)).buffer);
}

export function decodeGzippedCompressedSegmentationChunk(
    chunk: VolumeChunk, response: ArrayBuffer) {
  decodeCompressedSegmentationChunk(chunk, inflate(new Uint8Array(response)).buffer);
}

const CHUNK_DECODERS = new Map([
  [
    VolumeChunkEncoding.RAW,
    decodeGzippedRawChunk,
  ],
  [VolumeChunkEncoding.JPEG, decodeJpegChunk],
  [
    VolumeChunkEncoding.COMPRESSED_SEGMENTATION,
    decodeGzippedCompressedSegmentationChunk,
  ]
]);


@registerChunkSource(VolumeSourceParameters)
class VolumeChunkSource extends ParameterizedVolumeChunkSource<VolumeSourceParameters> {
  encodingParams = this.getEncodingParams();
  chunkDecoder = CHUNK_DECODERS.get(this.parameters.encoding)!;

  private getEncodingParams() {
    let {encoding} = this.parameters;
    const compression_suffix = `/image_format_options.gzip_compression_level=6`;
    switch (encoding) {
      case VolumeChunkEncoding.RAW:
        return `/subvolume_format=RAW${compression_suffix}`;
      case VolumeChunkEncoding.JPEG:
        return '/subvolume_format=SINGLE_IMAGE/image_format_options.image_format=JPEG';
      case VolumeChunkEncoding.COMPRESSED_SEGMENTATION:
        return `/subvolume_format=RAW/image_format_options.compressed_segmentation_block_size=${vec3Key(this.spec.compressedSegmentationBlockSize!)}${compression_suffix}`;
      default:
        throw new Error(`Invalid encoding: ${encoding}`);
    }
  }

  download(chunk: VolumeChunk) {
    let {parameters} = this;
    let path: string;
    {
      // chunkPosition must not be captured, since it will be invalidated by the next call to
      // computeChunkBounds.
      let chunkPosition = this.computeChunkBounds(chunk);
      let chunkDataSize = chunk.chunkDataSize!;
      path =
          `/v1beta2/binary/volumes/binary/volumes/subvolume/header.volume_id=${parameters['volume_id']}/geometry.corner=${vec3Key(chunkPosition)}/geometry.size=${vec3Key(chunkDataSize)}/geometry.scale=${parameters['scaleIndex']}${this.encodingParams}?alt=media`;
    }
    handleChunkDownloadPromise(
        chunk, makeRequest(parameters['instance'], 'GET', path, 'arraybuffer'), this.chunkDecoder);
  }
};

function decodeManifestChunk(chunk: ManifestChunk, response: any) {
  return decodeJsonManifestChunk(chunk, response, 'fragmentKey');
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
class MeshSource extends ParameterizedMeshSource<MeshSourceParameters> {
  download(chunk: ManifestChunk) {
    let {parameters} = this;
    const path =
        `/v1beta2/objects/${parameters['volume_id']}/meshes/${parameters['mesh_name']}:listfragments?object_id=${chunk.objectId}`;
    handleChunkDownloadPromise(
        chunk, makeRequest(parameters['instance'], 'GET', path, 'json'), decodeManifestChunk);
  }

  downloadFragment(chunk: FragmentChunk) {
    let {parameters} = this;
    const path =
        `/v1beta2/binary/objects/binary/objects/fragment/header.volume_id=${parameters['volume_id']}/mesh_name=${parameters['mesh_name']}/fragment_key=${chunk.fragmentId}/object_id=${chunk.manifestChunk!.objectId}?alt=media`;
    handleChunkDownloadPromise(
        chunk, makeRequest(parameters['instance'], 'GET', path, 'arraybuffer'),
        decodeFragmentChunk);
  }
};

function decodeSkeletonChunk(chunk: SkeletonChunk, response: ArrayBuffer) {
  let dv = new DataView(response);
  let numVertices = dv.getUint32(0, true);
  let numVerticesHigh = dv.getUint32(4, true);
  if (numVerticesHigh !== 0) {
    throw new Error(`The number of vertices should not exceed 2^32-1.`);
  }
  let numEdges = dv.getUint32(8, true);
  let numEdgesHigh = dv.getUint32(12, true);
  if (numEdgesHigh !== 0) {
    throw new Error(`The number of edges should not exceed 2^32-1.`);
  }
  decodeSkeletonVertexPositionsAndIndices(
      chunk, response, Endianness.LITTLE, /*vertexByteOffset=*/16, numVertices,
    /*indexByteOffset=*/undefined, /*numEdges=*/numEdges);
}

@registerChunkSource(SkeletonSourceParameters)
export class SkeletonSource extends ParameterizedSkeletonSource<SkeletonSourceParameters> {
  download(chunk: SkeletonChunk) {
    const {parameters} = this;
    const path =
        `/v1beta2/binary/objects/binary/objects/skeleton/header.volume_id=${parameters['volume_id']}/mesh_name=${parameters['mesh_name']}/object_id=${chunk.objectId}?alt=media`;
    handleChunkDownloadPromise(
        chunk, makeRequest(parameters['instance'], 'GET', path, 'arraybuffer'),
        decodeSkeletonChunk);
  }
};
