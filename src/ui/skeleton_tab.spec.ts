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
import type { SpatialSkeletonPreparationIntent } from "#src/skeleton/spatial_skeleton_manager.js";
import { buildSpatialSkeletonSegmentRenderState } from "#src/ui/skeleton_tab_render.js";

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

function stubWebGLContext() {
  const webglContextStub = new Proxy(
    {},
    {
      get: () => 0,
    },
  );
  (
    globalThis as { WebGL2RenderingContext?: unknown }
  ).WebGL2RenderingContext ??= webglContextStub;
}

async function getBuildSpatialSkeletonVirtualListItems() {
  stubWebGLContext();
  return (await import("#src/ui/skeleton_tab.js"))
    .buildSpatialSkeletonVirtualListItems;
}

async function getSpatialSkeletonEmptyListText() {
  stubWebGLContext();
  return (await import("#src/ui/skeleton_tab.js"))
    .getSpatialSkeletonEmptyListText;
}

async function getSpatialSkeletonDetailsPreparationState() {
  stubWebGLContext();
  return (await import("#src/ui/skeleton_tab.js"))
    .getSpatialSkeletonDetailsPreparationState;
}

async function getSpatialSkeletonNodeIdPresentation() {
  stubWebGLContext();
  return (await import("#src/ui/skeleton_tab.js"))
    .getSpatialSkeletonNodeIdPresentation;
}

function makePreparation(
  options: Partial<SpatialSkeletonPreparationIntent> = {},
): SpatialSkeletonPreparationIntent {
  return {
    intentId: 1,
    sequence: 1,
    direction: "execute",
    kind: "merge",
    lifecycle: "preparing",
    segmentIds: [20380],
    ...options,
  };
}

