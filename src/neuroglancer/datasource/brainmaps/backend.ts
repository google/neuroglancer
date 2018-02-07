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
import {ChunkSourceParametersConstructor} from 'neuroglancer/chunk_manager/base';
import {WithSharedCredentialsProviderCounterpart} from 'neuroglancer/credentials_provider/shared_counterpart';
import {ChangeSpec, MeshSourceParameters, SkeletonSourceParameters, VolumeChunkEncoding, VolumeSourceParameters} from 'neuroglancer/datasource/brainmaps/base';
import {BatchMeshFragment, BatchMeshFragmentPayload, ChangeStackAwarePayload, Credentials, makeRequest, SkeletonPayload, SubvolumePayload} from 'neuroglancer/datasource/brainmaps/api';
import {computeVertexNormals, decodeJsonManifestChunk, FragmentChunk, ManifestChunk, MeshSource} from 'neuroglancer/mesh/backend';
import {Bounds} from 'neuroglancer/segmentation_display_state/base';
import {decodeSkeletonVertexPositionsAndIndices, SkeletonChunk, SkeletonSource} from 'neuroglancer/skeleton/backend';
import {decodeCompressedSegmentationChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/compressed_segmentation';
import {decodeJpegChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/jpeg';
import {decodeRawChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/raw';
import {VolumeChunk, VolumeChunkSource} from 'neuroglancer/sliceview/volume/backend';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {decodeMorton, vec3, vec3Key} from 'neuroglancer/util/geom';
import {verifyObject, verifyObjectProperty, verifyStringArray} from 'neuroglancer/util/json';
import {convertEndian32, Endianness} from 'neuroglancer/util/endian';
import {Uint64} from 'neuroglancer/util/uint64';
import {registerSharedObject, SharedObject} from 'neuroglancer/worker_rpc';

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

function BrainmapsSource<Parameters, TBase extends {new (...args: any[]): SharedObject}>(
    Base: TBase, parametersConstructor: ChunkSourceParametersConstructor<Parameters>) {
  return WithParameters(
      WithSharedCredentialsProviderCounterpart<Credentials>()(Base), parametersConstructor);
}

@registerSharedObject()
export class BrainmapsVolumeChunkSource extends
(BrainmapsSource(VolumeChunkSource, VolumeSourceParameters)) {
  chunkDecoder = CHUNK_DECODERS.get(this.parameters.encoding)!;

  private applyEncodingParams(payload: SubvolumePayload) {
    let {encoding} = this.parameters;
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

    return makeRequest(
               parameters['instance'], this.credentialsProvider, {
                 method: 'POST',
                 payload: JSON.stringify(payload),
                 path,
                 responseType: 'arraybuffer',
               },
               cancellationToken)
        .then(response => this.chunkDecoder(chunk, response));
  }
}

function decodeManifestChunk(chunk: ManifestChunk, response: any) {
  decodeJsonManifestChunk(chunk, response, 'fragmentKey');
  if (chunk.clipBounds) {
    chunk.fragmentIds = filterFragments(chunk.fragmentIds!, chunk.clipBounds);
  }
  chunk.fragmentIds = groupFragmentsIntoBatches(chunk.fragmentIds!);
  return chunk;
}

function filterFragments(fragmentIds: string[], clipBounds: Bounds) {
  clipBounds;
  if (!fragmentIds) {
    return fragmentIds;
  }

  let filteredFragments = [];
  for (let fragmentId of fragmentIds) {
    // TODO(blakely): Hardcoded for now, remove when we can filter on the backend.
    const fragmentSize = 500;
    let fragmentBounds =
        getFragmentBounds(fragmentId, vec3.clone([fragmentSize, fragmentSize, fragmentSize]));
    if (boundsIntersect(fragmentBounds, clipBounds)) {
      filteredFragments.push(fragmentId);
    }
  }

  return filteredFragments;
}

function getFragmentBounds(fragmentId: string, fragmentSize: vec3): Bounds {
  let corner = getFragmentCorner(fragmentId, fragmentSize);

  let halfSize = vec3.create();
  vec3.scale(halfSize, fragmentSize, 0.5);
  let center = vec3.create();
  vec3.add(center, corner, halfSize);

  return {
    center,
    size: fragmentSize,
  };
}

function getFragmentCorner(fragmentId: string, fragmentSize: vec3) {
  let id = new Uint64();
  if (!id.tryParseString(fragmentId, 16)) {
    throw new Error(`Couldn't parse fragmentId ${fragmentId} as hex-encoded Uint64`);
  }
  if (id.high) {
    throw new Error(`Fragment ids > 2^32 not supported yet`);
  }
  const chunkCoord = decodeMorton(id);
  let worldCoord = vec3.create();
  return vec3.mul(worldCoord, chunkCoord, fragmentSize);
}

function boundsIntersect(first: Bounds, second: Bounds) {
  function transformCorner(point: vec3, size: vec3, sign: 1|- 1) {
    return [...point.map((value, idx) => value + sign * size[idx] / 2).values()];
  }

  function toMaxMinBounds(input: Bounds) {
    return {
      min: vec3.clone(transformCorner(input.center, input.size, -1)),
      max: vec3.clone(transformCorner(input.center, input.size, 1)),
    };
  }

  const a = toMaxMinBounds(first);
  const b = toMaxMinBounds(second);
  return (a.min[0] <= b.max[0] && a.max[0] >= b.min[0]) &&
      (a.min[1] <= b.max[1] && a.max[1] >= b.min[1]) &&
      (a.min[2] <= b.max[2] && a.max[2] >= b.min[2]);
}

function decodeManifestChunkWithSupervoxelIds(chunk: ManifestChunk, response: any) {
  verifyObject(response);
  const fragmentKeys = verifyObjectProperty(response, 'fragmentKey', verifyStringArray);
  const supervoxelIds = verifyObjectProperty(response, 'supervoxelId', verifyStringArray);
  const length = fragmentKeys.length;
  if (length !== supervoxelIds.length) {
    throw new Error('Expected fragmentKey and supervoxelId arrays to have the same length.');
  }
  let fragmentIds =
      supervoxelIds.map((supervoxelId, index) => supervoxelId + '\0' + fragmentKeys[index]);
  if (chunk.clipBounds) {
    fragmentIds = filterFragments(fragmentIds, chunk.clipBounds);
  }
  chunk.fragmentIds = groupFragmentsIntoBatches(fragmentIds);
}

const batchSize = 100;

function groupFragmentsIntoBatches(ids: string[]) {
  const batches = [];
  let index = 0;
  const length = ids.length;
  while (index < length) {
    batches.push(JSON.stringify(ids.slice(index, index + batchSize)));
    index += batchSize;
  }
  return batches;
}

@registerSharedObject() export class BrainmapsMeshSource extends
(BrainmapsSource(MeshSource, MeshSourceParameters)) {
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
    return makeRequest(
               parameters['instance'], this.credentialsProvider, {
                 method: 'GET',
                 path,
                 responseType: 'json',
               },
               cancellationToken)
        .then(response => this.manifestDecoder(chunk, response));
  }

  downloadFragment(chunk: FragmentChunk, cancellationToken: CancellationToken) {
    let {parameters} = this;

    const path = `/v1/objects/meshes:batch`;

    const ids = new Set<string>(JSON.parse(chunk.fragmentId!));

    let totalVertices = 0;
    let totalIndices = 0;
    let fragments: {
      buffer: ArrayBuffer,
      verticesOffset: number,
      indicesOffset: number,
      numVertices: number,
      numIndices: number
    }[] = [];

    function copyMeshData() {
      const vertexBuffer = new Float32Array(totalVertices * 3);
      const indexBuffer = new Uint32Array(totalIndices);
      let vertexOffset = 0;
      let indexOffset = 0;
      for (const fragment of fragments) {
        vertexBuffer.set(
            new Float32Array(fragment.buffer, fragment.verticesOffset, fragment.numVertices * 3),
            vertexOffset * 3);
        const {numIndices} = fragment;
        const sourceIndices = new Uint32Array(fragment.buffer, fragment.indicesOffset, numIndices);
        convertEndian32(sourceIndices, Endianness.LITTLE);
        for (let i = 0; i < numIndices; ++i) {
          indexBuffer[indexOffset++] = sourceIndices[i] + vertexOffset;
        }
        vertexOffset += fragment.numVertices;
      }
      convertEndian32(vertexBuffer, Endianness.LITTLE);
      chunk.vertexPositions = vertexBuffer;
      chunk.indices = indexBuffer;
      chunk.vertexNormals = computeVertexNormals(vertexBuffer, indexBuffer);
    }
    function decodeResponse(response: ArrayBuffer): Promise<void>|void {
      let length = response.byteLength;
      let index = 0;
      const dataView = new DataView(response);
      const headerSize =
          /*object id*/ 8 + /*fragment key length*/ 8 + /*num vertices*/ 8 + /*num triangles*/ 8;
      while (index < length) {
        if (index + headerSize > length) {
          throw new Error(`Invalid batch mesh fragment response.`);
        }
        let prefix: string;
        if (parameters.changeSpec !== undefined) {
          const objectIdLow = dataView.getUint32(index, /*littleEndian=*/true);
          const objectIdHigh = dataView.getUint32(index + 4, /*littleEndian=*/true);
          const objectIdString = new Uint64(objectIdLow, objectIdHigh).toString();
          prefix = objectIdString + '\0';
        } else {
          prefix = '';
        }
        index += 8;
        const fragmentKeyLength = dataView.getUint32(index, /*littleEndian=*/true);
        const fragmentKeyLengthHigh = dataView.getUint32(index + 4, /*littleEndian=*/true);
        index += 8;
        if (fragmentKeyLengthHigh !== 0) {
          throw new Error(`Invalid batch mesh fragment response.`);
        }
        if (index + fragmentKeyLength + /* num vertices */ 8 + /*num indices*/ 8 > length) {
          throw new Error(`Invalid batch mesh fragment response.`);
        }
        const fragmentKey =
            new TextDecoder().decode(new Uint8Array(response, index, fragmentKeyLength));
        const fullKey = prefix + fragmentKey;
        if (!ids.delete(fullKey)) {
          throw new Error(`Received unexpected fragment key: ${JSON.stringify(fullKey)}.`);
        }
        index += fragmentKeyLength;
        const numVertices = dataView.getUint32(index, /*littleEndian=*/true);
        const numVerticesHigh = dataView.getUint32(index + 4, /*littleEndian=*/true);
        index += 8;
        const numTriangles = dataView.getUint32(index, /*littleEndian=*/true);
        const numTrianglesHigh = dataView.getUint32(index + 4, /*littleEndian=*/true);
        index += 8;
        if (numVerticesHigh !== 0 || numTrianglesHigh !== 0) {
          throw new Error(`Invalid batch mesh fragment response.`);
        }
        const endOffset = index + numTriangles * 12 + numVertices * 12;
        if (endOffset > length) {
          throw new Error(`Invalid batch mesh fragment response.`);
        }
        totalVertices += numVertices;
        totalIndices += numTriangles * 3;
        fragments.push({
          buffer: response,
          verticesOffset: index,
          numVertices,
          indicesOffset: index + 12 * numVertices,
          numIndices: numTriangles * 3,
        });
        index = endOffset;
      }

      if (ids.size !== 0) {
        // Partial response received.
        return makeBatchRequest();
      }
      copyMeshData();
    }

    const {credentialsProvider} = this;

    function makeBatchRequest(): Promise<void> {
      const batches: BatchMeshFragment[] = [];

      if (parameters.changeSpec !== undefined) {
        let prevObjectId: string|undefined;
        for (const id of ids) {
          const splitIndex = id.indexOf('\0');
          const objectId = id.substring(0, splitIndex);
          const fragmentId = id.substring(splitIndex + 1);
          if (objectId !== prevObjectId) {
            batches.push({object_id: objectId, fragment_keys: []});
          }
          batches[batches.length - 1].fragment_keys.push(fragmentId);
        }
      } else {
        batches.push(
            {object_id: chunk.manifestChunk!.objectId.toString(), fragment_keys: Array.from(ids)});
      }
      const payload: BatchMeshFragmentPayload = {
        volume_id: parameters.volumeId,
        mesh_name: parameters.meshName,
        batches: batches,
      };
      return makeRequest(
                 parameters['instance'], credentialsProvider, {
                   method: 'POST',
                   path,
                   payload: JSON.stringify(payload),
                   responseType: 'arraybuffer',
                 },
                 cancellationToken)
          .then(decodeResponse);
    }
    return makeBatchRequest();
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

@registerSharedObject() export class BrainmapsSkeletonSource extends
(BrainmapsSource(SkeletonSource, SkeletonSourceParameters)) {
  download(chunk: SkeletonChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;
    let payload: SkeletonPayload = {
      object_id: `${chunk.objectId}`,
    };
    const path = `/v1/objects/${parameters['volumeId']}` +
        `/meshes/${parameters['meshName']}` +
        '/skeleton:binary';
    applyChangeStack(parameters.changeSpec, payload);
    return makeRequest(
               parameters['instance'], this.credentialsProvider, {
                 method: 'POST',
                 path,
                 payload: JSON.stringify(payload),
                 responseType: 'arraybuffer',
               },
               cancellationToken)
        .then(response => decodeSkeletonChunk(chunk, response));
  }
}
