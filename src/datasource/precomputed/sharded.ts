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

import type { ChunkManager } from "#src/chunk_manager/backend.js";
import { SimpleAsyncCache } from "#src/chunk_manager/generic_file_source.js";
import {
  DataEncoding,
  ShardingHashFunction,
  type ShardingParameters,
} from "#src/datasource/precomputed/base.js";
import { FileByteRangeHandle } from "#src/kvstore/byte_range/file_handle.js";
import { GzipFileHandle } from "#src/kvstore/gzip/file_handle.js";
import type {
  ByteRange,
  DriverReadOptions,
  FileHandle,
  KvStoreWithPath,
  ReadableKvStore,
  ReadResponse,
  StatOptions,
  StatResponse,
} from "#src/kvstore/index.js";
import { KvStoreFileHandle, readFileHandle } from "#src/kvstore/index.js";
import type { Owned } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import { convertEndian64, Endianness } from "#src/util/endian.js";
import { murmurHash3_x86_128Hash64Bits_Bigint } from "#src/util/hash.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";

const shardingHashFunctions: Map<
  ShardingHashFunction,
  (input: bigint) => bigint
> = new Map([
  [
    ShardingHashFunction.MURMURHASH3_X86_128,
    (input) => murmurHash3_x86_128Hash64Bits_Bigint(/*seed=*/ 0, input),
  ],
  [ShardingHashFunction.IDENTITY, (input) => input],
]);

export interface ShardInfo {
  shardPath: string;
  offset: number;
}

interface DecodedMinishardIndex {
  data: BigUint64Array;
  shardPath: string;
}

type MinishardIndexCache = SimpleAsyncCache<
  bigint,
  DecodedMinishardIndex | undefined
>;

function decodeFileHandle(handle: FileHandle, encoding: DataEncoding) {
  if (encoding === DataEncoding.GZIP) {
    handle = new GzipFileHandle(handle, "gzip");
  }
  return handle;
}

function makeMinishardIndexCache(
  chunkManager: ChunkManager,
  base: KvStoreWithPath,
  sharding: ShardingParameters,
): MinishardIndexCache {
  return new SimpleAsyncCache(chunkManager.addRef(), {
    encodeKey: (key) => key.toString(),
    get: async (
      shardAndMinishard: bigint,
      progressOptions: Partial<ProgressOptions>,
    ) => {
      const minishard =
        shardAndMinishard & ((1n << BigInt(sharding.minishardBits)) - 1n);
      const shard =
        ((1n << BigInt(sharding.shardBits)) - 1n) &
        (shardAndMinishard >> BigInt(sharding.minishardBits));
      const shardPath =
        base.path +
        shard.toString(16).padStart(Math.ceil(sharding.shardBits / 4), "0") +
        ".shard";

      const shardFileHandle = new KvStoreFileHandle(base.store, shardPath);

      // Retrive minishard index start/end offsets.
      const shardIndexSize = BigInt(16) << BigInt(sharding.minishardBits);

      // Multiply minishard by 16.
      const shardIndexStart = minishard << 4n;
      const response = await readFileHandle(shardFileHandle, {
        ...progressOptions,
        byteRange: { offset: Number(shardIndexStart), length: 16 },
        strictByteRange: true,
      });
      if (response === undefined) {
        return { data: undefined, size: 0 };
      }
      const shardIndexResponse = await response.response.arrayBuffer();
      const shardIndexDv = new DataView(shardIndexResponse);
      let minishardStartOffset = shardIndexDv.getBigUint64(
        0,
        /*littleEndian=*/ true,
      );
      let minishardEndOffset = shardIndexDv.getBigUint64(
        8,
        /*littleEndian=*/ true,
      );
      if (minishardStartOffset === minishardEndOffset) {
        return { data: undefined, size: 0 };
      }
      // The start/end offsets in the shard index are relative to the end of the shard
      // index.
      minishardStartOffset += shardIndexSize;
      minishardEndOffset += shardIndexSize;

      const minishardIndexBuffer = await (
        await readFileHandle(
          decodeFileHandle(
            new FileByteRangeHandle(shardFileHandle, {
              offset: Number(minishardStartOffset),
              length: Number(minishardEndOffset - minishardStartOffset),
            }),
            sharding.minishardIndexEncoding,
          ),
          {
            ...progressOptions,
            strictByteRange: true,
            throwIfMissing: true,
          },
        )
      ).response.arrayBuffer();
      if (minishardIndexBuffer.byteLength % 24 !== 0) {
        throw new Error(
          `Invalid minishard index length: ${minishardIndexBuffer.byteLength}`,
        );
      }
      const minishardIndex = new BigUint64Array(minishardIndexBuffer);
      convertEndian64(minishardIndex, Endianness.LITTLE);

      const minishardIndexSize = minishardIndex.byteLength / 24;
      let prevEntryKey = 0n;
      // Offsets in the minishard index are relative to the end of the shard index.
      let prevStart = shardIndexSize;
      for (let i = 0; i < minishardIndexSize; ++i) {
        const entryKey = prevEntryKey + minishardIndex[i];
        prevEntryKey = minishardIndex[i] = entryKey;
        const start = prevStart + minishardIndex[minishardIndexSize + i];
        minishardIndex[minishardIndexSize + i] = start;
        const size = minishardIndex[2 * minishardIndexSize + i];
        const end = start + size;
        prevStart = end;
        minishardIndex[2 * minishardIndexSize + i] = end;
      }
      return {
        data: { data: minishardIndex, shardPath },
        size: minishardIndex.byteLength,
      };
    },
  });
}

