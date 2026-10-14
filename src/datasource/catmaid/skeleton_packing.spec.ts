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
import type { SkeletonNodeBase } from "#src/skeleton/api.js";

describe("datasource/catmaid/skeleton_packing", () => {
  it("packs vertex, segment, index, and pick-node data", () => {
    const nodes: SkeletonNodeBase[] = [
      {
        nodeId: 1n,
        parentNodeId: undefined,
        position: new Float32Array([1, 2, 3]),
        segmentId: 10n,
      },
      {
        nodeId: 2n,
        parentNodeId: 1n,
        position: new Float32Array([4, 5, 6]),
        segmentId: 10n,
      },
      {
        nodeId: 3n,
        parentNodeId: 99n,
        position: new Float32Array([7, 8, 9]),
        segmentId: 11n,
      },
    ];

    const packed = packCatmaidSkeletonNodes(nodes);

    expect(packed.vertexPositions).toEqual(
      Float32Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9),
    );
    expect(packed.segmentIds).toEqual(BigUint64Array.of(10n, 10n, 11n));
    expect(packed.indices).toEqual(Uint32Array.of(1, 0));
    expect(packed.nodeIds).toEqual(BigUint64Array.of(1n, 2n, 3n));
  });

  it("keeps skeleton and node IDs above 2^32 exact in a packed chunk", () => {
    const nodes: SkeletonNodeBase[] = [
      {
        nodeId: 2n ** 53n + 1n,
        position: new Float32Array([1, 2, 3]),
        segmentId: 2n ** 63n + 5n,
      },
      {
        nodeId: 4_294_967_297n,
        parentNodeId: 2n ** 53n + 1n,
        position: new Float32Array([4, 5, 6]),
        segmentId: 2n ** 63n + 5n,
      },
    ];

    const packed = packCatmaidSkeletonNodes(nodes);

    expect(packed.segmentIds).toEqual(
      BigUint64Array.of(2n ** 63n + 5n, 2n ** 63n + 5n),
    );
    expect(packed.nodeIds).toEqual(
      BigUint64Array.of(2n ** 53n + 1n, 4_294_967_297n),
    );
    expect(packed.indices).toEqual(Uint32Array.of(1, 0));
  });
});
