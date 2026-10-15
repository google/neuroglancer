import { describe, expect, it } from "vitest";

import {
  formatSpatialSkeletonToolPoint,
  getSpatialSkeletonCreateIdleStatusText,
  getSpatialSkeletonCreatingStatusText,
  getSpatialSkeletonDefaultStatusText,
  getSpatialSkeletonDeleteIdleStatusText,
  getSpatialSkeletonDeletingStatusText,
  getSpatialSkeletonInsertingStatusText,
  getSpatialSkeletonInsertStatusText,
  getSpatialSkeletonMergeStatusText,
  getSpatialSkeletonMergingStatusText,
  getSpatialSkeletonMovingStatusText,
  getSpatialSkeletonSplitIdleStatusText,
  getSpatialSkeletonSplittingStatusText,
  getSpatialSkeletonToolPointSummaryRow,
  getSpatialSkeletonToolPointStatusFields,
} from "#src/ui/skeleton_edit_tool_messages.js";
import { SKELETON_EDIT_SHORTCUTS } from "#src/ui/skeleton_edit_tool_shortcuts.js";

describe("spatial_skeleton_tool_messages", () => {
  it("formats tool points with node and segment ids", () => {
    expect(formatSpatialSkeletonToolPoint({ nodeId: 17n, segmentId: 9n })).toBe(
      "Node 17, segment 9",
    );
    expect(formatSpatialSkeletonToolPoint({ nodeId: 17n })).toBe("Node 17");
    expect(
      getSpatialSkeletonToolPointStatusFields({
        nodeId: 17n,
        segmentId: 9n,
      }),
    ).toEqual([
      { label: "Node ID:", value: "17" },
      { label: "Segment ID:", value: "9" },
    ]);
    expect(getSpatialSkeletonToolPointStatusFields({ nodeId: 17n })).toEqual([
      { label: "Node ID:", value: "17" },
    ]);
    expect(
      getSpatialSkeletonToolPointSummaryRow({
        nodeId: 17n,
        segmentId: 9n,
        position: [100.2, 200.7, 300.1],
      }),
    ).toEqual({
      fields: [
        { label: "Segment ID:", value: "9" },
        { label: "Node ID:", value: "17" },
        { label: "x", value: "100", highlight: true },
        { label: "y", value: "201", highlight: true },
        { label: "z", value: "300", highlight: true },
      ],
    });
  });

  describe("getSpatialSkeletonDefaultStatusText", () => {
    it("no selection", () => {
      expect(getSpatialSkeletonDefaultStatusText("none", false)).toEqual({
        status: "No selection",
        actions: [
          SKELETON_EDIT_SHORTCUTS.select,
          SKELETON_EDIT_SHORTCUTS.move,
          SKELETON_EDIT_SHORTCUTS.merge,
          SKELETON_EDIT_SHORTCUTS.insert,
          SKELETON_EDIT_SHORTCUTS.split,
          SKELETON_EDIT_SHORTCUTS.newSkeleton,
          SKELETON_EDIT_SHORTCUTS.deleteMode,
          SKELETON_EDIT_SHORTCUTS.rotatePan,
        ],
      });
    });

    it("selected, visible skeleton", () => {
      expect(
        getSpatialSkeletonDefaultStatusText("selected-visible", false),
      ).toEqual({
        status: "Node selected",
        actions: [
          SKELETON_EDIT_SHORTCUTS.select,
          SKELETON_EDIT_SHORTCUTS.move,
          SKELETON_EDIT_SHORTCUTS.addNode,
          SKELETON_EDIT_SHORTCUTS.merge,
          SKELETON_EDIT_SHORTCUTS.insert,
          SKELETON_EDIT_SHORTCUTS.split,
          SKELETON_EDIT_SHORTCUTS.newSkeleton,
          SKELETON_EDIT_SHORTCUTS.deleteMode,
          SKELETON_EDIT_SHORTCUTS.rotatePan,
        ],
      });
    });

    it("selected, visible skeleton, shift held", () => {
      expect(
        getSpatialSkeletonDefaultStatusText("selected-visible", true),
      ).toEqual({
        status: "Ready to place new node",
        actions: [
          SKELETON_EDIT_SHORTCUTS.select,
          SKELETON_EDIT_SHORTCUTS.move,
          SKELETON_EDIT_SHORTCUTS.addNode,
          SKELETON_EDIT_SHORTCUTS.merge,
          SKELETON_EDIT_SHORTCUTS.insert,
          SKELETON_EDIT_SHORTCUTS.split,
          SKELETON_EDIT_SHORTCUTS.newSkeleton,
          SKELETON_EDIT_SHORTCUTS.deleteMode,
          SKELETON_EDIT_SHORTCUTS.rotatePan,
        ],
      });
    });

    it("selected, non-visible skeleton", () => {
      expect(
        getSpatialSkeletonDefaultStatusText("selected-hidden", false),
      ).toEqual({
        status: "Node selected from non-visible skeleton",
        actions: [
          SKELETON_EDIT_SHORTCUTS.show,
          SKELETON_EDIT_SHORTCUTS.merge,
          SKELETON_EDIT_SHORTCUTS.insert,
          SKELETON_EDIT_SHORTCUTS.split,
          SKELETON_EDIT_SHORTCUTS.newSkeleton,
          SKELETON_EDIT_SHORTCUTS.deleteMode,
          SKELETON_EDIT_SHORTCUTS.rotatePan,
        ],
      });
    });

    it("selected, non-visible skeleton, shift held — unaffected by shift", () => {
      expect(
        getSpatialSkeletonDefaultStatusText("selected-hidden", true),
      ).toEqual({
        status: "Node selected from non-visible skeleton",
        actions: [
          SKELETON_EDIT_SHORTCUTS.show,
          SKELETON_EDIT_SHORTCUTS.merge,
          SKELETON_EDIT_SHORTCUTS.insert,
          SKELETON_EDIT_SHORTCUTS.split,
          SKELETON_EDIT_SHORTCUTS.newSkeleton,
          SKELETON_EDIT_SHORTCUTS.deleteMode,
          SKELETON_EDIT_SHORTCUTS.rotatePan,
        ],
      });
    });
  });

  it("returns a static moving-node status", () => {
    expect(getSpatialSkeletonMovingStatusText()).toEqual({
      status: "Moving node",
      actions: [SKELETON_EDIT_SHORTCUTS.rotatePan],
    });
  });

  describe("getSpatialSkeletonInsertStatusText", () => {
    it("no first node, key held", () => {
      expect(getSpatialSkeletonInsertStatusText("no-first-node", true)).toEqual(
        {
          status: "Insert · click the first node",
          actions: [
            SKELETON_EDIT_SHORTCUTS.select,
            SKELETON_EDIT_SHORTCUTS.exitInsert,
            SKELETON_EDIT_SHORTCUTS.rotatePan,
          ],
        },
      );
    });

    it("first node picked, key not held", () => {
      expect(
        getSpatialSkeletonInsertStatusText("first-node-picked", false),
      ).toEqual({
        status: "Insert · click the parent or a child of the first node",
        actions: [
          SKELETON_EDIT_SHORTCUTS.select,
          SKELETON_EDIT_SHORTCUTS.rotatePan,
        ],
      });
    });
  });

  it("getSpatialSkeletonInsertingStatusText", () => {
    expect(getSpatialSkeletonInsertingStatusText()).toEqual({
      status: "Insert · inserting node…",
      actions: [SKELETON_EDIT_SHORTCUTS.rotatePan],
    });
  });

  describe("getSpatialSkeletonMergeStatusText", () => {
    it("no from node, key held", () => {
      expect(getSpatialSkeletonMergeStatusText("no-from-node", true)).toEqual({
        status: "Merge · click a node to merge from",
        actions: [
          SKELETON_EDIT_SHORTCUTS.select,
          SKELETON_EDIT_SHORTCUTS.exitMerge,
          SKELETON_EDIT_SHORTCUTS.rotatePan,
        ],
      });
    });

    it("no from node, key not held", () => {
      expect(getSpatialSkeletonMergeStatusText("no-from-node", false)).toEqual({
        status: "Merge · click a node to merge from",
        actions: [
          SKELETON_EDIT_SHORTCUTS.select,
          SKELETON_EDIT_SHORTCUTS.rotatePan,
        ],
      });
    });

    it("from node selected on a visible skeleton, key held", () => {
      expect(
        getSpatialSkeletonMergeStatusText("from-node-visible", true),
      ).toEqual({
        status: "Merge · click a node to merge to",
        actions: [
          SKELETON_EDIT_SHORTCUTS.select,
          SKELETON_EDIT_SHORTCUTS.exitMerge,
          SKELETON_EDIT_SHORTCUTS.rotatePan,
        ],
      });
    });

    it("from node selected on a visible skeleton, key not held", () => {
      expect(
        getSpatialSkeletonMergeStatusText("from-node-visible", false),
      ).toEqual({
        status: "Merge · click a node to merge to",
        actions: [
          SKELETON_EDIT_SHORTCUTS.select,
          SKELETON_EDIT_SHORTCUTS.rotatePan,
        ],
      });
    });

    it("from node on a non-visible skeleton, key held", () => {
      expect(
        getSpatialSkeletonMergeStatusText("from-node-hidden", true),
      ).toEqual({
        status: "Merge · make the from-node skeleton visible",
        actions: [
          SKELETON_EDIT_SHORTCUTS.show,
          SKELETON_EDIT_SHORTCUTS.exitMerge,
          SKELETON_EDIT_SHORTCUTS.rotatePan,
        ],
      });
    });

    it("from node on a non-visible skeleton, key not held", () => {
      expect(
        getSpatialSkeletonMergeStatusText("from-node-hidden", false),
      ).toEqual({
        status: "Merge · make the from-node skeleton visible",
        actions: [
          SKELETON_EDIT_SHORTCUTS.show,
          SKELETON_EDIT_SHORTCUTS.rotatePan,
        ],
      });
    });
  });

  it("returns a static merging status", () => {
    expect(getSpatialSkeletonMergingStatusText()).toEqual({
      status: "Merge · merging nodes…",
      actions: [SKELETON_EDIT_SHORTCUTS.rotatePan],
    });
  });

  describe("getSpatialSkeletonSplitIdleStatusText", () => {
    it("key held", () => {
      expect(getSpatialSkeletonSplitIdleStatusText(true)).toEqual({
        status: "Split · click a node to form the root of a new skeleton",
        actions: [
          SKELETON_EDIT_SHORTCUTS.select,
          SKELETON_EDIT_SHORTCUTS.exitSplit,
          SKELETON_EDIT_SHORTCUTS.rotatePan,
        ],
      });
    });

    it("key not held", () => {
      expect(getSpatialSkeletonSplitIdleStatusText(false)).toEqual({
        status: "Split · click a node to form the root of a new skeleton",
        actions: [
          SKELETON_EDIT_SHORTCUTS.select,
          SKELETON_EDIT_SHORTCUTS.rotatePan,
        ],
      });
    });
  });

  it("returns a static splitting status", () => {
    expect(getSpatialSkeletonSplittingStatusText()).toEqual({
      status: "Split · splitting node…",
      actions: [SKELETON_EDIT_SHORTCUTS.rotatePan],
    });
  });

  describe("getSpatialSkeletonDeleteIdleStatusText", () => {
    it("key held", () => {
      expect(getSpatialSkeletonDeleteIdleStatusText(true)).toEqual({
        status: "Delete · no selected nodes",
        actions: [
          SKELETON_EDIT_SHORTCUTS.deleteNode,
          SKELETON_EDIT_SHORTCUTS.exitDelete,
          SKELETON_EDIT_SHORTCUTS.rotatePan,
        ],
      });
    });

    it("key not held", () => {
      expect(getSpatialSkeletonDeleteIdleStatusText(false)).toEqual({
        status: "Delete · no selected nodes",
        actions: [
          SKELETON_EDIT_SHORTCUTS.deleteNode,
          SKELETON_EDIT_SHORTCUTS.rotatePan,
        ],
      });
    });
  });

  it("returns a static deleting status", () => {
    expect(getSpatialSkeletonDeletingStatusText()).toEqual({
      status: "Delete · deleting node…",
      actions: [SKELETON_EDIT_SHORTCUTS.rotatePan],
    });
  });

  describe("getSpatialSkeletonCreateIdleStatusText", () => {
    it("key held", () => {
      expect(getSpatialSkeletonCreateIdleStatusText(true)).toEqual({
        status: "Create · ready to place",
        actions: [
          SKELETON_EDIT_SHORTCUTS.place,
          SKELETON_EDIT_SHORTCUTS.exitCreate,
          SKELETON_EDIT_SHORTCUTS.rotatePan,
        ],
      });
    });

    it("key not held", () => {
      expect(getSpatialSkeletonCreateIdleStatusText(false)).toEqual({
        status: "Create · ready to place",
        actions: [
          SKELETON_EDIT_SHORTCUTS.place,
          SKELETON_EDIT_SHORTCUTS.rotatePan,
        ],
      });
    });
  });

  it("returns a static creating status", () => {
    expect(getSpatialSkeletonCreatingStatusText()).toEqual({
      status: "Create · creating skeleton…",
      actions: [SKELETON_EDIT_SHORTCUTS.rotatePan],
    });
  });
});
