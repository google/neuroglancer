/**
 * @license
 * Copyright 2026 Google Inc.
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

import type { SliceViewSourceOptions } from "#src/sliceview/base.js";
import { DataType } from "#src/sliceview/base.js";
import type { MultiscaleVolumeChunkSource } from "#src/sliceview/volume/frontend.js";

function getIdentitySourceOptions(rank: number): SliceViewSourceOptions {
  const multiscaleToViewTransform = new Float32Array(rank * rank);
  for (let i = 0; i < rank; ++i) {
    multiscaleToViewTransform[rank * i + i] = 1;
  }
  return {
    displayRank: rank,
    multiscaleToViewTransform,
    modelChannelDimensionIndices: [],
  };
}

function getHierarchyIncompatibility(
  volume: MultiscaleVolumeChunkSource,
): string | undefined {
  const { rank } = volume;
  const scales = volume.getSources(getIdentitySourceOptions(rank))[0];

  if (!scales || scales.length < 2) return undefined;

  const getPhysicalChunkExtent = (lodIndex: number) => {
    const source = scales[lodIndex];
    const transform = source.chunkToMultiscaleTransform;
    const chunkVoxels = source.chunkSource.spec.chunkDataSize;

    const extent = new Float32Array(rank);

    for (let i = 0; i < rank; i++) {
      let sumSq = 0;
      for (let row = 0; row < rank; row++) {
        const val = transform[i * (rank + 1) + row];
        sumSq += val * val;
      }
      const scaleFactor = Math.sqrt(sumSq);
      extent[i] = chunkVoxels[i] * scaleFactor;
    }
    return extent;
  };

  for (let i = 0; i < scales.length - 1; i++) {
    const childExtents = getPhysicalChunkExtent(i);
    const parentExtents = getPhysicalChunkExtent(i + 1);

    for (let d = 0; d < rank; d++) {
      const ratio = parentExtents[d] / childExtents[d];
      const isInteger = Math.abs(ratio - Math.round(ratio)) < 0.001;

      if (!isInteger) {
        return (
          `Hierarchy mismatch between LOD ${i} and ${i + 1}. ` +
          `Parent chunk must contain a whole number of child chunks. ` +
          `Ratio dim ${d}: ${ratio.toFixed(3)}`
        );
      }
    }
  }
  return undefined;
}

// The following checks are in place due to limitations in the implementation,
// and could be removed if support for the checked constraint is added.
export function getVoxelAnnotationIncompatibility(
  volume: MultiscaleVolumeChunkSource,
): string | undefined {
  if (volume.rank !== 3) {
    return `Voxel annotation only supports rank 3 volumes (got ${volume.rank}).`;
  }
  if (volume.dataType === DataType.FLOAT32) {
    return "Voxel annotation does not support Float32 datasets.";
  }
  return getHierarchyIncompatibility(volume);
}
