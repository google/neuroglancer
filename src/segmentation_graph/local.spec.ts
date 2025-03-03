/**
 * @license
 * Copyright 2021 Google Inc.
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

import { LocalSegmentationGraphSource } from "#src/segmentation_graph/local.js";

describe("LocalSegmentationGraphSource", () => {
  it("merge", async () => {
    const graph = new LocalSegmentationGraphSource();
    {
      const mergeResult = await graph.merge(1n, 2n);
      expect(mergeResult).toEqual(1n);
      expect(graph.toJSON()).toEqual([["1", "2"]]);
    }
    {
      const mergeResult = await graph.merge(2n, 3n);
      expect(mergeResult).toEqual(1n);
      expect(graph.toJSON()).toEqual([
        ["1", "2"],
        ["2", "3"],
      ]);
    }
    {
      const mergeResult = await graph.merge(1n, 3n);
      expect(mergeResult).toEqual(1n);
      expect(graph.toJSON()).toEqual([
        ["1", "2"],
        ["2", "3"],
      ]);
    }
  });
  it("split", async () => {
    const graph = new LocalSegmentationGraphSource();
    graph.restoreState([
      ["1", "2"],
      ["2", "3"],
    ]);
    {
      expect(await graph.computeSplit(1n, 3n)).toEqual({
        includeBaseSegments: [1n, 2n],
        includeRepresentative: 1n,
        excludeBaseSegments: [3n],
        excludeRepresentative: 3n,
      });
    }
    {
      expect(await graph.split(1n, 3n)).toEqual({
        include: 1n,
        exclude: 3n,
      });
      expect(graph.toJSON()).toEqual([["1", "2"]]);
    }
  });
  it("split2", async () => {
    const graph = new LocalSegmentationGraphSource();
    graph.restoreState([
      ["1", "2"],
      ["2", "3"],
      ["3", "4"],
      ["3", "5"],
    ]);
    {
      expect(await graph.split(1n, 3n)).toEqual({
        include: 1n,
        exclude: 3n,
      });
      expect(graph.toJSON()).toEqual([
        ["1", "2"],
        ["3", "4"],
        ["3", "5"],
      ]);
    }
  });
});
