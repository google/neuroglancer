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
import { createGriddedRectangleArray } from "#src/webgl/rectangle_grid_buffer.js";

describe("createGriddedRectangleArray", () => {
  it("creates a set of two squares for grid size=2 and rectangle width&height=2", () => {
    const result = createGriddedRectangleArray(2, -1, 1, 1, -1);
    expect(result).toEqual(
      new Float32Array([
        -1, 1, 0, 1, 0, -1 /* triangle in top right for first grid */, -1, 1, 0,
        -1, -1, -1 /* triangle in bottom left for first grid */, 0, 1, 1, 1, 1,
        -1 /* triangle in top right for second grid */, 0, 1, 1, -1, 0,
        -1 /* triangle in bottom left for second grid */,
      ]),
    );
    const resultReverse = createGriddedRectangleArray(2, 1, -1, -1, 1);
    expect(resultReverse).toEqual(
      new Float32Array([
        1, -1, 0, -1, 0, 1 /* triangle in top right for first grid */, 1, -1, 0,
        1, 1, 1 /* triangle in bottom left for first grid */, 0, -1, -1, -1, -1,
        1 /* triangle in top right for second grid */, 0, -1, -1, 1, 0,
        1 /* triangle in bottom left for second grid */,
      ]),
    );
  });
});
