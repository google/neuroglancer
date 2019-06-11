/**
 * @license
 * Copyright 2019 The Neuroglancer Authors
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

import {decodeGzip} from 'neuroglancer/async_computation/decode_gzip_request';
import {requestAsyncComputation} from 'neuroglancer/async_computation/request';
import {Chunk, ChunkManager, WithParameters} from 'neuroglancer/chunk_manager/backend';
import {GenericSharedDataSource} from 'neuroglancer/chunk_manager/generic_file_source';
import {ChunkedGraphSourceParameters, DataEncoding, MeshSourceParameters, ShardingHashFunction, ShardingParameters, SkeletonSourceParameters, VolumeChunkEncoding, VolumeChunkSourceParameters} from 'neuroglancer/datasource/graphene/base';
import {assignMeshFragmentData, decodeJsonManifestChunk, decodeTriangleVertexPositionsAndIndices, decodeTriangleVertexPositionsAndIndicesDraco, FragmentChunk, ManifestChunk, MeshSource} from 'neuroglancer/mesh/backend';
import {SkeletonChunk, SkeletonSource} from 'neuroglancer/skeleton/backend';
import {decodeSkeletonChunk} from 'neuroglancer/skeleton/decode_precomputed_skeleton';
import {ChunkDecoder} from 'neuroglancer/sliceview/backend_chunk_decoders';
import {decodeCompressedSegmentationChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/compressed_segmentation';
import {decodeJpegChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/jpeg';
import {decodeRawChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/raw';
import {ChunkedGraphChunk, ChunkedGraphChunkSource, decodeSupervoxelArray} from 'neuroglancer/sliceview/chunked_graph/backend';
import {VolumeChunk, VolumeChunkSource} from 'neuroglancer/sliceview/volume/backend';
import {fetchHttpByteRange} from 'neuroglancer/util/byte_range_http_requests';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {Borrowed} from 'neuroglancer/util/disposable';
import {convertEndian32, Endianness} from 'neuroglancer/util/endian';
import {murmurHash3_x86_128Hash64Bits} from 'neuroglancer/util/hash';
import {cancellableFetchOk, responseArrayBuffer, responseJson} from 'neuroglancer/util/http_request';
import {stableStringify} from 'neuroglancer/util/json';
import {Uint64} from 'neuroglancer/util/uint64';
import {registerSharedObject} from 'neuroglancer/worker_rpc';

const DracoLoader = require('dracoloader');

const shardingHashFunctions: Map<ShardingHashFunction, (out: Uint64) => void> = new Map([
  [
    ShardingHashFunction.MURMURHASH3_X86_128,
    (out) => {
      murmurHash3_x86_128Hash64Bits(out, 0, out.low, out.high);
    }
  ],
  [ShardingHashFunction.IDENTITY, (_out) => {}],
]);

interface ShardInfo {
  shardUrl: string;
  offset: Uint64;
}

interface DecodedMinishardIndex {
  data: Uint32Array;
  shardUrl: string;
}

interface MinishardIndexSource extends GenericSharedDataSource<Uint64, DecodedMinishardIndex> {
  sharding: ShardingParameters;
}

function getMinishardIndexDataSource(
    chunkManager: Borrowed<ChunkManager>,
    parameters: {url: string, sharding: ShardingParameters|undefined}): MinishardIndexSource|
    undefined {
  const {url, sharding} = parameters;
  if (sharding === undefined) return undefined;
  const source =
      GenericSharedDataSource.get<Uint64, DecodedMinishardIndex>(
          chunkManager, stableStringify({type: 'graphene:shardedDataSource', url, sharding}), {
            download: async function(
                shardAndMinishard: Uint64, cancellationToken: CancellationToken) {
              const minishard = Uint64.lowMask(new Uint64(), sharding.minishardBits);
              Uint64.and(minishard, minishard, shardAndMinishard);
              const shard = Uint64.lowMask(new Uint64(), sharding.shardBits);
              const temp = new Uint64();
              Uint64.rshift(temp, shardAndMinishard, sharding.minishardBits);
              Uint64.and(shard, shard, temp);
              const shardUrlPrefix =
                  `${url}/${shard.toString(16).padStart(Math.ceil(sharding.shardBits / 4), '0')}`;
              // Retrive minishard index start/end offsets.
              const indexUrl = shardUrlPrefix + '.index';

              // Multiply minishard by 16.
              const shardIndexStart = Uint64.lshift(new Uint64(), minishard, 4);
              const shardIndexEnd = Uint64.addUint32(new Uint64(), shardIndexStart, 16);
              const shardIndexResponse = await fetchHttpByteRange(
                  indexUrl, shardIndexStart, shardIndexEnd, cancellationToken);
              if (shardIndexResponse.byteLength !== 16) {
                throw new Error(`Failed to retrieve minishard offset`);
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

              const dataUrl = shardUrlPrefix + '.data';
              let minishardIndexResponse = await fetchHttpByteRange(
                  dataUrl, minishardStartOffset, minishardEndOffset, cancellationToken);
              if (sharding.minishardIndexEncoding === DataEncoding.GZIP) {
                minishardIndexResponse =
                    (await requestAsyncComputation(
                         decodeGzip, cancellationToken, [minishardIndexResponse],
                         new Uint8Array(minishardIndexResponse)))
                        .buffer;
              }
              if ((minishardIndexResponse.byteLength % 24) !== 0) {
                throw new Error(
                    `Invalid minishard index length: ${minishardIndexResponse.byteLength}`);
              }
              const minishardIndex = new Uint32Array(minishardIndexResponse);
              convertEndian32(minishardIndex, Endianness.LITTLE);

              const minishardIndexSize = minishardIndex.byteLength / 24;
              let prevEntryKeyLow = 0, prevEntryKeyHigh = 0, prevStartLow = 0, prevStartHigh = 0;
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
              return {
                data: {data: minishardIndex, shardUrl: dataUrl},
                size: minishardIndex.byteLength
              };
            },
            encodeKey: (key: Uint64) => key.toString(),
            sourceQueueLevel: 1,
          }) as MinishardIndexSource;
  source.sharding = sharding;
  return source;
}

function findMinishardEntry(minishardIndex: DecodedMinishardIndex, key: Uint64) {
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
  throw new Error(`Object not found in minishard: ${key}`);
}

async function getShardedData(
    minishardIndexSource: MinishardIndexSource, chunk: Chunk, key: Uint64,
    cancellationToken: CancellationToken): Promise<{shardInfo: ShardInfo, data: ArrayBuffer}> {
  const {sharding} = minishardIndexSource;
  const hashFunction = shardingHashFunctions.get(sharding.hash)!;
  const hashCode = Uint64.rshift(new Uint64(), key, sharding.preshiftBits);
  hashFunction(hashCode);
  const shardAndMinishard =
      Uint64.lowMask(new Uint64(), sharding.minishardBits + sharding.shardBits);
  Uint64.and(shardAndMinishard, shardAndMinishard, hashCode);
  const getPriority = () => ({priorityTier: chunk.priorityTier, priority: chunk.priority});
  const minishardIndex =
      await minishardIndexSource.getData(shardAndMinishard, getPriority, cancellationToken);
  const {startOffset, endOffset} = findMinishardEntry(minishardIndex, key);
  let data =
      await fetchHttpByteRange(minishardIndex.shardUrl, startOffset, endOffset, cancellationToken);
  if (minishardIndexSource.sharding.dataEncoding === DataEncoding.GZIP) {
    data =
        (await requestAsyncComputation(decodeGzip, cancellationToken, [data], new Uint8Array(data)))
            .buffer;
  }
  return {data, shardInfo: {shardUrl: minishardIndex.shardUrl, offset: startOffset}};
}


const chunkDecoders = new Map<VolumeChunkEncoding, ChunkDecoder>();
chunkDecoders.set(VolumeChunkEncoding.RAW, decodeRawChunk);
chunkDecoders.set(VolumeChunkEncoding.JPEG, decodeJpegChunk);
chunkDecoders.set(VolumeChunkEncoding.COMPRESSED_SEGMENTATION, decodeCompressedSegmentationChunk);

@registerSharedObject() export class GrapheneVolumeChunkSource extends
(WithParameters(VolumeChunkSource, VolumeChunkSourceParameters)) {
  chunkDecoder = chunkDecoders.get(this.parameters.encoding)!;

  async download(chunk: VolumeChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;
    let url: string;
    {
      // chunkPosition must not be captured, since it will be invalidated by the next call to
      // computeChunkBounds.
      let chunkPosition = this.computeChunkBounds(chunk);
      let chunkDataSize = chunk.chunkDataSize!;
      url = `${parameters.url}/${chunkPosition[0]}-${chunkPosition[0] + chunkDataSize[0]}_` +
          `${chunkPosition[1]}-${chunkPosition[1] + chunkDataSize[1]}_` +
          `${chunkPosition[2]}-${chunkPosition[2] + chunkDataSize[2]}`;
    }
    const response = await cancellableFetchOk(url, {}, responseArrayBuffer, cancellationToken);
    await this.chunkDecoder(chunk, cancellationToken, response);
  }
}

export function decodeChunkedGraphChunk(
    chunk: ChunkedGraphChunk, rootObjectKey: string, response: ArrayBuffer) {
  return decodeSupervoxelArray(chunk, rootObjectKey, response);
}

@registerSharedObject() export class GrapheneChunkedGraphChunkSource extends
(WithParameters(ChunkedGraphChunkSource, ChunkedGraphSourceParameters)) {
  async download(chunk: ChunkedGraphChunk, cancellationToken: CancellationToken) {
    let {parameters} = this;
    let chunkPosition = this.computeChunkBounds(chunk);
    let chunkDataSize = chunk.chunkDataSize!;
    let bounds = `${chunkPosition[0]}-${chunkPosition[0] + chunkDataSize[0]}_` +
        `${chunkPosition[1]}-${chunkPosition[1] + chunkDataSize[1]}_` +
        `${chunkPosition[2]}-${chunkPosition[2] + chunkDataSize[2]}`;

    let promises = Array<Promise<void>>();
    for (const [key, val] of chunk.mappings!.entries()) {
      if (val === null) {
        const segmentsDownloadPromise = cancellableFetchOk(
            `${parameters.url}/${key}/leaves?bounds=${bounds}`, {}, responseArrayBuffer,
            cancellationToken);
        promises.push(segmentsDownloadPromise.then(
            response => decodeChunkedGraphChunk(chunk, key, response)));
      }
    }
    await Promise.all(promises);
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
          response, Endianness.LITTLE, /*vertexByteOffset=*/4, numVertices));
}

