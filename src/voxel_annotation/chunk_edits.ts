/**
 * @license
 * Copyright 2025 Google Inc.
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

import {
  ChunkDownloadStatistics,
  ChunkState,
  getChunkDownloadStatisticIndex,
} from "#src/chunk_manager/base.js";
import { DataType } from "#src/sliceview/base.js";
import { decodeChannel as decodeChannelUint32 } from "#src/sliceview/compressed_segmentation/decode_uint32.js";
import { decodeChannel as decodeChannelUint64 } from "#src/sliceview/compressed_segmentation/decode_uint64.js";
import { encodeChannel as encodeChannelUint32 } from "#src/sliceview/compressed_segmentation/encode_uint32.js";
import { encodeChannel as encodeChannelUint64 } from "#src/sliceview/compressed_segmentation/encode_uint64.js";
import type {
  VolumeChunk,
  VolumeChunkSource,
} from "#src/sliceview/volume/backend.js";
import type { TypedArray } from "#src/util/array.js";
import { TypedArrayBuilder } from "#src/util/array.js";
import { DATA_TYPE_ARRAY_CONSTRUCTOR } from "#src/util/data_type.js";
import type { vec3 } from "#src/util/geom.js";
import type { VoxelChange } from "#src/voxel_annotation/base.js";

/**
 * Returns a chunk for `chunkGridPosition` that is NOT registered in the shared
 * chunk cache. The queue manager never sees it, so concurrent invalidation or
 * eviction cannot dispose it (`chunk.source = null`) while an edit-path
 * download or write is in flight on it. It must never be added to
 * `source.chunks`, which is why it stays private to this module: the exported
 * functions only hand out its data, never the chunk itself.
 */
function getIsolatedChunk(
  source: VolumeChunkSource,
  chunkGridPosition: Float32Array,
): VolumeChunk {
  const chunk = new (source.chunkConstructor as new () => VolumeChunk)();
  chunk.source = source;
  chunk.initializeVolumeChunk(
    chunkGridPosition.join(),
    chunkGridPosition as vec3,
  );
  return chunk;
}

// Isolated downloads bypass the chunk queue: record the same download
// statistics as the queue does for its own downloads.
async function downloadIsolatedChunk(
  source: VolumeChunkSource,
  chunk: VolumeChunk,
) {
  const startTime = Date.now();
  await source.download(chunk, new AbortController().signal);
  const { statistics } = source;
  statistics[
    getChunkDownloadStatisticIndex(ChunkDownloadStatistics.totalTime)
  ] += Date.now() - startTime;
  ++statistics[
    getChunkDownloadStatisticIndex(ChunkDownloadStatistics.totalChunks)
  ];
}

function getFlatChunkData(
  chunk: VolumeChunk,
  spec: any,
): Uint32Array | BigUint64Array | TypedArray | null {
  if (!chunk.data) return null;

  if (!spec.compressedSegmentationBlockSize) {
    return chunk.data as TypedArray;
  }

  const size = chunk.chunkDataSize!;
  const numElements = size[0] * size[1] * size[2];
  const compressedData = chunk.data as Uint32Array;
  const baseOffset = compressedData.length > 0 ? compressedData[0] : 0;
  const subchunkSize = spec.compressedSegmentationBlockSize;

  if (spec.dataType === DataType.UINT32) {
    const out = new Uint32Array(numElements);
    if (baseOffset !== 0) {
      decodeChannelUint32(out, compressedData, baseOffset, size, subchunkSize);
    }
    return out;
  } else {
    const out = new BigUint64Array(numElements);
    if (baseOffset !== 0) {
      decodeChannelUint64(out, compressedData, baseOffset, size, subchunkSize);
    }
    return out;
  }
}

/**
 * Reads the chunk at `chunkGridPosition` as flat data, decompressing
 * compressed segmentation. The data is null if the chunk cannot be downloaded.
 */
