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
import { computeRulerLengthNm } from "#src/util/ruler_length.js";

const p = (...values: number[]) => Float32Array.from(values);

describe("computeRulerLengthNm", () => {
  // C1: fewer than two points -> 0
  it("returns 0 for an empty path", () => {
    expect(computeRulerLengthNm([], [1, 1, 1])).toBe(0);
  });

  it("returns 0 for a single point", () => {
    expect(computeRulerLengthNm([p(3, 4, 5)], [1, 1, 1])).toBe(0);
  });

  // C2: two points -> single segment distance
  it("computes the distance between two points (unit scale)", () => {
    expect(
      computeRulerLengthNm([p(0, 0, 0), p(3, 4, 0)], [1, 1, 1]),
    ).toBeCloseTo(5, 6);
  });

  // C2: N points -> sum of N-1 segments
  it("sums all consecutive segment lengths", () => {
    const points = [p(0, 0, 0), p(3, 4, 0), p(3, 4, 12)];
    // 5 (first segment) + 12 (second segment)
    expect(computeRulerLengthNm(points, [1, 1, 1])).toBeCloseTo(17, 6);
  });

  // C3: a duplicate consecutive point contributes 0
  it("treats a zero-length segment as contributing nothing", () => {
    const points = [p(1, 1, 1), p(1, 1, 1), p(1, 1, 4)];
    expect(computeRulerLengthNm(points, [1, 1, 1])).toBeCloseTo(3, 6);
  });

  // C4: anisotropic per-axis scale
  it("applies the per-axis physical scale", () => {
    // 2 units along x at 10 nm/unit -> 20 nm; 2 units along y at 5 nm/unit -> 10 nm.
    const points = [p(0, 0), p(2, 0)];
    expect(computeRulerLengthNm(points, [10, 5])).toBeCloseTo(20, 6);
    const pointsY = [p(0, 0), p(0, 2)];
    expect(computeRulerLengthNm(pointsY, [10, 5])).toBeCloseTo(10, 6);
  });

  // C5: never throws, returns finite non-negative
  it("returns a finite non-negative number", () => {
    const result = computeRulerLengthNm([p(-1, -2), p(3, 5)], [7, 9]);
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThanOrEqual(0);
  });
});
