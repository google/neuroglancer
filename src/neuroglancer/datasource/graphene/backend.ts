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

import {Annotation, AnnotationPropertySerializer, annotationTypeHandlers, annotationTypes} from 'neuroglancer/annotation';
import {AnnotationGeometryChunk, AnnotationGeometryData, AnnotationMetadataChunk, AnnotationSource, AnnotationSubsetGeometryChunk} from 'neuroglancer/annotation/backend';
import {AnnotationGeometryChunkSourceBackend} from 'neuroglancer/annotation/backend';
import {decodeGzip} from 'neuroglancer/async_computation/decode_gzip_request';
import {requestAsyncComputation} from 'neuroglancer/async_computation/request';
import {Chunk, ChunkManager, WithParameters} from 'neuroglancer/chunk_manager/backend';
import {GenericSharedDataSource} from 'neuroglancer/chunk_manager/generic_file_source';
import {WithSharedCredentialsProviderCounterpart} from 'neuroglancer/credentials_provider/shared_counterpart';
// import {AnnotationSourceParameters, AnnotationSpatialIndexSourceParameters, DataEncoding, IndexedSegmentPropertySourceParameters, MeshSourceParameters, MultiscaleMeshSourceParameters, ShardingHashFunction, ShardingParameters, SkeletonSourceParameters, VolumeChunkEncoding, VolumeChunkSourceParameters} from 'neuroglancer/datasource/precomputed/base';
import {assignMeshFragmentData, assignMultiscaleMeshFragmentData, computeOctreeChildOffsets, decodeJsonManifestChunk, decodeTriangleVertexPositionsAndIndices, decodeTriangleVertexPositionsAndIndicesDraco, FragmentChunk, generateHigherOctreeLevel, ManifestChunk, MeshSource, MultiscaleFragmentChunk, MultiscaleManifestChunk, MultiscaleMeshSource} from 'neuroglancer/mesh/backend';
import {IndexedSegmentPropertySourceBackend} from 'neuroglancer/segmentation_display_state/backend';
import {SkeletonChunk, SkeletonSource} from 'neuroglancer/skeleton/backend';
import {decodeSkeletonChunk} from 'neuroglancer/skeleton/decode_precomputed_skeleton';
import {ChunkDecoder} from 'neuroglancer/sliceview/backend_chunk_decoders';
import {decodeCompressedSegmentationChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/compressed_segmentation';
import {decodeJpegChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/jpeg';
import {decodeRawChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/raw';
import {VolumeChunk, VolumeChunkSource} from 'neuroglancer/sliceview/volume/backend';
import {fetchSpecialHttpByteRange} from 'neuroglancer/datasource/graphene/base';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {Borrowed} from 'neuroglancer/util/disposable';
import {convertEndian32, Endianness} from 'neuroglancer/util/endian';
import {vec3} from 'neuroglancer/util/geom';
import {murmurHash3_x86_128Hash64Bits} from 'neuroglancer/util/hash';
import {cancellableFetchOk, HttpError, isNotFoundError, responseArrayBuffer, responseJson} from 'neuroglancer/util/http_request';
import {stableStringify} from 'neuroglancer/util/json';
import {getObjectId} from 'neuroglancer/util/object_id';
import {SpecialProtocolCredentials, SpecialProtocolCredentialsProvider} from 'neuroglancer/util/special_protocol_request';
import {cancellableFetchSpecialOk} from 'neuroglancer/datasource/graphene/base';
import {Uint64} from 'neuroglancer/util/uint64';
import {encodeZIndexCompressed} from 'neuroglancer/util/zorder';
import {registerSharedObject} from 'neuroglancer/worker_rpc';

import {AnnotationSourceParameters, AnnotationSpatialIndexSourceParameters, ChunkedGraphSourceParameters, DataEncoding, GRAPHENE_MANIFEST_SHARDED, IndexedSegmentPropertySourceParameters, MeshSourceParameters, MultiscaleMeshSourceParameters, ShardingHashFunction, ShardingParameters, SkeletonSourceParameters, VolumeChunkEncoding, VolumeChunkSourceParameters} from 'neuroglancer/datasource/graphene/base';

import * as DracoLoader from 'dracoloader';
import { ChunkedGraphChunk, ChunkedGraphChunkSource, decodeSupervoxelArray } from 'src/neuroglancer/sliceview/chunked_graph/backend';


interface ShardInfo {
  shardUrl: string;
  offset: Uint64;
}

interface DecodedMinishardIndex {
  data: Uint32Array;
  shardUrl: string;
}

interface MinishardIndexSource extends
    GenericSharedDataSource<string, DecodedMinishardIndex|undefined> {
  sharding: ShardingParameters;
  credentialsProvider: SpecialProtocolCredentialsProvider;
}

function getMinishardIndexDataSource(
    chunkManager: Borrowed<ChunkManager>, credentialsProvider: SpecialProtocolCredentialsProvider,
    parameters: {url: string, sharding: ShardingParameters|undefined, layer:number}): MinishardIndexSource|
    undefined {
  const {url, sharding, layer} = parameters;
  if (sharding === undefined) return undefined;
  const source =
      GenericSharedDataSource.get<string, DecodedMinishardIndex|undefined>(
          chunkManager, stableStringify({
            type: 'graphene:shardedDataSource',
            url,
            sharding,
            credentialsProvider: getObjectId(credentialsProvider),
          }),
          {
            download: async function(
                shardFileAndMiniShard: string, cancellationToken: CancellationToken) {
                  console.log('download getMinishardIndexDataSource');
              const parts = shardFileAndMiniShard.split(':');
              const shardFile = parts[0];
              const miniShard: Uint64 = Uint64.parseString(parts[1]);
              const shardUrl = `${url}/initial/${layer}/${shardFile}`;
              // Retrive miniShard index start/end offsets.

              const shardIndexSize = new Uint64(16);
              Uint64.lshift(shardIndexSize, shardIndexSize, sharding.minishardBits);

              // Multiply miniShard by 16.
              const shardIndexStart = Uint64.lshift(new Uint64(), miniShard, 4);
              const shardIndexEnd = Uint64.addUint32(new Uint64(), shardIndexStart, 16);
              const shardIndexResponse = await fetchSpecialHttpByteRange(undefined,
                  shardUrl, shardIndexStart, shardIndexEnd, cancellationToken);
              if (shardIndexResponse.byteLength !== 16) {
                throw new Error(`Failed to retrieve miniShard offset`);
              }
              const shardIndexDv = new DataView(shardIndexResponse);
              const minishardStartOffset = new Uint64(
                  shardIndexDv.getUint32(0, /*littleEndian=*/true),
                  shardIndexDv.getUint32(4, /*littleEndian=*/true));
              const minishardEndOffset = new Uint64(
                  shardIndexDv.getUint32(8, /*littleEndian=*/true),
                  shardIndexDv.getUint32(12, /*littleEndian=*/true));
              if (Uint64.equal(minishardStartOffset, minishardEndOffset)) {
                throw new Error('Object not found')
              }
              // The start/end offsets in the shard index are relative to the end of the shard
              // index.
              Uint64.add(minishardStartOffset, minishardStartOffset, shardIndexSize);
              Uint64.add(minishardEndOffset, minishardEndOffset, shardIndexSize);

              let minishardIndexResponse = await fetchSpecialHttpByteRange(undefined,
                  shardUrl, minishardStartOffset, minishardEndOffset, cancellationToken);
              if (sharding.minishardIndexEncoding === DataEncoding.GZIP) {
                minishardIndexResponse =
                    (await requestAsyncComputation(
                        decodeGzip, cancellationToken, [minishardIndexResponse],
                        new Uint8Array(minishardIndexResponse)))
                        .buffer;
              }
              if ((minishardIndexResponse.byteLength % 24) !== 0) {
                throw new Error(
                    `Invalid miniShard index length: ${minishardIndexResponse.byteLength}`);
              }
              const minishardIndex = new Uint32Array(minishardIndexResponse);
              convertEndian32(minishardIndex, Endianness.LITTLE);

              const minishardIndexSize = minishardIndex.byteLength / 24;
              let prevEntryKeyLow = 0, prevEntryKeyHigh = 0;
              // Offsets in the miniShard index are relative to the end of the shard index.
              let prevStartLow = shardIndexSize.low, prevStartHigh = shardIndexSize.high;
              for (let i = 0; i < minishardIndexSize; ++i) {
                let entryKeyLow = prevEntryKeyLow + minishardIndex[i * 2];
                let entryKeyHigh = prevEntryKeyHigh + minishardIndex[i * 2 + 1];
                if (entryKeyLow >= 4294967296) {
                  entryKeyLow -= 4294967296;
                  entryKeyHigh += 1;
                }
                prevEntryKeyLow = minishardIndex[i * 2] = entryKeyLow;
                prevEntryKeyHigh = minishardIndex[i * 2 + 1] = entryKeyHigh;
                let startLow = prevStartLow + minishardIndex[(minishardIndexSize + i) * 2];
                let startHigh = prevStartHigh + minishardIndex[(minishardIndexSize + i) * 2 + 1];
                if (startLow >= 4294967296) {
                  startLow -= 4294967296;
                  startHigh += 1;
                }
                minishardIndex[(minishardIndexSize + i) * 2] = startLow;
                minishardIndex[(minishardIndexSize + i) * 2 + 1] = startHigh;
                const sizeLow = minishardIndex[(2 * minishardIndexSize + i) * 2];
                const sizeHigh = minishardIndex[(2 * minishardIndexSize + i) * 2 + 1];
                let endLow = startLow + sizeLow;
                let endHigh = startHigh + sizeHigh;
                if (endLow >= 4294967296) {
                  endLow -= 4294967296;
                  endHigh += 1;
                }
                prevStartLow = endLow;
                prevStartHigh = endHigh;
                minishardIndex[(2 * minishardIndexSize + i) * 2] = endLow;
                minishardIndex[(2 * minishardIndexSize + i) * 2 + 1] = endHigh;
              }
              return {data: {data: minishardIndex, shardUrl}, size: minishardIndex.byteLength};
            },
            encodeKey: (key: string) => key,
            sourceQueueLevel: 1,
          }) as MinishardIndexSource;
  source.sharding = sharding;
  source.credentialsProvider = credentialsProvider;
  return source;
}

function getGrapheneMinishardIndexDataSources(
  chunkManager: Borrowed<ChunkManager>, credentialsProvider: SpecialProtocolCredentialsProvider,
  parameters: {url: string, sharding: Array<ShardingParameters>|undefined}): Array<MinishardIndexSource>|
  undefined {
  const {url, sharding} = parameters;
  if (sharding === undefined) return undefined;
  const sources = new Array<MinishardIndexSource>();
  for (const index in sharding)
  {
    const layer = Number(index);
     sources[layer] = getMinishardIndexDataSource(
       chunkManager, credentialsProvider, {url: url, sharding: sharding[layer], layer:layer})!;
  }
  return sources;
}

function findMinishardEntry(minishardIndex: DecodedMinishardIndex, key: Uint64):
    {startOffset: Uint64, endOffset: Uint64}|undefined {
  const minishardIndexData = minishardIndex.data;
  const minishardIndexSize = minishardIndexData.length / 6;
  const keyLow = key.low, keyHigh = key.high;
  for (let i = 0; i < minishardIndexSize; ++i) {
    if (minishardIndexData[i * 2] !== keyLow || minishardIndexData[i * 2 + 1] !== keyHigh) {
      continue;
    }
    const startOffset = new Uint64(
        minishardIndexData[(minishardIndexSize + i) * 2],
        minishardIndexData[(minishardIndexSize + i) * 2 + 1]);
    const endOffset = new Uint64(
        minishardIndexData[(2 * minishardIndexSize + i) * 2],
        minishardIndexData[(2 * minishardIndexSize + i) * 2 + 1]);
    return {startOffset, endOffset};
  }
  return undefined;
}

async function getShardedData(
    minishardIndexSource: MinishardIndexSource, chunk: Chunk, key: Uint64,
    cancellationToken: CancellationToken): Promise<{shardInfo: ShardInfo, data: ArrayBuffer}> {
  const parts = (chunk as FragmentChunk).fragmentId!.split(':');
  const getPriority = () => ({priorityTier: chunk.priorityTier, priority: chunk.priority});
  const minishardIndex =
      await minishardIndexSource.getData(`${parts[3]}:${parts[4]}`, getPriority, cancellationToken);

  if (minishardIndex === undefined) {
    throw new Error('getShardedData error');
  }

  const {startOffset, endOffset} = findMinishardEntry(minishardIndex, key)!; // TODO !
  let data =
      await fetchSpecialHttpByteRange(undefined, minishardIndex.shardUrl, startOffset, endOffset, cancellationToken);
  if (minishardIndexSource.sharding.dataEncoding === DataEncoding.GZIP) {
    data =
        (await requestAsyncComputation(decodeGzip, cancellationToken, [data], new Uint8Array(data)))
            .buffer;
  }
  return {data, shardInfo: {shardUrl: minishardIndex.shardUrl, offset: startOffset}};
}

function getOrNotFoundError<T>(v: T|undefined) {
  if (v === undefined) throw new Error('not found');
  return v;
}

const chunkDecoders = new Map<VolumeChunkEncoding, ChunkDecoder>();
chunkDecoders.set(VolumeChunkEncoding.RAW, decodeRawChunk);
chunkDecoders.set(VolumeChunkEncoding.JPEG, decodeJpegChunk);
chunkDecoders.set(VolumeChunkEncoding.COMPRESSED_SEGMENTATION, decodeCompressedSegmentationChunk);

@registerSharedObject() export class GrapheneVolumeChunkSource extends
(WithParameters(WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(VolumeChunkSource), VolumeChunkSourceParameters)) {
  chunkDecoder = chunkDecoders.get(this.parameters.encoding)!;
  // private minishardIndexSource =
  //     getMinishardIndexDataSource(this.chunkManager, this.credentialsProvider, this.parameters);

  gridShape = (() => {
    const gridShape = new Uint32Array(3);
    const {upperVoxelBound, chunkDataSize} = this.spec;
    for (let i = 0; i < 3; ++i) {
      gridShape[i] = Math.ceil(upperVoxelBound[i] / chunkDataSize[i]);
    }
    return gridShape;
  })();

  async download(chunk: VolumeChunk, cancellationToken: CancellationToken): Promise<void> {
    const {parameters} = this;
    // chunkPosition must not be captured, since it will be invalidated by the next call to
    // computeChunkBounds.
    const chunkPosition = this.computeChunkBounds(chunk);
    const chunkDataSize = chunk.chunkDataSize!;
    const url = `${parameters.url}/${chunkPosition[0]}-${chunkPosition[0] + chunkDataSize[0]}_` +
        `${chunkPosition[1]}-${chunkPosition[1] + chunkDataSize[1]}_` +
        `${chunkPosition[2]}-${chunkPosition[2] + chunkDataSize[2]}`;
    const response = await cancellableFetchSpecialOk(
      this.credentialsProvider, url, {}, responseArrayBuffer, cancellationToken);
    await this.chunkDecoder(chunk, cancellationToken, response);
  }
}

export const responseIdentity = async (x: any) => x;

export function decodeChunkedGraphChunk(
  chunk: ChunkedGraphChunk, rootObjectKey: string, response: Response) {
return decodeSupervoxelArray(chunk, rootObjectKey, response);
}

@registerSharedObject() export class GrapheneChunkedGraphChunkSource extends
(WithParameters(WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(ChunkedGraphChunkSource), ChunkedGraphSourceParameters)) {
  async download(chunk: ChunkedGraphChunk, cancellationToken: CancellationToken): Promise<void> {
    let {parameters} = this;
    let chunkPosition = this.computeChunkBounds(chunk);
    let chunkDataSize = chunk.chunkDataSize!;
    let bounds = `${chunkPosition[0]}-${chunkPosition[0] + chunkDataSize[0]}_` +
        `${chunkPosition[1]}-${chunkPosition[1] + chunkDataSize[1]}_` +
        `${chunkPosition[2]}-${chunkPosition[2] + chunkDataSize[2]}`;

    let promises = Array<Promise<any>>();
    let promise: Promise<any>;

    for (const [key, val] of chunk.mappings!.entries()) {
      if (val === null) {
        promise = cancellableFetchSpecialOk(this.credentialsProvider,
            `${parameters.url}/${key}/leaves?int64_as_str=1&bounds=${bounds}`, {}, responseIdentity,
            cancellationToken);
        promises.push(this.withErrorMessage(
                              promise, `Fetching leaves of segment ${key} in region ${bounds}: `)
                          .then(res => decodeChunkedGraphChunk(chunk, key, res))
                          .catch(err => console.error(err)));
      }
    }
    await Promise.all(promises);
  }

  async withErrorMessage(promise: Promise<Response>, errorPrefix: string): Promise<Response> {
    const response = await promise;
    if (response.ok) {
      return response;
    } else {
      let msg: string;
      try {
        msg = (await response.json())['message'];
      } catch {
        msg = await response.text();
      }
      throw new Error(`[${response.status}] ${errorPrefix}${msg}`);
    }
  }
}


export function decodeManifestChunk(chunk: ManifestChunk, response: any) {
  return decodeJsonManifestChunk(chunk, response, 'fragments');
}

export function decodeFragmentChunk(chunk: FragmentChunk, response: ArrayBuffer) {
  let dv = new DataView(response);
  let numVertices = dv.getUint32(0, true);
  assignMeshFragmentData(
      chunk,
      decodeTriangleVertexPositionsAndIndices(
          response, Endianness.LITTLE, /*vertexByteOffset=*/ 4, numVertices));
}

export function decodeDracoFragmentChunk(
  chunk: FragmentChunk, response: ArrayBuffer, decoderModule: any) {
assignMeshFragmentData(
    chunk, decodeTriangleVertexPositionsAndIndicesDraco(response, decoderModule));
}

async function getUnverifiedFragmentPromise(
  chunk: FragmentChunk,
  parameters: MeshSourceParameters,
  minishardIndexSources: MinishardIndexSource[],
  cancellationToken: CancellationToken) {
  if (chunk.fragmentId && chunk.fragmentId.charAt(0) === '~'){
    let objectId = Uint64.parseString(chunk.key!);
    let layer = Number(chunk.fragmentId.substr(1).split(':')[1]);
    let data: ArrayBuffer;
    ({data} =
      await getShardedData(minishardIndexSources[layer]!, chunk, objectId, cancellationToken));
    return Promise.resolve(data);
  }
  return cancellableFetchOk(
    `${parameters.fragmentUrl}/dynamic/${chunk.fragmentId}`, {}, responseArrayBuffer,
    cancellationToken);
}

function getVerifiedFragmentPromise(
  chunk: FragmentChunk,
  parameters: MeshSourceParameters,
  cancellationToken: CancellationToken) {
  if (chunk.fragmentId && chunk.fragmentId.charAt(0) === '~') {
    let parts = chunk.fragmentId.substr(1).split(':');
    let startOffset: Uint64|number, endOffset: Uint64|number;
    startOffset = Number(parts[1]);
    endOffset = startOffset+Number(parts[2]);
    return fetchSpecialHttpByteRange(undefined,
      `${parameters.fragmentUrl}/initial/${parts[0]}`,
      startOffset,
      endOffset,
      cancellationToken
    );
  }
  return cancellableFetchOk(
    `${parameters.fragmentUrl}/dynamic/${chunk.fragmentId}`, {}, responseArrayBuffer,
    cancellationToken);
}

function getFragmentDownloadPromise(
  chunk: FragmentChunk,
  parameters: MeshSourceParameters,
  minishardIndexSources: MinishardIndexSource[],
  cancellationToken: CancellationToken
) {
  let fragmentDownloadPromise;
  if (parameters.sharding){
    if (chunk.verifyFragment !== undefined && !chunk.verifyFragment) {
      // Download shard fragments without verification
      fragmentDownloadPromise =
        getUnverifiedFragmentPromise(chunk, parameters, minishardIndexSources, cancellationToken);
    }
    else {
      // Download shard fragments with verification (response contains size and offset)
      fragmentDownloadPromise = getVerifiedFragmentPromise(chunk, parameters, cancellationToken);
    }
  } else {
    fragmentDownloadPromise = cancellableFetchOk(
      `${parameters.fragmentUrl}/${chunk.fragmentId}`, {}, responseArrayBuffer,
      cancellationToken);
  }
  return fragmentDownloadPromise;
}

@registerSharedObject() export class GrapheneMeshSource extends
(WithParameters(WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(MeshSource), MeshSourceParameters)) {
  protected minishardIndexSources: MinishardIndexSource[];

  async download(chunk: ManifestChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;
    let url = `${parameters.manifestUrl}/manifest`;
    let manifestUrl = `${url}/${chunk.objectId}:${parameters.lod}?verify=1&prepend_seg_ids=1`;

    // speculative manifest isn't working all the time
    // race condition is the prime suspect so use verify=true
    chunk.verifyFragments = true;

    // parameters.sharding is a proxy for mesh format
    // if undefined, mesh format is old else new
    if (parameters.sharding !== undefined) {
      chunk.manifestType = GRAPHENE_MANIFEST_SHARDED;
      if (this.minishardIndexSources === undefined) {
        this.minishardIndexSources = getGrapheneMinishardIndexDataSources(
          this.chunkManager, undefined, {url: parameters.fragmentUrl, sharding: parameters.sharding})!;
      }
      if (!chunk.verifyFragments) {
        manifestUrl = `${url}/${chunk.objectId}:${parameters.lod}?verify=0&prepend_seg_ids=1`;
      }
    }
    await cancellableFetchSpecialOk(this.credentialsProvider, manifestUrl, {}, responseJson, cancellationToken)
        .then(response => decodeManifestChunk(chunk, response));
  }

  async downloadFragment(chunk: FragmentChunk, cancellationToken: CancellationToken) {
    const {parameters, minishardIndexSources} = this;
    const fragmentDownloadPromise = getFragmentDownloadPromise(
      chunk, parameters, minishardIndexSources, cancellationToken
    );

    const dracoModulePromise = DracoLoader.default;
    const readyToDecode = Promise.all([fragmentDownloadPromise, dracoModulePromise]);
    return readyToDecode.then(
        response => {
          try {
            decodeDracoFragmentChunk(chunk, response[0], response[1].decoderModule);
          } catch (err) {
            if (err instanceof TypeError) {
              // not a draco mesh
              decodeFragmentChunk(chunk, response[0]);
            }
          }
        },
        error => {
          if (error instanceof HttpError && error.status == 404) {
            chunk.source!.removeChunk(chunk);
          }
          Promise.reject(error);
        });
  }
}

async function fetchByUint64(
    credentialsProvider: SpecialProtocolCredentialsProvider, url: string, chunk: Chunk,
    minishardIndexSource: MinishardIndexSource|undefined, id: Uint64,
    cancellationToken: CancellationToken) {
  if (minishardIndexSource === undefined) {
    try {
      return await cancellableFetchSpecialOk(
          credentialsProvider, `${url}/${id}`, {}, responseArrayBuffer, cancellationToken);
    } catch (e) {
      if (isNotFoundError(e)) return undefined;
      throw e;
    }
  }
  const result = await getShardedData(minishardIndexSource, chunk, id, cancellationToken);
  if (result === undefined) return undefined;
  return result.data;
}

@registerSharedObject() //
export class GrapheneSkeletonSource extends
(WithParameters(WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(SkeletonSource), SkeletonSourceParameters)) {
  private minishardIndexSource = getMinishardIndexDataSource(
      this.chunkManager, this.credentialsProvider,
      {url: this.parameters.url, sharding: this.parameters.metadata.sharding, layer: 0});
  async download(chunk: SkeletonChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;
    const response = getOrNotFoundError(await fetchByUint64(
        this.credentialsProvider, parameters.url, chunk, this.minishardIndexSource, chunk.objectId,
        cancellationToken));
    decodeSkeletonChunk(chunk, response, parameters.metadata.vertexAttributes);
  }
}

// function parseAnnotations(
//     buffer: ArrayBuffer, parameters: AnnotationSourceParameters,
//     propertySerializer: AnnotationPropertySerializer): AnnotationGeometryData {
//   const dv = new DataView(buffer);
//   if (buffer.byteLength <= 8) throw new Error('Expected at least 8 bytes');
//   const countLow = dv.getUint32(0, /*littleEndian=*/ true);
//   const countHigh = dv.getUint32(4, /*littleEndian=*/ true);
//   if (countHigh !== 0) throw new Error('Annotation count too high');
//   const numBytes = annotationTypeHandlers[parameters.type].serializedBytes(parameters.rank) +
//       propertySerializer.serializedBytes;
//   const expectedBytes = 8 + (numBytes + 8) * countLow;
//   if (buffer.byteLength !== expectedBytes) {
//     throw new Error(`Expected ${expectedBytes} bytes, but received: ${buffer.byteLength} bytes`);
//   }
//   const idOffset = 8 + numBytes * countLow;
//   const id = new Uint64();
//   const ids = new Array<string>(countLow);
//   for (let i = 0; i < countLow; ++i) {
//     id.low = dv.getUint32(idOffset + i * 8, /*littleEndian=*/ true);
//     id.high = dv.getUint32(idOffset + i * 8 + 4, /*littleEndian=*/ true);
//     ids[i] = id.toString();
//   }
//   const geometryData = new AnnotationGeometryData();
//   const data = geometryData.data = new Uint8Array(buffer, 8, numBytes * countLow);
//   convertEndian32(data, Endianness.LITTLE);
//   const typeToOffset = geometryData.typeToOffset = new Array<number>(annotationTypes.length);
//   typeToOffset.fill(0);
//   typeToOffset[parameters.type] = 0;
//   const typeToIds = geometryData.typeToIds = new Array<string[]>(annotationTypes.length);
//   const typeToIdMaps = geometryData.typeToIdMaps =
//       new Array<Map<string, number>>(annotationTypes.length);
//   typeToIds.fill([]);
//   typeToIds[parameters.type] = ids;
//   typeToIdMaps.fill(new Map());
//   typeToIdMaps[parameters.type] = new Map(ids.map((id, i) => [id, i]));
//   return geometryData;
// }

// function parseSingleAnnotation(
//     buffer: ArrayBuffer, parameters: AnnotationSourceParameters,
//     propertySerializer: AnnotationPropertySerializer, id: string): Annotation {
//   const handler = annotationTypeHandlers[parameters.type];
//   const baseNumBytes = handler.serializedBytes(parameters.rank);
//   const numRelationships = parameters.relationships.length;
//   const minNumBytes = baseNumBytes + 4 * numRelationships;
//   if (buffer.byteLength < minNumBytes) {
//     throw new Error(`Expected at least ${minNumBytes} bytes, but received: ${buffer.byteLength}`);
//   }
//   const dv = new DataView(buffer);
//   const annotation = handler.deserialize(dv, 0, /*isLittleEndian=*/ true, parameters.rank, id);
//   propertySerializer.deserialize(
//       dv, baseNumBytes, /*isLittleEndian=*/ true,
//       annotation.properties = new Array(parameters.properties.length));
//   let offset = baseNumBytes + propertySerializer.serializedBytes;
//   const relatedSegments: Uint64[][] = annotation.relatedSegments = [];
//   relatedSegments.length = numRelationships;
//   for (let i = 0; i < numRelationships; ++i) {
//     const count = dv.getUint32(offset, /*littleEndian=*/ true);
//     if (buffer.byteLength < minNumBytes + count * 8) {
//       throw new Error(`Expected at least ${minNumBytes} bytes, but received: ${buffer.byteLength}`);
//     }
//     offset += 4;
//     const segments: Uint64[] = relatedSegments[i] = [];
//     for (let j = 0; j < count; ++j) {
//       segments[j] = new Uint64(
//           dv.getUint32(offset, /*littleEndian=*/ true),
//           dv.getUint32(offset + 4, /*littleEndian=*/ true));
//       offset += 8;
//     }
//   }
//   if (offset !== buffer.byteLength) {
//     throw new Error(`Expected ${offset} bytes, but received: ${buffer.byteLength}`);
//   }
//   return annotation;
// }

// @registerSharedObject() //
// export class GrapheneAnnotationSpatialIndexSourceBackend extends (WithParameters(WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(AnnotationGeometryChunkSourceBackend), AnnotationSpatialIndexSourceParameters)) {
//   private minishardIndexSource =
//       getMinishardIndexDataSource(this.chunkManager, this.credentialsProvider, this.parameters);
//   parent: GrapheneAnnotationSourceBackend;
//   async download(chunk: AnnotationGeometryChunk, cancellationToken: CancellationToken) {
//     const {parameters} = this;

//     const {minishardIndexSource} = this;
//     const {parent} = this;
//     let response: ArrayBuffer|undefined;
//     const {chunkGridPosition} = chunk;
//     if (minishardIndexSource === undefined) {
//       const url = `${parameters.url}/${chunkGridPosition.join('_')}`;
//       try {
//         response = await cancellableFetchSpecialOk(
//             this.credentialsProvider, url, {}, responseArrayBuffer, cancellationToken);
//       } catch (e) {
//         if (!isNotFoundError(e)) throw e;
//       }
//     } else {
//       const {upperChunkBound} = this.spec;
//       const {chunkGridPosition} = chunk;
//       const xBits = Math.ceil(Math.log2(upperChunkBound[0])),
//             yBits = Math.ceil(Math.log2(upperChunkBound[1])),
//             zBits = Math.ceil(Math.log2(upperChunkBound[2]));
//       const chunkIndex = encodeZIndexCompressed(
//           new Uint64(), xBits, yBits, zBits, chunkGridPosition[0], chunkGridPosition[1],
//           chunkGridPosition[2]);
//       const result =
//           await getShardedData(minishardIndexSource, chunk, chunkIndex, cancellationToken);
//       if (result !== undefined) response = result.data;
//     }
//     if (response !== undefined) {
//       chunk.data =
//           parseAnnotations(response, parent.parameters, parent.annotationPropertySerializer);
//     }
//   }
// }

// @registerSharedObject() //
// export class GrapheneAnnotationSourceBackend extends (WithParameters(WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(AnnotationSource), AnnotationSourceParameters)) {
//   private byIdMinishardIndexSource = getMinishardIndexDataSource(
//       this.chunkManager, this.credentialsProvider, this.parameters.byId);
//   private relationshipIndexSource = this.parameters.relationships.map(
//       x => getMinishardIndexDataSource(this.chunkManager, this.credentialsProvider, x));
//   annotationPropertySerializer =
//       new AnnotationPropertySerializer(this.parameters.rank, this.parameters.properties);

//   async downloadSegmentFilteredGeometry(
//       chunk: AnnotationSubsetGeometryChunk, relationshipIndex: number,
//       cancellationToken: CancellationToken) {
//     const {parameters} = this;
//     const response = await fetchByUint64(
//         this.credentialsProvider, parameters.relationships[relationshipIndex].url, chunk,
//         this.relationshipIndexSource[relationshipIndex], chunk.objectId, cancellationToken);
//     if (response !== undefined) {
//       chunk.data = parseAnnotations(response, this.parameters, this.annotationPropertySerializer);
//     }
//   }

//   async downloadMetadata(chunk: AnnotationMetadataChunk, cancellationToken: CancellationToken) {
//     const {parameters} = this;
//     const id = Uint64.parseString(chunk.key!);
//     const response = await fetchByUint64(
//         this.credentialsProvider, parameters.byId.url, chunk, this.byIdMinishardIndexSource, id,
//         cancellationToken);
//     if (response === undefined) {
//       chunk.annotation = null;
//     } else {
//       chunk.annotation = parseSingleAnnotation(
//           response, this.parameters, this.annotationPropertySerializer, chunk.key!);
//     }
//   }
// }

// @registerSharedObject()
// export class GrapheneIndexedSegmentPropertySourceBackend extends WithParameters
// (WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(
//      IndexedSegmentPropertySourceBackend),
//  IndexedSegmentPropertySourceParameters) {
//   minishardIndexSource =
//       getMinishardIndexDataSource(this.chunkManager, this.credentialsProvider, this.parameters);
// }
