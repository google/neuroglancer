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

import { SpatialSkeletonEditSession } from "#src/skeleton/edit/spatial_skeleton_edit_session.js";
import {
  resolveSpatiallyIndexedSkeletonNodePick,
  resolveSpatiallyIndexedSkeletonSegmentPick,
} from "#src/skeleton/spatial/picking.js";

function makePickGeometry(
  nodes: readonly {
    nodeId: bigint;
    segmentId: bigint;
    position: readonly number[];
  }[],
  indices: readonly number[] = [],
) {
  return {
    indices: Uint32Array.from(indices),
    numVertices: nodes.length,
    nodeIds: BigUint64Array.from(nodes.map((node) => node.nodeId)),
    segmentIds: BigUint64Array.from(nodes.map((node) => node.segmentId)),
    nodePositions: Float32Array.from(nodes.flatMap((node) => node.position)),
  };
}

describe("resolveSpatiallyIndexedSkeletonNodePick", () => {
  it("a click selects the skeleton and node under the mouse, with IDs above 2^32 exact", () => {
    const nodeId = 2n ** 40n + 1n;
    const segmentId = 2n ** 33n + 5n;
    const geometry = makePickGeometry([
      { nodeId: 1n, segmentId: 3n, position: [0, 0, 0] },
      { nodeId, segmentId, position: [4, 5, 6] },
    ]);

    expect(
      resolveSpatiallyIndexedSkeletonNodePick(
        geometry,
        1,
        new SpatialSkeletonEditSession(),
      ),
    ).toEqual({ nodeId, segmentId, position: Float32Array.of(4, 5, 6) });
  });

  it("a click on a stale cell reports the node's current skeleton and position", () => {
    const state = new SpatialSkeletonEditSession();
    state.replaceCachedSegmentSnapshots([
      [9n, [{ nodeId: 1n, segmentId: 9n, position: [7, 8, 9] }]],
    ]);
    const staleCell = makePickGeometry([
      { nodeId: 1n, segmentId: 3n, position: [0, 0, 0] },
    ]);

    expect(
      resolveSpatiallyIndexedSkeletonNodePick(staleCell, 0, state),
    ).toEqual({
      nodeId: 1n,
      segmentId: 9n,
      position: Float32Array.of(7, 8, 9),
    });
  });
});

describe("resolveSpatiallyIndexedSkeletonSegmentPick", () => {
  it("a click on an edge selects the skeleton of the end that has one", () => {
    const geometry = makePickGeometry(
      [
        { nodeId: 1n, segmentId: 0n, position: [0, 0, 0] },
        { nodeId: 2n, segmentId: 9n, position: [1, 0, 0] },
      ],
      [0, 1],
    );

    expect(
      resolveSpatiallyIndexedSkeletonSegmentPick(geometry, 0, "edge"),
    ).toBe(9n);
  });
});
