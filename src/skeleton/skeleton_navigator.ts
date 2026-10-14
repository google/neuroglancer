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

import type { RenderLayerTransformOrError } from "#src/render_coordinate_transform.js";
import type { SkeletonNode } from "#src/skeleton/api.js";
import {
  buildSkeletonNavigationGraph,
  getBranchEnd,
  getBranchStart,
  getNextCollapsedLevelNode,
  getOpenLeaves,
  getParentNode,
  getRandomChildNode,
  getSkeletonRootNode,
  type SkeletonNavigationGraph,
  type SkeletonNavigationTarget,
} from "#src/skeleton/navigation_graph.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { bigintCompare } from "#src/util/bigint.js";
import type { NullaryReadonlySignal } from "#src/util/signal.js";

const NO_SEGMENT_SELECTED_MESSAGE = "No segment/skeleton is selected.";
const NO_NODE_SELECTED_MESSAGE =
  "No skeleton node is selected, only go to root is supported on skeleton edges.";
const NODES_NOT_LOADED_MESSAGE =
  "To use skeleton navigation, show this skeleton in Seg, then allow it to finish loading.";
const PICKABLE_NODES_NOT_LOADED_MESSAGE =
  "To use skeleton navigation, show this skeleton in Seg or double-click one of its nodes, then allow its details to finish loading.";

export interface SkeletonNodeAccess {
  // Undefined until every node of the segment is in memory.
  // Returns the same array while the nodes are unchanged.
  getSegmentNodes(segmentId: bigint): readonly SkeletonNode[] | undefined;
  readonly nodesChanged: NullaryReadonlySignal;
  // Whether the viewer can hover over and select single nodes of this skeleton.
  readonly hasPickableNodes: boolean;
  readonly displayState: {
    readonly transform: WatchableValueInterface<RenderLayerTransformOrError>;
  };
}

export enum SkeletonNavigation {
  ROOT,
  PARENT,
  CHILD,
  BRANCH_START,
  BRANCH_END,
  NEXT_LEVEL_NODE,
  NEAREST_OPEN_LEAF,
}

export enum SkeletonNavigationFailure {
  NO_SEGMENT_SELECTED,
  NODES_NOT_LOADED,
  NO_NODE_SELECTED,
  NO_TARGET,
}

export type SkeletonNavigationResult = SkeletonNode | SkeletonNavigationFailure;

const NO_TARGET_MESSAGES: Partial<Record<SkeletonNavigation, string>> = {
  [SkeletonNavigation.PARENT]: "Selected node has no parent.",
  [SkeletonNavigation.CHILD]: "Selected node has no child.",
  [SkeletonNavigation.NEAREST_OPEN_LEAF]:
    "No unfinished branch was found in the current skeleton.",
};

type TargetFinder = (
  graph: SkeletonNavigationGraph,
  nodeId: bigint,
) => SkeletonNavigationTarget | undefined;

const TARGET_FINDERS: Record<
  Exclude<SkeletonNavigation, SkeletonNavigation.ROOT>,
  TargetFinder
> = {
  [SkeletonNavigation.PARENT]: getParentNode,
  [SkeletonNavigation.CHILD]: (graph, nodeId) =>
    getRandomChildNode(graph, nodeId),
  [SkeletonNavigation.BRANCH_START]: getBranchStart,
  [SkeletonNavigation.BRANCH_END]: (graph, nodeId) =>
    getBranchEnd(graph, nodeId),
  [SkeletonNavigation.NEXT_LEVEL_NODE]: getNextCollapsedLevelNode,
  [SkeletonNavigation.NEAREST_OPEN_LEAF]: (graph, nodeId) =>
    getOpenLeaves(graph, nodeId).sort((leftLeaf, rightLeaf) =>
      leftLeaf.distance === rightLeaf.distance
        ? bigintCompare(leftLeaf.nodeId, rightLeaf.nodeId)
        : leftLeaf.distance - rightLeaf.distance,
    )[0],
};

export class SkeletonNavigator {
  private readonly graphs = new WeakMap<
    readonly SkeletonNode[],
    SkeletonNavigationGraph
  >();

  constructor(
    private readonly nodeAccess: WatchableValueInterface<
      SkeletonNodeAccess | undefined
    >,
  ) {}

  getGraph(segmentId: bigint): SkeletonNavigationGraph | undefined {
    const nodes = this.nodeAccess.value?.getSegmentNodes(segmentId);
    if (nodes === undefined || nodes.length === 0) return undefined;
    let graph = this.graphs.get(nodes);
    if (graph === undefined) {
      graph = buildSkeletonNavigationGraph(nodes);
      this.graphs.set(nodes, graph);
    }
    return graph;
  }

  describeFailure(
    navigation: SkeletonNavigation,
    failure: SkeletonNavigationFailure,
  ): string {
    switch (failure) {
      case SkeletonNavigationFailure.NO_SEGMENT_SELECTED:
        return NO_SEGMENT_SELECTED_MESSAGE;
      case SkeletonNavigationFailure.NODES_NOT_LOADED:
        return (this.nodeAccess.value?.hasPickableNodes ?? false)
          ? PICKABLE_NODES_NOT_LOADED_MESSAGE
          : NODES_NOT_LOADED_MESSAGE;
      case SkeletonNavigationFailure.NO_NODE_SELECTED:
        return NO_NODE_SELECTED_MESSAGE;
      case SkeletonNavigationFailure.NO_TARGET: {
        const message = NO_TARGET_MESSAGES[navigation];
        if (message === undefined) {
          throw new Error(
            `Skeleton navigation ${SkeletonNavigation[navigation]} always has a target.`,
          );
        }
        return message;
      }
    }
  }

  navigate(
    navigation: SkeletonNavigation,
    selection: {
      readonly segmentId: bigint | undefined;
      readonly nodeId: bigint | undefined;
    },
  ): SkeletonNavigationResult {
    const { segmentId, nodeId } = selection;
    if (segmentId === undefined) {
      return SkeletonNavigationFailure.NO_SEGMENT_SELECTED;
    }
    const graph = this.getGraph(segmentId);
    if (graph === undefined) return SkeletonNavigationFailure.NODES_NOT_LOADED;
    if (navigation === SkeletonNavigation.ROOT) {
      return graph.nodeById.get(getSkeletonRootNode(graph).nodeId)!;
    }
    if (nodeId === undefined || !graph.nodeById.has(nodeId)) {
      return SkeletonNavigationFailure.NO_NODE_SELECTED;
    }
    const target = TARGET_FINDERS[navigation](graph, nodeId);
    return target === undefined
      ? SkeletonNavigationFailure.NO_TARGET
      : graph.nodeById.get(target.nodeId)!;
  }
}
