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

import { describe, expect, it } from "vitest";
import type { Annotation } from "#src/annotation/index.js";
import { AnnotationType } from "#src/annotation/index.js";
import {
  analyzeDerivedProperties,
  collectPhysicalDimensions,
  prettyUnit,
} from "#src/annotation/annotation_derived_properties.js";
import type { ChunkTransformParameters } from "#src/render_coordinate_transform.js";
import type { CoordinateSpace } from "#src/coordinate_transform.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function coordSpace(
  names: string[],
  units: string[],
  scales: number[],
): CoordinateSpace {
  return {
    rank: names.length,
    names,
    units,
    scales: Float64Array.from(scales),
  } as unknown as CoordinateSpace;
}

/** Identity chunk→layer transform of the given rank (global dims map 1:1). */
function identityTransform(rank: number): ChunkTransformParameters {
  const stride = rank + 1;
  const mat = new Float32Array(stride * stride);
  for (let i = 0; i < stride; ++i) mat[stride * i + i] = 1;
  const seq = Array.from({ length: rank }, (_, i) => i);
  return {
    layerRank: rank,
    chunkToLayerTransform: mat,
    modelTransform: {
      globalToRenderLayerDimensions: seq,
      localToRenderLayerDimensions: [],
    },
  } as unknown as ChunkTransformParameters;
}

let nextId = 0;
function line(pointA: number[], pointB: number[]): Annotation {
  return {
    type: AnnotationType.LINE,
    id: `l${nextId++}`,
    pointA: Float32Array.from(pointA),
    pointB: Float32Array.from(pointB),
    properties: [],
  } as Annotation;
}
function box(pointA: number[], pointB: number[]): Annotation {
  return {
    type: AnnotationType.AXIS_ALIGNED_BOUNDING_BOX,
    id: `b${nextId++}`,
    pointA: Float32Array.from(pointA),
    pointB: Float32Array.from(pointB),
    properties: [],
  } as Annotation;
}
function ellipsoid(center: number[], radii: number[]): Annotation {
  return {
    type: AnnotationType.ELLIPSOID,
    id: `e${nextId++}`,
    center: Float32Array.from(center),
    radii: Float32Array.from(radii),
    properties: [],
  } as Annotation;
}
function polyline(points: number[][]): Annotation {
  return {
    type: AnnotationType.POLYLINE,
    id: `p${nextId++}`,
    points: points.map((p) => Float32Array.from(p)),
    properties: [],
  } as Annotation;
}
function point(coords: number[]): Annotation {
  return {
    type: AnnotationType.POINT,
    id: `pt${nextId++}`,
    point: Float32Array.from(coords),
    properties: [],
  } as Annotation;
}

function analyze(
  annotations: Annotation[],
  space: CoordinateSpace,
): ReturnType<typeof analyzeDerivedProperties> {
  const rank = space.rank;
  const transform = identityTransform(rank);
  return analyzeDerivedProperties({
    annotations: annotations.map((annotation) => ({
      id: annotation.id,
      annotation,
      chunkTransform: transform,
    })),
    globalCoordinateSpace: space,
    localCoordinateSpace: coordSpace([], [], []),
    globalDimensionIndices: Array.from({ length: rank }, (_, i) => i),
    localDimensionIndices: [],
  });
}

const schemaIds = (r: ReturnType<typeof analyzeDerivedProperties>) =>
  new Set(r.schemas.map((s) => s.identifier));
const valueOf = (
  r: ReturnType<typeof analyzeDerivedProperties>,
  id: string,
  prop: string,
) => r.valuesByAnnotationId.get(id)?.get(prop);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("prettyUnit", () => {
  it("formats compound units with superscripts", () => {
    expect(prettyUnit("m")).toBe("m");
    expect(prettyUnit("s")).toBe("s");
    expect(prettyUnit("m^2")).toBe("m²");
    expect(prettyUnit("m^3")).toBe("m³");
  });
});

describe("collectPhysicalDimensions", () => {
  it("skips unitless dimensions and records base units", () => {
    const space = coordSpace(
      ["x", "y", "z", "t", "c"],
      ["nm", "nm", "m", "s", ""],
      [1e-9, 1e-9, 1, 1, 1],
    );
    const dims = collectPhysicalDimensions(space, [0, 1, 2, 3, 4], "global");
    expect(dims.map((d) => d.name)).toEqual(["x", "y", "z", "t"]);
    expect(dims.map((d) => d.baseUnit)).toEqual(["m", "m", "m", "s"]);
  });
});

