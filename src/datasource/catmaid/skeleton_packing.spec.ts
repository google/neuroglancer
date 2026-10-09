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

import { packCatmaidSkeletonNodes } from "#src/datasource/catmaid/skeleton_packing.js";
import type { SpatiallyIndexedSkeletonNodeBase } from "#src/skeleton/api.js";

describe("datasource/catmaid/skeleton_packing", () => {
  it("packs vertex, segment, index, and pick-node data", () => {
    const nodes: SpatiallyIndexedSkeletonNodeBase[] = [
      {
        nodeId: 1,
        parentNodeId: undefined,
        position: new Float32Array([1, 2, 3]),
        segmentId: 10,
        sourceState: { revisionToken: "node-1" },
      },
      {
        nodeId: 2,
        parentNodeId: 1,
        position: new Float32Array([4, 5, 6]),
        segmentId: 10,
        sourceState: { revisionToken: "node-2" },
      },
      {
        nodeId: 3,
        parentNodeId: 99,
        position: new Float32Array([7, 8, 9]),
        segmentId: 11,
      },
    ];

    const packed = packCatmaidSkeletonNodes(nodes);

    expect(packed.vertexPositions).toEqual(
      Float32Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9),
    );
    expect(packed.segmentIds).toEqual(Uint32Array.of(10, 10, 11));
    expect(packed.indices).toEqual(Uint32Array.of(1, 0));
    expect(packed.nodeIds).toEqual(Int32Array.of(1, 2, 3));
    expect(packed.sourceStates).toEqual([
      { revisionToken: "node-1" },
      { revisionToken: "node-2" },
      undefined,
    ]);
  });

  it("preserves large segment ids exactly", () => {
    const largeSegmentId = 16_777_217;
    const nodes: SpatiallyIndexedSkeletonNodeBase[] = [
      {
        nodeId: 1,
        parentNodeId: undefined,
        position: new Float32Array([1, 2, 3]),
        segmentId: largeSegmentId,
      },
    ];

    const packed = packCatmaidSkeletonNodes(nodes);

    expect(packed.segmentIds).toEqual(Uint32Array.of(largeSegmentId));
  });
});
