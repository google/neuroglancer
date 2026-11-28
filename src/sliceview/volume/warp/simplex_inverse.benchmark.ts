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

import { bench, describe } from "vitest";
import type { FieldBlock } from "#src/sliceview/volume/warp/simplex_inverse.js";
import { invertFieldBlock } from "#src/sliceview/volume/warp/simplex_inverse.js";

/**
 * A smooth field moving up to a few voxels, over the source box a 64^3
 * target chunk needs (with a margin), and over the box of whole chunks
 * around it, as fetched: the kernel's cost is mostly in the cells it skips.
 */
function makeField(n: number, origin: number): FieldBlock {
  const count = n * n * n;
  const data = new Float32Array(3 * count);
  for (let i2 = 0; i2 < n; ++i2) {
    for (let i1 = 0; i1 < n; ++i1) {
      for (let i0 = 0; i0 < n; ++i0) {
        const k = i0 + n * (i1 + n * i2);
        const x0 = origin + i0,
          x1 = origin + i1,
          x2 = origin + i2;
        data[k] = 3 * Math.sin(x1 / 17) + 0.02 * x0;
        data[count + k] = 2 * Math.cos(x2 / 13) - 0.01 * x1;
        data[2 * count + k] = 3 * Math.sin((x0 + x1) / 23);
      }
    }
  }
  return {
    data,
    size: [n, n, n],
    strides: [1, n, n * n],
    componentOffsets: [0, count, 2 * count],
    origin: [origin, origin, origin],
  };
}

const cropped = makeField(76, 56);
const fetched = makeField(192, 0);

describe("invertFieldBlock, 64^3 targets", () => {
  bench("source box (76^3 samples)", () => {
    invertFieldBlock(cropped, [64, 64, 64], [64, 64, 64]);
  });
  bench("whole fetched chunks (192^3 samples)", () => {
    invertFieldBlock(fetched, [64, 64, 64], [64, 64, 64]);
  });
});
