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
  getBranchStart,
  getChildNode,
  getFlatListNodeIds,
  getNextCollapsedLevelNode,
  getOpenLeaves,
  getParentNode,
  getPathBetweenNodes,
  getSkeletonRootNode,
} from "#src/skeleton/navigation_graph.js";

function makeNode(
  nodeId: bigint,
  parentNodeId: bigint | undefined,
  options: {
    description?: string;
    isTrueEnd?: boolean;
  } = {},
): SkeletonNode {
  return {
    nodeId,
    segmentId: 42n,
    position: new Float32Array([
      Number(nodeId),
      Number(nodeId) + 0.5,
      Number(nodeId) + 1,
    ]),
    parentNodeId,
    description: options.description,
    isTrueEnd: options.isTrueEnd ?? false,
  };
}

describe("skeleton/navigation", () => {
  const graph = buildSkeletonNavigationGraph([
    makeNode(1n, undefined),
    makeNode(2n, 1n),
    makeNode(3n, 2n),
    makeNode(4n, 3n),
    makeNode(5n, 4n, { description: "checkpoint" }),
    makeNode(6n, 5n),
    makeNode(7n, 3n),
    makeNode(8n, 3n),
    makeNode(9n, 8n),
    makeNode(10n, 9n, { isTrueEnd: true }),
    makeNode(11n, 9n),
  ]);

  it("finds the skeleton root and branch starts", () => {
    expect(getSkeletonRootNode(graph).nodeId).toBe(1n);
    expect(getBranchStart(graph, 6n).nodeId).toBe(3n);
    expect(getBranchStart(graph, 3n).nodeId).toBe(1n);
    expect(getBranchStart(graph, 2n).nodeId).toBe(1n);
    expect(getBranchStart(graph, 1n).nodeId).toBe(1n);
  });

  it("walks a degenerate, unbranched skeleton to the root", () => {
    const chainGraph = buildSkeletonNavigationGraph([
      makeNode(1n, undefined),
      makeNode(2n, 1n),
      makeNode(3n, 2n),
      makeNode(4n, 3n),
    ]);

    expect(getBranchStart(chainGraph, 4n).nodeId).toBe(1n);
    expect(getBranchStart(chainGraph, 3n).nodeId).toBe(1n);
    expect(getBranchStart(chainGraph, 2n).nodeId).toBe(1n);
    expect(getBranchStart(chainGraph, 1n).nodeId).toBe(1n);
  });

  it("walks past a branch point to the previous branch point or root", () => {
    const nestedForkGraph = buildSkeletonNavigationGraph([
      makeNode(1n, undefined),
      makeNode(2n, 1n),
      makeNode(3n, 2n),
      makeNode(4n, 2n),
      makeNode(5n, 3n),
      makeNode(6n, 3n),
    ]);

    expect(getBranchStart(nestedForkGraph, 6n).nodeId).toBe(3n);
    expect(getBranchStart(nestedForkGraph, 3n).nodeId).toBe(2n);
    expect(getBranchStart(nestedForkGraph, 2n).nodeId).toBe(1n);
    expect(getBranchStart(nestedForkGraph, 1n).nodeId).toBe(1n);
  });

  it("prefers a downstream branch over a leaf for branch-end navigation", () => {
    const preferenceGraph = buildSkeletonNavigationGraph([
      makeNode(1n, undefined),
      makeNode(2n, 1n),
      makeNode(3n, 1n),
      makeNode(4n, 3n),
      makeNode(5n, 4n),
      makeNode(6n, 4n),
    ]);

    expect(getBranchEnd(preferenceGraph, 1n).nodeId).toBe(4n);
    expect(getBranchEnd(preferenceGraph, 3n).nodeId).toBe(4n);
    expect(getBranchEnd(preferenceGraph, 2n).nodeId).toBe(2n);
  });

  it("randomly resolves ties between equally preferred branch-end candidates", () => {
    const tiedGraph = buildSkeletonNavigationGraph([
      makeNode(1n, undefined),
      makeNode(2n, 1n),
      makeNode(3n, 2n),
      makeNode(4n, 2n),
      makeNode(5n, 1n),
      makeNode(6n, 5n),
      makeNode(7n, 5n),
    ]);

    expect(getBranchEnd(tiedGraph, 1n, { random: () => 0 }).nodeId).toBe(2n);
    expect(getBranchEnd(tiedGraph, 1n, { random: () => 0.99 }).nodeId).toBe(5n);
  });

  it("orders flat-list rows in leaf-first pre-order", () => {
    const listGraph = buildSkeletonNavigationGraph([
      makeNode(1n, undefined),
      makeNode(2n, 1n),
      makeNode(3n, 1n),
      makeNode(4n, 1n),
      makeNode(5n, 2n),
      makeNode(6n, 4n),
      makeNode(7n, 4n),
      makeNode(8n, 1n, { isTrueEnd: true }),
      makeNode(9n, 8n),
    ]);

    expect(getFlatListNodeIds(listGraph)).toEqual([
      1n,
      3n,
      8n,
      9n,
      4n,
      6n,
      7n,
      2n,
      5n,
    ]);
  });

  it("orders flat-list rows by collapsed branches in leaf-first pre-order", () => {
    const listGraph = buildSkeletonNavigationGraph([
      makeNode(1n, undefined),
      makeNode(2n, 1n),
      makeNode(3n, 2n),
      makeNode(4n, 3n),
      makeNode(5n, 3n),
      makeNode(6n, 2n),
      makeNode(7n, 6n),
    ]);

    expect(
      getFlatListNodeIds(listGraph, {
        collapseRegularNodesForOrdering: true,
      }),
    ).toEqual([1n, 2n, 6n, 7n, 3n, 4n, 5n]);
  });

  it("keeps a branch adjacent to its own leaf-first descendants", () => {
    const listGraph = buildSkeletonNavigationGraph([
      makeNode(1n, undefined),
      makeNode(2n, 1n),
      makeNode(3n, 1n),
      makeNode(4n, 2n),
      makeNode(5n, 2n),
      makeNode(6n, 3n),
      makeNode(7n, 3n),
    ]);

    expect(
      getFlatListNodeIds(listGraph, {
        collapseRegularNodesForOrdering: true,
      }),
    ).toEqual([1n, 2n, 4n, 5n, 3n, 6n, 7n]);
  });

  it("returns deterministic direct parent and child navigation targets", () => {
    expect(getParentNode(graph, 6n)?.nodeId).toBe(5n);
    expect(getParentNode(graph, 1n)).toBeUndefined();
    expect(getChildNode(graph, 3n)?.nodeId).toBe(7n);
    expect(getChildNode(graph, 11n)).toBeUndefined();
  });

  describe("getPathBetweenNodes", () => {
    const getNodeIds = (path: ReturnType<typeof getPathBetweenNodes>) =>
      path?.map(({ nodeId }) => nodeId);

    it("returns endpoint-inclusive paths across direct edges and branches", () => {
      expect(getNodeIds(getPathBetweenNodes(graph, 5n, 6n))).toEqual([5n, 6n]);
      expect(getNodeIds(getPathBetweenNodes(graph, 6n, 7n))).toEqual([
        6n,
        5n,
        4n,
        3n,
        7n,
      ]);
    });

    it("finds the same route in reverse order", () => {
      expect(getNodeIds(getPathBetweenNodes(graph, 7n, 6n))).toEqual([
        7n,
        3n,
        4n,
        5n,
        6n,
      ]);
    });

    it("returns a singleton path only for an existing node", () => {
      const path = getPathBetweenNodes(graph, 3n, 3n);
      expect(getNodeIds(path)).toEqual([3n]);
      expect(path?.[0].position).toBe(graph.nodeById.get(3n)?.position);
      expect(getPathBetweenNodes(graph, 99n, 99n)).toBeUndefined();
    });

    it("returns undefined for missing or disconnected nodes", () => {
      const disconnectedGraph = buildSkeletonNavigationGraph([
        makeNode(1n, undefined),
        makeNode(2n, 1n),
        makeNode(3n, undefined),
        makeNode(4n, 3n),
      ]);

      expect(getPathBetweenNodes(disconnectedGraph, 1n, 99n)).toBeUndefined();
      expect(getPathBetweenNodes(disconnectedGraph, 99n, 1n)).toBeUndefined();
      expect(getPathBetweenNodes(disconnectedGraph, 1n, 4n)).toBeUndefined();
    });

    it("is cycle-safe and chooses deterministic shortest paths", () => {
      const cycleGraph = buildSkeletonNavigationGraph([
        makeNode(1n, 4n),
        makeNode(2n, 1n),
        makeNode(3n, 2n),
        makeNode(4n, 3n),
      ]);

      // Both 1-2-3 and 1-4-3 are shortest paths. Node 2 is visited first.
      expect(getNodeIds(getPathBetweenNodes(cycleGraph, 1n, 3n))).toEqual([
        1n,
        2n,
        3n,
      ]);
      // The ascending-neighbor tie break applies independently in reverse.
      expect(getNodeIds(getPathBetweenNodes(cycleGraph, 3n, 1n))).toEqual([
        3n,
        2n,
        1n,
      ]);
    });

    it("handles long chains iteratively", () => {
      const nodeCount = 10_000;
      const chainGraph = buildSkeletonNavigationGraph(
        Array.from({ length: nodeCount }, (_, index) =>
          makeNode(BigInt(index + 1), index === 0 ? undefined : BigInt(index)),
        ),
      );

      const path = getPathBetweenNodes(chainGraph, 1n, BigInt(nodeCount));
      expect(path).toHaveLength(nodeCount);
      expect(path?.[0].nodeId).toBe(1n);
      expect(path?.[nodeCount - 1].nodeId).toBe(BigInt(nodeCount));
    });
  });

  it("cycles through collapsed-level nodes and skips regular nodes", () => {
    const collapsedGraph = buildSkeletonNavigationGraph([
      makeNode(1n, undefined),
      makeNode(2n, 1n),
      makeNode(3n, 2n),
      makeNode(4n, 1n),
      makeNode(5n, 1n),
      makeNode(6n, 4n),
      makeNode(7n, 4n),
    ]);

    expect(getNextCollapsedLevelNode(collapsedGraph, 1n).nodeId).toBe(1n);
    expect(getNextCollapsedLevelNode(collapsedGraph, 2n).nodeId).toBe(2n);
    expect(getNextCollapsedLevelNode(collapsedGraph, 5n).nodeId).toBe(4n);
    expect(getNextCollapsedLevelNode(collapsedGraph, 4n).nodeId).toBe(3n);
    expect(getNextCollapsedLevelNode(collapsedGraph, 3n).nodeId).toBe(5n);
  });

  it("cycles collapsed-level nodes using collapsed leaf-first ordering", () => {
    const collapsedGraph = buildSkeletonNavigationGraph([
      makeNode(1n, undefined),
      makeNode(2n, 1n),
      makeNode(3n, 2n),
      makeNode(4n, 3n),
      makeNode(5n, 3n),
      makeNode(6n, 2n),
      makeNode(7n, 6n),
    ]);

    expect(getNextCollapsedLevelNode(collapsedGraph, 6n).nodeId).toBe(6n);
    expect(getNextCollapsedLevelNode(collapsedGraph, 7n).nodeId).toBe(3n);
    expect(getNextCollapsedLevelNode(collapsedGraph, 3n).nodeId).toBe(7n);
  });

  it("finds unfinished leaves from any selected node and filters closed ends", () => {
    expect(
      getOpenLeaves(graph, 3n).map((leaf) => [leaf.nodeId, leaf.distance]),
    ).toEqual([
      [7n, 1],
      [6n, 3],
      [11n, 3],
    ]);
    expect(
      getOpenLeaves(graph, 1n).map((leaf) => [leaf.nodeId, leaf.distance]),
    ).toEqual([
      [7n, 3],
      [6n, 5],
      [11n, 5],
    ]);
  });
});
