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

import type { ChunkManager } from "#src/chunk_manager/backend.js";
import { ChunkState } from "#src/chunk_manager/base.js";
import { SimpleAsyncCache } from "#src/chunk_manager/generic_file_source.js";
import {
  decodeArray,
  registerCodec,
} from "#src/datasource/zarr/codec/decode.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import type {
  Configuration,
  IndexConfiguration,
} from "#src/datasource/zarr/codec/sharding_indexed/resolve.js";
import { ShardIndexLocation } from "#src/datasource/zarr/codec/sharding_indexed/resolve.js";
import { FileByteRangeHandle } from "#src/kvstore/byte_range/file_handle.js";
import type {
  ByteRangeRequest,
  ReadableKvStore,
  DriverReadOptions,
  ReadResponse,
  StatResponse,
  StatOptions,
  ByteRange,
} from "#src/kvstore/index.js";
import { KvStoreFileHandle } from "#src/kvstore/index.js";
import type { Owned } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";

type ShardIndex = BigUint64Array | undefined;

const MISSING_VALUE = BigInt("18446744073709551615");

type ShardIndexCache<BaseKey> = SimpleAsyncCache<BaseKey, ShardIndex>;

function makeIndexCache<BaseKey>(
  chunkManager: ChunkManager,
  base: ReadableKvStore<BaseKey>,
  configuration: IndexConfiguration,
): ShardIndexCache<BaseKey> {
  return new SimpleAsyncCache(chunkManager.addRef(), {
    get: async (key: BaseKey, progressOptions: ProgressOptions) => {
      const { indexCodecs } = configuration;
      const encodedSize =
        indexCodecs.encodedSize[indexCodecs.encodedSize.length - 1];
      let byteRange: ByteRangeRequest;
      switch (configuration.indexLocation) {
        case ShardIndexLocation.START:
          byteRange = { offset: 0, length: encodedSize! };
          break;
        case ShardIndexLocation.END:
          byteRange = { suffixLength: encodedSize! };
          break;
      }
      const response = await base.read(key, {
        ...progressOptions,
        byteRange,
      });
      if (response === undefined) {
        return { size: 0, data: undefined };
      }
      const index = await decodeArray(
        configuration.indexCodecs,
        new Uint8Array(await response.response.arrayBuffer()),
        progressOptions.signal,
      );
      return {
        size: index.byteLength,
        data: new BigUint64Array(
          index.buffer,
          index.byteOffset,
          index.byteLength / 8,
        ),
      };
    },
  });
}

class ShardedKvStore<BaseKey>
  extends RefCounted
  implements ReadableKvStore<{ base: BaseKey; subChunk: number[] }>
{
  private indexCache: Owned<ShardIndexCache<BaseKey>>;
  private indexStrides: number[];
  constructor(
    private configuration: Configuration,
    chunkManager: ChunkManager,
    private base: ReadableKvStore<BaseKey>,
  ) {
    super();
    this.indexCache = this.registerDisposer(
      makeIndexCache(chunkManager, base, configuration),
    );
    const { subChunkGridShape } = this.configuration;
    const rank = subChunkGridShape.length;
    const physicalToLogicalIndexDimension =
      this.configuration.indexCodecs.layoutInfo[0].physicalToLogicalDimension;
    const indexStrides = (this.indexStrides = new Array(rank + 1));
    let stride = 1;
    for (
      let physicalIndexDim = rank;
      physicalIndexDim >= 0;
      --physicalIndexDim
    ) {
      const logicalIndexDim = physicalToLogicalIndexDimension[physicalIndexDim];
      indexStrides[logicalIndexDim] = stride;
      stride *=
        logicalIndexDim === rank ? 2 : subChunkGridShape[logicalIndexDim];
    }
  }

  private async findKey(
    key: {
      base: BaseKey;
      subChunk: number[];
    },
    progressOptions: Partial<ProgressOptions>,
  ): Promise<ByteRange | undefined> {
    const shardIndex = await this.indexCache.get(key.base, progressOptions);
    if (shardIndex === undefined) {
      // Shard not present.
      return undefined;
    }
    const rank = this.configuration.subChunkShape.length;
    const { subChunk } = key;
    const { indexStrides } = this;
    let indexOffset = 0;
    for (let logicalIndexDim = 0; logicalIndexDim < rank; ++logicalIndexDim) {
      const pos = subChunk[logicalIndexDim];
      indexOffset += pos * indexStrides[logicalIndexDim];
    }
    const dataOffset = shardIndex[indexOffset];
    const dataLength = shardIndex[indexOffset + indexStrides[rank]];
    if (dataOffset === MISSING_VALUE && dataLength === MISSING_VALUE) {
      // Sub-chunk not present.
      return undefined;
    }
    return {
      offset: Number(dataOffset),
      length: Number(dataLength),
    };
  }

  async stat(
    key: { base: BaseKey; subChunk: number[] },
    options: StatOptions,
  ): Promise<StatResponse | undefined> {
    const fullByteRange = await this.findKey(key, options);
    if (fullByteRange === undefined) return undefined;
    return { totalSize: fullByteRange.length };
  }

  async read(
    key: { base: BaseKey; subChunk: number[] },
    options: DriverReadOptions,
  ): Promise<ReadResponse | undefined> {
    const fullByteRange = await this.findKey(key, options);
    if (fullByteRange === undefined) return undefined;
    return new FileByteRangeHandle(
      new KvStoreFileHandle(this.base, key.base),
      fullByteRange,
    ).read(options);
  }

  getUrl(key: { base: BaseKey; subChunk: number[] }): string {
    return `subchunk ${JSON.stringify(key.subChunk)} within shard ${this.base.getUrl(key.base)}`;
  }

  invalidateIndexCache() {
    const { indexCache } = this;
    for (const chunk of indexCache.chunks.values()) {
      if (chunk.state === ChunkState.SYSTEM_MEMORY_WORKER) {
        chunk.freeSystemMemory();
      }
      indexCache.chunkManager.queueManager.updateChunkState(chunk, ChunkState.QUEUED);
    }
  }

  get supportsOffsetReads() {
    return true;
  }
  get supportsSuffixReads() {
    return true;
  }
}

registerCodec({
  name: "sharding_indexed",
  kind: CodecKind.arrayToBytes,
  getShardedKvStore<BaseKey>(
    configuration: Configuration,
    chunkManager: ChunkManager,
    base: ReadableKvStore<BaseKey>,
  ): ReadableKvStore<{ base: BaseKey; subChunk: number[] }> & RefCounted {
    return new ShardedKvStore(configuration, chunkManager, base);
  },
});
