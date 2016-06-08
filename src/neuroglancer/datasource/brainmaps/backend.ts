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

import {handleChunkDownloadPromise} from 'neuroglancer/chunk_manager/backend';
import {makeRequest} from 'neuroglancer/datasource/brainmaps/api';
import {VolumeChunkEncoding, VolumeSourceParameters, volumeSourceToString, MeshSourceParameters, meshSourceToString} from 'neuroglancer/datasource/brainmaps/base';
import {ManifestChunk, FragmentChunk, MeshSource as GenericMeshSource, decodeJsonManifestChunk, decodeVertexPositionsAndIndices} from 'neuroglancer/mesh/backend';
import {VolumeChunk, VolumeChunkSource as GenericVolumeChunkSource} from 'neuroglancer/sliceview/backend';
import {ChunkDecoder} from 'neuroglancer/sliceview/backend_chunk_decoders';
import {decodeCompressedSegmentationChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/compressed_segmentation';
import {decodeJpegChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/jpeg';
import {decodeRawChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/raw';
import {Endianness} from 'neuroglancer/util/endian';
import {vec3Key} from 'neuroglancer/util/geom';
import {RPC, registerSharedObject} from 'neuroglancer/worker_rpc';
import {inflate} from 'pako';

class VolumeChunkSource extends GenericVolumeChunkSource {
  parameters: VolumeSourceParameters;
  encodingParams: string;
  chunkDecoder: ChunkDecoder;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    let parameters = this.parameters = options['parameters'];
    const compression_suffix = `/image_format_options.gzip_compression_level=6`;
    switch (parameters['encoding']) {
      case VolumeChunkEncoding.RAW:
        this.chunkDecoder = (chunk, response) => {
          decodeRawChunk(chunk, inflate(new Uint8Array(response)).buffer);
        };
        this.encodingParams = `/subvolume_format=RAW${compression_suffix}`;
        break;
      case VolumeChunkEncoding.JPEG:
        this.chunkDecoder = decodeJpegChunk;
        this.encodingParams =
            '/subvolume_format=SINGLE_IMAGE/image_format_options.image_format=JPEG';
        break;
      case VolumeChunkEncoding.COMPRESSED_SEGMENTATION:
        this.chunkDecoder = (chunk, response) => {
          decodeCompressedSegmentationChunk(chunk, inflate(new Uint8Array(response)).buffer);
        };
        this.encodingParams =
            `/subvolume_format=RAW/image_format_options.compressed_segmentation_block_size=${vec3Key(this.spec.compressedSegmentationBlockSize)}${compression_suffix}`;
        break;
    }
  }

  download(chunk: VolumeChunk) {
    let {parameters} = this;
    let path: string;
    {
      // chunkPosition must not be captured, since it will be invalidated by the next call to
      // computeChunkBounds.
      let chunkPosition = this.computeChunkBounds(chunk);
      let {chunkDataSize} = chunk;
      path =
          `/v1beta2/binary/volumes/binary/volumes/subvolume/header.volume_id=${parameters['volume_id']}/geometry.corner=${vec3Key(chunkPosition)}/geometry.size=${vec3Key(chunkDataSize)}/geometry.scale=${parameters['scaleIndex']}${this.encodingParams}?alt=media`;
    }
    handleChunkDownloadPromise(
        chunk, makeRequest(parameters['instance'], 'GET', path, 'arraybuffer'), this.chunkDecoder);
  }
  toString() { return volumeSourceToString(this.parameters); }
};
registerSharedObject('brainmaps/VolumeChunkSource', VolumeChunkSource);

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
  decodeVertexPositionsAndIndices(
      chunk, response, Endianness.LITTLE, /*vertexByteOffset=*/8, numVertices);
}

class MeshSource extends GenericMeshSource {
  parameters: MeshSourceParameters;
  constructor (rpc: RPC, options: any) {
    super(rpc, options);
    this.parameters = options['parameters'];
  }

  download(chunk: ManifestChunk) {
    let {parameters} = this;
    const path = `/v1beta2/objects/${parameters['volume_id']}/meshes/${parameters['mesh_name']}:listfragments?object_id=${chunk.objectId}`;
    handleChunkDownloadPromise(
        chunk, makeRequest(parameters['instance'], 'GET', path, 'json'), decodeManifestChunk);
  }

  downloadFragment(chunk: FragmentChunk) {
    let {parameters} = this;
    const path =
        `/v1beta2/binary/objects/binary/objects/fragment/header.volume_id=${parameters['volume_id']}/mesh_name=${parameters['mesh_name']}/fragment_key=${chunk.fragmentId}/object_id=${chunk.manifestChunk.objectId}?alt=media`;
    handleChunkDownloadPromise(
        chunk, makeRequest(parameters['instance'], 'GET', path, 'arraybuffer'),
        decodeFragmentChunk);
  }

  toString() { return meshSourceToString(this.parameters); }
};
registerSharedObject('brainmaps/MeshSource', MeshSource);