export async function readChunkData(
  source: VolumeChunkSource,
  chunkKey: string,
  chunkGridPosition: Float32Array,
): Promise<{ data: TypedArray | null; chunkDataSize: Uint32Array | null }> {
  // Same pattern as `applyChunkEdits`: only use the shared cache entry when its
  // data is already resident (synchronous read, safe). Otherwise download
  // into an isolated chunk the queue manager cannot dispose mid-download.
  let chunk = source.chunks.get(chunkKey) as VolumeChunk | undefined;
  if (
    chunk === undefined ||
    chunk.state > ChunkState.SYSTEM_MEMORY_WORKER ||
    !chunk.data
  ) {
    chunk = getIsolatedChunk(source, chunkGridPosition);
    try {
      await downloadIsolatedChunk(source, chunk);
    } catch {
      return { data: null, chunkDataSize: chunk.chunkDataSize };
    }
  }

  if (!chunk.chunkDataSize) {
    source.computeChunkBounds(chunk);
  }

  return {
    data: getFlatChunkData(chunk, source.spec),
    chunkDataSize: chunk.chunkDataSize,
  };
}

export async function applyChunkEdits(
  source: VolumeChunkSource,
  chunkKey: string,
  indices: ArrayLike<number>,
  values: ArrayLike<number | bigint>,
): Promise<VoxelChange> {
  if (indices.length !== values.length) {
    throw new Error("applyChunkEdits: indices and values length mismatch");
  }
  const chunkGridPosition = new Float32Array(chunkKey.split(",").map(Number));
  if (
    chunkGridPosition.length !== source.spec.rank ||
    chunkGridPosition.some((v) => !Number.isFinite(v))
  ) {
    throw new Error(`applyChunkEdits: invalid chunk key ${chunkKey}`);
  }

  // The whole read-modify-write runs on an isolated chunk the queue manager
  // cannot see: mutating or encoding a shared cache entry races with
  // concurrent invalidation (dispose nulls `chunk.source` mid-download) and
  // with promotion/serialization (the buffer transfer to the frontend
  // detaches it mid-write). If the shared entry has resident data, copy it
  // synchronously (a detached source buffer makes `slice()` throw, failing
  // the edit loudly instead of writing garbage); otherwise download. The
  // shared entry itself is invalidated after the successful write below.
  const resident = source.chunks.get(chunkKey) as VolumeChunk | undefined;
  const chunk = getIsolatedChunk(source, chunkGridPosition);
  if (
    resident !== undefined &&
    resident.state <= ChunkState.SYSTEM_MEMORY_WORKER &&
    resident.data
  ) {
    chunk.chunkDataSize = resident.chunkDataSize;
    chunk.data = (resident.data as TypedArray).slice();
  } else {
    try {
      await downloadIsolatedChunk(source, chunk);
    } catch (e) {
      // Only deterministic decode failures proving the stored bytes themselves
      // are corrupt (e.g. the empty-body objects written by an earlier bug) may
      // be repaired by overwriting the stored chunk. Any other error may be
      // transient (network, server, cancellation, codec OOM, wrapped kvstore
      // errors) and must fail the edit: repairing on a false positive would
      // durably overwrite valid data (fail-closed).
      if (
        !(e instanceof Error && /Raw-format chunk is \d+ bytes/.test(e.message))
      ) {
        throw e;
      }
      // The stored object itself is corrupt: treat the chunk as absent so
      // the edit proceeds on fill data and the write below repairs it.
      console.warn(
        `applyChunkEdits: stored chunk ${chunkKey} is unreadable; ` +
          `treating it as empty and repairing it on write.`,
        e,
      );
    }
  }

  if (!chunk.chunkDataSize) {
    source.computeChunkBounds(chunk);
  }
  if (!chunk.chunkDataSize) {
    throw new Error(
      `applyChunkEdits: Cannot create new chunk ${chunkKey} because its size is unknown.`,
    );
  }

  if (!chunk.data) {
    const numElements = chunk.chunkDataSize.reduce((a, b) => a * b, 1);
    let Ctor;
    if (source.spec.compressedSegmentationBlockSize !== undefined) {
      Ctor = Uint32Array;
    } else {
      Ctor = DATA_TYPE_ARRAY_CONSTRUCTOR[source.spec.dataType];
    }
    chunk.data = new (Ctor as any)(numElements) as TypedArray;
  }

  const ArrayCtor = DATA_TYPE_ARRAY_CONSTRUCTOR[source.spec.dataType] as any;
  const indicesCopy = new Uint32Array(indices);
  const newValuesArray = new ArrayCtor(values.length);
  for (let i = 0; i < values.length; ++i) {
    newValuesArray[i] =
      source.spec.dataType === DataType.UINT64
        ? values[i]!
        : Number(values[i]!);
  }
  const oldValuesArray = new ArrayCtor(indices.length);

  if (source.spec.compressedSegmentationBlockSize !== undefined) {
    const compressedData = chunk.data as Uint32Array;
    const { chunkDataSize } = chunk;
    const numElements = chunkDataSize[0] * chunkDataSize[1] * chunkDataSize[2];
    const { dataType, compressedSegmentationBlockSize: subchunkSize } =
      source.spec;
    const baseOffset = compressedData.length > 0 ? compressedData[0] : 0;

    let uncompressedData: Uint32Array | BigUint64Array;
    if (dataType === DataType.UINT32) {
      uncompressedData = new Uint32Array(numElements);
      if (baseOffset !== 0) {
        decodeChannelUint32(
          uncompressedData,
          compressedData,
          baseOffset,
          chunkDataSize,
          subchunkSize!,
        );
      }
    } else {
      uncompressedData = new BigUint64Array(numElements);
      if (baseOffset !== 0) {
        decodeChannelUint64(
          uncompressedData,
          compressedData,
          baseOffset,
          chunkDataSize,
          subchunkSize!,
        );
      }
    }

    for (let i = 0; i < indices.length; ++i) {
      const idx = indices[i]!;
      if (idx < 0 || idx >= uncompressedData.length) {
        throw new Error(
          `applyChunkEdits: index ${idx} out of bounds for chunk ${chunkKey}`,
        );
      }
      oldValuesArray[i] = uncompressedData[idx];
      if (dataType === DataType.UINT32) {
        (uncompressedData as Uint32Array)[idx] = Number(values[i]!);
        newValuesArray[i] = Number(values[i]!);
      } else {
        (uncompressedData as BigUint64Array)[idx] = values[i]! as bigint;
        newValuesArray[i] = values[i]! as bigint;
      }
    }

    const outputBuilder = new TypedArrayBuilder(Uint32Array);
    outputBuilder.resize(1);
    outputBuilder.data[0] = 1;

    if (dataType === DataType.UINT32) {
      encodeChannelUint32(
        outputBuilder,
        subchunkSize!,
        uncompressedData as Uint32Array,
        chunkDataSize,
      );
    } else {
      encodeChannelUint64(
        outputBuilder,
        subchunkSize!,
        uncompressedData as BigUint64Array,
        chunkDataSize,
      );
    }

    chunk.data = outputBuilder.view;
  } else {
    const data = chunk.data as TypedArray;
    for (let i = 0; i < indices.length; ++i) {
      const idx = indices[i]!;
      if (idx < 0 || idx >= data.length) {
        throw new Error(
          `applyChunkEdits: index ${idx} out of bounds for chunk ${chunkKey}`,
        );
      }
      oldValuesArray[i] = data[idx];
      data[idx] = newValuesArray[i];
    }
  }

  await source.writeChunk(chunk);
  // The edit was written from an isolated chunk, so the shared cache
  // entry (if any) still holds pre-edit data — or has a pre-edit
  // download in flight that would otherwise later land as "fresh" and
  // even be reused by the next edit, durably erasing this write.
  // Invalidate it backend-side: routing through the frontend RPC would
  // miss chunks the frontend does not hold (e.g. still DOWNLOADING).
  const { queueManager } = source.chunkManager;
  queueManager.invalidateCachedChunks(source, [chunkKey]);
  queueManager.scheduleUpdate();
  return {
    indices: indicesCopy,
    oldValues: oldValuesArray,
    newValues: newValuesArray,
  };
}
