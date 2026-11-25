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
import {
  makeCoordinateSpace,
  makeIdentityTransform,
  makeIdentityTransformedBoundingBox,
} from "#src/coordinate_transform.js";
import {
  layerDataSourceSpecificationFromJson,
  layerDataSourceSpecificationToJson,
} from "#src/layer/layer_data_source.js";
import { coordinateMatrix } from "#src/sliceview/volume/warp/affine.js";
import {
  composeChainAffine,
  matchChainAxes,
  parseTransformSourceSpecification,
  transformSourceSpecificationToJson,
} from "#src/sliceview/volume/warp/transform_source.js";
import * as matrix from "#src/util/matrix.js";

// A precomputed-like source: x, y, z voxels of 8 x 8 x 40 nm.
const space = makeCoordinateSpace({
  names: ["x", "y", "z"],
  units: ["m", "m", "m"],
  scales: Float64Array.of(8e-9, 8e-9, 40e-9),
  boundingBoxes: [
    makeIdentityTransformedBoundingBox({
      lowerBounds: Float64Array.of(0, 0, 0),
      upperBounds: Float64Array.of(100, 100, 100),
    }),
  ],
});
const um = (name: string) => ({ name, type: "space", unit: "micrometer" });
const zyx = [um("z"), um("y"), um("x")];

/** Applies a transform's coordinate matrix to a point. */
function apply(rows: number[][], p: number[]) {
  return rows.map((row) =>
    row.reduce((s, v, j) => s + v * (j < p.length ? p[j] : 1), 0),
  );
}

describe("transform sources", () => {
  it("matches chain axes by name, else length dimensions in order", () => {
    expect(matchChainAxes(zyx, space)).toEqual([2, 1, 0]);
    expect(matchChainAxes([um("k"), um("j"), um("i")], space)).toEqual([
      0, 1, 2,
    ]);
    expect(() => matchChainAxes([um("z"), um("q"), um("x")], space)).toThrow(
      /do not match/,
    );
  });

  it("composes a chain affine in its own units with a source", () => {
    // z, y, x in micrometers: x + 1 um, y mirrored about 10 um.
    const affine = matrix.createIdentity(Float64Array, 4);
    affine[3 * 4 + 2] = 1;
    affine[1 * 4 + 1] = -1;
    affine[3 * 4 + 1] = 10;
    const t = composeChainAffine(
      makeIdentityTransform(space),
      matchChainAxes(zyx, space),
      [1e-6, 1e-6, 1e-6],
      affine,
      zyx.map(({ name }) => ({ name, unit: "m", scale: 1e-6 })),
    );
    expect(Array.from(t.outputSpace.names)).toEqual(["z", "y", "x"]);
    // One voxel of the source per coordinate.
    expect(Array.from(t.outputSpace.scales)).toEqual([40e-9, 8e-9, 8e-9]);
    // Voxel (10, 20, 30): x = 80 nm + 1 um, y = 10 um - 160 nm, z = 1.2 um.
    const out = apply(coordinateMatrix(t), [10, 20, 30]);
    expect(out[0]).toBeCloseTo(30, 9);
    expect(out[1]).toBeCloseTo((10e-6 - 160e-9) / 8e-9, 6);
    expect(out[2]).toBeCloseTo((1e-6 + 80e-9) / 8e-9, 6);
    // The bounds follow.
    expect(t.outputSpace.bounds.lowerBounds[1]).toBeCloseTo(1150, 6);
    expect(t.outputSpace.bounds.upperBounds[1]).toBeCloseTo(1250, 6);
  });

  it("passes other dimensions through and refuses name clashes", () => {
    const withChannel = makeCoordinateSpace({
      names: ["c'", "z", "y", "x"],
      units: ["", "m", "m", "m"],
      scales: Float64Array.of(1, 1e-6, 1e-6, 1e-6),
    });
    const identity = matrix.createIdentity(Float64Array, 4);
    const outDims = zyx.map(({ name }) => ({ name, unit: "m", scale: 1e-6 }));
    const t = composeChainAffine(
      makeIdentityTransform(withChannel),
      matchChainAxes(zyx, withChannel),
      [1e-6, 1e-6, 1e-6],
      identity,
      outDims,
    );
    expect(Array.from(t.outputSpace.names)).toEqual(["z", "y", "x", "c'"]);
    expect(apply(coordinateMatrix(t), [1, 2, 3, 4])).toEqual([2, 3, 4, 1]);
    expect(() =>
      composeChainAffine(
        makeIdentityTransform(withChannel),
        [1, 2, 3],
        [1e-6, 1e-6, 1e-6],
        identity,
        [outDims[0], outDims[1], { ...outDims[2], name: "c'" }],
      ),
    ).toThrow(/also one of the source's other dimensions/);
  });

  it("round-trips its JSON", () => {
    for (const json of [
      "zarr3://http://host/scene.zarr/",
      { url: "http://host/scene.zarr/", name: "a to b", inverse: true },
      { url: "http://host/f.nii.gz", vectorFrame: "RAS", vectorUnit: "mm" },
    ]) {
      expect(
        transformSourceSpecificationToJson(
          parseTransformSourceSpecification(json),
        ),
      ).toEqual(json);
    }
  });

  it("round-trips a data source's transform source and prepend", () => {
    const json = {
      url: "precomputed://http://host/seg",
      transform: {
        outputDimensions: { x: [1e-6, "m"], y: [1e-6, "m"], z: [1e-6, "m"] },
      },
      transformSource: "http://host/field.zarr/",
      prependTransform: true,
    };
    const spec = layerDataSourceSpecificationFromJson(json);
    expect(spec.transformSource).toEqual({ url: "http://host/field.zarr/" });
    expect(spec.prependTransform).toBe(true);
    expect(layerDataSourceSpecificationToJson(spec)).toEqual(json);
  });
});
