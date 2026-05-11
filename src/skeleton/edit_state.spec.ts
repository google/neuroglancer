import { describe, expect, it } from "vitest";

import type { SpatiallyIndexedSkeletonNode } from "#src/skeleton/api.js";
import { getSpatiallyIndexedSkeletonSubtreeNodes } from "#src/skeleton/edit_state.js";

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
