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

export interface SpatialSkeletonToolPointInfo {
  nodeId: number;
  segmentId?: number;
  position?: ArrayLike<number>;
}

export interface SpatialSkeletonToolSummaryField {
  label: string;
  value: string;
  highlight?: boolean;
}

export interface SpatialSkeletonToolSummaryRow {
  fields: SpatialSkeletonToolSummaryField[];
}

export interface SpatialSkeletonToolStatusField {
  label: string;
  value: string;
}

export const SPATIAL_SKELETON_EDIT_BANNER_MESSAGE =
  "Move nodes, select a node to append or click to start a new skeleton";
export const SPATIAL_SKELETON_EDIT_SELECTED_BANNER_MESSAGE =
  "Move node or append to selected node";
export const SPATIAL_SKELETON_MERGE_BANNER_MESSAGE = "Select 2 nodes to merge";
export const SPATIAL_SKELETON_MERGE_SELECTED_BANNER_MESSAGE =
  "Select 2nd node from a different skeleton to merge with";
export const SPATIAL_SKELETON_SPLIT_BANNER_MESSAGE = "Select 1 node to split";

export function formatSpatialSkeletonToolPoint(
  point: SpatialSkeletonToolPointInfo,
) {
  return point.segmentId === undefined
    ? `Node ${point.nodeId}`
    : `Node ${point.nodeId}, segment ${point.segmentId}`;
}

export function getSpatialSkeletonToolPointSummaryRow(
  point: SpatialSkeletonToolPointInfo,
): SpatialSkeletonToolSummaryRow {
  const fields: SpatialSkeletonToolSummaryField[] = [
    {
      label: "Segment ID:",
      value: point.segmentId === undefined ? "-" : `${point.segmentId}`,
    },
    { label: "Node ID:", value: `${point.nodeId}` },
  ];
  const { position } = point;
  if (position !== undefined && position.length >= 3) {
    fields.push({
      label: "x",
      value: `${Math.round(Number(position[0]))}`,
      highlight: true,
    });
    fields.push({
      label: "y",
      value: `${Math.round(Number(position[1]))}`,
      highlight: true,
    });
    fields.push({
      label: "z",
      value: `${Math.round(Number(position[2]))}`,
      highlight: true,
    });
  }
  return { fields };
}

export function getSpatialSkeletonToolPointStatusFields(
  point: SpatialSkeletonToolPointInfo,
): SpatialSkeletonToolStatusField[] {
  const fields: SpatialSkeletonToolStatusField[] = [
    { label: "Node ID:", value: `${point.nodeId}` },
  ];
  if (point.segmentId !== undefined) {
    fields.push({ label: "Segment ID:", value: `${point.segmentId}` });
  }
  return fields;
}

export function getSpatialSkeletonEditBannerMessage(
  selectedPoint: SpatialSkeletonToolPointInfo | undefined,
) {
  return selectedPoint === undefined
    ? SPATIAL_SKELETON_EDIT_BANNER_MESSAGE
    : SPATIAL_SKELETON_EDIT_SELECTED_BANNER_MESSAGE;
}

export function getSpatialSkeletonMergeBannerMessage(
  selectedPoint: SpatialSkeletonToolPointInfo | undefined,
) {
  return selectedPoint === undefined
    ? SPATIAL_SKELETON_MERGE_BANNER_MESSAGE
    : SPATIAL_SKELETON_MERGE_SELECTED_BANNER_MESSAGE;
}
