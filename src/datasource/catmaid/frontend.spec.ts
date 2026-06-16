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

import { getCatmaidLodForSpatialIndexLevel } from "#src/datasource/catmaid/base.js";

describe("CATMAID frontend spatial index LOD mapping", () => {
  it("maps a single spatial index level to full CATMAID LOD", () => {
    expect(getCatmaidLodForSpatialIndexLevel(0, 1)).toBe(1);
  });

  it("maps multiple spatial index levels from coarse to fine", () => {
    expect(getCatmaidLodForSpatialIndexLevel(0, 3)).toBe(0);
    expect(getCatmaidLodForSpatialIndexLevel(1, 3)).toBe(0.5);
    expect(getCatmaidLodForSpatialIndexLevel(2, 3)).toBe(1);
  });
});
