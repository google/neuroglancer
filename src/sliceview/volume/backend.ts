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

import type { Chunk } from "#src/chunk_manager/backend.js";
import { ChunkState } from "#src/chunk_manager/base.js";
import { SliceViewChunk, SliceViewChunkSourceBackend } from "#src/sliceview/backend.js";
import type { SliceViewChunkSpecification } from "#src/sliceview/base.js";
import { DataType } from "#src/sliceview/base.js";
import type {
  VolumeChunkSource as VolumeChunkSourceInterface,
  VolumeChunkSpecification
} from "#src/sliceview/volume/base.js";
import type { TypedArray } from "#src/util/array.js";
import { DATA_TYPE_ARRAY_CONSTRUCTOR } from "#src/util/data_type.js";
import type { vec3 } from "#src/util/geom.js";
import { HttpError } from "#src/util/http_request.js";
import * as vector from "#src/util/vector.js";
import type { VoxelChange } from "#src/voxel_annotation/base.js";
import type { RPC } from "#src/worker_rpc.js";

export class VolumeChunk extends SliceViewChunk {
  source: VolumeChunkSource | null = null;
  data: ArrayBufferView | null;
  chunkDataSize: Uint32Array | null;

  initializeVolumeChunk(key: string, chunkGridPosition: vec3) {
    super.initializeVolumeChunk(key, chunkGridPosition);
    this.chunkDataSize = null;
    this.data = null;
  }

  serialize(msg: any, transfers: any[]) {
    super.serialize(msg, transfers);
    const chunkDataSize = this.chunkDataSize;
    if (chunkDataSize !== this.source!.spec.chunkDataSize) {
      msg.chunkDataSize = chunkDataSize;
    }
    const data = (msg.data = this.data);
    if (data !== null) {
      transfers.push(data!.buffer);
    }
    this.data = null;
  }

  downloadSucceeded() {
    this.systemMemoryBytes = this.gpuMemoryBytes = this.data?.byteLength ?? 0;
    super.downloadSucceeded();
  }

  freeSystemMemory() {
    this.data = null;
  }
}

interface ChunkWithGridPositionAndDataSize extends Chunk {
  chunkGridPosition: Float32Array;
  chunkDataSize: Uint32Array | null;
}

interface SliceViewChunkSpecWithOffsetAndDatatype
  extends SliceViewChunkSpecification<Uint32Array> {
  baseVoxelOffset: Float32Array;
  dataType: DataType;
}

interface ChunkSourceForChunkBounds {
  spec: SliceViewChunkSpecWithOffsetAndDatatype;
  tempChunkDataSize: Uint32Array;
  tempChunkPosition: Float32Array;
}

/**
 * Helper function for computing the voxel bounds of a chunk based on its chunkGridPosition.
 *
 * This assumes that the grid of chunk positions starts at this.baseVoxelOffset.  Chunks are
 * clipped to lie within upperVoxelBound, but are not clipped to lie within lowerVoxelBound.  (The
 * frontend code currently cannot handle chunks clipped at their lower corner, and the chunk
 * layout can generally be chosen so that lowerVoxelBound lies on a chunk boundary.)
 *
 * This sets chunk.chunkDataSize to a copy of the returned chunkDataSize if it differs from
 * source.spec.chunkDataSize; otherwise, it is set to source.spec.chunkDataSize.
 *
 * @returns A globally-allocated Vec3 containing the chunk corner position in voxel coordinates.
 * The returned Vec3 will be invalidated by any subsequent call to this method, even on a
 * different VolumeChunkSource instance.
 */
export function computeChunkBounds(
  source: ChunkSourceForChunkBounds,
  chunk: ChunkWithGridPositionAndDataSize,
) {
  const { spec, tempChunkDataSize, tempChunkPosition } = source;
  const { upperVoxelBound, rank, baseVoxelOffset } = spec;

  const origChunkDataSize = spec.chunkDataSize;
  const newChunkDataSize = tempChunkDataSize;

  // Chunk start position in voxel coordinates.
  const chunkPosition = vector.multiply(
    tempChunkPosition,
    chunk.chunkGridPosition,
    origChunkDataSize,
  );

  // Specifies whether the chunk only partially fits within the data bounds.
  let partial = false;
  for (let i = 0; i < rank; ++i) {
    const upper = Math.min(
      upperVoxelBound[i],
      chunkPosition[i] + origChunkDataSize[i],
    );
    const size = (newChunkDataSize[i] = upper - chunkPosition[i]);
    if (size !== origChunkDataSize[i]) {
      partial = true;
    }
  }

  vector.add(chunkPosition, chunkPosition, baseVoxelOffset);

  if (partial) {
    chunk.chunkDataSize = Uint32Array.from(newChunkDataSize);
  } else {
    chunk.chunkDataSize = origChunkDataSize;
  }

  return chunkPosition;
}

