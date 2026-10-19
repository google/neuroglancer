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

import type { SkeletonNode } from "#src/skeleton/api.js";
import {
  buildSkeletonNavigationGraph,
  getBranchEnd,
  getSkeletonRootNode,
} from "#src/skeleton/navigation_graph.js";
import { getSkeletonChunkNodes } from "#src/skeleton/skeleton_chunk_nodes.js";

function makePackedSkeletonChunk(
  positions: readonly (readonly number[])[],
  edges: readonly (readonly [number, number])[],
) {
  return {
    numVertices: positions.length,
    vertexAttributes: new Uint8Array(new Float32Array(positions.flat()).buffer),
    vertexAttributeOffsets: new Uint32Array([0]),
    indices: new Uint32Array(edges.flat()),
  };
}

function getParentNodeIds(nodes: readonly SkeletonNode[]) {
  return nodes.map((node) => [node.nodeId, node.parentNodeId]);
}

describe("skeleton nodes from a chunk", () => {
  it("infers parents from the lowest vertex even when the stored edges form a tree", () => {
    const chunk = makePackedSkeletonChunk(
      [
        [0, 0, 0],
        [10, 0, 0],
        [20, 0, 0],
      ],
      [
        [2, 1],
        [1, 0],
      ],
    );

    const nodes = getSkeletonChunkNodes(7n, chunk);

    expect(getParentNodeIds(nodes)).toEqual([
      [0n, undefined],
      [1n, 0n],
      [2n, 1n],
    ]);
  });

  it("goes to a root and along a branch of a skeleton with a loop and two separate parts", () => {
    const chunk = makePackedSkeletonChunk(
      [
        [0, 0, 0],
        [10, 0, 0],
        [20, 0, 0],
        [100, 0, 0],
        [110, 0, 0],
      ],
      [
        [0, 1],
        [1, 2],
        [2, 0],
        [3, 4],
      ],
    );

    const graph = buildSkeletonNavigationGraph(
      getSkeletonChunkNodes(7n, chunk),
    );

    expect(graph.rootNodeIds).toEqual([0n, 3n]);
    expect(getSkeletonRootNode(graph).nodeId).toBe(0n);
    expect(getBranchEnd(graph, 4n).nodeId).toBe(4n);
  });

  it("ignores an edge to a vertex that the skeleton does not have", () => {
    const chunk = makePackedSkeletonChunk(
      [
        [0, 0, 0],
        [10, 0, 0],
      ],
      [
        [0, 1],
        [1, 5],
      ],
    );

    expect(getParentNodeIds(getSkeletonChunkNodes(7n, chunk))).toEqual([
      [0n, undefined],
      [1n, 0n],
    ]);
  });

  it("infers parents from the lowest vertex when the edges have no direction", () => {
    const chunk = makePackedSkeletonChunk(
      [
        [0, 0, 0],
        [10, 0, 0],
        [20, 0, 0],
      ],
      [
        [0, 2],
        [1, 2],
      ],
    );

    const nodes = getSkeletonChunkNodes(7n, chunk);

    expect(getParentNodeIds(nodes)).toEqual([
      [0n, undefined],
      [1n, 2n],
      [2n, 0n],
    ]);
  });

  it("cuts a loop in the edges so that branch navigation ends", () => {
    const chunk = makePackedSkeletonChunk(
      [
        [0, 0, 0],
        [10, 0, 0],
        [20, 0, 0],
      ],
      [
        [0, 1],
        [1, 2],
        [2, 0],
      ],
    );

    const nodes = getSkeletonChunkNodes(7n, chunk);

    expect(getParentNodeIds(nodes)).toEqual([
      [0n, undefined],
      [1n, 0n],
      [2n, 0n],
    ]);
    expect(getBranchEnd(buildSkeletonNavigationGraph(nodes), 1n).nodeId).toBe(
      1n,
    );
  });
});
