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

import type {
  SpatialSkeletonBounds,
  SpatialSkeletonVector,
} from "#src/skeleton/api.js";

const DEFAULT_SPATIALLY_INDEXED_SKELETON_MAX_CHUNKS = 64;
const DEFAULT_SPATIALLY_INDEXED_SKELETON_MIN_CHUNK_SIZE = 1;

export type SpatiallyIndexedSkeletonChunkSize = number[];

export interface DefaultSpatiallyIndexedSkeletonChunkSizeOptions {
  maxChunks?: number;
  minChunkSize?: number;
}

function validateFiniteOptions(
  options: DefaultSpatiallyIndexedSkeletonChunkSizeOptions,
) {
  if (
    options.minChunkSize !== undefined &&
    !Number.isFinite(options.minChunkSize)
  ) {
    throw new Error("Spatially indexed skeleton minChunkSize must be finite.");
  }
  if (options.maxChunks !== undefined && !Number.isFinite(options.maxChunks)) {
    throw new Error("Spatially indexed skeleton maxChunks must be finite.");
  }
}

function validateFiniteVector(vector: SpatialSkeletonVector, label: string) {
  for (let i = 0; i < vector.length; ++i) {
    const value = Number(vector[i]);
    if (!Number.isFinite(value)) {
      throw new Error(
        `Spatially indexed skeleton bounds must be finite, but ${label}[${i}] is ${value}.`,
      );
    }
  }
}

function validateFiniteBounds(bounds: SpatialSkeletonBounds) {
  if (bounds.lowerBounds.length !== bounds.upperBounds.length) {
    throw new Error(
      "Spatially indexed skeleton lower and upper bounds must have matching ranks.",
    );
  }
  if (bounds.lowerBounds.length === 0) {
    throw new Error("Spatially indexed skeleton bounds must have rank > 0.");
  }
  validateFiniteVector(bounds.lowerBounds, "lowerBounds");
  validateFiniteVector(bounds.upperBounds, "upperBounds");
}

function getChunkCoverageForChunkSize(
  extents: readonly number[],
  chunkSize: number,
) {
  return extents.reduce((product, extent) => {
    const axisChunks = extent <= 0 ? 1 : Math.ceil(extent / chunkSize);
    return product * axisChunks;
  }, 1);
}

export function getDefaultSpatiallyIndexedSkeletonChunkSize(
  bounds: SpatialSkeletonBounds,
  options: DefaultSpatiallyIndexedSkeletonChunkSizeOptions = {},
): SpatiallyIndexedSkeletonChunkSize {
  validateFiniteOptions(options);
  validateFiniteBounds(bounds);
  const minChunkSize = Math.max(
    DEFAULT_SPATIALLY_INDEXED_SKELETON_MIN_CHUNK_SIZE,
    Math.ceil(
      options.minChunkSize ?? DEFAULT_SPATIALLY_INDEXED_SKELETON_MIN_CHUNK_SIZE,
    ),
  );
  const maxChunks = Math.max(
    1,
    Math.floor(
      options.maxChunks ?? DEFAULT_SPATIALLY_INDEXED_SKELETON_MAX_CHUNKS,
    ),
  );
  const extents = Array.from(bounds.lowerBounds, (lowerBound, index) =>
    Math.max(0, Number(bounds.upperBounds[index]) - Number(lowerBound)),
  );
  const maxExtent = Math.max(...extents);

  if (!(maxExtent > 0)) {
    return extents.map(() => minChunkSize);
  }

  // Choose the smallest isotropic chunk size that keeps the full bounding box
  // coverage within the requested chunk budget.
  let low = minChunkSize;
  let high = Math.max(minChunkSize, Math.ceil(maxExtent));
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (getChunkCoverageForChunkSize(extents, mid) <= maxChunks) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }

  return extents.map(() => low);
}
