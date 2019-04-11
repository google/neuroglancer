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

import {Annotation, AnnotationId, AnnotationSerializer, AnnotationType} from 'neuroglancer/annotation';
import {AnnotationGeometryChunk, AnnotationGeometryData, AnnotationMetadataChunk, AnnotationSource, AnnotationSubsetGeometryChunk} from 'neuroglancer/annotation/backend';
import {WithParameters} from 'neuroglancer/chunk_manager/backend';
import {ChunkSourceParametersConstructor} from 'neuroglancer/chunk_manager/base';
import {CredentialsProvider} from 'neuroglancer/credentials_provider';
import {WithSharedCredentialsProviderCounterpart} from 'neuroglancer/credentials_provider/shared_counterpart';
import {BatchMeshFragment, BatchMeshFragmentPayload, BrainmapsInstance, ChangeStackAwarePayload, Credentials, makeRequest, SkeletonPayload, SubvolumePayload} from 'neuroglancer/datasource/brainmaps/api';
import {AnnotationSourceParameters, ChangeSpec, MeshSourceParameters, MultiscaleMeshSourceParameters, SkeletonSourceParameters, VolumeChunkEncoding, VolumeSourceParameters} from 'neuroglancer/datasource/brainmaps/base';
import {assignMeshFragmentData, assignMultiscaleMeshFragmentData, FragmentChunk, ManifestChunk, MeshSource, MultiscaleFragmentChunk, MultiscaleManifestChunk, MultiscaleMeshSource} from 'neuroglancer/mesh/backend';
import {MultiscaleMeshManifest} from 'neuroglancer/mesh/multiscale';
import {decodeSkeletonVertexPositionsAndIndices, SkeletonChunk, SkeletonSource} from 'neuroglancer/skeleton/backend';
import {decodeCompressedSegmentationChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/compressed_segmentation';
import {decodeJpegChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/jpeg';
import {decodeRawChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/raw';
import {VolumeChunk, VolumeChunkSource} from 'neuroglancer/sliceview/volume/backend';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {convertEndian32, Endianness} from 'neuroglancer/util/endian';
import {kInfinityVec, kZeroVec, vec3, vec3Key} from 'neuroglancer/util/geom';
import {parseArray, parseFixedLengthArray, verifyObject, verifyObjectProperty, verifyOptionalString, verifyString, verifyStringArray} from 'neuroglancer/util/json';
import {Uint64} from 'neuroglancer/util/uint64';
import {decodeZIndexCompressed, zorder3LessThan} from 'neuroglancer/util/zorder';
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

function getFragmentCorner(
    fragmentId: string, xBits: number, yBits: number, zBits: number): Uint32Array {
  const id = new Uint64();
  if (!id.tryParseString(fragmentId, 16)) {
    throw new Error(`Couldn't parse fragmentId ${fragmentId} as hex-encoded Uint64`);
  }
  return decodeZIndexCompressed(id, xBits, yBits, zBits);
}

interface BrainmapsMultiscaleManifestChunk extends MultiscaleManifestChunk {
  fragmentSupervoxelIds: {fragmentId: string, supervoxelIds: string[]}[];
}

function decodeMultiscaleManifestChunk(chunk: BrainmapsMultiscaleManifestChunk, response: any) {
  verifyObject(response);
  const source = chunk.source as BrainmapsMultiscaleMeshSource;
  const fragmentKeys = verifyObjectProperty(response, 'fragmentKey', verifyStringArray);
  const supervoxelIds = verifyObjectProperty(response, 'supervoxelId', verifyStringArray);
  const length = fragmentKeys.length;
  if (length !== supervoxelIds.length) {
    throw new Error('Expected fragmentKey and supervoxelId arrays to have the same length.');
  }
  const fragmentSupervoxelIds = new Map<string, string[]>();
  fragmentKeys.forEach((fragmentId, i) => {
    let ids = fragmentSupervoxelIds.get(fragmentId);
    if (ids === undefined) {
      ids = [];
      fragmentSupervoxelIds.set(fragmentId, ids);
    }
    ids.push(supervoxelIds[i]);
  });
  const {chunkShape, gridShape} = source.parameters.info;
  const chunkCoordinates = new Uint32Array(3 * fragmentSupervoxelIds.size);

  const xBits = Math.ceil(Math.log2(gridShape[0])), yBits = Math.ceil(Math.log2(gridShape[1])),
        zBits = Math.ceil(Math.log2(gridShape[2]));
  const fragmentIdAndCorners =
      Array.from(fragmentSupervoxelIds.entries()).map(([id, supervoxelIds]) => ({
                                                        fragmentId: id,
                                                        corner: getFragmentCorner(
                                                            id, xBits, yBits, zBits),
                                                        supervoxelIds
                                                      }));
  fragmentIdAndCorners.sort((a, b) => {
    return zorder3LessThan(
               a.corner[0], a.corner[1], a.corner[2], b.corner[0], b.corner[1], b.corner[2]) ?
        -1 :
        1;
  });
  let clipLowerBound: vec3, clipUpperBound: vec3;
  let minNumLods = 0;
  if (length === 0) {
    clipLowerBound = clipUpperBound = kZeroVec;
  } else {
    const minCoord = vec3.clone(kInfinityVec);
    const maxCoord = vec3.clone(kZeroVec);
    fragmentIdAndCorners.forEach((x, i) => {
      const {corner} = x;
      chunkCoordinates.set(corner, i * 3);
      for (let i = 0; i < 3; ++i) {
        minCoord[i] = Math.min(minCoord[i], corner[i]);
        maxCoord[i] = Math.max(maxCoord[i], corner[i]);
      }
    });
    let maxCoordValue = Math.max(...maxCoord);
    minNumLods = 1;
    while (maxCoordValue !== 0) {
      maxCoordValue >>>= 1;
      ++minNumLods;
    }
    clipLowerBound = vec3.multiply(minCoord, minCoord, chunkShape);
    clipUpperBound = vec3.add(maxCoord, vec3.multiply(maxCoord, maxCoord, chunkShape), chunkShape);
  }
  const lodScales: number[] = [];
  const {lods} = source.parameters.info;
  for (const lodInfo of lods) {
    lodScales[lodInfo.lod] = lodInfo.scale;
  }
  for (let lod = 0; lod < Math.max(lodScales.length, minNumLods); ++lod) {
    if (lodScales[lod] === undefined) {
      lodScales[lod] = 0;
    }
  }
  const manifest: MultiscaleMeshManifest = {
    chunkShape,
    chunkGridSpatialOrigin: kZeroVec,
    clipLowerBound,
    clipUpperBound,
    chunkCoordinates,
    lodScales,
  };
  chunk.manifest = manifest;
  chunk.fragmentSupervoxelIds = fragmentIdAndCorners;
}

const maxMeshBatchSize = 100;

interface BatchMeshResponseFragment {
  fullKey: string;
  buffer: ArrayBuffer;
  verticesOffset: number;
  indicesOffset: number;
  numVertices: number;
  numIndices: number;
}

function decodeBatchMeshResponse(
    response: ArrayBuffer, callback: (fragment: BatchMeshResponseFragment) => void) {
  let length = response.byteLength;
  let index = 0;
  const dataView = new DataView(response);
  const headerSize =
      /*object id*/ 8 + /*fragment key length*/ 8 + /*num vertices*/ 8 + /*num triangles*/ 8;
  while (index < length) {
    if (index + headerSize > length) {
      throw new Error(`Invalid batch mesh fragment response.`);
    }
    const objectIdLow = dataView.getUint32(index, /*littleEndian=*/ true);
    const objectIdHigh = dataView.getUint32(index + 4, /*littleEndian=*/ true);
    const objectIdString = new Uint64(objectIdLow, objectIdHigh).toString();
    const prefix = objectIdString + '\0';
    index += 8;
    const fragmentKeyLength = dataView.getUint32(index, /*littleEndian=*/ true);
    const fragmentKeyLengthHigh = dataView.getUint32(index + 4, /*littleEndian=*/ true);
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
    index += fragmentKeyLength;
    const numVertices = dataView.getUint32(index, /*littleEndian=*/ true);
    const numVerticesHigh = dataView.getUint32(index + 4, /*littleEndian=*/ true);
    index += 8;
    const numTriangles = dataView.getUint32(index, /*littleEndian=*/ true);
    const numTrianglesHigh = dataView.getUint32(index + 4, /*littleEndian=*/ true);
    index += 8;
    if (numVerticesHigh !== 0 || numTrianglesHigh !== 0) {
      throw new Error(`Invalid batch mesh fragment response.`);
    }
    const endOffset = index + numTriangles * 12 + numVertices * 12;
    if (endOffset > length) {
      throw new Error(`Invalid batch mesh fragment response.`);
    }
    callback({
      fullKey,
      buffer: response,
      verticesOffset: index,
      numVertices,
      indicesOffset: index + 12 * numVertices,
      numIndices: numTriangles * 3,
    });
    index = endOffset;
  }
}

function combineBatchMeshFragments(fragments: BatchMeshResponseFragment[]) {
  let totalVertices = 0, totalIndices = 0;
  for (let fragment of fragments) {
    totalVertices += fragment.numVertices;
    totalIndices += fragment.numIndices;
  }
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
  return {vertexPositions: vertexBuffer, indices: indexBuffer};
}

function makeBatchMeshRequest(
    credentialsProvider: CredentialsProvider<Credentials>,
    parameters: {instance: BrainmapsInstance, volumeId: string, meshName: string},
    ids: Iterable<string>, cancellationToken: CancellationToken): Promise<ArrayBuffer> {
  const path = `/v1/objects/meshes:batch`;

  const batches: BatchMeshFragment[] = [];
  let prevObjectId: string|undefined;
  let batchSize = 0;
  for (const id of ids) {
    const splitIndex = id.indexOf('\0');
    const objectId = id.substring(0, splitIndex);
    const fragmentId = id.substring(splitIndex + 1);
    if (objectId !== prevObjectId) {
      batches.push({object_id: objectId, fragment_keys: []});
    }
    batches[batches.length - 1].fragment_keys.push(fragmentId);
    if (++batchSize === maxMeshBatchSize) break;
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
      cancellationToken);
}

@registerSharedObject() export class BrainmapsMultiscaleMeshSource extends
(BrainmapsSource(MultiscaleMeshSource, MultiscaleMeshSourceParameters)) {
  private listFragmentsParams = (() => {
    const {parameters} = this;
    const {changeSpec} = parameters;
    if (changeSpec !== undefined) {
      return `&header.changeStackId=${changeSpec.changeStackId}`;
    }
    return '';
  })();

  download(chunk: BrainmapsMultiscaleManifestChunk, cancellationToken: CancellationToken) {
    let {parameters} = this;
    const path = `/v1/objects/${parameters['volumeId']}/meshes/` +
        `${parameters.info.lods[0].info.name}:listfragments?` +
        `object_id=${chunk.objectId}&return_supervoxel_ids=true` + this.listFragmentsParams;
    return makeRequest(
               parameters['instance'], this.credentialsProvider, {
                 method: 'GET',
                 path,
                 responseType: 'json',
               },
               cancellationToken)
        .then(response => decodeMultiscaleManifestChunk(chunk, response));
  }

  downloadFragment(chunk: MultiscaleFragmentChunk, cancellationToken: CancellationToken) {
    let {parameters} = this;

    const idArray: [string, number][] = [];
    const manifestChunk = chunk.manifestChunk! as BrainmapsMultiscaleManifestChunk;
    const {fragmentSupervoxelIds} = manifestChunk;
    const manifest = manifestChunk.manifest!;
    const {lod} = chunk;
    const startChunkIndex = chunk.chunkIndex;
    const {chunkCoordinates} = manifest;
    const xGrid = chunkCoordinates[startChunkIndex * 3] >>> lod,
          yGrid = chunkCoordinates[startChunkIndex * 3 + 1] >>> lod,
          zGrid = chunkCoordinates[startChunkIndex * 3 + 2] >>> lod;
    let endChunkIndex = startChunkIndex;
    {
      let chunkIndex, maxChunkIndex = fragmentSupervoxelIds.length;
      for (chunkIndex = startChunkIndex; chunkIndex < maxChunkIndex; ++chunkIndex) {
        if ((chunkCoordinates[chunkIndex * 3] >>> lod) != xGrid ||
            (chunkCoordinates[chunkIndex * 3 + 1] >>> lod) != yGrid ||
            (chunkCoordinates[chunkIndex * 3 + 2] >>> lod) != zGrid) {
          break;
        }
        const entry = fragmentSupervoxelIds[chunkIndex];
        for (const supervoxelId of entry.supervoxelIds) {
          idArray.push([supervoxelId + '\0' + entry.fragmentId, chunkIndex]);
        }
      }
      endChunkIndex = chunkIndex;
    }

    let fragments: (BatchMeshResponseFragment&{chunkIndex: number})[] = [];

    idArray.sort((a, b) => a[0].localeCompare(b[0]));
    const ids = new Map(idArray);

    function copyMeshData() {
      fragments.sort((a, b) => a.chunkIndex - b.chunkIndex);
      let indexOffset = 0;
      const subChunkOffsets = new Uint32Array(endChunkIndex - startChunkIndex + 1);
      for (const fragment of fragments) {
        indexOffset += fragment.numIndices;
        subChunkOffsets[fragment.chunkIndex - startChunkIndex + 1] = indexOffset;
      }
      assignMultiscaleMeshFragmentData(
          chunk, {...combineBatchMeshFragments(fragments), subChunkOffsets});
    }
    function decodeResponse(response: ArrayBuffer): Promise<void>|void {
      decodeBatchMeshResponse(
          response, (fragment: BatchMeshResponseFragment&{chunkIndex: number}) => {
            const chunkIndex = ids.get(fragment.fullKey)!;
            if (!ids.delete(fragment.fullKey)) {
              throw new Error(
                  `Received unexpected fragment key: ${JSON.stringify(fragment.fullKey)}.`);
            }
            fragment.chunkIndex = chunkIndex;
            fragments.push(fragment);
          });

      if (ids.size !== 0) {
        // Partial response received.
        return makeBatchRequest();
      }
      copyMeshData();
    }

    const {credentialsProvider} = this;

    const meshName = parameters.info.lods.find(x => x.lod === lod)!.info.name;

    function makeBatchRequest(): Promise<void> {
      return makeBatchMeshRequest(
                 credentialsProvider,
                 {instance: parameters.instance, volumeId: parameters.volumeId, meshName},
                 ids.keys(), cancellationToken)
          .then(decodeResponse);
    }
    return makeBatchRequest();
  }
}

function groupFragmentsIntoBatches(ids: string[]) {
  const batches = [];
  let index = 0;
  const length = ids.length;
  while (index < length) {
    batches.push(JSON.stringify(ids.slice(index, index + maxMeshBatchSize)));
    index += maxMeshBatchSize;
  }
  return batches;
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
  chunk.fragmentIds = groupFragmentsIntoBatches(fragmentIds);
}

@registerSharedObject() export class BrainmapsMeshSource extends
(BrainmapsSource(MeshSource, MeshSourceParameters)) {
  private listFragmentsParams = (() => {
    const {parameters} = this;
    const {changeSpec} = parameters;
    if (changeSpec !== undefined) {
      return `&header.changeStackId=${changeSpec.changeStackId}`;
    }
    return '';
  })();

  download(chunk: ManifestChunk, cancellationToken: CancellationToken) {
    let {parameters} = this;
    const path = `/v1/objects/${parameters['volumeId']}/meshes/` +
        `${parameters['meshName']}:listfragments?` +
        `object_id=${chunk.objectId}&return_supervoxel_ids=true` + this.listFragmentsParams;
    return makeRequest(
               parameters['instance'], this.credentialsProvider, {
                 method: 'GET',
                 path,
                 responseType: 'json',
               },
               cancellationToken)
        .then(response => decodeManifestChunkWithSupervoxelIds(chunk, response));
  }

  downloadFragment(chunk: FragmentChunk, cancellationToken: CancellationToken) {
    let {parameters} = this;

    const ids = new Set<string>(JSON.parse(chunk.fragmentId!));

    let fragments: BatchMeshResponseFragment[] = [];

    function copyMeshData() {
      assignMeshFragmentData(chunk, combineBatchMeshFragments(fragments));
    }

    function decodeResponse(response: ArrayBuffer): Promise<void>|void {
      decodeBatchMeshResponse(response, fragment => {
        if (!ids.delete(fragment.fullKey)) {
          throw new Error(`Received unexpected fragment key: ${JSON.stringify(fragment.fullKey)}.`);
        }
        fragments.push(fragment);
      });

      if (ids.size !== 0) {
        // Partial response received.
        return makeBatchRequest();
      }
      copyMeshData();
    }

    const {credentialsProvider} = this;

    function makeBatchRequest(): Promise<void> {
      return makeBatchMeshRequest(credentialsProvider, parameters, ids, cancellationToken)
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
      chunk, response, Endianness.LITTLE, /*vertexByteOffset=*/ 16, numVertices,
      /*indexByteOffset=*/ undefined, /*numEdges=*/ numEdges);
}

@registerSharedObject() export class BrainmapsSkeletonSource extends
(BrainmapsSource(SkeletonSource, SkeletonSourceParameters)) {
  download(chunk: SkeletonChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;
    let payload: SkeletonPayload = {
      object_id: `${chunk.objectId}`,
    };
    const path = `/v1/objects/${parameters['volumeId']}` +
        `/meshes/${parameters.meshName}` +
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

const spatialAnnotationTypes = ['LOCATION', 'LINE', 'VOLUME'];

function parseCommaSeparatedPoint(x: string) {
  const pattern = /(-?[0-9]+),(-?[0-9]+),(-?[0-9]+)/;
  const cornerParts = x.match(pattern);
  if (cornerParts === null) {
    throw new Error(`Error parsing number triplet: ${JSON.stringify(x)}.`);
  }
  return vec3.fromValues(
      parseFloat(cornerParts[1]), parseFloat(cornerParts[2]), parseFloat(cornerParts[3]));
}

function getIdPrefix(parameters: AnnotationSourceParameters) {
  return parameters.volumeId + ':' + parameters.changestack + ':';
}

function parseBrainmapsAnnotationId(idPrefix: string, fullId: string) {
  if (!fullId.startsWith(idPrefix)) {
    throw new Error(`Received annotation id ${
        JSON.stringify(fullId)} does not have expected prefix of ${JSON.stringify(idPrefix)}.`);
  }
  const id = fullId.substring(idPrefix.length);
  return id;
}

function parseObjectLabels(obj: any): Uint64[]|undefined {
  if (obj == null) {
    return undefined;
  }
  return parseArray(obj, x => Uint64.parseString('' + x, 10));
}

function parseAnnotation(entry: any, idPrefix: string, expectedId?: string): Annotation {
  const corner =
      verifyObjectProperty(entry, 'corner', x => parseCommaSeparatedPoint(verifyString(x)));
  const size = verifyObjectProperty(entry, 'size', x => parseCommaSeparatedPoint(verifyString(x)));
  const description = verifyObjectProperty(entry, 'payload', verifyOptionalString);
  const spatialAnnotationType = verifyObjectProperty(entry, 'type', verifyString);
  const fullId = verifyObjectProperty(entry, 'id', verifyString);
  const id = parseBrainmapsAnnotationId(idPrefix, fullId);
  const segments = verifyObjectProperty(entry, 'objectLabels', parseObjectLabels);
  if (expectedId !== undefined && id !== expectedId) {
    throw new Error(`Received annotation has unexpected id ${JSON.stringify(fullId)}.`);
  }
  switch (spatialAnnotationType) {
    case 'LOCATION':
      if (vec3.equals(size, kZeroVec)) {
        return {
          type: AnnotationType.POINT,
          id,
          point: corner,
          description,
          segments,
        };
      } else {
        const radii = vec3.scale(vec3.create(), size, 0.5);
        const center = vec3.add(vec3.create(), corner, radii);
        return {
          type: AnnotationType.ELLIPSOID,
          id,
          center,
          radii,
          description,
          segments,
        };
      }
    case 'LINE':
      return {
        type: AnnotationType.LINE,
        id,
        pointA: corner,
        pointB: vec3.add(vec3.create(), corner, size),
        description,
        segments,
      };
    case 'VOLUME':
      return {
        type: AnnotationType.AXIS_ALIGNED_BOUNDING_BOX,
        id,
        pointA: corner,
        pointB: vec3.add(vec3.create(), corner, size),
        description,
        segments,
      };
    default:
      throw new Error(`Unknown spatial annotation type: ${JSON.stringify(spatialAnnotationType)}.`);
  }
}

function parseAnnotationResponse(response: any, idPrefix: string, expectedId?: string): Annotation {
  verifyObject(response);
  const entry = verifyObjectProperty(
      response, 'annotations', x => parseFixedLengthArray(<any[]>[undefined], x, verifyObject))[0];
  return parseAnnotation(entry, idPrefix, expectedId);
}

function parseAnnotations(
    chunk: AnnotationGeometryChunk|AnnotationSubsetGeometryChunk, responses: any[]) {
  const serializer = new AnnotationSerializer();
  const source = <BrainmapsAnnotationSource>chunk.source.parent;
  const idPrefix = getIdPrefix(source.parameters);
  responses.forEach((response, responseIndex) => {
    try {
      verifyObject(response);
      const annotationsArray =
          verifyObjectProperty(response, 'annotations', x => x === undefined ? [] : x);
      if (!Array.isArray(annotationsArray)) {
        throw new Error(`Expected array, but received ${JSON.stringify(typeof annotationsArray)}.`);
      }
      for (const entry of annotationsArray) {
        try {
          serializer.add(parseAnnotation(entry, idPrefix));
        } catch (e) {
          throw new Error(`Error parsing annotation: ${e.message}`);
        }
      }
    } catch (parseError) {
      throw new Error(`Error parsing ${spatialAnnotationTypes[responseIndex]} annotations: ${
          parseError.message}`);
    }
  });
  chunk.data = Object.assign(new AnnotationGeometryData(), serializer.serialize());
}

function getSpatialAnnotationTypeFromId(id: string) {
  const index = id.indexOf('.');
  return id.substring(0, index);
}

function toCommaSeparated(v: vec3) {
  return `${Math.round(v[0])},${Math.round(v[1])},${Math.round(v[2])}`;
}

function getFullSpatialAnnotationId(parameters: AnnotationSourceParameters, id: string) {
  return `${parameters.volumeId}:${parameters.changestack}:${id}`;
}

function annotationToBrainmaps(annotation: Annotation): any {
  const payload = annotation.description || '';
  const objectLabels =
      annotation.segments === undefined ? undefined : annotation.segments.map(x => x.toString());
  switch (annotation.type) {
    case AnnotationType.LINE:
    case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX: {
      const {pointA, pointB} = annotation;
      const minPoint = vec3.min(vec3.create(), pointA, pointB);
      const maxPoint = vec3.max(vec3.create(), pointA, pointB);
      const size = vec3.subtract(maxPoint, maxPoint, minPoint);
      return {
        type: annotation.type === AnnotationType.LINE ? 'LINE' : 'VOLUME',
        corner: toCommaSeparated(minPoint),
        size: toCommaSeparated(size),
        object_labels: objectLabels,
        payload,
      };
    }
    case AnnotationType.POINT: {
      return {
        type: 'LOCATION',
        corner: toCommaSeparated(annotation.point),
        size: '0,0,0',
        object_labels: objectLabels,
        payload,
      };
    }
    case AnnotationType.ELLIPSOID: {
      const corner = vec3.subtract(vec3.create(), annotation.center, annotation.radii);
      const size = vec3.scale(vec3.create(), annotation.radii, 2);
      return {
        type: 'LOCATION',
        corner: toCommaSeparated(corner),
        size: toCommaSeparated(size),
        object_labels: objectLabels,
        payload,
      };
    }
  }
}

@registerSharedObject() export class BrainmapsAnnotationSource extends (BrainmapsSource(AnnotationSource, AnnotationSourceParameters)) {
  downloadGeometry(chunk: AnnotationGeometryChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;
    return Promise
        .all(spatialAnnotationTypes.map(
            spatialAnnotationType => makeRequest(
                parameters.instance, this.credentialsProvider, {
                  method: 'POST',
                  path: `/v1/changes/${parameters.volumeId}/${parameters.changestack}/spatials:get`,
                  payload: JSON.stringify({
                    type: spatialAnnotationType,
                    ignore_payload: true,
                  }),
                  responseType: 'json',
                },
                cancellationToken)))
        .then(values => {
          parseAnnotations(chunk, values);
        });
  }

  downloadSegmentFilteredGeometry(
      chunk: AnnotationSubsetGeometryChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;
    return Promise
        .all(spatialAnnotationTypes.map(
            spatialAnnotationType => makeRequest(
                parameters.instance, this.credentialsProvider, {
                  method: 'POST',
                  path: `/v1/changes/${parameters.volumeId}/${parameters.changestack}/spatials:get`,
                  payload: JSON.stringify({
                    type: spatialAnnotationType,
                    object_labels: [chunk.objectId.toString()],
                    ignore_payload: true,
                  }),
                  responseType: 'json',
                },
                cancellationToken)))
        .then(values => {
          parseAnnotations(chunk, values);
        });
  }

  downloadMetadata(chunk: AnnotationMetadataChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;
    const id = chunk.key!;
    return makeRequest(
               parameters.instance, this.credentialsProvider, {
                 method: 'POST',
                 path: `/v1/changes/${parameters.volumeId}/${parameters.changestack}/spatials:get`,
                 payload: JSON.stringify({
                   type: getSpatialAnnotationTypeFromId(id),
                   id: getFullSpatialAnnotationId(parameters, id)
                 }),
                 responseType: 'json',
               },
               cancellationToken)
        .then(
            response => {
              chunk.annotation = parseAnnotationResponse(response, getIdPrefix(parameters), id);
            },
            () => {
              chunk.annotation = null;
            });
  }

  add(annotation: Annotation) {
    const {parameters} = this;
    const brainmapsAnnotation = annotationToBrainmaps(annotation);
    return makeRequest(parameters.instance, this.credentialsProvider, {
             method: 'POST',
             path: `/v1/changes/${parameters.volumeId}/${parameters.changestack}/spatials:push`,
             payload: JSON.stringify({annotations: [brainmapsAnnotation]}),
             responseType: 'json',
           })
        .then(response => {
          verifyObject(response);
          const ids = verifyObjectProperty(response, 'ids', verifyStringArray);
          if (ids.length !== 1) {
            throw new Error(`Expected list of 1 id, but received ${JSON.stringify(ids)}.`);
          }
          const idPrefix = getIdPrefix(this.parameters);
          return parseBrainmapsAnnotationId(idPrefix, ids[0]);
        });
  }

  update(id: AnnotationId, annotation: Annotation) {
    const {parameters} = this;
    const brainmapsAnnotation = annotationToBrainmaps(annotation);
    brainmapsAnnotation.id = getFullSpatialAnnotationId(parameters, id);
    return makeRequest(parameters.instance, this.credentialsProvider, {
      method: 'POST',
      path: `/v1/changes/${parameters.volumeId}/${parameters.changestack}/spatials:push`,
      payload: JSON.stringify({annotations: [brainmapsAnnotation]}),
      responseType: 'json',
    });
  }

  delete (id: AnnotationId) {
    const {parameters} = this;
    return makeRequest(parameters.instance, this.credentialsProvider, {
      method: 'POST',
      path: `/v1/changes/${parameters.volumeId}/${parameters.changestack}/spatials:delete`,
      payload: JSON.stringify({
        type: getSpatialAnnotationTypeFromId(id),
        ids: [getFullSpatialAnnotationId(parameters, id)]
      }),
      responseType: 'json',
    });
  }
}
