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

import type { SkeletonNode } from "#src/skeleton/api.js";
import { TrackableValue } from "#src/trackable_value.js";
import { verifyString } from "#src/util/json.js";
import { CompoundTrackable } from "#src/util/trackable.js";
import { TrackableEnum } from "#src/util/trackable_enum.js";

export enum SkeletonDisplayNodeType {
  ROOT = "root",
  BRANCH_START = "branchStart",
  REGULAR = "regular",
  VIRTUAL_END = "virtualEnd",
}

export enum SkeletonNodeFilterType {
  DEFAULT,
  NONE,
  LEAF,
  VIRTUAL_END,
  TRUE_END,
  HAS_DESCRIPTION,
}

export function classifySkeletonDisplayNodeType(
  node: SkeletonNode,
  childCount: number | undefined,
  parentInTree = true,
): SkeletonDisplayNodeType {
  if (node.parentNodeId === undefined || !parentInTree) {
    return SkeletonDisplayNodeType.ROOT;
  }
  if (childCount === undefined) {
    return SkeletonDisplayNodeType.REGULAR;
  }
  if (childCount > 1) {
    return SkeletonDisplayNodeType.BRANCH_START;
  }
  if (childCount === 0) {
    return SkeletonDisplayNodeType.VIRTUAL_END;
  }
  return SkeletonDisplayNodeType.REGULAR;
}

export function getSkeletonNodeFilterLabel(filterType: SkeletonNodeFilterType) {
  switch (filterType) {
    case SkeletonNodeFilterType.DEFAULT:
      return "Default";
    case SkeletonNodeFilterType.NONE:
      return "None";
    case SkeletonNodeFilterType.LEAF:
      return "Leaf";
    case SkeletonNodeFilterType.VIRTUAL_END:
      return "Virtual end";
    case SkeletonNodeFilterType.TRUE_END:
      return "True end";
    case SkeletonNodeFilterType.HAS_DESCRIPTION:
      return "Has description";
  }
}

const SKELETON_NODE_TYPE_LABELS: Record<SkeletonDisplayNodeType, string> = {
  [SkeletonDisplayNodeType.ROOT]: "Root",
  [SkeletonDisplayNodeType.BRANCH_START]: "Branch point",
  [SkeletonDisplayNodeType.REGULAR]: "Node",
  [SkeletonDisplayNodeType.VIRTUAL_END]: "Virtual end",
};

export function getSkeletonNodeTypeLabel(
  nodeType: SkeletonDisplayNodeType,
  nodeIsTrueEnd: boolean,
): string {
  return nodeIsTrueEnd ? "True end" : SKELETON_NODE_TYPE_LABELS[nodeType];
}

export class SkeletonBrowseState extends CompoundTrackable {
  readonly nodeQuery = new TrackableValue<string>("", verifyString);
  readonly nodeFilter = new TrackableEnum<SkeletonNodeFilterType>(
    SkeletonNodeFilterType,
    SkeletonNodeFilterType.DEFAULT,
  );

  constructor() {
    super();
    this.add("nodeQuery", this.nodeQuery);
    this.add("nodeFilter", this.nodeFilter);
  }

  restoreState(obj: unknown) {
    if (obj === undefined) return;
    super.restoreState(obj);
  }

  toJSON(): any {
    const obj = super.toJSON();
    for (const value of Object.values(obj)) {
      if (value !== undefined) return obj;
    }
    return undefined;
  }
}

export function matchesSkeletonNodeFilter(
  filterType: SkeletonNodeFilterType,
  options: {
    isLeaf: boolean;
    nodeHasDescription: boolean;
    nodeIsTrueEnd: boolean;
    nodeType: SkeletonDisplayNodeType;
  },
) {
  switch (filterType) {
    case SkeletonNodeFilterType.DEFAULT:
    case SkeletonNodeFilterType.NONE:
      return true;
    case SkeletonNodeFilterType.LEAF:
      return options.isLeaf;
    case SkeletonNodeFilterType.VIRTUAL_END:
      return options.isLeaf && !options.nodeIsTrueEnd;
    case SkeletonNodeFilterType.TRUE_END:
      return options.nodeIsTrueEnd;
    case SkeletonNodeFilterType.HAS_DESCRIPTION:
      return options.nodeHasDescription;
  }
}

export function getSkeletonNodeIconFilterType(options: {
  nodeIsTrueEnd: boolean;
  nodeType: SkeletonDisplayNodeType;
}) {
  if (options.nodeIsTrueEnd) {
    return SkeletonNodeFilterType.TRUE_END;
  }
  if (options.nodeType === SkeletonDisplayNodeType.VIRTUAL_END) {
    return SkeletonNodeFilterType.VIRTUAL_END;
  }
  return undefined;
}
