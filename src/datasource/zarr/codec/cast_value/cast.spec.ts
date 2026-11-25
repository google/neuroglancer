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

import { describe, it, expect } from "vitest";
import { castValues } from "#src/datasource/zarr/codec/cast_value/cast.js";
import { DataType } from "#src/util/data_type.js";

describe("castValues", () => {
  it("rounds to nearest even", () => {
    const out = castValues(
      [0.5, 1.5, 2.5, -0.5, 2.4],
      DataType.INT8,
      "nearest-even",
      undefined,
    );
    expect(Array.from(out as Int8Array)).toEqual([0, 2, 2, 0, 2]);
  });

  it("supports the other rounding modes", () => {
    const x = [1.5, -1.5];
    const f = (r: Parameters<typeof castValues>[2]) =>
      Array.from(castValues(x, DataType.INT16, r, undefined) as Int16Array);
    expect(f("towards-zero")).toEqual([1, -1]);
    expect(f("towards-positive")).toEqual([2, -1]);
    expect(f("towards-negative")).toEqual([1, -2]);
    expect(f("nearest-away")).toEqual([2, -2]);
  });

  it("clamps, wraps, or rejects out-of-range values", () => {
    expect(
      Array.from(
        castValues(
          [-3, 300],
          DataType.UINT8,
          "nearest-even",
          "clamp",
        ) as Uint8Array,
      ),
    ).toEqual([0, 255]);
    expect(
      Array.from(
        castValues(
          [128, -129],
          DataType.INT8,
          "nearest-even",
          "wrap",
        ) as Int8Array,
      ),
    ).toEqual([-128, 127]);
    expect(() =>
      castValues([256], DataType.UINT8, "nearest-even", undefined),
    ).toThrow();
  });

  it("rejects NaN and infinity for integer types", () => {
    expect(() =>
      castValues([NaN], DataType.UINT16, "nearest-even", "clamp"),
    ).toThrow();
    expect(() =>
      castValues([Infinity], DataType.UINT16, "nearest-even", "clamp"),
    ).toThrow();
  });

  it("converts to float32", () => {
    const out = castValues(
      [1, 255],
      DataType.FLOAT32,
      "nearest-even",
      undefined,
    );
    expect(out).toBeInstanceOf(Float32Array);
    expect(Array.from(out as Float32Array)).toEqual([1, 255]);
  });

  it("decodes the acquire-zarr chain back to uint16", () => {
    // encoded uint8 -> float32 -> (unscaled elsewhere) -> uint16
    const scale = Math.fround(255 / 4095);
    const unscaled = [0, 128, 255].map((v) => Math.fround(v / scale));
    const out = castValues(
      unscaled,
      DataType.UINT16,
      "nearest-even",
      undefined,
    );
    expect(Array.from(out as Uint16Array)).toEqual([0, 2056, 4095]);
  });
});
