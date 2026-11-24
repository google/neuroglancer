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
  parseWarpSpecification,
  warpSpecificationToJson,
} from "#src/sliceview/volume/warp/field.js";

describe("warp specification", () => {
  it("keeps the string form for a URL alone", () => {
    const spec = parseWarpSpecification("zarr3://http://x/field.zarr/");
    expect(spec).toEqual({ url: "zarr3://http://x/field.zarr/" });
    expect(warpSpecificationToJson(spec)).toBe("zarr3://http://x/field.zarr/");
  });

  it("round-trips the object form", () => {
    const json = {
      url: "nifti://http://x/warp.nii.gz",
      vectorDimension: "c^",
      vectorDimensions: ["x", "y", "z"],
      vectorFrame: "RAS",
      vectorUnit: "mm",
      transform: {
        outputDimensions: { y: [4e-6, "m"], x: [4e-6, "m"], "c'": [1, ""] },
        matrix: [
          [1, 0, 0, 0],
          [0, -1, 0, 16],
          [0, 0, 1, 0],
        ],
      },
    };
    const spec = parseWarpSpecification(json);
    expect(spec.vectorDimensions).toEqual(["x", "y", "z"]);
    expect(JSON.parse(JSON.stringify(warpSpecificationToJson(spec)))).toEqual(
      json,
    );
  });

  it("rejects an unknown frame or unit", () => {
    expect(() =>
      parseWarpSpecification({ url: "u", vectorFrame: "LPI" }),
    ).toThrow(/"LPS" or "RAS"/);
    expect(() =>
      parseWarpSpecification({ url: "u", vectorUnit: "furlong" }),
    ).toThrow(/Unsupported unit/);
  });
});
