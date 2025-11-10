/**
 * @license
 * Copyright 2024 Google Inc.
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

import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import type { SliceViewSingleResolutionSource } from "#src/sliceview/frontend.js";
import type { VolumeSourceOptions } from "#src/sliceview/volume/base.js";
import {
  makeVolumeChunkSpecification,
  VolumeType,
} from "#src/sliceview/volume/base.js";
import { MultiscaleVolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import { DataType } from "#src/util/data_type.js";
import { VoxChunkSource } from "#src/voxel_annotation/frontend.js";

/**
 * This is an abstract representation of 3D (volumetric) data that can exist at multiple resolutions or "scales."
 * Think of it as a way to access a very large 3D image or a 3D array of values (like segmentation IDs, or in your case, voxel annotation data).
 *
 * Its primary job is to provide chunks of this volumetric data to the renderer. When you zoom in, zoom out, or pan through the 3D space,
 * the `MultiscaleVolumeChunkSource` efficiently determines which resolution and which specific 3D "chunks" of data are needed for the current view and makes them available.
 *
 * Key Characteristics:
 * - Multiscale: It manages different levels of detail for the same underlying data, allowing for efficient rendering at various zoom levels.
 * - Chunking: Data is divided into smaller, manageable 3D blocks (chunks) to optimize loading and memory usage.
 * - Asynchronous: Data loading is typically asynchronous, as it might involve fetching from a remote server or reading from large local files.
 */
export interface VoxMultiscaleOptions {
  chunkDataSize?: Uint32Array | number[];
  upperVoxelBound?: Float32Array | number[];
  baseVoxelOffset?: Float32Array | number[];
}

export class VoxMultiscaleVolumeChunkSource extends MultiscaleVolumeChunkSource {
  dataType = DataType.UINT32;
  volumeType = VolumeType.SEGMENTATION;
  get rank() {
    return 3;
  }

  private cfgChunkDataSize: Uint32Array;
  private cfgUpperVoxelBound: Float32Array;
  private cfgBaseVoxelOffset: Float32Array;

  constructor(chunkManager: ChunkManager, options?: VoxMultiscaleOptions) {
    super(chunkManager);
    this.cfgChunkDataSize = new Uint32Array(
      options?.chunkDataSize ? Array.from(options.chunkDataSize) : [64, 64, 64],
    );
    this.cfgUpperVoxelBound = new Float32Array(
      options?.upperVoxelBound
        ? Array.from(options.upperVoxelBound)
        : [1_000, 1_000, 1_000],
    );
    this.cfgBaseVoxelOffset = new Float32Array(
      options?.baseVoxelOffset
        ? Array.from(options.baseVoxelOffset)
        : [0, 0, 0],
    );
  }

  getSources(_options: VolumeSourceOptions) {
    // Provide a base scale and a coarse "guard" scale to avoid memory blowups at extreme zoom out.
    const rank = this.rank;

    // Base (fine) scale specification.
    const baseSpec = makeVolumeChunkSpecification({
      rank,
      dataType: this.dataType,
      chunkDataSize: this.cfgChunkDataSize,
      upperVoxelBound: this.cfgUpperVoxelBound,
      baseVoxelOffset: this.cfgBaseVoxelOffset,
    });
    const baseSource: VoxChunkSource = this.chunkManager.getChunkSource(
      VoxChunkSource as any,
      { spec: baseSpec },
    );

    // Identity transform for base scale.
    const identity = new Float32Array((rank + 1) * (rank + 1));
    for (let i = 0; i < rank; ++i) {
      identity[i * (rank + 1) + i] = 1;
    }
    identity[rank * (rank + 1) + rank] = 1;

    const base: SliceViewSingleResolutionSource<VoxChunkSource> = {
      chunkSource: baseSource,
      chunkToMultiscaleTransform: identity,
      lowerClipBound: baseSpec.lowerVoxelBound,
      upperClipBound: baseSpec.upperVoxelBound,
    };

    // Coarse guard scale: no chunks will be created (zero-sized bounds) but it will be selected
    // at extremely low zoom levels due to a very large voxel scale transform.
    const guardSpec = makeVolumeChunkSpecification({
      rank,
      dataType: this.dataType,
      // Use same chunk size; since bounds are empty below, no chunks are actually requested.
      chunkDataSize: this.cfgChunkDataSize,
      // Zero-sized bounds => lowerChunkBound === upperChunkBound, therefore 0 chunks.
      upperVoxelBound: new Float32Array(rank),
      lowerVoxelBound: new Float32Array(rank),
    });

    const guardSource: VoxChunkSource = this.chunkManager.getChunkSource(
      VoxChunkSource as any,
      { spec: guardSpec },
    );

    // Large diagonal scale to make effective voxel size huge, ensuring guard scale is used when
    // zoomed out. Homogeneous (rank+1)x(rank+1) matrix.
    const scale = 10;
    const guardXform = new Float32Array((rank + 1) * (rank + 1));
    for (let i = 0; i < rank; ++i) {
      guardXform[i * (rank + 1) + i] = scale;
    }
    guardXform[rank * (rank + 1) + rank] = 1;

    const guard: SliceViewSingleResolutionSource<VoxChunkSource> = {
      chunkSource: guardSource,
      chunkToMultiscaleTransform: guardXform,
      lowerClipBound: guardSpec.lowerVoxelBound,
      upperClipBound: guardSpec.upperVoxelBound,
    };

    // Outer array: orientations. Inner array: scales ordered from finest -> coarsest.
    return [[base, guard]];
  }
}
