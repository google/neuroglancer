/**
 * @license
 * Copyright 2023 Google Inc.
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

import {ChunkManager} from 'neuroglancer/chunk_manager/backend';
import {CodecArrayInfo, CodecChainSpec, CodecKind} from 'neuroglancer/datasource/zarr/codec';
import {ReadableKvStore} from 'neuroglancer/kvstore';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {RefCounted} from 'neuroglancer/util/disposable';

export interface Codec {
  name: string;
  kind: CodecKind;
}

export interface ArrayToArrayCodec<Configuration = unknown> extends Codec {
  kind: CodecKind.arrayToArray;
  decode(
      configuration: Configuration, decodedArrayInfo: CodecArrayInfo, encoded: ArrayBufferView,
      cancellationToken: CancellationToken): Promise<ArrayBufferView>;
}

export interface ArrayToBytesCodec<Configuration = unknown> extends Codec {
  kind: CodecKind.arrayToBytes;
  decode(
      configuration: Configuration, decodedArrayInfo: CodecArrayInfo, encoded: Uint8Array,
      cancellationToken: CancellationToken): Promise<ArrayBufferView>;
}

export type ShardingKey<BaseKey> = {
  base: BaseKey,
  subChunk: number[]
};

export interface ShardingCodec<Configuration = unknown> extends Codec {
  kind: CodecKind.arrayToBytes;
  getShardedKvStore<BaseKey>(
      configuration: Configuration, chunkManager: ChunkManager,
      base: ReadableKvStore<BaseKey>): ReadableKvStore<ShardingKey<BaseKey>>&RefCounted;
}

export interface BytesToBytesCodec<Configuration = unknown> extends Codec {
  kind: CodecKind.bytesToBytes;
  decode(configuration: Configuration, encoded: Uint8Array, cancellationToken: CancellationToken):
      Promise<Uint8Array>;
}

const codecRegistry = {
  [CodecKind.arrayToArray]: new Map<string, ArrayToArrayCodec>(),
  [CodecKind.arrayToBytes]: new Map<string, ArrayToBytesCodec>(),
  [CodecKind.bytesToBytes]: new Map<string, BytesToBytesCodec>(),
  sharding: new Map<string, ShardingCodec>(),
};

export function registerCodec<Configuration>(
    codec: ArrayToArrayCodec<Configuration>|ArrayToBytesCodec<Configuration>|
    BytesToBytesCodec<Configuration>|ShardingCodec<Configuration>) {
  if (codec.kind === CodecKind.arrayToBytes && 'getShardedKvStore' in codec) {
    codecRegistry.sharding.set(codec.name, codec as any);
  } else {
    codecRegistry[codec.kind].set(codec.name, codec as any);
  }
}

export async function decodeArray(
    codecs: CodecChainSpec, encoded: Uint8Array,
    cancellationToken: CancellationToken): Promise<ArrayBufferView> {
  const bytesToBytes = codecs[CodecKind.bytesToBytes];
  for (let i = bytesToBytes.length; i--;) {
    const codec = bytesToBytes[i];
    const impl = codecRegistry[CodecKind.bytesToBytes].get(codec.name);
    if (impl === undefined) {
      throw new Error(`Unsupported codec: ${JSON.stringify(codec.name)}`);
    }
    encoded = await impl.decode(codec.configuration, encoded, cancellationToken);
  }

  let decoded: ArrayBufferView;
  {
    const codec = codecs[CodecKind.arrayToBytes];
    const impl = codecRegistry[CodecKind.arrayToBytes].get(codec.name);
    if (impl === undefined) {
      throw new Error(`Unsupported codec: ${JSON.stringify(codec.name)}`);
    }
    decoded = await impl.decode(
        codec.configuration, codecs.arrayInfo[codecs.arrayInfo.length - 1], encoded,
        cancellationToken);
  }


  const arrayToArray = codecs[CodecKind.arrayToArray];
  for (let i = arrayToArray.length; i--;) {
    const codec = arrayToArray[i];
    const impl = codecRegistry[CodecKind.arrayToArray].get(codec.name);
    if (impl === undefined) {
      throw new Error(`Unsupported codec: ${JSON.stringify(codec.name)}`);
    }
    decoded =
        await impl.decode(codec.configuration, codecs.arrayInfo[i], decoded, cancellationToken);
  }

  return decoded;
}

export function applySharding(
    chunkManager: ChunkManager, codecs: CodecChainSpec, baseKvStore: ReadableKvStore<string>): {
  kvStore: ReadableKvStore<unknown>,
  getChunkKey: (chunkGridPosition: ArrayLike<number>, baseKey: string) => unknown,
  decodeCodecs: CodecChainSpec,
} {
  let kvStore: ReadableKvStore<unknown> = baseKvStore;
  let curCodecs = codecs;
  while (true) {
    const {shardingInfo} = curCodecs;
    if (shardingInfo === undefined) break;
    const codec = curCodecs[CodecKind.arrayToBytes];
    const impl = codecRegistry.sharding.get(codec.name);
    if (impl === undefined) {
      throw new Error(`Unsupported codec: ${JSON.stringify(codec.name)}`);
    }
    kvStore = impl.getShardedKvStore(codec.configuration, chunkManager, kvStore);
    curCodecs = shardingInfo.subChunkCodecs;
  }

  const decodeCodecs = curCodecs;

  function getChunkKey(chunkGridPosition: ArrayLike<number>, baseKey: string): unknown {
    let key: unknown = baseKey;
    const rank = chunkGridPosition.length;
    let curCodecs = codecs;
    while (curCodecs.shardingInfo !== undefined) {
      const layoutInfo = codecs.layoutInfo[codecs.layoutInfo.length - 1];
      const {physicalToLogicalDimension, readChunkShape} = layoutInfo;
      const {subChunkShape, subChunkGridShape, subChunkCodecs} = curCodecs.shardingInfo;
      const subChunk = new Array<number>(rank);
      for (let fOrderPhysicalDim = 0; fOrderPhysicalDim < rank; ++fOrderPhysicalDim) {
        const subChunkDim = physicalToLogicalDimension[rank - 1 - fOrderPhysicalDim];
        subChunk[subChunkDim] = Math.floor(
                                    chunkGridPosition[fOrderPhysicalDim] *
                                    readChunkShape[subChunkDim] / subChunkShape[subChunkDim]) %
            subChunkGridShape[subChunkDim];
      }
      key = {base: key, subChunk};
      curCodecs = subChunkCodecs;
    }
    return key;
  }

  return {kvStore, getChunkKey, decodeCodecs};
}
