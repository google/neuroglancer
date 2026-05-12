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
import { buildSpatiallyIndexedSkeletonNavigationGraph } from "#src/skeleton/navigation_graph.js";
import { SpatialSkeletonNodeFilterType } from "#src/skeleton/node_types.js";
import { buildSpatialSkeletonSegmentRenderState } from "#src/ui/spatial_skeleton_edit_tab_render_state.js";

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
    segmentId: 20380,
    parentNodeId,
    position: new Float32Array([nodeId, nodeId + 1, nodeId + 2]),
    description: options.description,
    isTrueEnd: options.isTrueEnd ?? false,
  };
}

async function getBuildSpatialSkeletonVirtualListItems() {
  const webglContextStub = new Proxy(
    {},
    {
      get: () => 0,
    },
  );
  (
    globalThis as { WebGL2RenderingContext?: unknown }
  ).WebGL2RenderingContext ??= webglContextStub;
  return (await import("#src/ui/spatial_skeleton_edit_tab.js"))
    .buildSpatialSkeletonVirtualListItems;
}

describe("spatial skeleton edit tab render state", () => {
  it("shows only directly matching nodes for text filtering", () => {
    const graph = buildSpatiallyIndexedSkeletonNavigationGraph([
      makeNode(1, undefined),
      makeNode(2, 1),
      makeNode(3, 2),
      makeNode(4, 2),
    ]);

    const state = buildSpatialSkeletonSegmentRenderState(20380, graph, {
      filterText: "target",
      nodeFilterType: SpatialSkeletonNodeFilterType.NONE,
      getNodeDescription(node) {
        return node.nodeId === 4 ? "target" : undefined;
      },
    });

    expect(state.matchedNodeCount).toBe(1);
    expect(state.displayedNodeCount).toBe(1);
    expect(state.branchCount).toBe(1);
    expect(state.rows.map((row) => row.node.nodeId)).toEqual([4]);
  });

  it("does not match coordinates, segment ids, or true-end state in the search filter", () => {
    const graph = buildSpatiallyIndexedSkeletonNavigationGraph([
      makeNode(101, undefined, { isTrueEnd: true }),
      makeNode(102, 101),
    ]);

    const byCoordinates = buildSpatialSkeletonSegmentRenderState(20380, graph, {
      filterText: "101 102 103",
      nodeFilterType: SpatialSkeletonNodeFilterType.NONE,
      getNodeDescription() {
        return undefined;
      },
    });
    const bySegmentId = buildSpatialSkeletonSegmentRenderState(20380, graph, {
      filterText: "20380",
      nodeFilterType: SpatialSkeletonNodeFilterType.NONE,
      getNodeDescription() {
        return undefined;
      },
    });
    const byTrueEndText = buildSpatialSkeletonSegmentRenderState(20380, graph, {
      filterText: "true end",
      nodeFilterType: SpatialSkeletonNodeFilterType.NONE,
      getNodeDescription() {
        return undefined;
      },
    });

    expect(byCoordinates.matchedNodeCount).toBe(0);
    expect(byCoordinates.displayedNodeCount).toBe(0);
    expect(bySegmentId.matchedNodeCount).toBe(0);
    expect(bySegmentId.displayedNodeCount).toBe(0);
    expect(byTrueEndText.matchedNodeCount).toBe(0);
    expect(byTrueEndText.displayedNodeCount).toBe(0);
  });

  it("counts hidden regular nodes in the ratio while omitting them from collapsed rows", () => {
    const graph = buildSpatiallyIndexedSkeletonNavigationGraph([
      makeNode(10, undefined),
      makeNode(11, 10),
      makeNode(12, 11),
    ]);

    const state = buildSpatialSkeletonSegmentRenderState(20380, graph, {
      filterText: "",
      nodeFilterType: SpatialSkeletonNodeFilterType.NONE,
      getNodeDescription() {
        return undefined;
      },
    });

    expect(state.matchedNodeCount).toBe(3);
    expect(state.displayedNodeCount).toBe(2);
    expect(state.branchCount).toBe(1);
    expect(state.rows.map((row) => row.node.nodeId)).toEqual([10, 12]);
  });

  it("treats node-type-only matches as disconnected visible branches", () => {
    const graph = buildSpatiallyIndexedSkeletonNavigationGraph([
      makeNode(20, undefined),
      makeNode(21, 20),
      makeNode(22, 20),
    ]);

    const state = buildSpatialSkeletonSegmentRenderState(20380, graph, {
      filterText: "",
      nodeFilterType: SpatialSkeletonNodeFilterType.VIRTUAL_END,
      getNodeDescription() {
        return undefined;
      },
    });

    expect(state.matchedNodeCount).toBe(2);
    expect(state.displayedNodeCount).toBe(2);
    expect(state.branchCount).toBe(2);
    expect(state.rows.map((row) => row.node.nodeId)).toEqual([21, 22]);
  });

  it("filters to nodes with non-empty descriptions", () => {
    const graph = buildSpatiallyIndexedSkeletonNavigationGraph([
      makeNode(30, undefined),
      makeNode(31, 30),
      makeNode(32, 30),
      makeNode(33, 30),
    ]);

    const state = buildSpatialSkeletonSegmentRenderState(20380, graph, {
      filterText: "",
      nodeFilterType: SpatialSkeletonNodeFilterType.HAS_DESCRIPTION,
      getNodeDescription(node) {
        switch (node.nodeId) {
          case 31:
            return "has description";
          case 32:
            return "";
          case 33:
            return "   ";
          default:
            return undefined;
        }
      },
    });

    expect(state.matchedNodeCount).toBe(1);
    expect(state.displayedNodeCount).toBe(1);
    expect(state.branchCount).toBe(1);
    expect(state.rows.map((row) => row.node.nodeId)).toEqual([31]);
  });
});

