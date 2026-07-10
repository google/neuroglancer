/**
 * @license
 * Copyright 2024 Google Inc.
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

import { describe, it, expect } from "vitest";
import { computeAxisPhysicalExtents } from "#src/util/axis_extents.js";

const p = (...values: number[]) => Float32Array.from(values);

describe("computeAxisPhysicalExtents", () => {
  // C4: returns one entry per dimension
  it("returns one entry per dimension", () => {
    expect(
      computeAxisPhysicalExtents(p(0, 0, 0), p(1, 2, 3), [1, 1, 1]),
    ).toHaveLength(3);
  });

  // C1: equal points -> all zero
  it("returns all zeros for equal points", () => {
    expect(
      computeAxisPhysicalExtents(p(4, 5, 6), p(4, 5, 6), [10, 10, 10]),
    ).toEqual([0, 0, 0]);
  });

  it("uses the absolute per-axis difference", () => {
    // deltas (3, -4) at unit scale.
    const extents = computeAxisPhysicalExtents(p(1, 5), p(4, 1), [1, 1]);
    expect(extents[0]).toBeCloseTo(3, 6);
    expect(extents[1]).toBeCloseTo(4, 6);
  });

  // C2: anisotropic per-axis scale
  it("applies the per-axis physical scale", () => {
    // 2 units x at 4 nm/unit -> 8 nm; 3 units y at 40 nm/unit -> 120 nm.
    const extents = computeAxisPhysicalExtents(p(0, 0), p(2, 3), [4, 40]);
    expect(extents[0]).toBeCloseTo(8, 6);
    expect(extents[1]).toBeCloseTo(120, 6);
  });

  // L1: a zero-scale (non-length) axis contributes a 0 extent
  it("yields 0 for a zero-scale (non-length) axis", () => {
    const extents = computeAxisPhysicalExtents(
      p(0, 0, 0),
      p(2, 5, 9),
      [4, 0, 4],
    );
    expect(extents[1]).toBe(0);
  });

  // C3: finite, non-negative
  it("returns finite, non-negative extents", () => {
    const extents = computeAxisPhysicalExtents(p(-3, 2), p(5, -1), [7, 9]);
    for (const e of extents) {
      expect(Number.isFinite(e)).toBe(true);
      expect(e).toBeGreaterThanOrEqual(0);
    }
  });
});
