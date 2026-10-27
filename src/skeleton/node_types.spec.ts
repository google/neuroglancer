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
  classifySkeletonDisplayNodeType,
  matchesSkeletonNodeFilter,
  SkeletonBrowseState,
  SkeletonDisplayNodeType,
  SkeletonNodeFilterType,
} from "#src/skeleton/node_types.js";

function makeNode(overrides: Partial<SkeletonNode> = {}): SkeletonNode {
  return {
    nodeId: 1n,
    segmentId: 1n,
    position: new Float32Array([0, 0, 0]),
    ...overrides,
  };
}

describe("skeleton node types", () => {
  it("classifies display node types for roots, branches, regular nodes, and virtual ends", () => {
    expect(
      classifySkeletonDisplayNodeType(makeNode({ parentNodeId: undefined }), 0),
    ).toBe("root");
    expect(
      classifySkeletonDisplayNodeType(makeNode({ parentNodeId: 1n }), 2),
    ).toBe("branchStart");
    expect(
      classifySkeletonDisplayNodeType(makeNode({ parentNodeId: 1n }), 1),
    ).toBe("regular");
    expect(
      classifySkeletonDisplayNodeType(makeNode({ parentNodeId: 1n }), 0),
    ).toBe("virtualEnd");
    expect(
      classifySkeletonDisplayNodeType(makeNode({ parentNodeId: 1n }), 0, false),
    ).toBe("root");
  });

  it("each Skeleton tab filter shows the nodes its label names", () => {
    const rootLeaf = {
      isLeaf: true,
      nodeHasDescription: false,
      nodeIsTrueEnd: false,
      nodeType: SkeletonDisplayNodeType.ROOT,
    };
    const virtualEnd = {
      isLeaf: true,
      nodeHasDescription: false,
      nodeIsTrueEnd: false,
      nodeType: SkeletonDisplayNodeType.VIRTUAL_END,
    };
    const trueEnd = {
      isLeaf: true,
      nodeHasDescription: false,
      nodeIsTrueEnd: true,
      nodeType: SkeletonDisplayNodeType.VIRTUAL_END,
    };
    const describedNode = {
      isLeaf: false,
      nodeHasDescription: true,
      nodeIsTrueEnd: false,
      nodeType: SkeletonDisplayNodeType.REGULAR,
    };

    expect(
      matchesSkeletonNodeFilter(SkeletonNodeFilterType.DEFAULT, rootLeaf),
    ).toBe(true);
    expect(
      matchesSkeletonNodeFilter(SkeletonNodeFilterType.DEFAULT, {
        isLeaf: false,
        nodeHasDescription: false,
        nodeIsTrueEnd: false,
        nodeType: SkeletonDisplayNodeType.REGULAR,
      }),
    ).toBe(true);
    expect(
      matchesSkeletonNodeFilter(SkeletonNodeFilterType.LEAF, rootLeaf),
    ).toBe(true);
    expect(
      matchesSkeletonNodeFilter(SkeletonNodeFilterType.VIRTUAL_END, rootLeaf),
    ).toBe(true);
    expect(
      matchesSkeletonNodeFilter(SkeletonNodeFilterType.VIRTUAL_END, virtualEnd),
    ).toBe(true);
    expect(
      matchesSkeletonNodeFilter(SkeletonNodeFilterType.VIRTUAL_END, trueEnd),
    ).toBe(false);
    expect(
      matchesSkeletonNodeFilter(SkeletonNodeFilterType.TRUE_END, trueEnd),
    ).toBe(true);
    expect(
      matchesSkeletonNodeFilter(
        SkeletonNodeFilterType.HAS_DESCRIPTION,
        describedNode,
      ),
    ).toBe(true);
    expect(
      matchesSkeletonNodeFilter(
        SkeletonNodeFilterType.HAS_DESCRIPTION,
        rootLeaf,
      ),
    ).toBe(false);
  });
});

describe("SkeletonBrowseState", () => {
  it("a saved state restores the Skeleton tab's node query and filter", () => {
    const savedState = new SkeletonBrowseState();
    savedState.nodeQuery.value = "soma";
    savedState.nodeFilter.value = SkeletonNodeFilterType.TRUE_END;

    const restoredState = new SkeletonBrowseState();
    restoredState.restoreState(JSON.parse(JSON.stringify(savedState.toJSON())));

    expect(restoredState.nodeQuery.value).toBe("soma");
    expect(restoredState.nodeFilter.value).toBe(
      SkeletonNodeFilterType.TRUE_END,
    );
  });

  it("a layer without saved Skeleton tab state starts with an empty query and the default filter", () => {
    const browseState = new SkeletonBrowseState();
    browseState.restoreState(undefined);

    expect(browseState.nodeQuery.value).toBe("");
    expect(browseState.nodeFilter.value).toBe(SkeletonNodeFilterType.DEFAULT);
    expect(browseState.toJSON()).toBeUndefined();
  });
});
