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

import {registerChunkSource} from 'neuroglancer/chunk_manager/backend';
import {makeRequest, HttpCall, ChangeSpecPayload, ChangeStackAwarePayload, MeshFragmentPayload, SkeletonPayload, SubvolumePayload} from 'neuroglancer/datasource/brainmaps/api';
import {ChangeSpec, MeshSourceParameters, SkeletonSourceParameters, VolumeChunkEncoding, VolumeSourceParameters} from 'neuroglancer/datasource/brainmaps/base';
import {decodeJsonManifestChunk, decodeTriangleVertexPositionsAndIndices, FragmentChunk, ManifestChunk, ParameterizedMeshSource} from 'neuroglancer/mesh/backend';
import {decodeSkeletonVertexPositionsAndIndices, ParameterizedSkeletonSource, SkeletonChunk} from 'neuroglancer/skeleton/backend';
import {ParameterizedVolumeChunkSource, VolumeChunk} from 'neuroglancer/sliceview/backend';
import {decodeCompressedSegmentationChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/compressed_segmentation';
import {decodeJpegChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/jpeg';
import {decodeRawChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/raw';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {Endianness} from 'neuroglancer/util/endian';
import {vec3Key} from 'neuroglancer/util/geom';
import {verifyObject, verifyObjectProperty, verifyStringArray} from 'neuroglancer/util/json';
import {inflate} from 'pako';

const CHUNK_DECODERS = new Map([
  [
    VolumeChunkEncoding.RAW,
    decodeRawChunk,
  ],
  [VolumeChunkEncoding.JPEG, decodeJpegChunk],
  [
    VolumeChunkEncoding.COMPRESSED_SEGMENTATION,
    decodeCompressedSegmentationChunk,
  ]
]);

function applyChangeStack(changeStack: ChangeSpec|undefined, payload: ChangeStackAwarePayload) {
  if (!changeStack) {
    return;
  }
  payload.change_spec = {
    change_stack_id: changeStack.changeStackId,
  };
  if (changeStack.timeStamp) {
    payload.change_spec.time_stamp = changeStack.timeStamp;
  }
  if (changeStack.skipEquivalences) {
    payload.change_spec.skip_equivalences = changeStack.skipEquivalences;
  }
}

@registerChunkSource(VolumeSourceParameters)
class VolumeChunkSource extends ParameterizedVolumeChunkSource<VolumeSourceParameters> {
  chunkDecoder = CHUNK_DECODERS.get(this.parameters.encoding)!;

  private applyEncodingParams(payload: SubvolumePayload) {
    let {encoding} = this.parameters;
    const compression_suffix = `/image_format_options.gzip_compression_level=6`;
    switch (encoding) {
      case VolumeChunkEncoding.RAW:
        payload.subvolume_format = 'RAW';
        break;
      case VolumeChunkEncoding.JPEG:
        payload.subvolume_format = 'SINGLE_IMAGE';
        payload.image_format_options = {
          image_format: 'JPEG',
          jpeg_quality: 70,
        };
        return;
      case VolumeChunkEncoding.COMPRESSED_SEGMENTATION:
        payload.subvolume_format = 'RAW';
        payload.image_format_options = {
          compressed_segmentation_block_size: vec3Key(this.spec.compressedSegmentationBlockSize!),
        };
        break;
      default:
        throw new Error(`Invalid encoding: ${encoding}`);
    }
  }

  download(chunk: VolumeChunk, cancellationToken: CancellationToken) {
    let {parameters} = this;
    let path: string;
    
    // chunkPosition must not be captured, since it will be invalidated by the next call to
    // computeChunkBounds.
    let chunkPosition = this.computeChunkBounds(chunk);
    let chunkDataSize = chunk.chunkDataSize!;
    path = `/v1/volumes/${parameters['volumeId']}/subvolume:binary`;

    let payload: SubvolumePayload = {
      geometry: {
        corner: vec3Key(chunkPosition),
        size: vec3Key(chunkDataSize),
        scale: parameters.scaleIndex,
      },
    };

    this.applyEncodingParams(payload);
    applyChangeStack(parameters.changeSpec, payload);

    let httpCall: HttpCall = {
      method: 'POST',
      payload: JSON.stringify(payload),
      path,
      responseType: 'arraybuffer'
    };
     
    return makeRequest(parameters['instance'], httpCall, cancellationToken)
        .then(response => this.chunkDecoder(chunk, response));
  }
};

function decodeManifestChunk(chunk: ManifestChunk, response: any) {
  return decodeJsonManifestChunk(chunk, response, 'fragmentKey');
}

function decodeManifestChunkWithSupervoxelIds(chunk: ManifestChunk, response: any) {
  verifyObject(response);
  const fragmentKeys = verifyObjectProperty(response, 'fragmentKey', verifyStringArray);
  const supervoxelIds = verifyObjectProperty(response, 'supervoxelId', verifyStringArray);
  const length = fragmentKeys.length;
  if (length !== supervoxelIds.length) {
    throw new Error('Expected fragmentKey and supervoxelId arrays to have the same length.');
  }
  chunk.fragmentIds =
      supervoxelIds.map((supervoxelId, index) => supervoxelId + '\0' + fragmentKeys[index]);
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
  private manifestDecoder = this.parameters.changeSpec !== undefined ?
      decodeManifestChunkWithSupervoxelIds :
      decodeManifestChunk;

  private listFragmentsParams = (() => {
    const {parameters} = this;
    const {changeSpec} = parameters;
    if (changeSpec !== undefined) {
      return `&header.changeStackId=${changeSpec.changeStackId}&return_supervoxel_ids=true`;
    }
    return '';
  })();

  download(chunk: ManifestChunk, cancellationToken: CancellationToken) {
    let {parameters} = this;
    const path = `/v1/objects/${parameters['volumeId']}/meshes/` +
        `${parameters['meshName']}:listfragments?object_id=${chunk.objectId}` +
        this.listFragmentsParams;
    let httpCall: HttpCall = {
      method: 'GET',
      path,
      responseType: 'json',
    };
    return makeRequest(parameters['instance'], httpCall, cancellationToken)
        .then(response => this.manifestDecoder(chunk, response));
  }

  downloadFragment(chunk: FragmentChunk, cancellationToken: CancellationToken) {
    let {parameters} = this;
    let objectId: string;
    let fragmentId = chunk.fragmentId!;
    if (parameters.changeSpec !== undefined) {
      const splitIndex = fragmentId.indexOf('\0');
      objectId = fragmentId.substring(0, splitIndex);
      fragmentId = fragmentId.substring(splitIndex + 1);
    } else {
      objectId = chunk.manifestChunk!.objectId.toString();
    }

    const path = `/v1/objects/${parameters['volumeId']}` +
      `/meshes/${parameters['meshName']}` +
      '/fragment:binary';
    
    let payload: MeshFragmentPayload = {
      fragment_key: fragmentId,
      object_id: objectId,
    };

    applyChangeStack(parameters.changeSpec, payload);
    
    let httpCall: HttpCall = {
      method: 'POST',
      path,
      payload: JSON.stringify(payload),
      responseType: 'arraybuffer',
    };

    return makeRequest(parameters['instance'], httpCall, cancellationToken)
        .then(response => decodeFragmentChunk(chunk, response));
  }
}

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
  download(chunk: SkeletonChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;
    let payload: SkeletonPayload = {
      object_id: `${chunk.objectId}`,
    };
    const path = `/v1/objects/${parameters['volumeId']}` +
      `/meshes/${parameters['meshName']}` +
      '/skeleton:binary';
    applyChangeStack(parameters.changeSpec, payload);
    let httpCall: HttpCall = {
      method: 'POST',
      path,
      payload: JSON.stringify(payload),
      responseType: 'arraybuffer',
    };
    return makeRequest(parameters['instance'], httpCall, cancellationToken)
        .then(response => decodeSkeletonChunk(chunk, response));
  }
}
