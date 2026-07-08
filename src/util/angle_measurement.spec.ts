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
import { computeVertexAnglesDegrees } from "#src/util/angle_measurement.js";

const p = (...values: number[]) => Float32Array.from(values);

describe("computeVertexAnglesDegrees", () => {
  // C1: fewer than three points -> no angles
  it("returns an empty array for fewer than three points", () => {
    expect(computeVertexAnglesDegrees([], [1, 1])).toEqual([]);
    expect(computeVertexAnglesDegrees([p(0, 0)], [1, 1])).toEqual([]);
    expect(computeVertexAnglesDegrees([p(0, 0), p(1, 1)], [1, 1])).toEqual([]);
  });

  // C3: right angle at the middle vertex
  it("computes a right angle", () => {
    const angles = computeVertexAnglesDegrees(
      [p(1, 0), p(0, 0), p(0, 1)],
      [1, 1],
    );
    expect(angles).toHaveLength(1);
    expect(angles[0]).toBeCloseTo(90, 5);
  });

  // C4: collinear points -> straight angle
  it("computes a straight (180) angle for collinear points", () => {
    const angles = computeVertexAnglesDegrees(
      [p(0, 0), p(1, 0), p(2, 0)],
      [1, 1],
    );
    expect(angles[0]).toBeCloseTo(180, 5);
  });

  it("computes an acute angle", () => {
    // Vectors (1,0) and (1,1) from the vertex -> 45 degrees.
    const angles = computeVertexAnglesDegrees(
      [p(1, 0), p(0, 0), p(1, 1)],
      [1, 1],
    );
    expect(angles[0]).toBeCloseTo(45, 5);
  });

  // C2: N points -> N-2 angles
  it("returns one angle per interior vertex (N-2)", () => {
    const angles = computeVertexAnglesDegrees(
      [p(0, 0), p(1, 0), p(1, 1), p(2, 1)],
      [1, 1],
    );
    expect(angles).toHaveLength(2);
    expect(angles[0]).toBeCloseTo(90, 5);
    expect(angles[1]).toBeCloseTo(90, 5);
  });

  // C5: zero-length segment -> NaN at that vertex, others valid
  it("reports NaN for a vertex adjoining a zero-length segment", () => {
    const angles = computeVertexAnglesDegrees(
      [p(0, 0), p(0, 0), p(1, 0), p(1, 1)],
      [1, 1],
    );
    expect(angles).toHaveLength(2);
    expect(Number.isNaN(angles[0])).toBe(true); // vertex 1 has a zero-length segment
    expect(angles[1]).toBeCloseTo(90, 5); // vertex 2 is a valid right angle
  });

  // C6: anisotropic per-axis scale changes the angle
  it("applies the per-axis physical scale", () => {
    // Raw vectors (1,0) and (0,1) are 90 deg. With scale x=1, y=1000 the y arm
    // dominates but the arms remain orthogonal, so still 90 deg; use a skew case
    // to show scale matters: vectors (1,0) and (1,1) are 45 deg at unit scale.
    const unit = computeVertexAnglesDegrees(
      [p(1, 0), p(0, 0), p(1, 1)],
      [1, 1],
    );
    expect(unit[0]).toBeCloseTo(45, 5);
    // Stretch y by 1000: the (1,1) arm becomes nearly vertical -> angle -> ~90.
    const stretched = computeVertexAnglesDegrees(
      [p(1, 0), p(0, 0), p(1, 1)],
      [1, 1000],
    );
    expect(stretched[0]).toBeGreaterThan(89);
    expect(stretched[0]).toBeLessThanOrEqual(90);
  });

  // C7: results within [0, 180], never throws
  it("keeps non-NaN results within 0..180", () => {
    const angles = computeVertexAnglesDegrees(
      [p(-3, 2), p(5, -1), p(0, 4), p(2, 2)],
      [7, 9],
    );
    for (const a of angles) {
      if (!Number.isNaN(a)) {
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThanOrEqual(180);
      }
    }
  });
});
