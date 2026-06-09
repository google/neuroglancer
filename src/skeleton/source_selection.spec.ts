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
  selectSpatiallyIndexedSkeletonEntriesByGrid,
  selectSpatiallyIndexedSkeletonEntriesByGridWithFallback,
  selectSpatiallyIndexedSkeletonEntriesForViewWithFallback,
} from "#src/skeleton/source_selection.js";

describe("skeleton/source_selection", () => {
  it("returns the exact grid match when available", () => {
    const entries = [
      { id: "coarse", gridIndex: 0 },
      { id: "medium", gridIndex: 2 },
      { id: "fine", gridIndex: 4 },
    ];
    expect(
      selectSpatiallyIndexedSkeletonEntriesByGrid(
        entries,
        2,
        (entry) => entry.gridIndex,
      ),
    ).toEqual([entries[1]]);
  });

  it("returns the nearest grid match and keeps the first entry on ties", () => {
    const entries = [
      { id: "left", gridIndex: 0 },
      { id: "right", gridIndex: 4 },
    ];
    expect(
      selectSpatiallyIndexedSkeletonEntriesByGrid(
        entries,
        2,
        (entry) => entry.gridIndex,
      ),
    ).toEqual([entries[0]]);
  });

  it("returns all entries if any entry is missing a grid index", () => {
    const entries = [
      { id: "indexed", gridIndex: 0 },
      { id: "unindexed" },
      { id: "indexed-2", gridIndex: 2 },
    ];
    expect(
      selectSpatiallyIndexedSkeletonEntriesByGrid(
        entries,
        1,
        (entry) => entry.gridIndex,
      ),
    ).toEqual(entries);
  });

  it("returns preferred level followed by finer then coarser fallback levels", () => {
    const entries = [
      { id: "finest", gridIndex: 0 },
      { id: "finer", gridIndex: 1 },
      { id: "preferred", gridIndex: 2 },
      { id: "coarser", gridIndex: 3 },
    ];
    expect(
      selectSpatiallyIndexedSkeletonEntriesByGridWithFallback(
        entries,
        2,
        (entry) => entry.gridIndex,
      ).map((entry) => entry.id),
    ).toEqual(["preferred", "finer", "finest", "coarser"]);
  });

  it("falls back to the nearest finer level first when target is coarser", () => {
    const entries = [
      { id: "finest", gridIndex: 0 },
      { id: "fine", gridIndex: 1 },
      { id: "medium", gridIndex: 2 },
      { id: "coarse", gridIndex: 3 },
    ];
    expect(
      selectSpatiallyIndexedSkeletonEntriesByGridWithFallback(
        entries,
        3,
        (entry) => entry.gridIndex,
      ).map((entry) => entry.id),
    ).toEqual(["coarse", "medium", "fine", "finest"]);
  });

  it("returns all entries unchanged when any entry lacks grid index", () => {
    const entries = [
      { id: "a", gridIndex: 0 },
      { id: "b" },
      { id: "c", gridIndex: 2 },
    ];
    expect(
      selectSpatiallyIndexedSkeletonEntriesByGridWithFallback(
        entries,
        1,
        (entry) => entry.gridIndex,
      ),
    ).toEqual(entries);
  });

  it("applies view filtering before fallback ordering", () => {
    const entries = [
      { id: "a2d", gridIndex: 0, view: "2d" },
      { id: "b3d", gridIndex: 2, view: "3d" },
      { id: "c3d", gridIndex: 1, view: "3d" },
    ];
    expect(
      selectSpatiallyIndexedSkeletonEntriesForViewWithFallback(
        entries,
        "3d",
        2,
        (entry) => entry.view,
        (entry) => entry.gridIndex,
      ).map((entry) => entry.id),
    ).toEqual(["b3d", "c3d"]);
  });
});
