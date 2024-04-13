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
import { SimpleAsyncCache } from "#src/chunk_manager/generic_file_source.js";
import {
  decodeArray,
  registerCodec,
} from "#src/datasource/zarr/codec/decode.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import type { Configuration } from "#src/datasource/zarr/codec/sharding_indexed/resolve.js";
import { ShardIndexLocation } from "#src/datasource/zarr/codec/sharding_indexed/resolve.js";
import type {
  ByteRangeRequest,
  ReadableKvStore,
  ReadOptions,
  ReadResponse,
} from "#src/kvstore/index.js";
import { composeByteRangeRequest } from "#src/kvstore/index.js";
import type { CancellationToken } from "#src/util/cancellation.js";
import { uncancelableToken } from "#src/util/cancellation.js";
import type { Owned } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";

type ShardIndex = BigUint64Array | undefined;

const MISSING_VALUE = BigInt("18446744073709551615");

class ShardedKvStore<BaseKey>
  extends RefCounted
  implements ReadableKvStore<{ base: BaseKey; subChunk: number[] }>
{
  private indexCache: Owned<SimpleAsyncCache<BaseKey, ShardIndex>>;
  private indexStrides: number[];
  constructor(
    private configuration: Configuration,
    chunkManager: ChunkManager,
    private base: ReadableKvStore<BaseKey>,
  ) {
    super();
    this.indexCache = this.registerDisposer(
      new SimpleAsyncCache(chunkManager.addRef(), {
        get: async (key: BaseKey, cancellationToken: CancellationToken) => {
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
            cancellationToken,
            byteRange,
          });
          if (response === undefined) {
            return { size: 0, data: undefined };
          }
          const index = await decodeArray(
            configuration.indexCodecs,
            response.data,
            cancellationToken,
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
      }),
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

  async read(
    key: { base: BaseKey; subChunk: number[] },
    options: ReadOptions,
  ): Promise<ReadResponse | undefined> {
    const shardIndex = await this.indexCache.get(
      key.base,
      options.cancellationToken ?? uncancelableToken,
    );
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
    const fullByteRange = {
      offset: Number(dataOffset),
      length: Number(dataLength),
    };
    const { outer: outerByteRange, inner: innerByteRange } =
      composeByteRangeRequest(fullByteRange, options.byteRange);
    if (outerByteRange.length === 0) {
      return {
        data: new Uint8Array(0),
        dataRange: innerByteRange,
        totalSize: fullByteRange.length,
      };
    }
    const response = await this.base.read(key.base, {
      cancellationToken: options.cancellationToken,
      byteRange: outerByteRange,
    });
    if (response === undefined) {
      // Shard unexpectedly deleted.
      return undefined;
    }
    if (
      response.dataRange.offset !== outerByteRange.offset ||
      response.dataRange.length !== outerByteRange.length
    ) {
      throw new Error(
        `Received truncated response, expected ${JSON.stringify(
          outerByteRange,
        )} but received ${JSON.stringify(response.dataRange)}`,
      );
    }
    return {
      data: response.data,
      dataRange: innerByteRange,
      totalSize: fullByteRange.length,
    };
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
