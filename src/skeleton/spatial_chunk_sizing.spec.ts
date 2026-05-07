import { describe, expect, it } from "vitest";

import { getDefaultSpatiallyIndexedSkeletonChunkSize } from "#src/skeleton/spatial_chunk_sizing.js";

describe("skeleton/spatial_chunk_sizing", () => {
  it("derives an isotropic chunk size that stays within the default chunk budget", () => {
    expect(
      getDefaultSpatiallyIndexedSkeletonChunkSize({
        lowerBounds: [5, 6, 7],
        upperBounds: [25, 66, 127],
      }),
    ).toEqual([15, 15, 15]);
  });

  it("handles elongated bounds while keeping the chunk size isotropic", () => {
    expect(
      getDefaultSpatiallyIndexedSkeletonChunkSize({
        lowerBounds: [0, 0, 0],
        upperBounds: [1000, 10, 10],
      }),
    ).toEqual([16, 16, 16]);
  });

  it("returns the minimum chunk size for tiny bounds", () => {
    expect(
      getDefaultSpatiallyIndexedSkeletonChunkSize({
        lowerBounds: [0, 0, 0],
        upperBounds: [2, 2, 2],
      }),
    ).toEqual([1, 1, 1]);
  });

  it("returns a chunk-size array with the same rank as the bounds", () => {
    expect(
      getDefaultSpatiallyIndexedSkeletonChunkSize({
        lowerBounds: [0, 0, 0, 0],
        upperBounds: [16, 32, 48, 2],
      }),
    ).toEqual([8, 8, 8, 8]);
  });

  it("supports overriding the chunk budget", () => {
    expect(
      getDefaultSpatiallyIndexedSkeletonChunkSize(
        {
          lowerBounds: [0, 0, 0],
          upperBounds: [100, 100, 100],
        },
        { maxChunks: 8 },
      ),
    ).toEqual([50, 50, 50]);
  });

  it("rejects NaN bounds", () => {
    expect(() =>
      getDefaultSpatiallyIndexedSkeletonChunkSize({
        lowerBounds: [Number.NaN, 0, 0],
        upperBounds: [10, 10, 10],
      }),
    ).toThrow(/bounds must be finite/i);
  });

  it("rejects infinite bounds", () => {
    expect(() =>
      getDefaultSpatiallyIndexedSkeletonChunkSize({
        lowerBounds: [0, 0, 0],
        upperBounds: [Number.POSITIVE_INFINITY, 10, 10],
      }),
    ).toThrow(/bounds must be finite/i);
  });

  it("rejects mismatched lower/upper bound ranks", () => {
    expect(() =>
      getDefaultSpatiallyIndexedSkeletonChunkSize({
        lowerBounds: [0, 0],
        upperBounds: [10, 10, 10],
      }),
    ).toThrow(/matching ranks/i);
  });

  it("rejects NaN minChunkSize", () => {
    expect(() =>
      getDefaultSpatiallyIndexedSkeletonChunkSize(
        {
          lowerBounds: [0, 0, 0],
          upperBounds: [10, 10, 10],
        },
        { minChunkSize: Number.NaN },
      ),
    ).toThrow(/minChunkSize must be finite/i);
  });

  it("rejects infinite maxChunks", () => {
    expect(() =>
      getDefaultSpatiallyIndexedSkeletonChunkSize(
        {
          lowerBounds: [0, 0, 0],
          upperBounds: [10, 10, 10],
        },
        { maxChunks: Number.POSITIVE_INFINITY },
      ),
    ).toThrow(/maxChunks must be finite/i);
  });
});