function findMinishardEntry(
  minishardIndex: DecodedMinishardIndex,
  key: bigint,
): ByteRange | undefined {
  const minishardIndexData = minishardIndex.data;
  const minishardIndexSize = minishardIndexData.length / 3;
  for (let i = 0; i < minishardIndexSize; ++i) {
    if (minishardIndexData[i] !== key) {
      continue;
    }
    const startOffset = minishardIndexData[minishardIndexSize + i];
    const endOffset = minishardIndexData[2 * minishardIndexSize + i];

    return {
      offset: Number(startOffset),
      length: Number(endOffset - startOffset),
    };
  }
  return undefined;
}

export class ShardedKvStore
  extends RefCounted
  implements ReadableKvStore<bigint>
{
  private minishardIndexCache: Owned<MinishardIndexCache>;

  constructor(
    chunkManager: ChunkManager,
    private base: KvStoreWithPath,
    private sharding: ShardingParameters,
  ) {
    super();
    this.minishardIndexCache = this.registerDisposer(
      makeMinishardIndexCache(chunkManager, base, sharding),
    );
  }

  getUrl(key: bigint): string {
    return `chunk ${key} in ${this.base.store.getUrl(this.base.path)}`;
  }

  async findKey(
    key: bigint,
    progressOptions: Partial<ProgressOptions>,
  ): Promise<{ minishardEntry: ByteRange; shardInfo: ShardInfo } | undefined> {
    const { sharding } = this;
    const hashFunction = shardingHashFunctions.get(sharding.hash)!;
    const hashCode = hashFunction(key >> BigInt(sharding.preshiftBits));
    const shardAndMinishard =
      hashCode &
      ((1n << BigInt(sharding.minishardBits + sharding.shardBits)) - 1n);
    const minishardIndex = await this.minishardIndexCache.get(
      shardAndMinishard,
      progressOptions,
    );
    if (minishardIndex === undefined) return undefined;
    const minishardEntry = findMinishardEntry(minishardIndex, key);
    if (minishardEntry === undefined) return undefined;
    return {
      minishardEntry,
      shardInfo: {
        shardPath: minishardIndex.shardPath,
        offset: minishardEntry.offset,
      },
    };
  }

  async readWithShardInfo(
    key: bigint,
    options: DriverReadOptions,
  ): Promise<
    | {
        response: ReadResponse;
        shardInfo: ShardInfo;
      }
    | undefined
  > {
    const { sharding } = this;
    const findResult = await this.findKey(key, options);
    if (findResult === undefined) return undefined;
    const { minishardEntry, shardInfo } = findResult;
    return {
      response: (await decodeFileHandle(
        new FileByteRangeHandle(
          new KvStoreFileHandle(this.base.store, shardInfo.shardPath),
          minishardEntry,
        ),
        sharding.dataEncoding,
      ).read(options))!,
      shardInfo,
    };
  }

  async stat(
    key: bigint,
    options: StatOptions,
  ): Promise<StatResponse | undefined> {
    const findResult = await this.findKey(key, options);
    if (findResult === undefined) return undefined;
    const { sharding } = this;
    if (sharding.dataEncoding !== DataEncoding.RAW) {
      return { totalSize: undefined };
    } else {
      return { totalSize: findResult.minishardEntry.length };
    }
  }

  async read(
    key: bigint,
    options: DriverReadOptions,
  ): Promise<ReadResponse | undefined> {
    const response = await this.readWithShardInfo(key, options);
    if (response === undefined) return undefined;
    return response.response;
  }

  get supportsOffsetReads() {
    return this.sharding.dataEncoding === DataEncoding.RAW;
  }
  get supportsSuffixReads() {
    return this.sharding.dataEncoding === DataEncoding.RAW;
  }
}

export function getShardedKvStoreIfApplicable(
  chunkSource: RefCounted & {
    chunkManager: ChunkManager;
  },
  base: KvStoreWithPath,
  sharding: ShardingParameters | undefined,
) {
  if (sharding === undefined) return undefined;
  return chunkSource.registerDisposer(
    new ShardedKvStore(chunkSource.chunkManager, base, sharding),
  );
}
