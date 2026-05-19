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

import { selectSpatialSkeletonSourcesByLimit } from "#src/skeleton/source_selection.js";

describe("skeleton/source_selection", () => {
  it("selects only enough 3D sources to meet the spacing-derived density target", () => {
    expect(
      selectSpatialSkeletonSourcesByLimit(
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
      ).map((selection) => selection.source),
    ).toEqual(["coarse"]);
  });

  it("adds finer 2D sources when slice density is below the target", () => {
    expect(
      selectSpatialSkeletonSourcesByLimit(
        [
          {
            source: "coarse",
            index: 0,
            physicalVolume: 1000,
            limit: 200,
            sliceFraction: 0.1,
          },
          {
            source: "fine",
            index: 1,
            physicalVolume: 125,
            limit: 500,
            sliceFraction: 0.1,
          },
        ],
        0.1,
        1000,
        100,
      ).map((selection) => selection.source),
    ).toEqual(["coarse", "fine"]);
  });

  it("keeps zero-limit sources selectable without density contribution", () => {
    const selections = selectSpatialSkeletonSourcesByLimit(
      [
        {
          source: "unknown-density-coarse",
          index: 0,
          physicalVolume: 1000,
          limit: 0,
          sliceFraction: 1,
        },
        {
          source: "unknown-density-fine",
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

    expect(selections.map((selection) => selection.source)).toEqual([
      "unknown-density-coarse",
      "unknown-density-fine",
    ]);
    for (const selection of selections) {
      expect(selection.physicalDensity).toBe(0);
      expect(selection.physicalSpacing).toBe(Number.POSITIVE_INFINITY);
      expect(selection.pixelSpacing).toBe(Number.POSITIVE_INFINITY);
    }
  });

  it("includes zero-limit sources reached before the density target is met", () => {
    expect(
      selectSpatialSkeletonSourcesByLimit(
        [
          {
            source: "unknown-density",
            index: 0,
            physicalVolume: 1000,
            limit: 0,
            sliceFraction: 1,
          },
          {
            source: "estimated-density",
            index: 1,
            physicalVolume: 125,
            limit: 500,
            sliceFraction: 1,
          },
        ],
        0.1,
        1000,
        100,
      ).map((selection) => selection.source),
    ).toEqual(["unknown-density", "estimated-density"]);
  });

  it("stops before later zero-limit sources once positive density reaches the target", () => {
    expect(
      selectSpatialSkeletonSourcesByLimit(
        [
          {
            source: "coarse",
            index: 0,
            physicalVolume: 1000,
            limit: 200,
            sliceFraction: 1,
          },
          {
            source: "unknown-density-fine",
            index: 1,
            physicalVolume: 125,
            limit: 0,
            sliceFraction: 1,
          },
        ],
        0.1,
        1000,
        100,
      ).map((selection) => selection.source),
    ).toEqual(["coarse"]);
  });

  it("selects sources from coarsest to finest physical volume", () => {
    expect(
      selectSpatialSkeletonSourcesByLimit(
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
            limit: 10,
            sliceFraction: 1,
          },
        ],
        1,
        1000,
        100,
      ).map((selection) => selection.source),
    ).toEqual(["coarse", "fine"]);
  });
});