export class VolumeChunkSource
  extends SliceViewChunkSourceBackend
  implements VolumeChunkSourceInterface
{
  declare spec: VolumeChunkSpecification;
  tempChunkDataSize: Uint32Array;
  tempChunkPosition: Float32Array;
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    const rank = this.spec.rank;
    this.tempChunkDataSize = new Uint32Array(rank);
    this.tempChunkPosition = new Float32Array(rank);
  }

  computeChunkBounds(chunk: VolumeChunk) {
    return computeChunkBounds(this, chunk);
  }

  // Override in data source backends to actually persist the chunk.
  // Default throws to ensure write capability is explicitly implemented.
  async writeChunk(_chunk: VolumeChunk): Promise<void> {
    throw new Error("VolumeChunkSource.writeChunk not implemented for this datasource");
  }

  async applyEdits(chunkKey: string, indices: ArrayLike<number>, values: ArrayLike<number | bigint>): Promise<VoxelChange> {
    if (indices.length !== values.length) {
      throw new Error("applyEdits: indices and values length mismatch");
    }
    const chunkGridPosition = new Float32Array(chunkKey.split(',').map(Number));
    if (chunkGridPosition.length !== this.spec.rank || chunkGridPosition.some((v) => !Number.isFinite(v))) {
      throw new Error(`applyEdits: invalid chunk key ${chunkKey}`);
    }
    const chunk = this.getChunk(chunkGridPosition) as VolumeChunk;

    if (chunk.state > ChunkState.SYSTEM_MEMORY_WORKER) {
      const ac = new AbortController();
      await this.download(chunk, ac.signal);
    }

    if (!chunk.data) {
      try {
        const ac = new AbortController();
        await this.download(chunk, ac.signal);
      } catch {
        //
      }
    }

    if (!chunk.data) {
      // If chunk.data is null, the chunk does not exist at the source or was evicted.
      // Create a new, zero-filled chunk to apply the edits to.
      if (!chunk.chunkDataSize) {
        this.computeChunkBounds(chunk);
      }
      if (!chunk.chunkDataSize) {
        throw new Error(`applyEdits: Cannot create new chunk ${chunkKey} because its size is unknown.`);
      }
      const numElements = chunk.chunkDataSize.reduce((a, b) => a * b, 1);
      const Ctor = DATA_TYPE_ARRAY_CONSTRUCTOR[this.spec.dataType];
      chunk.data = new (Ctor as any)(numElements);
      // The new TypedArray is already zero-filled.
    }
    const data = chunk.data as TypedArray;

    const ArrayCtor = DATA_TYPE_ARRAY_CONSTRUCTOR[this.spec.dataType] as any;
    const indicesCopy = new Uint32Array(indices);
    const newValuesArray = new ArrayCtor(values.length);
    for (let i = 0; i < values.length; ++i) {
      newValuesArray[i] = this.spec.dataType === DataType.UINT32 ? Number(values[i]!) : values[i]!;
    }
    const oldValuesArray = new ArrayCtor(indices.length);

    for (let i = 0; i < indices.length; ++i) {
      const idx = indices[i]!;
      if (idx < 0 || idx >= data.length) {
        throw new Error(`applyEdits: index ${idx} out of bounds for chunk ${chunkKey}`);
      }
      oldValuesArray[i] = data[idx];
      data[idx] = newValuesArray[i];
    }
    const maxRetries = 3;
    let lastError: Error | undefined;

    for (let i = 0; i < maxRetries; i++) {
      try {
        await this.writeChunk(chunk);
        return {
          indices: indicesCopy,
          oldValues: oldValuesArray,
          newValues: newValuesArray,
        };
      } catch (e) {
        lastError = e as Error;
        if (e instanceof HttpError && e.status < 500 && e.status !== 429) {
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 250 * Math.pow(2, i)));
      }
    }
    throw new Error(`Failed to write chunk ${chunkKey} after ${maxRetries} attempts.`, { cause: lastError });
  }
}
VolumeChunkSource.prototype.chunkConstructor = VolumeChunk;
