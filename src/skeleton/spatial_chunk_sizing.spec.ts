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
  buildSpatialSkeletonGridLevels,
  getDefaultSpatiallyIndexedSkeletonChunkSize,
} from "#src/skeleton/spatial_chunk_sizing.js";

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

  it("sorts spatial skeleton grid levels by spacing and preserves limits", () => {
    expect(
      buildSpatialSkeletonGridLevels([
        { x: 10, y: 10, z: 10, limit: 1000 },
        { x: 40, y: 40, z: 40, limit: 10 },
        { x: 20, y: 20, z: 20, limit: 100 },
      ]),
    ).toEqual([
      { size: { x: 40, y: 40, z: 40, limit: 10 }, limit: 10 },
      { size: { x: 20, y: 20, z: 20, limit: 100 }, limit: 100 },
      { size: { x: 10, y: 10, z: 10, limit: 1000 }, limit: 1000 },
    ]);
  });
});
