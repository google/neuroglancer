import { describe, expect, it } from "vitest";

import {
  SPATIAL_SKELETON_EDIT_BANNER_MESSAGE,
  SPATIAL_SKELETON_EDIT_SELECTED_BANNER_MESSAGE,
  SPATIAL_SKELETON_MERGE_BANNER_MESSAGE,
  SPATIAL_SKELETON_MERGE_SELECTED_BANNER_MESSAGE,
  SPATIAL_SKELETON_SPLIT_BANNER_MESSAGE,
  formatSpatialSkeletonToolPoint,
  getSpatialSkeletonToolPointSummaryRow,
  getSpatialSkeletonToolPointStatusFields,
  getSpatialSkeletonEditBannerMessage,
  getSpatialSkeletonMergeBannerMessage,
} from "#src/ui/spatial_skeleton_tool_messages.js";

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

  it("switches edit banner copy when a node is selected", () => {
    expect(getSpatialSkeletonEditBannerMessage(undefined)).toBe(
      SPATIAL_SKELETON_EDIT_BANNER_MESSAGE,
    );
    expect(
      getSpatialSkeletonEditBannerMessage({ nodeId: 8, segmentId: 12 }),
    ).toBe(SPATIAL_SKELETON_EDIT_SELECTED_BANNER_MESSAGE);
  });

  it("switches merge banner copy after the first point is selected", () => {
    expect(getSpatialSkeletonMergeBannerMessage(undefined)).toBe(
      SPATIAL_SKELETON_MERGE_BANNER_MESSAGE,
    );
    expect(
      getSpatialSkeletonMergeBannerMessage({ nodeId: 8, segmentId: 12 }),
    ).toBe(SPATIAL_SKELETON_MERGE_SELECTED_BANNER_MESSAGE);
  });

  it("keeps the split banner copy stable", () => {
    expect(SPATIAL_SKELETON_SPLIT_BANNER_MESSAGE).toBe(
      "Select 1 node to split",
    );
  });
});
