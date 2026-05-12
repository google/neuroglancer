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
import {
  buildSpatiallyIndexedSkeletonNavigationGraph,
  getBranchEnd,
  getBranchStart,
  getChildNode,
  getFlatListNodeIds,
  getNextCollapsedLevelNode,
  getOpenLeaves,
  getParentNode,
  getSkeletonRootNode,
} from "#src/skeleton/navigation_graph.js";

function makeNode(
  nodeId: number,
  parentNodeId: number | undefined,
  options: {
    description?: string;
    isTrueEnd?: boolean;
  } = {},
): SpatiallyIndexedSkeletonNode {
  return {
    nodeId,
    segmentId: 42,
    position: new Float32Array([nodeId, nodeId + 0.5, nodeId + 1]),
    parentNodeId,
    description: options.description,
    isTrueEnd: options.isTrueEnd ?? false,
  };
}

describe("skeleton/navigation", () => {
  const graph = buildSpatiallyIndexedSkeletonNavigationGraph([
    makeNode(1, undefined),
    makeNode(2, 1),
    makeNode(3, 2),
    makeNode(4, 3),
    makeNode(5, 4, { description: "checkpoint" }),
    makeNode(6, 5),
    makeNode(7, 3),
    makeNode(8, 3),
    makeNode(9, 8),
    makeNode(10, 9, { isTrueEnd: true }),
    makeNode(11, 9),
  ]);

  it("finds the skeleton root and branch starts", () => {
    expect(getSkeletonRootNode(graph).nodeId).toBe(1);
    expect(getBranchStart(graph, 6).nodeId).toBe(3);
    expect(getBranchStart(graph, 3).nodeId).toBe(3);
    expect(getBranchStart(graph, 2).nodeId).toBe(2);
    expect(getBranchStart(graph, 1).nodeId).toBe(1);
  });

  it("prefers a downstream branch over a leaf for branch-end navigation", () => {
    const preferenceGraph = buildSpatiallyIndexedSkeletonNavigationGraph([
      makeNode(1, undefined),
      makeNode(2, 1),
      makeNode(3, 1),
      makeNode(4, 3),
      makeNode(5, 4),
      makeNode(6, 4),
    ]);

    expect(getBranchEnd(preferenceGraph, 1).nodeId).toBe(4);
    expect(getBranchEnd(preferenceGraph, 3).nodeId).toBe(4);
    expect(getBranchEnd(preferenceGraph, 2).nodeId).toBe(2);
  });

  it("orders flat-list rows in leaf-first pre-order", () => {
    const listGraph = buildSpatiallyIndexedSkeletonNavigationGraph([
      makeNode(1, undefined),
      makeNode(2, 1),
      makeNode(3, 1),
      makeNode(4, 1),
      makeNode(5, 2),
      makeNode(6, 4),
      makeNode(7, 4),
      makeNode(8, 1, { isTrueEnd: true }),
      makeNode(9, 8),
    ]);

    expect(getFlatListNodeIds(listGraph)).toEqual([1, 3, 8, 9, 4, 6, 7, 2, 5]);
  });

  it("orders flat-list rows by collapsed branches in leaf-first pre-order", () => {
    const listGraph = buildSpatiallyIndexedSkeletonNavigationGraph([
      makeNode(1, undefined),
      makeNode(2, 1),
      makeNode(3, 2),
      makeNode(4, 3),
      makeNode(5, 3),
      makeNode(6, 2),
      makeNode(7, 6),
    ]);

    expect(
      getFlatListNodeIds(listGraph, {
        collapseRegularNodesForOrdering: true,
      }),
    ).toEqual([1, 2, 6, 7, 3, 4, 5]);
  });

  it("keeps a branch adjacent to its own leaf-first descendants", () => {
    const listGraph = buildSpatiallyIndexedSkeletonNavigationGraph([
      makeNode(1, undefined),
      makeNode(2, 1),
      makeNode(3, 1),
      makeNode(4, 2),
      makeNode(5, 2),
      makeNode(6, 3),
      makeNode(7, 3),
    ]);

    expect(
      getFlatListNodeIds(listGraph, {
        collapseRegularNodesForOrdering: true,
      }),
    ).toEqual([1, 2, 4, 5, 3, 6, 7]);
  });

  it("returns deterministic direct parent and child navigation targets", () => {
    expect(getParentNode(graph, 6)?.nodeId).toBe(5);
    expect(getParentNode(graph, 1)).toBeUndefined();
    expect(getChildNode(graph, 3)?.nodeId).toBe(7);
    expect(getChildNode(graph, 11)).toBeUndefined();
  });

  it("cycles through collapsed-level nodes and skips regular nodes", () => {
    const collapsedGraph = buildSpatiallyIndexedSkeletonNavigationGraph([
      makeNode(1, undefined),
      makeNode(2, 1),
      makeNode(3, 2),
      makeNode(4, 1),
      makeNode(5, 1),
      makeNode(6, 4),
      makeNode(7, 4),
    ]);

    expect(getNextCollapsedLevelNode(collapsedGraph, 1).nodeId).toBe(1);
    expect(getNextCollapsedLevelNode(collapsedGraph, 2).nodeId).toBe(2);
    expect(getNextCollapsedLevelNode(collapsedGraph, 5).nodeId).toBe(4);
    expect(getNextCollapsedLevelNode(collapsedGraph, 4).nodeId).toBe(3);
    expect(getNextCollapsedLevelNode(collapsedGraph, 3).nodeId).toBe(5);
  });

  it("cycles collapsed-level nodes using collapsed leaf-first ordering", () => {
    const collapsedGraph = buildSpatiallyIndexedSkeletonNavigationGraph([
      makeNode(1, undefined),
      makeNode(2, 1),
      makeNode(3, 2),
      makeNode(4, 3),
      makeNode(5, 3),
      makeNode(6, 2),
      makeNode(7, 6),
    ]);

    expect(getNextCollapsedLevelNode(collapsedGraph, 6).nodeId).toBe(6);
    expect(getNextCollapsedLevelNode(collapsedGraph, 7).nodeId).toBe(3);
    expect(getNextCollapsedLevelNode(collapsedGraph, 3).nodeId).toBe(7);
  });

  it("finds unfinished leaves from any selected node and filters closed ends", () => {
    expect(
      getOpenLeaves(graph, 3).map((leaf) => [leaf.nodeId, leaf.distance]),
    ).toEqual([
      [7, 1],
      [6, 3],
      [11, 3],
    ]);
    expect(
      getOpenLeaves(graph, 1).map((leaf) => [leaf.nodeId, leaf.distance]),
    ).toEqual([
      [7, 3],
      [6, 5],
      [11, 5],
    ]);
  });
});
