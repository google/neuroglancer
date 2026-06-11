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

import type { SpatiallyIndexedSkeletonNode } from "#src/skeleton/api.js";
import { getSpatiallyIndexedSkeletonSubtreeNodes } from "#src/skeleton/node_traversal.js";

function makeNode(
  nodeId: number,
  parentNodeId?: number,
): SpatiallyIndexedSkeletonNode {
  return {
    nodeId,
    parentNodeId,
    segmentId: 1,
    position: new Float32Array([nodeId, 0, 0]),
  };
}

describe("getSpatiallyIndexedSkeletonSubtreeNodes", () => {
  it("returns the root and all descendants only", () => {
    const nodes = [
      makeNode(1),
      makeNode(2, 1),
      makeNode(3, 1),
      makeNode(4, 2),
      makeNode(5, 2),
      makeNode(6, 3),
    ];

    expect(
      getSpatiallyIndexedSkeletonSubtreeNodes(nodes, 2).map(
        (node) => node.nodeId,
      ),
    ).toEqual([2, 4, 5]);
  });

  it("handles leaf nodes", () => {
    const nodes = [makeNode(1), makeNode(2, 1)];

    expect(
      getSpatiallyIndexedSkeletonSubtreeNodes(nodes, 2).map(
        (node) => node.nodeId,
      ),
    ).toEqual([2]);
  });

  it("returns an empty list for missing roots", () => {
    expect(getSpatiallyIndexedSkeletonSubtreeNodes([makeNode(1)], 99)).toEqual(
      [],
    );
  });

  it("terminates on malformed cycles", () => {
    const nodes = [makeNode(1, 3), makeNode(2, 1), makeNode(3, 2)];

    expect(
      getSpatiallyIndexedSkeletonSubtreeNodes(nodes, 1).map(
        (node) => node.nodeId,
      ),
    ).toEqual([1, 2, 3]);
  });
});
