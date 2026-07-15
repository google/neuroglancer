import { describe, expect, it } from "vitest";

  getSpatialSkeletonDefaultStatusText,
  getSpatialSkeletonDeleteIdleStatusText,
  getSpatialSkeletonDeletingStatusText,
  getSpatialSkeletonMergeStatusText,
  getSpatialSkeletonMergingStatusText,
  getSpatialSkeletonMovingStatusText,
  getSpatialSkeletonSplitIdleStatusText,
  getSpatialSkeletonSplittingStatusText,
  getSpatialSkeletonToolPointSummaryRow,
import {
  ADD_NODE_ACTION,
  DELETE_ACTION,
  DELETE_CLICK_ACTION,
  EXIT_CREATE_ACTION,
  EXIT_DELETE_ACTION,
  EXIT_MERGE_ACTION,
  EXIT_SPLIT_ACTION,
  MERGE_ACTION,
  MOVE_ACTION,
  NEW_SKELETON_ACTION,
  PLACE_ACTION,
  SELECT_ACTION,
  SHOW_SKELETON_ACTION,
  SPATIAL_SKELETON_ROTATE_PAN_ACTION,
  SPLIT_ACTION,
} from "#src/ui/skeleton_edit_tool_shortcuts.js";

describe("spatial_skeleton_tool_messages", () => {
  it("formats tool points with node and segment ids", () => {
    expect(formatSpatialSkeletonToolPoint({ nodeId: 17, segmentId: 9 })).toBe(
      "Node 17, segment 9",
    );
    expect(formatSpatialSkeletonToolPoint({ nodeId: 17 })).toBe("Node 17");
    expect(
      getSpatialSkeletonToolPointStatusFields({
        nodeId: 17,
        segmentId: 9,
      }),
    ).toEqual([
      { label: "Node ID:", value: "17" },
      { label: "Segment ID:", value: "9" },
    ]);
    expect(getSpatialSkeletonToolPointStatusFields({ nodeId: 17 })).toEqual([
      { label: "Node ID:", value: "17" },
    ]);
    expect(
      getSpatialSkeletonToolPointSummaryRow({
        nodeId: 17,
        segmentId: 9,
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
        actions: [
          SELECT_ACTION,
          MOVE_ACTION,
          MERGE_ACTION,
          SPLIT_ACTION,
          NEW_SKELETON_ACTION,
          DELETE_ACTION,
          SPATIAL_SKELETON_ROTATE_PAN_ACTION,
        ],
      });
    });

    it("selected, visible skeleton", () => {
      expect(
        getSpatialSkeletonDefaultStatusText("selected-visible", false),
        actions: [
          SELECT_ACTION,
          MOVE_ACTION,
          ADD_NODE_ACTION,
          MERGE_ACTION,
          SPLIT_ACTION,
          NEW_SKELETON_ACTION,
          DELETE_ACTION,
          SPATIAL_SKELETON_ROTATE_PAN_ACTION,
        ],
      });
    });

    it("selected, visible skeleton, shift held", () => {
      expect(
        getSpatialSkeletonDefaultStatusText("selected-visible", true),
        actions: [
          SELECT_ACTION,
          MOVE_ACTION,
          ADD_NODE_ACTION,
          MERGE_ACTION,
          SPLIT_ACTION,
          NEW_SKELETON_ACTION,
          DELETE_ACTION,
          SPATIAL_SKELETON_ROTATE_PAN_ACTION,
        ],
      });
    });

    it("selected, non-visible skeleton", () => {
      expect(
        getSpatialSkeletonDefaultStatusText("selected-hidden", false),
        actions: [
          SHOW_SKELETON_ACTION,
          MERGE_ACTION,
          SPLIT_ACTION,
          NEW_SKELETON_ACTION,
          DELETE_ACTION,
          SPATIAL_SKELETON_ROTATE_PAN_ACTION,
        ],
      });
    });

    it("selected, non-visible skeleton, shift held — unaffected by shift", () => {
      expect(
        getSpatialSkeletonDefaultStatusText("selected-hidden", true),
        actions: [
          SHOW_SKELETON_ACTION,
          MERGE_ACTION,
          SPLIT_ACTION,
          NEW_SKELETON_ACTION,
          DELETE_ACTION,
          SPATIAL_SKELETON_ROTATE_PAN_ACTION,
        ],
      });
    });
  });

  it("returns a static moving-node status", () => {
      actions: [SPATIAL_SKELETON_ROTATE_PAN_ACTION],
    });
  });

  describe("getSpatialSkeletonMergeStatusText", () => {
    it("no from node, key held", () => {
        actions: [
          SELECT_ACTION,
          EXIT_MERGE_ACTION,
          SPATIAL_SKELETON_ROTATE_PAN_ACTION,
        ],
      });
    });

    it("no from node, key not held", () => {
        actions: [SELECT_ACTION, SPATIAL_SKELETON_ROTATE_PAN_ACTION],
      });
    });

    it("from node selected on a visible skeleton, key held", () => {
      expect(
        getSpatialSkeletonMergeStatusText("from-node-visible", true),
        actions: [
          SELECT_ACTION,
          EXIT_MERGE_ACTION,
          SPATIAL_SKELETON_ROTATE_PAN_ACTION,
        ],
      });
    });

    it("from node selected on a visible skeleton, key not held", () => {
      expect(
        getSpatialSkeletonMergeStatusText("from-node-visible", false),
        actions: [SELECT_ACTION, SPATIAL_SKELETON_ROTATE_PAN_ACTION],
      });
    });

    it("from node on a non-visible skeleton, key held", () => {
      expect(
        getSpatialSkeletonMergeStatusText("from-node-hidden", true),
        actions: [
          SHOW_SKELETON_ACTION,
          EXIT_MERGE_ACTION,
          SPATIAL_SKELETON_ROTATE_PAN_ACTION,
        ],
      });
    });

    it("from node on a non-visible skeleton, key not held", () => {
      expect(
        getSpatialSkeletonMergeStatusText("from-node-hidden", false),
        actions: [SHOW_SKELETON_ACTION, SPATIAL_SKELETON_ROTATE_PAN_ACTION],
      });
    });
  });

  it("returns a static merging status", () => {
      actions: [SPATIAL_SKELETON_ROTATE_PAN_ACTION],
    });
  });

  describe("getSpatialSkeletonSplitIdleStatusText", () => {
    it("key held", () => {
        actions: [
          SELECT_ACTION,
          EXIT_SPLIT_ACTION,
          SPATIAL_SKELETON_ROTATE_PAN_ACTION,
        ],
      });
    });

    it("key not held", () => {
        actions: [SELECT_ACTION, SPATIAL_SKELETON_ROTATE_PAN_ACTION],
      });
    });
  });

  it("returns a static splitting status", () => {
      actions: [SPATIAL_SKELETON_ROTATE_PAN_ACTION],
    });
  });

  describe("getSpatialSkeletonDeleteIdleStatusText", () => {
    it("key held", () => {
        actions: [
          DELETE_CLICK_ACTION,
          EXIT_DELETE_ACTION,
          SPATIAL_SKELETON_ROTATE_PAN_ACTION,
        ],
      });
    });

    it("key not held", () => {
        actions: [DELETE_CLICK_ACTION, SPATIAL_SKELETON_ROTATE_PAN_ACTION],
      });
    });
  });

  it("returns a static deleting status", () => {
      actions: [SPATIAL_SKELETON_ROTATE_PAN_ACTION],
    });
  });

  describe("getSpatialSkeletonCreateIdleStatusText", () => {
    it("key held", () => {
        actions: [
          PLACE_ACTION,
          EXIT_CREATE_ACTION,
          SPATIAL_SKELETON_ROTATE_PAN_ACTION,
        ],
      });
    });

    it("key not held", () => {
        actions: [PLACE_ACTION, SPATIAL_SKELETON_ROTATE_PAN_ACTION],
      });
    });
  });

  it("returns a static creating status", () => {
      actions: [SPATIAL_SKELETON_ROTATE_PAN_ACTION],
    });
  });
});
