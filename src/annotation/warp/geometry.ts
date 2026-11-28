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

/**
 * @file Warped annotations: reading serialized annotations, and the geometry
 * of an annotation moved through a displacement field (see `warp/base.ts`).
 * Pure, so that it can be tested without a worker.
 */

import type {
  Annotation,
  AnnotationPropertySerializer,
  SerializedAnnotations,
} from "#src/annotation/index.js";
import {
  annotationTypeHandlers,
  annotationTypes,
  AnnotationType,
} from "#src/annotation/index.js";
import { Endianness, ENDIANNESS } from "#src/util/endian.js";

// --- Serialized annotations.

const isLittleEndian = ENDIANNESS === Endianness.LITTLE;

/** The annotations of serialized chunk data, with their properties. */
export function deserializeAnnotations(
  data: SerializedAnnotations,
  serializers: AnnotationPropertySerializer[],
): Annotation[] {
  const dv = new DataView(
    data.data.buffer,
    data.data.byteOffset,
    data.data.byteLength,
  );
  const out: Annotation[] = [];
  for (const type of annotationTypes) {
    const ids = data.typeToIds[type];
    if (ids === undefined || ids.length === 0) continue;
    const serializer = serializers[type];
    const { rank } = serializer;
    const stride = serializer.propertyGroupBytes[0];
    const offset = data.typeToOffset[type];
    const count = data.typeToSize[type];
    const handler = annotationTypeHandlers[type];
    for (let i = 0; i < ids.length; ++i) {
      const instance =
        type === AnnotationType.POLYLINE
          ? data.typeToInstanceCounts[type][i]
          : i;
      const annotation = handler.deserialize(
        dv,
        offset + instance * stride,
        isLittleEndian,
        rank,
        ids[i],
        stride,
      );
      annotation.properties = new Array(serializer.propertySpecs.length);
      serializer.deserialize(
        dv,
        offset,
        instance,
        count,
        isLittleEndian,
        annotation.properties,
      );
      out.push(annotation);
    }
  }
  return out;
}

// --- Moving annotations through the field.

export interface WarpedAnnotation {
  annotation: Annotation;
  // Bounds of its geometry (output coordinates).
  lo: number[];
  hi: number[];
}

/** The points of an annotation's geometry that move (stored coordinates). */
export function annotationPoints(a: Annotation): ArrayLike<number>[] {
  switch (a.type) {
    case AnnotationType.POINT:
      return [a.point];
    case AnnotationType.LINE:
      return [a.pointA, a.pointB];
    case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX: {
      const corners: number[][] = [];
      for (let c = 0; c < 8; ++c) {
        corners.push(
          [0, 1, 2].map((i) => ((c >> i) & 1 ? a.pointB[i] : a.pointA[i])),
        );
      }
      return corners;
    }
    case AnnotationType.ELLIPSOID:
      return [a.center];
    case AnnotationType.POLYLINE:
      return a.points;
  }
}

function boundsOf(points: Float32Array[]) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let i = 0; i < 3; ++i) {
      lo[i] = Math.min(lo[i], p[i]);
      hi[i] = Math.max(hi[i], p[i]);
    }
  }
  return { lo, hi };
}

/** An annotation with its moved points (output coordinates). */
export function rebuild(
  a: Annotation,
  moved: Float32Array[],
  storedToOutput: number[],
): WarpedAnnotation {
  const M = storedToOutput;
  switch (a.type) {
    case AnnotationType.POINT:
      return { annotation: { ...a, point: moved[0] }, ...boundsOf(moved) };
    case AnnotationType.LINE:
      return {
        annotation: { ...a, pointA: moved[0], pointB: moved[1] },
        ...boundsOf(moved),
      };
    case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX: {
      const { lo, hi } = boundsOf(moved);
      return {
        annotation: {
          ...a,
          pointA: Float32Array.from(lo),
          pointB: Float32Array.from(hi),
        },
        lo,
        hi,
      };
    }
    case AnnotationType.ELLIPSOID: {
      // The radii follow the linear placement (the field's local stretch is
      // not applied).
      const radii = Float32Array.from([0, 1, 2], (i) =>
        Math.hypot(
          M[i * 4] * a.radii[0],
          M[i * 4 + 1] * a.radii[1],
          M[i * 4 + 2] * a.radii[2],
        ),
      );
      const center = moved[0];
      return {
        annotation: { ...a, center, radii },
        lo: [0, 1, 2].map((i) => center[i] - radii[i]),
        hi: [0, 1, 2].map((i) => center[i] + radii[i]),
      };
    }
    case AnnotationType.POLYLINE:
      return { annotation: { ...a, points: moved }, ...boundsOf(moved) };
  }
}
