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

import { getDefaultCatmaidChunkSize } from "#src/datasource/catmaid/default_chunk_size.js";

describe("datasource/catmaid/default_chunk_size", () => {
  it("covers the bounds with at most 64 isotropic chunks", () => {
    expect(
      getDefaultCatmaidChunkSize({
        lowerBounds: Float64Array.of(5, 6, 7),
        upperBounds: Float64Array.of(25, 66, 127),
      }),
    ).toEqual([15, 15, 15]);
  });

  it("keeps the chunk size isotropic for elongated bounds", () => {
    expect(
      getDefaultCatmaidChunkSize({
        lowerBounds: Float64Array.of(0, 0, 0),
        upperBounds: Float64Array.of(1000, 10, 10),
      }),
    ).toEqual([16, 16, 16]);
  });

  it("returns the minimum chunk size for tiny bounds", () => {
    expect(
      getDefaultCatmaidChunkSize({
        lowerBounds: Float64Array.of(0, 0, 0),
        upperBounds: Float64Array.of(2, 2, 2),
      }),
    ).toEqual([1, 1, 1]);
  });
});
