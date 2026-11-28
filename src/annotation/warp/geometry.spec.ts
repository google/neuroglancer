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
import type { Annotation } from "#src/annotation/index.js";
import {
  AnnotationSerializer,
  AnnotationType,
  makeAnnotationPropertySerializers,
} from "#src/annotation/index.js";
import {
  annotationPoints,
  deserializeAnnotations,
  rebuild,
} from "#src/annotation/warp/geometry.js";

const v = (...x: number[]) => Float32Array.from(x);

const annotations: Annotation[] = [
  {
    type: AnnotationType.POINT,
    id: "p1",
    point: v(1, 2, 3),
    properties: [7, 0.5],
  },
  {
    type: AnnotationType.POINT,
    id: "p2",
    point: v(4, 5, 6),
    properties: [8, 1.5],
  },
  {
    type: AnnotationType.LINE,
    id: "l1",
    pointA: v(0, 0, 0),
    pointB: v(1, 1, 1),
    properties: [9, 2.5],
  },
  {
    type: AnnotationType.AXIS_ALIGNED_BOUNDING_BOX,
    id: "b1",
    pointA: v(0, 0, 0),
    pointB: v(2, 3, 4),
    properties: [10, 3.5],
  },
  {
    type: AnnotationType.ELLIPSOID,
    id: "e1",
    center: v(5, 5, 5),
    radii: v(1, 2, 3),
    properties: [11, 4.5],
  },
  {
    type: AnnotationType.POLYLINE,
    id: "q1",
    points: [v(0, 0, 0), v(1, 0, 0), v(1, 1, 0), v(1, 1, 1)],
    properties: [12, 5.5],
  },
  {
    type: AnnotationType.POLYLINE,
    id: "q2",
    points: [v(9, 9, 9), v(8, 8, 8)],
    properties: [13, 6.5],
  },
];

describe("warped annotation geometry", () => {
  it("reads back serialized annotations of every type, with properties", () => {
    const serializers = makeAnnotationPropertySerializers(3, [
      { identifier: "a", description: undefined, type: "uint8", default: 0 },
      { identifier: "b", description: undefined, type: "float32", default: 0 },
    ]);
    const serializer = new AnnotationSerializer(serializers);
    for (const a of annotations) serializer.add(a);
    const read = deserializeAnnotations(serializer.serialize(), serializers);
    const byId = new Map(read.map((a) => [a.id, a]));
    expect(read.length).toBe(annotations.length);
    for (const a of annotations) {
      expect(byId.get(a.id)).toEqual(a);
    }
  });

  it("moves every point of the geometry, and only those", () => {
    // Shift by (10, 20, 30), as a moved annotation would be.
    const shift = (p: ArrayLike<number>) => v(p[0] + 10, p[1] + 20, p[2] + 30);
    const placement = [1, 0, 0, 10, 0, 2, 0, 20, 0, 0, 1, 30, 0, 0, 0, 1];
    const box = annotations[3];
    const corners = annotationPoints(box);
    expect(corners.length).toBe(8);
    const movedBox = rebuild(box, corners.map(shift), placement);
    expect(movedBox.annotation).toMatchObject({
      pointA: v(10, 20, 30),
      pointB: v(12, 23, 34),
    });
    expect(movedBox.lo).toEqual([10, 20, 30]);
    expect(movedBox.hi).toEqual([12, 23, 34]);

    // Ellipsoid radii follow the linear placement (y doubled).
    const ellipsoid = annotations[4];
    const movedEllipsoid = rebuild(
      ellipsoid,
      annotationPoints(ellipsoid).map(shift),
      placement,
    );
    expect(movedEllipsoid.annotation).toMatchObject({
      center: v(15, 25, 35),
      radii: v(1, 4, 3),
    });
    expect(movedEllipsoid.lo).toEqual([14, 21, 32]);

    const polyline = annotations[5];
    const movedPolyline = rebuild(
      polyline,
      annotationPoints(polyline).map(shift),
      placement,
    );
    expect(movedPolyline.annotation).toMatchObject({
      id: "q1",
      properties: [12, 5.5],
    });
    expect(movedPolyline.hi).toEqual([11, 21, 31]);
  });
});
