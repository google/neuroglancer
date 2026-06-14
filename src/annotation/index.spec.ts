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
import type {
  Annotation,
  AnnotationPropertySpec,
  AxisAlignedBoundingBox,
  Ellipsoid,
  Line,
  Point,
  PolyLine,
} from "#src/annotation/index.js";
import {
  AnnotationSerializer,
  AnnotationType,
  deserializeAnnotation,
  makeAnnotationPropertySerializers,
} from "#src/annotation/index.js";

function expectVecClose(actual: Float32Array, expected: Float32Array) {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; ++i) {
    expect(actual[i]).toBeCloseTo(expected[i], 6);
  }
}

describe("deserializeAnnotation", () => {
  it("round-trips mixed annotation types with properties, including polyline", () => {
    const rank = 4;
    const propertySpecs: AnnotationPropertySpec[] = [
      {
        identifier: "score",
        type: "float32",
        default: 0,
      },
      {
        identifier: "label",
        type: "int32",
        default: 0,
      },
      {
        identifier: "flag",
        type: "bool",
        default: 0,
      },
    ];
    const propertySerializers = makeAnnotationPropertySerializers(
      rank,
      propertySpecs,
    );

    const point: Point = {
      id: "pt-1",
      type: AnnotationType.POINT,
      point: Float32Array.of(1.25, -2, 3, 4.5),
      properties: [1.25, 7, true],
      description: "p",
    };
    const line: Line = {
      id: "ln-1",
      type: AnnotationType.LINE,
      pointA: Float32Array.of(0, 1, 2, 3),
      pointB: Float32Array.of(4, 5, 6, 7),
      properties: [2.5, 8, false],
      description: "l",
    };
    const bbox: AxisAlignedBoundingBox = {
      id: "bx-1",
      type: AnnotationType.AXIS_ALIGNED_BOUNDING_BOX,
      pointA: Float32Array.of(1, 2, 3, 4),
      pointB: Float32Array.of(5, 6, 7, 8),
      properties: [3.5, 9, true],
      description: "b",
    };
    const ellipsoid: Ellipsoid = {
      id: "el-1",
      type: AnnotationType.ELLIPSOID,
      center: Float32Array.of(2, 3, 4, 5),
      radii: Float32Array.of(0.5, 1.5, 2.5, 3.5),
      properties: [4.5, 10, false],
      description: "e",
    };
    const polylineA: PolyLine = {
      id: "pl-1",
      type: AnnotationType.POLYLINE,
      points: [
        Float32Array.of(0, 0, 0, 0),
        Float32Array.of(1, 2, 3, 4),
        Float32Array.of(2, 4, 6, 8),
      ],
      properties: [5.5, 11, true],
      description: "pa",
    };
    const polylineB: PolyLine = {
      id: "pl-2",
      type: AnnotationType.POLYLINE,
      points: [Float32Array.of(4, 3, 2, 1), Float32Array.of(8, 7, 6, 5)],
      properties: [6.5, 12, false],
      description: "pb",
    };

    const source: Annotation[] = [
      point,
      line,
      bbox,
      ellipsoid,
      polylineA,
      polylineB,
    ];
    const serializer = new AnnotationSerializer(propertySerializers);
    for (const annotation of source) {
      serializer.add(annotation);
    }
    const serialized = serializer.serialize();

    const roundTrip = (original: Annotation) => {
      const index = serialized.typeToIdMaps[original.type].get(original.id)!;
      return deserializeAnnotation(
        serialized,
        propertySerializers[original.type],
        original.type,
        index,
      );
    };

    const decodedPoint = roundTrip(point) as Point;
    expect(decodedPoint.id).toBe(point.id);
    expectVecClose(decodedPoint.point, point.point);
    expect(decodedPoint.properties).toEqual(point.properties);

    const decodedLine = roundTrip(line) as Line;
    expect(decodedLine.id).toBe(line.id);
    expectVecClose(decodedLine.pointA, line.pointA);
    expectVecClose(decodedLine.pointB, line.pointB);
    expect(decodedLine.properties).toEqual(line.properties);

    const decodedBbox = roundTrip(bbox) as AxisAlignedBoundingBox;
    expect(decodedBbox.id).toBe(bbox.id);
    expectVecClose(decodedBbox.pointA, bbox.pointA);
    expectVecClose(decodedBbox.pointB, bbox.pointB);
    expect(decodedBbox.properties).toEqual(bbox.properties);

    const decodedEllipsoid = roundTrip(ellipsoid) as Ellipsoid;
    expect(decodedEllipsoid.id).toBe(ellipsoid.id);
    expectVecClose(decodedEllipsoid.center, ellipsoid.center);
    expectVecClose(decodedEllipsoid.radii, ellipsoid.radii);
    expect(decodedEllipsoid.properties).toEqual(ellipsoid.properties);

    const decodedPolylineA = roundTrip(polylineA) as PolyLine;
    expect(decodedPolylineA.id).toBe(polylineA.id);
    expect(decodedPolylineA.points.length).toBe(polylineA.points.length);
    for (let i = 0; i < polylineA.points.length; ++i) {
      expectVecClose(decodedPolylineA.points[i], polylineA.points[i]);
    }
    expect(decodedPolylineA.properties).toEqual(polylineA.properties);

    const decodedPolylineB = roundTrip(polylineB) as PolyLine;
    expect(decodedPolylineB.id).toBe(polylineB.id);
    expect(decodedPolylineB.points.length).toBe(polylineB.points.length);
    for (let i = 0; i < polylineB.points.length; ++i) {
      expectVecClose(decodedPolylineB.points[i], polylineB.points[i]);
    }
    expect(decodedPolylineB.properties).toEqual(polylineB.properties);
  });
});
