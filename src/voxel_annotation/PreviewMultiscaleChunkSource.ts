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

import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import type { SliceViewSingleResolutionSource } from "#src/sliceview/frontend.js";
import type {
  VolumeChunkSpecification,
  VolumeSourceOptions,
  DataType,
  VolumeType,
} from "#src/sliceview/volume/base.js";
import {
  InMemoryVolumeChunkSource,
  MultiscaleVolumeChunkSource,
  type VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";

export class VoxelPreviewMultiscaleSource extends MultiscaleVolumeChunkSource {
  dataType: DataType;
  volumeType: VolumeType;
  rank: number;

  constructor(
    chunkManager: ChunkManager,
    public primarySource: MultiscaleVolumeChunkSource,
  ) {
    super(chunkManager);
    this.dataType = primarySource.dataType;
    this.volumeType = primarySource.volumeType;
    this.rank = primarySource.rank;
  }

  getSources(
    options: VolumeSourceOptions,
  ): SliceViewSingleResolutionSource<VolumeChunkSource>[][] {
    const sourcesByScale = this.primarySource.getSources(options);

    return sourcesByScale.map((orientation) => {
      return orientation.map((primaryResSource) => {
        const spec = primaryResSource.chunkSource.spec;

        const previewSpec: VolumeChunkSpecification = {
          ...spec,
          compressedSegmentationBlockSize: undefined,
        };

        const previewSource = this.chunkManager.getChunkSource(
          InMemoryVolumeChunkSource,
          { spec: previewSpec },
        );

        return {
          chunkSource: previewSource,
          chunkToMultiscaleTransform:
            primaryResSource.chunkToMultiscaleTransform,
        };
      });
    });
  }
}
