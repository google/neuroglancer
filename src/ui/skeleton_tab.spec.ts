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
import type { SpatialSkeletonPendingEdit } from "#src/skeleton/edit/spatial_skeleton_edit_session.js";
import { buildSkeletonNavigationGraph } from "#src/skeleton/navigation_graph.js";
import { SkeletonNodeFilterType } from "#src/skeleton/node_types.js";
import {
  buildSkeletonSegmentRenderState,
  buildSkeletonVirtualListItems,
  getSkeletonEmptyListText,
  getSkeletonNodeIdPresentation,
  getSpatialSkeletonDetailsPreparationState,
} from "#src/ui/skeleton_tab_render.js";

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
    segmentId: 20380n,
    parentNodeId,
    position: new Float32Array([
      Number(nodeId),
      Number(nodeId) + 1,
      Number(nodeId) + 2,
    ]),
    description: options.description,
    ...(options.isTrueEnd ? { attributes: { true_end: [1] } } : {}),
  };
}

function makePendingEdit(
  options: Partial<SpatialSkeletonPendingEdit> = {},
): SpatialSkeletonPendingEdit {
  return {
    intentId: 1,
    sequence: 1,
    direction: "execute",
    kind: "merge",
    lifecycle: "preparing",
    segmentIds: [20380n],
    ...options,
  };
}

describe("spatial skeleton node id presentation", () => {
  it("replaces only a provisional node id with a Preview placeholder", () => {
    expect(
      getSkeletonNodeIdPresentation(2n ** 63n + 1n, [2n ** 63n + 1n]),
    ).toEqual({
      label: "Preview",
      tooltip:
        "Preview node. The skeleton source has not yet confirmed its permanent node ID.",
      provisional: true,
    });
    expect(getSkeletonNodeIdPresentation(42n, [2n ** 63n + 1n])).toEqual({
      label: "42",
      tooltip: undefined,
      provisional: false,
    });
  });
});

