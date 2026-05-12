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

import { selectSpatiallyIndexedSkeletonEntriesByGrid } from "#src/skeleton/source_selection.js";

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
});