export function decodeDracoFragmentChunk(
    chunk: FragmentChunk, response: ArrayBuffer, decoderModule: any) {
  assignMeshFragmentData(
      chunk, decodeTriangleVertexPositionsAndIndicesDraco(response, decoderModule));
}

@registerSharedObject() export class GrapheneMeshSource extends
(WithParameters(MeshSource, MeshSourceParameters)) {
  download(chunk: ManifestChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;
    return cancellableFetchOk(
               `${parameters.manifestUrl}/manifest/${chunk.objectId}:${parameters.lod}?verify=True`,
               {}, responseJson, cancellationToken)
        .then(response => decodeManifestChunk(chunk, response));
  }

  downloadFragment(chunk: FragmentChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;
    const fragmentDownloadPromise = cancellableFetchOk(
        `${parameters.fragmentUrl}/${chunk.fragmentId}`, {}, responseArrayBuffer,
        cancellationToken);
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
          Promise.reject(error);
        });
  }
}

@registerSharedObject() //
export class GrapheneSkeletonSource extends
(WithParameters(SkeletonSource, SkeletonSourceParameters)) {
  private minishardIndexSource = getMinishardIndexDataSource(
      this.chunkManager, {url: this.parameters.url, sharding: this.parameters.metadata.sharding});
  async download(chunk: SkeletonChunk, cancellationToken: CancellationToken) {
    const {minishardIndexSource, parameters} = this;
    let response: ArrayBuffer;
    if (minishardIndexSource === undefined) {
      response = await cancellableFetchOk(
          `${parameters.url}/${chunk.objectId}`, {}, responseArrayBuffer, cancellationToken);
    } else {
      response =
          (await getShardedData(minishardIndexSource, chunk, chunk.objectId, cancellationToken))
              .data;
    }
    decodeSkeletonChunk(chunk, response, parameters.metadata.vertexAttributes);
  }
}