describe("spatial skeleton edit tab render state", () => {
  it("shows only directly matching nodes for text filtering", () => {
    const graph = buildSkeletonNavigationGraph([
      makeNode(1n, undefined),
      makeNode(2n, 1n),
      makeNode(3n, 2n),
      makeNode(4n, 2n),
    ]);

    const state = buildSkeletonSegmentRenderState(20380n, graph, {
      filterText: "target",
      nodeFilterType: SkeletonNodeFilterType.NONE,
      getNodeDescription(node) {
        return node.nodeId === 4n ? "target" : undefined;
      },
    });

    expect(state.matchedNodeCount).toBe(1);
    expect(state.displayedNodeCount).toBe(1);
    expect(state.branchCount).toBe(1);
    expect(state.rows.map((row) => row.node.nodeId)).toEqual([4n]);
  });

  it("does not match coordinates, segment ids, or true-end state in the search filter", () => {
    const graph = buildSkeletonNavigationGraph([
      makeNode(101n, undefined, { isTrueEnd: true }),
      makeNode(102n, 101n),
    ]);

    const byCoordinates = buildSkeletonSegmentRenderState(20380n, graph, {
      filterText: "101 102 103",
      nodeFilterType: SkeletonNodeFilterType.NONE,
      getNodeDescription() {
        return undefined;
      },
    });
    const bySegmentId = buildSkeletonSegmentRenderState(20380n, graph, {
      filterText: "20380",
      nodeFilterType: SkeletonNodeFilterType.NONE,
      getNodeDescription() {
        return undefined;
      },
    });
    const byTrueEndText = buildSkeletonSegmentRenderState(20380n, graph, {
      filterText: "true end",
      nodeFilterType: SkeletonNodeFilterType.NONE,
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
    const graph = buildSkeletonNavigationGraph([
      makeNode(10n, undefined),
      makeNode(11n, 10n),
      makeNode(12n, 11n),
    ]);

    const state = buildSkeletonSegmentRenderState(20380n, graph, {
      filterText: "",
      nodeFilterType: SkeletonNodeFilterType.DEFAULT,
      getNodeDescription() {
        return undefined;
      },
    });

    expect(state.matchedNodeCount).toBe(3);
    expect(state.displayedNodeCount).toBe(2);
    expect(state.branchCount).toBe(1);
    expect(state.rows.map((row) => row.node.nodeId)).toEqual([10n, 12n]);
  });

  it("shows all nodes including regular chain nodes when filter is None", () => {
    const graph = buildSkeletonNavigationGraph([
      makeNode(10n, undefined),
      makeNode(11n, 10n),
      makeNode(12n, 11n),
    ]);

    const state = buildSkeletonSegmentRenderState(20380n, graph, {
      filterText: "",
      nodeFilterType: SkeletonNodeFilterType.NONE,
      getNodeDescription() {
        return undefined;
      },
    });

    expect(state.matchedNodeCount).toBe(3);
    expect(state.displayedNodeCount).toBe(3);
    expect(state.rows.map((row) => row.node.nodeId)).toEqual([10n, 11n, 12n]);
  });

  it("treats node-type-only matches as disconnected visible branches", () => {
    const graph = buildSkeletonNavigationGraph([
      makeNode(20n, undefined),
      makeNode(21n, 20n),
      makeNode(22n, 20n),
    ]);

    const state = buildSkeletonSegmentRenderState(20380n, graph, {
      filterText: "",
      nodeFilterType: SkeletonNodeFilterType.VIRTUAL_END,
      getNodeDescription() {
        return undefined;
      },
    });

    expect(state.matchedNodeCount).toBe(2);
    expect(state.displayedNodeCount).toBe(2);
    expect(state.branchCount).toBe(2);
    expect(state.rows.map((row) => row.node.nodeId)).toEqual([21n, 22n]);
  });

  it("filters to nodes with non-empty descriptions", () => {
    const graph = buildSkeletonNavigationGraph([
      makeNode(30n, undefined),
      makeNode(31n, 30n),
      makeNode(32n, 30n),
      makeNode(33n, 30n),
    ]);

    const state = buildSkeletonSegmentRenderState(20380n, graph, {
      filterText: "",
      nodeFilterType: SkeletonNodeFilterType.HAS_DESCRIPTION,
      getNodeDescription(node) {
        switch (node.nodeId) {
          case 31n:
            return "has description";
          case 32n:
            return "";
          case 33n:
            return "   ";
          default:
            return undefined;
        }
      },
    });

    expect(state.matchedNodeCount).toBe(1);
    expect(state.displayedNodeCount).toBe(1);
    expect(state.branchCount).toBe(1);
    expect(state.rows.map((row) => row.node.nodeId)).toEqual([31n]);
  });
});

describe("spatial skeleton edit tab virtual list items", () => {
  it("lists the selected skeleton's row followed by its node rows", () => {
    const graph = buildSkeletonNavigationGraph([
      makeNode(1n, undefined),
      makeNode(2n, 1n),
      makeNode(3n, 2n),
    ]);
    const segmentState = {
      ...buildSkeletonSegmentRenderState(20380n, graph, {
        filterText: "",
        nodeFilterType: SkeletonNodeFilterType.DEFAULT,
        getNodeDescription() {
          return undefined;
        },
      }),
      segmentLabel: "selected segment",
    };

    const flattened = buildSkeletonVirtualListItems(segmentState, "empty");

    expect(flattened.items.map((item) => item.kind)).toEqual([
      "segment",
      "node",
      "node",
    ]);
    expect(
      flattened.items
        .filter((item) => item.kind === "node")
        .map((item) => item.row.node.nodeId),
    ).toEqual([1n, 3n]);
    expect(flattened.listIndexByNodeId.get(1n)).toBe(1);
    expect(flattened.listIndexByNodeId.get(3n)).toBe(2);
  });

  it("returns one empty row when no selected segment rows are available", () => {
    const flattened = buildSkeletonVirtualListItems(
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

  it("lists more than 10,000 nodes without truncating", () => {
    const leafCount = 10001;
    const nodes = [makeNode(1n, undefined)];
    for (let i = 0; i < leafCount; ++i) {
      nodes.push(makeNode(BigInt(i + 2), 1n));
    }
    const graph = buildSkeletonNavigationGraph(nodes);
    const segmentState = {
      ...buildSkeletonSegmentRenderState(20380n, graph, {
        filterText: "",
        nodeFilterType: SkeletonNodeFilterType.NONE,
        getNodeDescription() {
          return undefined;
        },
      }),
      segmentLabel: undefined,
    };

    const flattened = buildSkeletonVirtualListItems(segmentState, "empty");

    expect(segmentState.displayedNodeCount).toBeGreaterThan(10_000);
    expect(flattened.items.length).toBe(segmentState.displayedNodeCount + 1);
    expect(flattened.listIndexByNodeId.get(BigInt(leafCount + 1))).toBe(
      leafCount + 1,
    );
  });
});

describe("spatial skeleton edit tab empty list text", () => {
  it("explains how to obtain node details when a hovered or selected skeleton has no complete details", () => {
    const text = getSkeletonEmptyListText({
      activeSegmentId: undefined,
      selectedSegmentDetailsUnavailable: true,
      segmentState: undefined,
      filterText: "",
      nodeFilterType: SkeletonNodeFilterType.DEFAULT,
      hasPickableNodes: true,
    });

    expect(text).toContain("show it in Seg or double-click one of its nodes");
    expect(text).toContain("allow its details to finish loading");
    expect(text).not.toMatch(/is selected|non-visible/i);
  });

  it("asks the user to hover over or select a node when there is no skeleton context", () => {
    const text = getSkeletonEmptyListText({
      activeSegmentId: undefined,
      selectedSegmentDetailsUnavailable: false,
      segmentState: undefined,
      filterText: "",
      nodeFilterType: SkeletonNodeFilterType.DEFAULT,
      hasPickableNodes: true,
    });

    expect(text).toBe(
      "Hover over or select a skeleton node to view its skeleton's nodes.",
    );
  });

  it("reports no loaded nodes for an active segment with no cached nodes, regardless of visibility", () => {
    const text = getSkeletonEmptyListText({
      activeSegmentId: 20380n,
      selectedSegmentDetailsUnavailable: false,
      segmentState: undefined,
      filterText: "",
      nodeFilterType: SkeletonNodeFilterType.DEFAULT,
      hasPickableNodes: true,
    });

    expect(text).toBe("No loaded nodes.");
  });

  it("reports no matching nodes when a filter excludes all loaded nodes", () => {
    const graph = buildSkeletonNavigationGraph([makeNode(1n, undefined)]);
    const segmentState = {
      ...buildSkeletonSegmentRenderState(20380n, graph, {
        filterText: "no-match",
        nodeFilterType: SkeletonNodeFilterType.DEFAULT,
        getNodeDescription() {
          return undefined;
        },
      }),
      segmentLabel: undefined,
    };

    const text = getSkeletonEmptyListText({
      activeSegmentId: 20380n,
      selectedSegmentDetailsUnavailable: false,
      segmentState,
      filterText: "no-match",
      nodeFilterType: SkeletonNodeFilterType.DEFAULT,
      hasPickableNodes: true,
    });

    expect(text).toBe("No matching nodes.");
  });

  it("does not claim zero nodes while the complete preview is preparing", () => {
    const text = getSkeletonEmptyListText({
      activeSegmentId: undefined,
      selectedSegmentDetailsUnavailable: true,
      segmentState: undefined,
      filterText: "",
      nodeFilterType: SkeletonNodeFilterType.DEFAULT,
      preparationActive: true,
      hasPickableNodes: true,
    });

    expect(text).toBe("Preparing the complete skeleton preview…");
  });
});

describe("spatial skeleton edit tab preparation status", () => {
  it("shows the earliest overlapping preparation and counts only later overlapping edits", () => {
    const state = getSpatialSkeletonDetailsPreparationState({
      preparations: [
        makePendingEdit({
          intentId: 3,
          sequence: 3,
          kind: "split",
          segmentIds: [20380n],
        }),
        makePendingEdit({
          intentId: 1,
          sequence: 1,
          segmentIds: [20380n, 20381n],
        }),
        makePendingEdit({
          intentId: 2,
          sequence: 2,
          kind: "reroot",
          segmentIds: [999n],
        }),
      ],
      selectedSegmentId: 20380n,
      hasExactTopology: true,
    });

    expect(state?.preparation.intentId).toBe(1);
    expect(state?.statusText).toBe("Preparing merge preview…");
    expect(state?.laterEditCount).toBe(1);
    expect(state?.detailText).toMatch(/last complete skeleton/i);
    expect(state?.statusText).not.toContain("20380");
  });

  it("an Undo of a split says so and disables node controls until its preview is complete", () => {
    const state = getSpatialSkeletonDetailsPreparationState({
      preparations: [
        makePendingEdit({
          direction: "undo",
          kind: "split",
          segmentIds: [20380n],
        }),
      ],
      selectedSegmentId: 20380n,
      hasExactTopology: false,
    });

    expect(state?.statusText).toBe("Preparing Undo preview for split…");
    expect(state?.detailText).toBe("Preparing the complete skeleton preview…");
    expect(state?.controlsDisabledReason).toBe(
      "Available after the exact split preview finishes preparing.",
    );
  });

  it("a Redo says so and disables node controls until its preview is complete", () => {
    const state = getSpatialSkeletonDetailsPreparationState({
      preparations: [
        makePendingEdit({
          direction: "redo",
          kind: "merge",
        }),
      ],
      selectedSegmentId: 20380n,
      hasExactTopology: true,
    });

    expect(state?.statusText).toBe("Preparing Redo preview for merge…");
    expect(state?.controlsDisabledReason).toBe(
      "Available after the exact merge preview finishes preparing.",
    );
  });

  it("keeps the Preparing status on the selected skeleton after a merge changes its ID", () => {
    const state = getSpatialSkeletonDetailsPreparationState({
      preparations: [
        makePendingEdit({
          segmentIds: [20380n],
          stableSegmentHandles: [
            { kind: "segment", stableId: "segment:selected" },
          ],
        }),
      ],
      selectedSegmentId: 20381n,
      selectedSegmentStableId: "segment:selected",
      hasExactTopology: true,
    });

    expect(state?.statusText).toBe("Preparing merge preview…");
  });
});
