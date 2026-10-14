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
  getSkeletonNodeFilterLabel,
  getSkeletonNodeIconFilterType,
  matchesSkeletonNodeFilter,
  SkeletonDisplayNodeType,
  SkeletonNodeFilterType,
} from "#src/skeleton/node_types.js";

function makeNode(overrides: Partial<SkeletonNode> = {}): SkeletonNode {
  return {
    nodeId: 1n,
    segmentId: 1n,
    position: new Float32Array([0, 0, 0]),
    isTrueEnd: false,
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

  it("matches the dropdown filter semantics", () => {
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

  it("reuses the terminal filter enum for row icon decisions", () => {
    expect(
      getSkeletonNodeIconFilterType({
        nodeIsTrueEnd: false,
        nodeType: SkeletonDisplayNodeType.VIRTUAL_END,
      }),
    ).toBe(SkeletonNodeFilterType.VIRTUAL_END);
    expect(
      getSkeletonNodeIconFilterType({
        nodeIsTrueEnd: true,
        nodeType: SkeletonDisplayNodeType.REGULAR,
      }),
    ).toBe(SkeletonNodeFilterType.TRUE_END);
    expect(
      getSkeletonNodeIconFilterType({
        nodeIsTrueEnd: false,
        nodeType: SkeletonDisplayNodeType.ROOT,
      }),
    ).toBeUndefined();
    expect(getSkeletonNodeFilterLabel(SkeletonNodeFilterType.TRUE_END)).toBe(
      "True end",
    );
    expect(
      getSkeletonNodeFilterLabel(SkeletonNodeFilterType.HAS_DESCRIPTION),
    ).toBe("Has description");
  });
});