describe("spatial skeleton edit tab virtual list items", () => {
  it("flattens one selected segment and its displayed node rows", async () => {
    const buildSpatialSkeletonVirtualListItems =
      await getBuildSpatialSkeletonVirtualListItems();
    const graph = buildSpatiallyIndexedSkeletonNavigationGraph([
      makeNode(1, undefined),
      makeNode(2, 1),
      makeNode(3, 2),
    ]);
    const segmentState = {
      ...buildSpatialSkeletonSegmentRenderState(20380, graph, {
        filterText: "",
        nodeFilterType: SpatialSkeletonNodeFilterType.NONE,
        getNodeDescription() {
          return undefined;
        },
      }),
      segmentLabel: "selected segment",
    };

    const flattened = buildSpatialSkeletonVirtualListItems(
      segmentState,
      "empty",
    );

    expect(flattened.items.map((item) => item.kind)).toEqual([
      "segment",
      "node",
      "node",
    ]);
    expect(
      flattened.items
        .filter((item) => item.kind === "node")
        .map((item) => item.row.node.nodeId),
    ).toEqual([1, 3]);
    expect(flattened.listIndexByNodeId.get(1)).toBe(1);
    expect(flattened.listIndexByNodeId.get(3)).toBe(2);
  });

  it("returns one empty row when no selected segment rows are available", async () => {
    const buildSpatialSkeletonVirtualListItems =
      await getBuildSpatialSkeletonVirtualListItems();

    const flattened = buildSpatialSkeletonVirtualListItems(
      undefined,
      "Select a skeleton segment to inspect editable nodes.",
    );

    expect(flattened.items).toEqual([
      {
        kind: "empty",
        text: "Select a skeleton segment to inspect editable nodes.",
      },
    ]);
    expect(flattened.listIndexByNodeId.size).toBe(0);
  });

  it("keeps more than 10,000 displayed rows in the virtual source items", async () => {
    const buildSpatialSkeletonVirtualListItems =
      await getBuildSpatialSkeletonVirtualListItems();
    const leafCount = 10001;
    const nodes = [makeNode(1, undefined)];
    for (let i = 0; i < leafCount; ++i) {
      nodes.push(makeNode(i + 2, 1));
    }
    const graph = buildSpatiallyIndexedSkeletonNavigationGraph(nodes);
    const segmentState = {
      ...buildSpatialSkeletonSegmentRenderState(20380, graph, {
        filterText: "",
        nodeFilterType: SpatialSkeletonNodeFilterType.NONE,
        getNodeDescription() {
          return undefined;
        },
      }),
      segmentLabel: undefined,
    };

    const flattened = buildSpatialSkeletonVirtualListItems(
      segmentState,
      "empty",
    );

    expect(segmentState.displayedNodeCount).toBeGreaterThan(10_000);
    expect(flattened.items.length).toBe(segmentState.displayedNodeCount + 1);
    expect(flattened.listIndexByNodeId.get(leafCount + 1)).toBe(leafCount + 1);
  });
});
