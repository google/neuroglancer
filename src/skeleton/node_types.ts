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

import type { SpatiallyIndexedSkeletonNode } from "#src/skeleton/api.js";

export enum SpatialSkeletonDisplayNodeType {
  ROOT = "root",
  BRANCH_START = "branchStart",
  REGULAR = "regular",
  VIRTUAL_END = "virtualEnd",
}

export enum SpatialSkeletonNodeFilterType {
  NONE,
  LEAF,
  VIRTUAL_END,
  TRUE_END,
  HAS_DESCRIPTION,
}

export function classifySpatialSkeletonDisplayNodeType(
  node: SpatiallyIndexedSkeletonNode,
  childCount: number | undefined,
  parentInTree = true,
): SpatialSkeletonDisplayNodeType {
  if (node.parentNodeId === undefined || !parentInTree) {
    return SpatialSkeletonDisplayNodeType.ROOT;
  }
  if (childCount === undefined) {
    return SpatialSkeletonDisplayNodeType.REGULAR;
  }
  if (childCount > 1) {
    return SpatialSkeletonDisplayNodeType.BRANCH_START;
  }
  if (childCount === 0) {
    return SpatialSkeletonDisplayNodeType.VIRTUAL_END;
  }
  return SpatialSkeletonDisplayNodeType.REGULAR;
}

export function getSpatialSkeletonNodeFilterLabel(
  filterType: SpatialSkeletonNodeFilterType,
) {
  switch (filterType) {
    case SpatialSkeletonNodeFilterType.NONE:
      return "None";
    case SpatialSkeletonNodeFilterType.LEAF:
      return "Leaf";
    case SpatialSkeletonNodeFilterType.VIRTUAL_END:
      return "Virtual end";
    case SpatialSkeletonNodeFilterType.TRUE_END:
      return "True end";
    case SpatialSkeletonNodeFilterType.HAS_DESCRIPTION:
      return "Has description";
  }
}

export function matchesSpatialSkeletonNodeFilter(
  filterType: SpatialSkeletonNodeFilterType,
  options: {
    isLeaf: boolean;
    nodeHasDescription: boolean;
    nodeIsTrueEnd: boolean;
    nodeType: SpatialSkeletonDisplayNodeType;
  },
) {
  switch (filterType) {
    case SpatialSkeletonNodeFilterType.NONE:
      return true;
    case SpatialSkeletonNodeFilterType.LEAF:
      return options.isLeaf;
    case SpatialSkeletonNodeFilterType.VIRTUAL_END:
      return options.isLeaf && !options.nodeIsTrueEnd;
    case SpatialSkeletonNodeFilterType.TRUE_END:
      return options.nodeIsTrueEnd;
    case SpatialSkeletonNodeFilterType.HAS_DESCRIPTION:
      return options.nodeHasDescription;
  }
}

export function getSpatialSkeletonNodeIconFilterType(options: {
  nodeIsTrueEnd: boolean;
  nodeType: SpatialSkeletonDisplayNodeType;
}) {
  if (options.nodeIsTrueEnd) {
    return SpatialSkeletonNodeFilterType.TRUE_END;
  }
  if (options.nodeType === SpatialSkeletonDisplayNodeType.VIRTUAL_END) {
    return SpatialSkeletonNodeFilterType.VIRTUAL_END;
  }
  return undefined;
}
