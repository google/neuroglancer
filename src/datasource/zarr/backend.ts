/**
 * @license
 * Copyright 2020 Google Inc.
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

import "#src/datasource/zarr/codec/blosc/decode.js";
import "#src/datasource/zarr/codec/bytes/decode.js";
import "#src/datasource/zarr/codec/crc32c/decode.js";
import "#src/datasource/zarr/codec/zstd/decode.js";

import { WithParameters } from "#src/chunk_manager/backend.js";
import { VolumeChunkSourceParameters } from "#src/datasource/zarr/base.js";
import {
  applySharding,
  decodeArray,
} from "#src/datasource/zarr/codec/decode.js";
import "#src/datasource/zarr/codec/gzip/decode.js";
import "#src/datasource/zarr/codec/sharding_indexed/decode.js";
import "#src/datasource/zarr/codec/transpose/decode.js";
import { ChunkKeyEncoding } from "#src/datasource/zarr/metadata/index.js";
import { WithSharedKvStoreContextCounterpart } from "#src/kvstore/backend.js";
import { postProcessRawData } from "#src/sliceview/backend_chunk_decoders/postprocess.js";
import type { VolumeChunk } from "#src/sliceview/volume/backend.js";
import { VolumeChunkSource } from "#src/sliceview/volume/backend.js";
import { registerSharedObject } from "#src/worker_rpc.js";

@registerSharedObject()
export class ZarrVolumeChunkSource extends WithParameters(
  WithSharedKvStoreContextCounterpart(VolumeChunkSource),
  VolumeChunkSourceParameters,
) {
  private chunkKvStore = applySharding(
    this.chunkManager,
    this.parameters.metadata.codecs,
    this.sharedKvStoreContext.kvStoreContext.getKvStore(this.parameters.url),
  );

  async download(chunk: VolumeChunk, signal: AbortSignal) {
    chunk.chunkDataSize = this.spec.chunkDataSize;
    const { parameters } = this;
    const { chunkGridPosition } = chunk;
    const { metadata } = parameters;
    let baseKey = "";
    const rank = this.spec.rank;
    const { physicalToLogicalDimension } = metadata.codecs.layoutInfo[0];
    let sep: string;
    if (metadata.chunkKeyEncoding === ChunkKeyEncoding.DEFAULT) {
      baseKey += "c";
      sep = metadata.dimensionSeparator;
    } else {
      sep = "";
      if (rank === 0) {
        baseKey += "0";
      }
    }
    const keyCoords = new Array<number>(rank);
    const { readChunkShape } = metadata.codecs.layoutInfo[0];
    const { chunkShape } = metadata;
    for (
      let fOrderPhysicalDim = 0;
      fOrderPhysicalDim < rank;
      ++fOrderPhysicalDim
    ) {
      const decodedDim =
        physicalToLogicalDimension[rank - 1 - fOrderPhysicalDim];
      keyCoords[decodedDim] = Math.floor(
        (chunkGridPosition[fOrderPhysicalDim] * readChunkShape[decodedDim]) /
          chunkShape[decodedDim],
      );
    }
    for (let i = 0; i < rank; ++i) {
      baseKey += `${sep}${keyCoords[i]}`;
      sep = metadata.dimensionSeparator;
    }
    const { chunkKvStore } = this;
    const response = await chunkKvStore.kvStore.read(
      chunkKvStore.getChunkKey(chunkGridPosition, baseKey),
      { signal },
    );
    if (response !== undefined) {
      const decoded = await decodeArray(
        chunkKvStore.decodeCodecs,
        new Uint8Array(await response.response.arrayBuffer()),
        signal,
      );
      await postProcessRawData(chunk, signal, decoded);
    }
  }
}
