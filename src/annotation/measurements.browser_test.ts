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
import type {
  AxisAlignedBoundingBox,
  Line,
  PolyLine,
} from "#src/annotation/index.js";
import { AnnotationSource, AnnotationType } from "#src/annotation/index.js";
import { computeVertexPhysicalAngles } from "#src/util/angle_measurement.js";
import { computeAxisPhysicalExtents } from "#src/util/axis_extents.js";
import { computeRulerPhysicalLength } from "#src/util/ruler_length.js";
import { formatLength, formatVolume } from "#src/util/spatial_units.js";

describe("built-in annotation measurements", () => {
  it("computes line total length and per-axis projected lengths (physical)", () => {
    const pointA = Float32Array.of(0, 0, 0);
    const pointB = Float32Array.of(3, 4, 0);
    const scaleNm = [10, 10, 10];
    const length = computeRulerPhysicalLength([pointA, pointB], scaleNm);
    expect(length).toBeCloseTo(50, 5); // 5 units * 10 nm
    expect(formatLength(length)).toContain("nm");
    const extents = computeAxisPhysicalExtents(pointA, pointB, scaleNm);
    expect(extents).toEqual([30, 40, 0]);
  });

  it("computes polyline total length and interior angles", () => {
    const points = [
      Float32Array.of(0, 0),
      Float32Array.of(3, 0),
      Float32Array.of(3, 4),
    ];
    const scaleNm = [1, 1];
    expect(computeRulerPhysicalLength(points, scaleNm)).toBeCloseTo(7, 5); // 3 + 4
    const angles = computeVertexPhysicalAngles(points, scaleNm);
    expect(angles).toHaveLength(1);
    expect(angles[0]).toBeCloseTo(90, 5);
  });

  it("computes bounding box edges and volume (physical)", () => {
    const pointA = Float32Array.of(0, 0, 0);
    const pointB = Float32Array.of(2, 3, 5);
    const scaleNm = [10, 10, 10];
    const extents = computeAxisPhysicalExtents(pointA, pointB, scaleNm);
    expect(extents).toEqual([20, 30, 50]);
    const volume = extents[0] * extents[1] * extents[2];
    expect(volume).toBeCloseTo(30000, 5);
    expect(formatVolume(volume)).toContain("³");
  });

  it("round-trips line, polyline, and bounding box through JSON", () => {
    const source = new AnnotationSource(3);
    source.add({
      id: "line",
      type: AnnotationType.LINE,
      pointA: Float32Array.of(0, 0, 0),
      pointB: Float32Array.of(1, 2, 3),
      properties: [],
    } as Line);
    source.add({
      id: "poly",
      type: AnnotationType.POLYLINE,
      points: [Float32Array.of(0, 0, 0), Float32Array.of(1, 1, 1)],
      properties: [],
    } as PolyLine);
    source.add({
      id: "box",
      type: AnnotationType.AXIS_ALIGNED_BOUNDING_BOX,
      pointA: Float32Array.of(0, 0, 0),
      pointB: Float32Array.of(2, 3, 4),
      properties: [],
    } as AxisAlignedBoundingBox);

    const restored = new AnnotationSource(3);
    restored.restoreState(source.toJSON());
    expect((restored.get("line") as Line).type).toBe(AnnotationType.LINE);
    expect((restored.get("poly") as PolyLine).type).toBe(
      AnnotationType.POLYLINE,
    );
    expect((restored.get("box") as AxisAlignedBoundingBox).type).toBe(
      AnnotationType.AXIS_ALIGNED_BOUNDING_BOX,
    );
  });
});
