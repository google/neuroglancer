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
import {
  SkeletonNavigation,
  SkeletonNavigationFailure,
  SkeletonNavigator,
  type SkeletonNavigationResult,
  type SkeletonNodeAccess,
} from "#src/skeleton/skeleton_navigator.js";
import { WatchableValue } from "#src/trackable_value.js";
import { NullarySignal } from "#src/util/signal.js";

function makeNode(nodeId: bigint, parentNodeId?: bigint): SkeletonNode {
  return {
    nodeId,
    segmentId: 7n,
    position: new Float32Array([Number(nodeId), 0, 0]),
    parentNodeId,
  };
}

function makeNodeAccess(
  getSegmentNodes: (segmentId: bigint) => readonly SkeletonNode[] | undefined,
) {
  const access: SkeletonNodeAccess = {
    getSegmentNodes,
    nodesChanged: new NullarySignal(),
    hasPickableNodes: false,
    displayState: { transform: new WatchableValue(undefined as any) },
  };
  return new WatchableValue<SkeletonNodeAccess | undefined>(access);
}

function getNodeId(result: SkeletonNavigationResult) {
  return typeof result === "number" ? result : result.nodeId;
}

describe("skeleton navigator", () => {
  it("goes to the parent, child and root of the selected node", () => {
    const nodes = [makeNode(1n), makeNode(2n, 1n), makeNode(3n, 2n)];
    const navigator = new SkeletonNavigator(makeNodeAccess(() => nodes));
    const selection = { segmentId: 7n, nodeId: 2n };

    expect(
      getNodeId(navigator.navigate(SkeletonNavigation.PARENT, selection)),
    ).toBe(1n);
    expect(
      getNodeId(navigator.navigate(SkeletonNavigation.CHILD, selection)),
    ).toBe(3n);
    expect(
      getNodeId(
        navigator.navigate(SkeletonNavigation.ROOT, {
          segmentId: 7n,
          nodeId: undefined,
        }),
      ),
    ).toBe(1n);
  });

  it("asks to show the skeleton when its nodes are not in memory", () => {
    const navigator = new SkeletonNavigator(makeNodeAccess(() => undefined));

    const result = navigator.navigate(SkeletonNavigation.PARENT, {
      segmentId: 7n,
      nodeId: 2n,
    });

    expect(result).toBe(SkeletonNavigationFailure.NODES_NOT_LOADED);
    expect(
      navigator.describeFailure(
        SkeletonNavigation.PARENT,
        result as SkeletonNavigationFailure,
      ),
    ).toBe(
      "To use skeleton navigation, show this skeleton in Seg, then allow it to finish loading.",
    );
  });

  it("goes to the new parent after the skeleton changes", () => {
    let nodes = [makeNode(1n), makeNode(2n, 1n), makeNode(3n, 2n)];
    const navigator = new SkeletonNavigator(makeNodeAccess(() => nodes));
    const selection = { segmentId: 7n, nodeId: 3n };
    expect(
      getNodeId(navigator.navigate(SkeletonNavigation.PARENT, selection)),
    ).toBe(2n);

    nodes = [makeNode(1n), makeNode(2n, 1n), makeNode(3n, 1n)];

    expect(
      getNodeId(navigator.navigate(SkeletonNavigation.PARENT, selection)),
    ).toBe(1n);
  });
});
