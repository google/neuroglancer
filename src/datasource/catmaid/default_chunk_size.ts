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

import type { BoundingBox } from "#src/coordinate_transform.js";

const MAX_CHUNKS = 64;
const MIN_CHUNK_SIZE = 1;

function getChunkCoverageForChunkSize(
  extents: readonly number[],
  chunkSize: number,
) {
  return extents.reduce((product, extent) => {
    const axisChunks = extent <= 0 ? 1 : Math.ceil(extent / chunkSize);
    return product * axisChunks;
  }, 1);
}

// The smallest isotropic chunk size that covers the bounds with at most MAX_CHUNKS chunks.
export function getDefaultCatmaidChunkSize(bounds: BoundingBox): number[] {
  const extents = Array.from(bounds.lowerBounds, (lowerBound, index) =>
    Math.max(0, bounds.upperBounds[index] - lowerBound),
  );
  const maxExtent = Math.max(...extents);
  if (!(maxExtent > 0)) {
    return extents.map(() => MIN_CHUNK_SIZE);
  }
  let low = MIN_CHUNK_SIZE;
  let high = Math.max(MIN_CHUNK_SIZE, Math.ceil(maxExtent));
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (getChunkCoverageForChunkSize(extents, mid) <= MAX_CHUNKS) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  return extents.map(() => low);
}
