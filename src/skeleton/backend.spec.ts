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

import { describe, expect, it } from "vitest";

import {
  getSpatiallyIndexedSkeletonChunkPriority,
  getSpatiallyIndexedSkeletonRenderPriority,
  SPATIALLY_INDEXED_SKELETON_PRIORITY_BOOST,
  SpatiallyIndexedSkeletonChunkRequestOwner,
} from "#src/skeleton/backend.js";
import {
  BASE_PRIORITY,
  SCALE_PRIORITY_MULTIPLIER,
} from "#src/sliceview/backend.js";

describe("skeleton/backend chunk priority", () => {
  it("uses the standard chunk-origin distance rule for spatial skeleton chunks", () => {
    expect(
      getSpatiallyIndexedSkeletonChunkPriority(
        Float32Array.of(3, 4, 0),
        Float32Array.of(2, 5, 1),
        Float32Array.of(1, 0, 0),
      ),
    ).toBeCloseTo(-Math.sqrt(17));
  });

  it("prioritizes chunks nearer the view center ahead of farther chunks", () => {
    const localCenter = Float32Array.of(10, 20, 30);
    const chunkSize = Float32Array.of(4, 4, 8);
    const nearChunk = Float32Array.of(2, 5, 4);
    const farChunk = Float32Array.of(5, 1, 0);

    expect(
      getSpatiallyIndexedSkeletonChunkPriority(
        localCenter,
        chunkSize,
        nearChunk,
      ),
    ).toBeGreaterThan(
      getSpatiallyIndexedSkeletonChunkPriority(
        localCenter,
        chunkSize,
        farChunk,
      ),
    );
  });

  it("uses a view-agnostic boost tied to the shared volumetric base priority", () => {
    expect(SPATIALLY_INDEXED_SKELETON_PRIORITY_BOOST).toBe(-BASE_PRIORITY);
  });

  it("boosts spatial skeleton chunks in all views above equivalent volume-rendering chunks", () => {
    const basePriority = BASE_PRIORITY;
    const scaleIndex = 2;
    const localCenter = Float32Array.of(10, 20, 30);
    const chunkSize = Float32Array.of(4, 4, 8);
    const positionInChunks = Float32Array.of(2, 5, 4);
    const distancePriority = getSpatiallyIndexedSkeletonChunkPriority(
      localCenter,
      chunkSize,
      positionInChunks,
    );
    const equivalentVolumeRenderingPriority =
      basePriority + SCALE_PRIORITY_MULTIPLIER * scaleIndex + distancePriority;

    for (const owner of [
      SpatiallyIndexedSkeletonChunkRequestOwner.VIEW_2D,
      SpatiallyIndexedSkeletonChunkRequestOwner.VIEW_3D,
    ]) {
      expect(owner).not.toBe(SpatiallyIndexedSkeletonChunkRequestOwner.NONE);
      const skeletonPriority = getSpatiallyIndexedSkeletonRenderPriority(
        basePriority,
        scaleIndex,
        localCenter,
        chunkSize,
        positionInChunks,
      );

      expect(skeletonPriority).toBeGreaterThan(
        equivalentVolumeRenderingPriority,
      );
      expect(skeletonPriority - equivalentVolumeRenderingPriority).toBeCloseTo(
        SPATIALLY_INDEXED_SKELETON_PRIORITY_BOOST,
      );
    }
  });

  it("keeps spatial skeleton chunks ordered by distance after applying the boost", () => {
    const basePriority = BASE_PRIORITY;
    const scaleIndex = 1;
    const localCenter = Float32Array.of(10, 20, 30);
    const chunkSize = Float32Array.of(4, 4, 8);
    const nearChunk = Float32Array.of(2, 5, 4);
    const farChunk = Float32Array.of(5, 1, 0);

    expect(
      getSpatiallyIndexedSkeletonRenderPriority(
        basePriority,
        scaleIndex,
        localCenter,
        chunkSize,
        nearChunk,
      ),
    ).toBeGreaterThan(
      getSpatiallyIndexedSkeletonRenderPriority(
        basePriority,
        scaleIndex,
        localCenter,
        chunkSize,
        farChunk,
      ),
    );
  });
});
