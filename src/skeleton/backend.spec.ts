import { describe, expect, it } from "vitest";

import { getSpatiallyIndexedSkeletonChunkPriority } from "#src/skeleton/backend.js";

describe("skeleton/backend chunk priority", () => {
  it("uses the standard chunk-origin distance rule for 3d chunks", () => {
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
});