describe("analyzeDerivedProperties", () => {
  const meters3 = () => coordSpace(["x", "y", "z"], ["m", "m", "m"], [1, 1, 1]);

  it("computes line length over active spatial dims (3-4-5)", () => {
    const a = line([0, 0, 0], [3, 4, 0]);
    const r = analyze([a], meters3());
    // z is constant (0) → inactive; length over {x,y} = 5.
    expect(valueOf(r, a.id, "length")).toBeCloseTo(5, 6);
    expect(schemaIds(r).has("length")).toBe(true);
  });

  it("drops delta for a constant dimension", () => {
    const a = line([0, 0, 0], [3, 4, 0]);
    const r = analyze([a], meters3());
    expect(schemaIds(r).has("delta_x")).toBe(true);
    expect(schemaIds(r).has("delta_y")).toBe(true);
    // z never varies → no delta_z.
    expect(schemaIds(r).has("delta_z")).toBe(false);
    expect(valueOf(r, a.id, "delta_x")).toBeCloseTo(3, 6);
  });

  it("computes box volume (3D) and area (2D) by active-dim count", () => {
    const r3 = analyze([box([0, 0, 0], [2, 3, 4])], meters3());
    expect(schemaIds(r3).has("volume")).toBe(true);
    const b3 = [...r3.valuesByAnnotationId.keys()][0];
    expect(valueOf(r3, b3, "volume")).toBeCloseTo(24, 5);

    // Only x and y vary → 2 active spatial dims → "area".
    const r2 = analyze([box([0, 0, 0], [2, 3, 0])], meters3());
    expect(schemaIds(r2).has("area")).toBe(true);
    expect(schemaIds(r2).has("volume")).toBe(false);
    const b2 = [...r2.valuesByAnnotationId.keys()][0];
    expect(valueOf(r2, b2, "area")).toBeCloseTo(6, 5);
  });

  it("computes ellipsoid n-ball volume and diameter delta", () => {
    const e = ellipsoid([0, 0, 0], [1, 2, 3]);
    const r = analyze([e], meters3());
    // (4/3)π r1 r2 r3 = 8π
    expect(valueOf(r, e.id, "volume")).toBeCloseTo(8 * Math.PI, 4);
    // delta = diameter = 2*radius
    expect(valueOf(r, e.id, "delta_x")).toBeCloseTo(2, 6);
    expect(valueOf(r, e.id, "delta_z")).toBeCloseTo(6, 6);
  });

  it("computes polyline length and extent", () => {
    const p = polyline([
      [0, 0, 0],
      [3, 0, 0],
      [3, 4, 0],
    ]);
    const r = analyze([p], coordSpace(["x", "y", "z"], ["m", "m", "m"], [1, 1, 1]));
    // path = 3 + 4 = 7
    expect(valueOf(r, p.id, "length")).toBeCloseTo(7, 6);
    // extent_x = 3, extent_y = 4
    expect(valueOf(r, p.id, "extent_x")).toBeCloseTo(3, 6);
    expect(valueOf(r, p.id, "extent_y")).toBeCloseTo(4, 6);
    // delta_x = last - first = 3 - 0 = 3
    expect(valueOf(r, p.id, "delta_x")).toBeCloseTo(3, 6);
  });

  it("scales mixed units to SI base (nm and m combine in meters)", () => {
    // x in nm (1e-9 m), y in m. Line from origin to (1e9 nm, 0).
    const space = coordSpace(["x", "y"], ["nm", "m"], [1e-9, 1]);
    const a = line([1e9, 0], [0, 1]);
    const r = analyze([a], space);
    // dx = 1e9 * 1e-9 = 1 m; dy = 1 m; length = sqrt(2).
    expect(valueOf(r, a.id, "length")).toBeCloseTo(Math.SQRT2, 6);
  });

  describe("temporal", () => {
    const xyt = () => coordSpace(["x", "y", "t"], ["m", "m", "s"], [1, 1, 1]);

    it("computes duration and omits temporal delta for monotonic lines", () => {
      const a = line([0, 0, 0], [3, 4, 5]);
      const r = analyze([a], xyt());
      expect(valueOf(r, a.id, "duration")).toBeCloseTo(5, 6);
      expect(schemaIds(r).has("duration")).toBe(true);
      // Lines never get temporal delta (always monotonic).
      expect(schemaIds(r).has("delta_t")).toBe(false);
    });

    it("drops all temporal properties when time never varies", () => {
      const r = analyze([line([0, 0, 0], [3, 4, 0])], xyt());
      expect(schemaIds(r).has("duration")).toBe(false);
      expect(schemaIds(r).has("delta_t")).toBe(false);
    });

    it("keeps temporal delta for a non-monotonic polyline", () => {
      // t goes 0 → 5 → 2 (reverses) → non-monotonic.
      const p = polyline([
        [0, 0, 0],
        [1, 0, 5],
        [2, 0, 2],
      ]);
      const r = analyze([p], xyt());
      expect(schemaIds(r).has("delta_t")).toBe(true);
      // delta_t = last - first = 2 - 0 = 2
      expect(valueOf(r, p.id, "delta_t")).toBeCloseTo(2, 6);
    });
  });

  it("yields NaN for type-mismatched properties in mixed layers", () => {
    // 2 active spatial dims → line has "length", box has "area".
    const l = line([0, 0], [3, 4]);
    const b = box([0, 0], [2, 3]);
    const r = analyze([l, b], coordSpace(["x", "y"], ["m", "m"], [1, 1]));
    expect(valueOf(r, l.id, "length")).toBeCloseTo(5, 6);
    expect(Number.isNaN(valueOf(r, l.id, "area")!)).toBe(true);
    expect(valueOf(r, b.id, "area")).toBeCloseTo(6, 5);
    expect(Number.isNaN(valueOf(r, b.id, "length")!)).toBe(true);
  });

  it("produces no derived properties for a point-only layer", () => {
    const r = analyze([point([1, 2, 3]), point([4, 5, 6])], meters3());
    expect(r.schemas.length).toBe(0);
    expect(r.warning).toBeUndefined();
  });

  it("warns when measurable annotations exist but units are missing", () => {
    const space = coordSpace(["x", "y"], ["", ""], [1, 1]);
    const r = analyze([line([0, 0], [3, 4])], space);
    expect(r.schemas.length).toBe(0);
    expect(r.warning).toBeDefined();
  });

  it("computeForAnnotation matches the set-wide values", () => {
    const a = line([0, 0, 0], [3, 4, 0]);
    const space = meters3();
    const r = analyze([a], space);
    const recomputed = r.computeForAnnotation(a, identityTransform(space.rank));
    expect(recomputed.get("length")).toBeCloseTo(5, 6);
  });
});