describe("spatial skeleton node id presentation", () => {
  it("replaces only a provisional node id with a Preview placeholder", async () => {
    const getNodeIdPresentation = await getSpatialSkeletonNodeIdPresentation();

    expect(getNodeIdPresentation(0x7fff_ffff, [0x7fff_ffff])).toEqual({
      label: "Preview",
      tooltip:
        "Preview node. The skeleton source has not yet confirmed its permanent node ID.",
      provisional: true,
    });
    expect(getNodeIdPresentation(42, [0x7fff_ffff])).toEqual({
      label: "42",
      tooltip: undefined,
      provisional: false,
    });
  });
});

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
      nodeFilterType: SpatialSkeletonNodeFilterType.DEFAULT,
      getNodeDescription() {
        return undefined;
      },
    });

    expect(state.matchedNodeCount).toBe(3);
    expect(state.displayedNodeCount).toBe(2);
    expect(state.branchCount).toBe(1);
    expect(state.rows.map((row) => row.node.nodeId)).toEqual([10, 12]);
  });

  it("shows all nodes including regular chain nodes when filter is None", () => {
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
    expect(state.displayedNodeCount).toBe(3);
    expect(state.rows.map((row) => row.node.nodeId)).toEqual([10, 11, 12]);
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
        nodeFilterType: SpatialSkeletonNodeFilterType.DEFAULT,
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

describe("spatial skeleton edit tab empty list text", () => {
  it("explains how to obtain node details when a hovered or selected skeleton has no complete details", async () => {
    const getEmptyListText = await getSpatialSkeletonEmptyListText();

    const text = getEmptyListText({
      activeSegmentId: undefined,
      selectedSegmentDetailsUnavailable: true,
      segmentState: undefined,
      filterText: "",
      nodeFilterType: SpatialSkeletonNodeFilterType.DEFAULT,
    });

    expect(text).toContain("show it in Seg or double-click one of its nodes");
    expect(text).toContain("allow its details to finish loading");
    expect(text).not.toMatch(/is selected|non-visible/i);
  });

  it("asks the user to hover over or select a node when there is no skeleton context", async () => {
    const getEmptyListText = await getSpatialSkeletonEmptyListText();

    const text = getEmptyListText({
      activeSegmentId: undefined,
      selectedSegmentDetailsUnavailable: false,
      segmentState: undefined,
      filterText: "",
      nodeFilterType: SpatialSkeletonNodeFilterType.DEFAULT,
    });

    expect(text).toBe(
      "Hover over or select a skeleton node to view its skeleton's nodes.",
    );
  });

  it("reports no loaded nodes for an active segment with no cached nodes, regardless of visibility", async () => {
    const getEmptyListText = await getSpatialSkeletonEmptyListText();

    const text = getEmptyListText({
      activeSegmentId: 20380,
      selectedSegmentDetailsUnavailable: false,
      segmentState: undefined,
      filterText: "",
      nodeFilterType: SpatialSkeletonNodeFilterType.DEFAULT,
    });

    expect(text).toBe("No loaded nodes.");
  });

  it("reports no matching nodes when a filter excludes all loaded nodes", async () => {
    const getEmptyListText = await getSpatialSkeletonEmptyListText();
    const graph = buildSpatiallyIndexedSkeletonNavigationGraph([
      makeNode(1, undefined),
    ]);
    const segmentState = {
      ...buildSpatialSkeletonSegmentRenderState(20380, graph, {
        filterText: "no-match",
        nodeFilterType: SpatialSkeletonNodeFilterType.DEFAULT,
        getNodeDescription() {
          return undefined;
        },
      }),
      segmentLabel: undefined,
    };

    const text = getEmptyListText({
      activeSegmentId: 20380,
      selectedSegmentDetailsUnavailable: false,
      segmentState,
      filterText: "no-match",
      nodeFilterType: SpatialSkeletonNodeFilterType.DEFAULT,
    });

    expect(text).toBe("No matching nodes.");
  });

  it("does not claim zero nodes while the complete preview is preparing", async () => {
    const getEmptyListText = await getSpatialSkeletonEmptyListText();

    const text = getEmptyListText({
      activeSegmentId: undefined,
      selectedSegmentDetailsUnavailable: true,
      segmentState: undefined,
      filterText: "",
      nodeFilterType: SpatialSkeletonNodeFilterType.DEFAULT,
      preparationActive: true,
    });

    expect(text).toBe("Preparing the complete skeleton preview…");
  });
});

describe("spatial skeleton edit tab preparation status", () => {
  it("shows the earliest overlapping preparation and counts only later overlapping edits", async () => {
    const getPreparationState =
      await getSpatialSkeletonDetailsPreparationState();
    const state = getPreparationState({
      preparations: [
        makePreparation({
          intentId: 3,
          sequence: 3,
          kind: "split",
          segmentIds: [20380],
        }),
        makePreparation({
          intentId: 1,
          sequence: 1,
          segmentIds: [20380, 20381],
        }),
        makePreparation({
          intentId: 2,
          sequence: 2,
          kind: "reroot",
          segmentIds: [999],
        }),
      ],
      selectedSegmentId: 20380,
      hasExactTopology: true,
    });

    expect(state?.preparation.intentId).toBe(1);
    expect(state?.statusText).toBe("Preparing merge preview…");
    expect(state?.laterEditCount).toBe(1);
    expect(state?.detailText).toMatch(/last complete skeleton/i);
    expect(state?.statusText).not.toContain("20380");
  });

  it("uses Undo wording and hides derived details until the split preview is exact", async () => {
    const getPreparationState =
      await getSpatialSkeletonDetailsPreparationState();
    const state = getPreparationState({
      preparations: [
        makePreparation({
          direction: "undo",
          kind: "split",
          segmentIds: [20380],
        }),
      ],
      selectedSegmentId: 20380,
      hasExactTopology: false,
    });

    expect(state?.statusText).toBe("Preparing Undo preview for split…");
    expect(state?.detailText).toBe("Preparing the complete skeleton preview…");
    expect(state?.controlsDisabledReason).toBe(
      "Available after the exact split preview finishes preparing.",
    );
  });

  it("uses Redo wording while the exact preview is preparing", async () => {
    const getPreparationState =
      await getSpatialSkeletonDetailsPreparationState();
    const state = getPreparationState({
      preparations: [
        makePreparation({
          direction: "redo",
          kind: "merge",
        }),
      ],
      selectedSegmentId: 20380,
      hasExactTopology: true,
    });

    expect(state?.statusText).toBe("Preparing Redo preview for merge…");
    expect(state?.controlsDisabledReason).toBe(
      "Available after the exact merge preview finishes preparing.",
    );
  });

  it("keeps status attached to logical selection when a physical merge alias changes", async () => {
    const getPreparationState =
      await getSpatialSkeletonDetailsPreparationState();
    const state = getPreparationState({
      preparations: [
        makePreparation({
          segmentIds: [20380],
          logicalSegmentHandles: [
            { kind: "segment", stableId: "segment:selected" },
          ],
        }),
      ],
      selectedSegmentId: 20381,
      selectedLogicalSegmentStableId: "segment:selected",
      hasExactTopology: true,
    });

    expect(state?.statusText).toBe("Preparing merge preview…");
  });
});
