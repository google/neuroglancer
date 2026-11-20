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
import { computeReshapedShape } from "#src/datasource/zarr/codec/reshape/shape.js";

describe("computeReshapedShape", () => {
  it("merges the leading dimensions, as acquire-zarr writes", () => {
    expect(
      computeReshapedShape([[0, 1, 2, 3], [4]], [1, 1, 8, 64, 64]),
    ).toEqual([512, 64]);
  });

  it("supports fixed sizes and -1", () => {
    expect(computeReshapedShape([[0, 1], [2], 3], [100, 50, 64, 3])).toEqual([
      5000, 64, 3,
    ]);
    expect(computeReshapedShape([-1, 64], [10, 8, 64])).toEqual([80, 64]);
  });

  it("rejects the invalid examples of the spec", () => {
    expect(() => computeReshapedShape([[1], [0]], [2, 3])).toThrow();
    expect(() =>
      computeReshapedShape([[1, 0], 10, [3, 4]], [2, 5, 10, 3, 4]),
    ).toThrow();
    expect(() =>
      computeReshapedShape([[3, 4], 10, [0, 1]], [2, 5, 10, 3, 4]),
    ).toThrow();
  });

  it("rejects a shape that changes the element count or misaligns", () => {
    expect(() => computeReshapedShape([7], [2, 3])).toThrow();
    expect(() => computeReshapedShape([3, [1]], [2, 3])).toThrow();
    expect(() => computeReshapedShape([-1, -1], [2, 3])).toThrow();
  });
});
