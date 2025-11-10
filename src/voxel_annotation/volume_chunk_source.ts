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
import type { VoxMapConfig } from "#src/voxel_annotation/map.js";

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
  map?: VoxMapConfig;
}

export class VoxMultiscaleVolumeChunkSource extends MultiscaleVolumeChunkSource {
  dataType = DataType.UINT32;
  volumeType = VolumeType.SEGMENTATION;
  get rank() {
    return 3;
  }

  private mapCfg?: VoxMapConfig;

  constructor(chunkManager: ChunkManager, options?: VoxMultiscaleOptions) {
    super(chunkManager);
    this.mapCfg = options?.map;
    if (this.mapCfg?.dataType != null) {
      this.dataType = this.mapCfg.dataType as any;
    }
  }

  getSources(_options: VolumeSourceOptions) {
    // Steps are computed during map creation and saved. Here we just consume the bound map.
    const map = this.mapCfg;
    if (!map) return [];
    const rank = this.rank;

    const chunkDataSize = new Uint32Array(Array.from(map.chunkDataSize));
    const upperVoxelBound = new Float32Array(Array.from(map.upperVoxelBound));
    const baseVoxelOffset = new Float32Array(Array.from(map.baseVoxelOffset));

    const baseSpec = makeVolumeChunkSpecification({
      rank,
      dataType: this.dataType,
      chunkDataSize,
      upperVoxelBound,
      baseVoxelOffset,
    });
    // Helper to make a homogeneous scaling transform matrix with scale factor f.
    const makeScale = (f: number) => {
      const m = new Float32Array((rank + 1) * (rank + 1));
      for (let i = 0; i < rank; ++i) m[i * (rank + 1) + i] = f;
      m[rank * (rank + 1) + rank] = 1;
      return m;
    };

    const factors = map.steps && map.steps.length > 0 ? [...map.steps] : [1];

    const levels: SliceViewSingleResolutionSource<VoxChunkSource>[] = factors.map(
      (f) => {
        const src: VoxChunkSource = this.chunkManager.getChunkSource(
          VoxChunkSource,
          {
            spec: baseSpec,
            vox: {
              serverUrl: map.serverUrl,
              token: map.token,
            },
            lodFactor: f,
          },
        );
        return {
          chunkSource: src,
          chunkToMultiscaleTransform: makeScale(f),
          lowerClipBound: baseSpec.lowerVoxelBound,
          upperClipBound: baseSpec.upperVoxelBound,
        };
      },
    );

    return [levels];
  }
}
