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
import type { Angle, PolyLine } from "#src/annotation/index.js";
import {
  AnnotationSerializer,
  AnnotationSource,
  AnnotationType,
  makeAnnotationPropertySerializers,
} from "#src/annotation/index.js";

describe("angle annotation type", () => {
  it("round-trips geometry through JSON as a distinct type", () => {
    const source = new AnnotationSource(2);
    source.add({
      id: "a",
      type: AnnotationType.ANGLE,
      description: "my label",
      points: [
        Float32Array.of(1, 0),
        Float32Array.of(0, 0),
        Float32Array.of(0, 1),
      ],
      properties: [],
    } as Angle);

    const json = source.toJSON();
    const restored = new AnnotationSource(2);
    restored.restoreState(json);

    const angle = restored.get("a") as Angle;
    expect(angle.type).toBe(AnnotationType.ANGLE);
    expect(angle.description).toBe("my label");
    expect(angle.points.map((p) => Array.from(p))).toEqual([
      [1, 0],
      [0, 0],
      [0, 1],
    ]);
  });

  it("is a distinct type from polyline and ruler", () => {
    expect(AnnotationType.ANGLE).not.toBe(AnnotationType.POLYLINE);
    expect(AnnotationType.ANGLE).not.toBe(AnnotationType.RULER);
  });

  it("serializes to the same bytes as a polyline with identical geometry", () => {
    const rank = 2;
    const propertySerializers = makeAnnotationPropertySerializers(rank, []);
    const points = [
      Float32Array.of(0, 0),
      Float32Array.of(1, 0),
      Float32Array.of(1, 1),
    ];
    const angleSerializer = new AnnotationSerializer(propertySerializers);
    angleSerializer.add({
      id: "a",
      type: AnnotationType.ANGLE,
      points,
      properties: [],
    } as Angle);
    const polylineSerializer = new AnnotationSerializer(propertySerializers);
    polylineSerializer.add({
      id: "p",
      type: AnnotationType.POLYLINE,
      points,
      properties: [],
    } as PolyLine);
    // Angles reuse the polyline geometry serializer, so identical geometry must
    // produce identical bytes (each type is the only annotation in its set).
    expect(angleSerializer.serialize().data).toEqual(
      polylineSerializer.serialize().data,
    );
  });
});
