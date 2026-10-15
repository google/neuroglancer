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

import { describe, expect, it, vi } from "vitest";

import { CatmaidSpatiallyIndexedSkeletonSourceBackend } from "#src/datasource/catmaid/backend.js";

describe("CatmaidSpatiallyIndexedSkeletonSourceBackend", () => {
  it("passes the source-associated CATMAID lod to node/list downloads", async () => {
    const signal = new AbortController().signal;
    const fetchNodes = vi.fn().mockResolvedValue([]);
    const source = Object.create(
      CatmaidSpatiallyIndexedSkeletonSourceBackend.prototype,
    );
    Object.defineProperties(source, {
      client: { value: { fetchNodes } },
      parameters: {
        value: {
          catmaidLod: 0.5,
          catmaidParameters: { cacheProvider: "cached_msgpack_grid" },
        },
      },
      spec: {
        value: {
          chunkDataSize: Float32Array.of(10, 20, 30),
        },
      },
    });
    const chunk = {
      chunkGridPosition: Float32Array.of(2, 3, 4),
    };

    await CatmaidSpatiallyIndexedSkeletonSourceBackend.prototype.download.call(
      source,
      chunk,
      signal,
    );

    expect(fetchNodes).toHaveBeenCalledWith(
      {
        lowerBounds: [20, 60, 120],
        upperBounds: [30, 80, 150],
      },
      0.5,
      {
        cacheProvider: "cached_msgpack_grid",
        signal,
      },
    );
  });
});
