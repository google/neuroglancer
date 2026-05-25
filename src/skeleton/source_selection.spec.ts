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
  getSpatialSkeletonSourceScalesByLimit,
  selectSpatialSkeletonSourceByLimit,
  SPATIAL_SKELETON_ZERO_LIMIT_FINEST_ERROR,
} from "#src/skeleton/source_selection.js";

describe("skeleton/source_selection", () => {
  it("selects exactly one coarse source when it satisfies the density target", () => {
    const selection = selectSpatialSkeletonSourceByLimit(
      [
        {
          source: "coarse",
          index: 0,
          physicalVolume: 1000,
          limit: 200,
          sliceFraction: 1,
        },
        {
          source: "fine",
          index: 1,
          physicalVolume: 125,
          limit: 500,
          sliceFraction: 1,
        },
      ],
      0.1,
      1000,
      100,
    );

    expect(selection?.source).toBe("coarse");
    expect(selection?.physicalDensity).toBeCloseTo(0.2);
  });

  it("selects a finer positive-limit source when coarser sources are too sparse", () => {
    const selection = selectSpatialSkeletonSourceByLimit(
      [
        {
          source: "coarse",
          index: 0,
          physicalVolume: 1000,
          limit: 10,
          sliceFraction: 1,
        },
        {
          source: "fine",
          index: 1,
          physicalVolume: 125,
          limit: 500,
          sliceFraction: 1,
        },
      ],
      0.1,
      1000,
      100,
    );

    expect(selection?.source).toBe("fine");
    expect(selection?.physicalDensity).toBeCloseTo(4);
  });

  it("falls back to the finest positive-limit source when no source satisfies the target", () => {
    const selection = selectSpatialSkeletonSourceByLimit(
      [
        {
          source: "coarse",
          index: 0,
          physicalVolume: 1000,
          limit: 10,
          sliceFraction: 1,
        },
        {
          source: "fine",
          index: 1,
          physicalVolume: 125,
          limit: 10,
          sliceFraction: 1,
        },
      ],
      100,
      1000,
      100,
    );

    expect(selection?.source).toBe("fine");
    expect(selection?.physicalDensity).toBeCloseTo(0.08);
  });

  it("selects a finest zero-limit source when positive-limit sources are too sparse", () => {
    const selection = selectSpatialSkeletonSourceByLimit(
      [
        {
          source: "coarse",
          index: 0,
          physicalVolume: 1000,
          limit: 10,
          sliceFraction: 1,
        },
        {
          source: "complete-finest",
          index: 1,
          physicalVolume: 125,
          limit: 0,
          sliceFraction: 1,
        },
      ],
      100,
      1000,
      100,
    );

    expect(selection?.source).toBe("complete-finest");
    expect(selection?.physicalDensity).toBe(Number.POSITIVE_INFINITY);
    expect(selection?.physicalSpacing).toBe(Number.POSITIVE_INFINITY);
    expect(selection?.pixelSpacing).toBe(Number.POSITIVE_INFINITY);
  });

  it("does not select a finest zero-limit source if a coarser source satisfies the target", () => {
    const selection = selectSpatialSkeletonSourceByLimit(
      [
        {
          source: "coarse",
          index: 0,
          physicalVolume: 1000,
          limit: 200,
          sliceFraction: 1,
        },
        {
          source: "complete-finest",
          index: 1,
          physicalVolume: 125,
          limit: 0,
          sliceFraction: 1,
        },
      ],
      0.1,
      1000,
      100,
    );

    expect(selection?.source).toBe("coarse");
  });

  it("rejects a non-finest zero-limit source", () => {
    expect(() =>
      selectSpatialSkeletonSourceByLimit(
        [
          {
            source: "complete-coarse",
            index: 0,
            physicalVolume: 1000,
            limit: 0,
            sliceFraction: 1,
          },
          {
            source: "fine",
            index: 1,
            physicalVolume: 125,
            limit: 500,
            sliceFraction: 1,
          },
        ],
        0.1,
        1000,
        100,
      ),
    ).toThrow(SPATIAL_SKELETON_ZERO_LIMIT_FINEST_ERROR);
  });

  it("rejects multiple zero-limit sources unless there is only one source", () => {
    expect(() =>
      selectSpatialSkeletonSourceByLimit(
        [
          {
            source: "complete-coarse",
            index: 0,
            physicalVolume: 1000,
            limit: 0,
            sliceFraction: 1,
          },
          {
            source: "complete-fine",
            index: 1,
            physicalVolume: 125,
            limit: 0,
            sliceFraction: 1,
          },
        ],
        0.1,
        1000,
        100,
      ),
    ).toThrow(SPATIAL_SKELETON_ZERO_LIMIT_FINEST_ERROR);

    expect(
      selectSpatialSkeletonSourceByLimit(
        [
          {
            source: "single-complete",
            index: 0,
            physicalVolume: 1000,
            limit: 0,
            sliceFraction: 1,
          },
        ],
        0.1,
        1000,
        100,
      )?.source,
    ).toBe("single-complete");
  });

  it("uses the provided source order rather than sorting by physical volume", () => {
    const selection = selectSpatialSkeletonSourceByLimit(
      [
        {
          source: "fine",
          index: 1,
          physicalVolume: 125,
          limit: 500,
          sliceFraction: 1,
        },
        {
          source: "coarse",
          index: 0,
          physicalVolume: 1000,
          limit: 200,
          sliceFraction: 1,
        },
      ],
      0.1,
      1000,
      100,
    );

    expect(selection?.source).toBe("fine");
  });

  it("reports all source scales in source order for histogram indicators", () => {
    const scales = getSpatialSkeletonSourceScalesByLimit(
      [
        {
          source: "fine",
          index: 1,
          physicalVolume: 125,
          limit: 500,
          sliceFraction: 1,
        },
        {
          source: "coarse",
          index: 0,
          physicalVolume: 1000,
          limit: 200,
          sliceFraction: 1,
        },
      ],
      1000,
      100,
    );

    expect(scales.map((scale) => scale.source)).toEqual(["fine", "coarse"]);
    expect(scales[0].physicalDensity).toBeCloseTo(4);
    expect(scales[1].physicalDensity).toBeCloseTo(0.2);
  });
});
