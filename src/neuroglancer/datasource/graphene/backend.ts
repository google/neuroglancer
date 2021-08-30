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

import {decodeGzip} from 'neuroglancer/async_computation/decode_gzip_request';
import {requestAsyncComputation} from 'neuroglancer/async_computation/request';
import {ChunkManager, WithParameters} from 'neuroglancer/chunk_manager/backend';
import {GenericSharedDataSource} from 'neuroglancer/chunk_manager/generic_file_source';
import {WithSharedCredentialsProviderCounterpart} from 'neuroglancer/credentials_provider/shared_counterpart';
import {assignMeshFragmentData, FragmentChunk, ManifestChunk, MeshSource} from 'neuroglancer/mesh/backend';
import {fetchSpecialHttpByteRange, getGrapheneFragmentKey, responseIdentity} from 'neuroglancer/datasource/graphene/base';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {Borrowed} from 'neuroglancer/util/disposable';
import {convertEndian32, Endianness} from 'neuroglancer/util/endian';
import {cancellableFetchOk, isNotFoundError, responseArrayBuffer, responseJson} from 'neuroglancer/util/http_request';
import {stableStringify} from 'neuroglancer/util/json';
import {getObjectId} from 'neuroglancer/util/object_id';
import {SpecialProtocolCredentials, SpecialProtocolCredentialsProvider} from 'neuroglancer/util/special_protocol_request';
import {cancellableFetchSpecialOk} from 'neuroglancer/datasource/graphene/base';
import {Uint64} from 'neuroglancer/util/uint64';
import {registerSharedObject} from 'neuroglancer/worker_rpc';
import {ChunkedGraphSourceParameters, MeshSourceParameters} from 'neuroglancer/datasource/graphene/base';
import {DataEncoding, ShardingParameters} from 'neuroglancer/datasource/precomputed/base';
import {ChunkedGraphChunk, ChunkedGraphChunkSource, decodeSupervoxelArray} from 'neuroglancer/sliceview/chunked_graph/backend';
import {DecodedMinishardIndex, decodeManifestChunk} from 'neuroglancer/datasource/precomputed/backend';

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
        // should this be moved to chunked graph interface?
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
    minishardIndexSources;
    // if (chunk.verifyFragment !== undefined && !chunk.verifyFragment) {
    //   // Download shard fragments without verification
    //   fragmentDownloadPromise =
    //     getUnverifiedFragmentPromise(chunk, parameters, minishardIndexSources, cancellationToken);
    // }
    // else {
      // Download shard fragments with verification (response contains size and offset)
      fragmentDownloadPromise = getVerifiedFragmentPromise(chunk, parameters, cancellationToken);
    // }
  } else {
    fragmentDownloadPromise = cancellableFetchOk(
      `${parameters.fragmentUrl}/${chunk.fragmentId}`, {}, responseArrayBuffer,
      cancellationToken);
  }
  return fragmentDownloadPromise;
}

async function decodeDracoFragmentChunk(
    chunk: FragmentChunk, response: ArrayBuffer) {
  const m = await import(/* webpackChunkName: "draco" */ 'neuroglancer/mesh/draco');
  const rawMesh = await m.decodeDraco(new Uint8Array(response));
  assignMeshFragmentData(chunk, rawMesh);
}

@registerSharedObject() export class GrapheneMeshSource extends
(WithParameters(WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(MeshSource), MeshSourceParameters)) {
  protected minishardIndexSources: MinishardIndexSource[];

  async download(chunk: ManifestChunk, cancellationToken: CancellationToken) {
    cancellationToken.add(() => {
      console.log('GrapheneMeshSource cancelled');
    });
    const {parameters} = this;
    let url = `${parameters.manifestUrl}/manifest`;
    let manifestUrl = `${url}/${chunk.objectId}:${parameters.lod}?verify=1&prepend_seg_ids=1`;

    // commented out verifyFragments code until graphene proofreading is added

    // speculative manifest isn't working all the time
    // race condition is the prime suspect so use verify=true
    // chunk.verifyFragments = true;

    // parameters.sharding is a proxy for mesh format
    // if undefined, mesh format is old else new
    if (parameters.sharding !== undefined) {
      if (this.minishardIndexSources === undefined) {
        this.minishardIndexSources = getGrapheneMinishardIndexDataSources(
          this.chunkManager, undefined, {url: parameters.fragmentUrl, sharding: parameters.sharding})!;
      }
      // if (!chunk.verifyFragments) {
      //   manifestUrl = `${url}/${chunk.objectId}:${parameters.lod}?verify=0&prepend_seg_ids=1`;
      // }
    }
    await cancellableFetchSpecialOk(this.credentialsProvider, manifestUrl, {}, responseJson, cancellationToken)
        .then(response => decodeManifestChunk(chunk, response));
  }

  async downloadFragment(chunk: FragmentChunk, cancellationToken: CancellationToken) {
    const {parameters, minishardIndexSources} = this;

    try {
      const response = await getFragmentDownloadPromise(
        chunk, parameters, minishardIndexSources, cancellationToken);
      await decodeDracoFragmentChunk(chunk, response);
    } catch (e) {
      if (isNotFoundError(e)) {
        chunk.source!.removeChunk(chunk);
      }
      Promise.reject(e);
    }
  }

  getFragmentKey(objectKey: string|null, fragmentId: string) {
    objectKey;
    return getGrapheneFragmentKey(fragmentId);
  }
}
