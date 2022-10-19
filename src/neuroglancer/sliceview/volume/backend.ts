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

import {SliceViewChunk, SliceViewChunkSourceBackend} from 'neuroglancer/sliceview/backend';
import {VolumeChunkSource as VolumeChunkSourceInterface, VolumeChunkSpecification} from 'neuroglancer/sliceview/volume/base';
import {vec3} from 'neuroglancer/util/geom';
import * as vector from 'neuroglancer/util/vector';
import {RPC} from 'neuroglancer/worker_rpc';
import { Chunk } from 'neuroglancer/chunk_manager/backend';
import { DataType, SliceViewChunkSpecification } from 'neuroglancer/sliceview/base';

export class VolumeChunk extends SliceViewChunk {
  source: VolumeChunkSource|null = null;
  data: ArrayBufferView|null;
  chunkDataSize: Uint32Array|null;
  constructor() {
    super();
  }

  initializeVolumeChunk(key: string, chunkGridPosition: vec3) {
    super.initializeVolumeChunk(key, chunkGridPosition);
    this.chunkDataSize = null;
    this.data = null;
  }

  serialize(msg: any, transfers: any[]) {
    super.serialize(msg, transfers);
    let chunkDataSize = this.chunkDataSize;
    if (chunkDataSize !== this.source!.spec.chunkDataSize) {
      msg['chunkDataSize'] = chunkDataSize;
    }
    let data = msg['data'] = this.data;
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
  chunkDataSize: Uint32Array|null;
}

interface SliceViewChunkSpecWithOffsetAndDatatype extends SliceViewChunkSpecification<Uint32Array> {
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
    chunk: ChunkWithGridPositionAndDataSize) {
  const {spec, tempChunkDataSize, tempChunkPosition} = source;
  const {upperVoxelBound, rank, baseVoxelOffset} = spec;

  let origChunkDataSize = spec.chunkDataSize;
  let newChunkDataSize = tempChunkDataSize;


  // Chunk start position in voxel coordinates.
  const chunkPosition =
      vector.multiply(tempChunkPosition, chunk.chunkGridPosition, origChunkDataSize);

  // Specifies whether the chunk only partially fits within the data bounds.
  let partial = false;
  for (let i = 0; i < rank; ++i) {
    let upper = Math.min(upperVoxelBound[i], chunkPosition[i] + origChunkDataSize[i]);
    let size = newChunkDataSize[i] = upper - chunkPosition[i];
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

export class VolumeChunkSource extends SliceViewChunkSourceBackend implements
    VolumeChunkSourceInterface {
  spec: VolumeChunkSpecification;
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
}
VolumeChunkSource.prototype.chunkConstructor = VolumeChunk;
