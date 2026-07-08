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
import type { PolyLine, Ruler } from "#src/annotation/index.js";
import {
  AnnotationSerializer,
  AnnotationSource,
  AnnotationType,
  makeAnnotationPropertySerializers,
} from "#src/annotation/index.js";
import { computeRulerLengthNm } from "#src/util/ruler_length.js";
import { formatLength } from "#src/util/spatial_units.js";

describe("ruler annotation type", () => {
  it("round-trips geometry through JSON as a distinct type", () => {
    const source = new AnnotationSource(2);
    source.add({
      id: "a",
      type: AnnotationType.RULER,
      description: "my label",
      points: [Float32Array.of(0, 0), Float32Array.of(3, 4)],
      properties: [],
    } as Ruler);

    const json = source.toJSON();
    const restored = new AnnotationSource(2);
    restored.restoreState(json);

    const ruler = restored.get("a") as Ruler;
    expect(ruler.type).toBe(AnnotationType.RULER);
    expect(ruler.description).toBe("my label");
    expect(ruler.points.map((p) => Array.from(p))).toEqual([
      [0, 0],
      [3, 4],
    ]);
  });

  it("is a distinct type from polyline", () => {
    expect(AnnotationType.RULER).not.toBe(AnnotationType.POLYLINE);
  });

  it("formats the total physical length with an auto-scaled unit", () => {
    // A 3-4-5 leg then a 12-unit leg: 5 + 12 = 17 units of length.
    const points = [
      Float32Array.of(0, 0),
      Float32Array.of(3, 4),
      Float32Array.of(3, 16),
    ];
    // 4 nm per unit -> 17 * 4 = 68 nm (sub-micrometer, shown in nm).
    const nm = computeRulerLengthNm(points, [4, 4]);
    expect(nm).toBeCloseTo(68, 5);
    expect(formatLength(nm)).toContain("nm");
    // 400 nm per unit -> 17 * 400 = 6800 nm = 6.8 µm (shown in µm).
    const um = computeRulerLengthNm(points, [400, 400]);
    expect(formatLength(um)).toContain("µm");
  });

  it("serializes to the same bytes as a polyline with identical geometry", () => {
    const rank = 2;
    const propertySerializers = makeAnnotationPropertySerializers(rank, []);
    const points = [
      Float32Array.of(0, 0),
      Float32Array.of(1, 0),
      Float32Array.of(1, 1),
    ];
    const rulerSerializer = new AnnotationSerializer(propertySerializers);
    rulerSerializer.add({
      id: "r",
      type: AnnotationType.RULER,
      points,
      properties: [],
    } as Ruler);
    const polylineSerializer = new AnnotationSerializer(propertySerializers);
    polylineSerializer.add({
      id: "p",
      type: AnnotationType.POLYLINE,
      points,
      properties: [],
    } as PolyLine);
    // Rulers reuse the polyline geometry serializer, so identical geometry must
    // produce identical bytes (each type is the only annotation in its set).
    expect(rulerSerializer.serialize().data).toEqual(
      polylineSerializer.serialize().data,
    );
  });
});
