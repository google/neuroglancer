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

import {
  DEFAULT_MAX_RETAINED_OVERLAY_SEGMENTS,
  mergeSpatiallyIndexedSkeletonOverlaySegmentIds,
  retainSpatiallyIndexedSkeletonOverlaySegment,
  buildSpatiallyIndexedSkeletonOverlayGeometry,
} from "#src/skeleton/segment_overlay.js";
import { bigintCompare } from "#src/util/bigint.js";

describe("buildSpatiallyIndexedSkeletonOverlayGeometry", () => {
  it("packs inspected segment nodes into overlay geometry with deduped nodes", () => {
    const geometry = buildSpatiallyIndexedSkeletonOverlayGeometry(
      [
        [
          {
            nodeId: 1n,
            segmentId: 11n,
            position: new Float32Array([1, 2, 3]),
          },
          {
            nodeId: 2n,
            segmentId: 11n,
            position: new Float32Array([4, 5, 6]),
            parentNodeId: 1n,
          },
        ],
        [
          {
            nodeId: 2n,
            segmentId: 11n,
            position: new Float32Array([40, 50, 60]),
            parentNodeId: 1n,
          },
          {
            nodeId: 3n,
            segmentId: 13n,
            position: new Float32Array([7, 8, 9]),
          },
        ],
      ],
      {
        getPendingNodePosition: (nodeId) =>
          nodeId === 3n ? new Float32Array([70, 80, 90]) : undefined,
      },
    );

    expect(geometry.numVertices).toBe(3);
    expect([...geometry.nodeIds]).toEqual([1n, 2n, 3n]);
    expect([...geometry.segmentIds]).toEqual([11n, 11n, 13n]);
    expect([...geometry.positions]).toEqual([1, 2, 3, 4, 5, 6, 70, 80, 90]);
    expect([...geometry.indices]).toEqual([1, 0]);
  });

  it("preserves the maximum provisional node id used for picking", () => {
    const maxProvisionalNodeId = 2n ** 63n + 0x7fff_ffffn;
    const geometry = buildSpatiallyIndexedSkeletonOverlayGeometry([
      [
        {
          nodeId: maxProvisionalNodeId,
          segmentId: 11n,
          position: new Float32Array([1, 2, 3]),
        },
      ],
    ]);

    expect(geometry.nodeIds[0]).toBe(maxProvisionalNodeId);
    expect(geometry.nodeIds[0]).toBeGreaterThan(0n);
  });

  it("returns a nodeIndex map aligned with the packed vertex order", () => {
    const geometry = buildSpatiallyIndexedSkeletonOverlayGeometry([
      [
        { nodeId: 5n, segmentId: 11n, position: new Float32Array([1, 2, 3]) },
        {
          nodeId: 6n,
          segmentId: 11n,
          position: new Float32Array([4, 5, 6]),
          parentNodeId: 5n,
        },
      ],
      // Duplicate of node 5 in a second segment must not create a new vertex.
      [{ nodeId: 5n, segmentId: 13n, position: new Float32Array([9, 9, 9]) }],
    ]);
    expect(geometry.numVertices).toBe(2);
    // The nodeIndex maps each nodeId to its packed vertex index, so a live drag
    // can override the right vertex's position via a shader uniform.
    expect(geometry.nodeIndex.get(5n)).toBe(0);
    expect(geometry.nodeIndex.get(6n)).toBe(1);
    expect([...geometry.nodeIds]).toEqual([5n, 6n]);
  });
});

describe("mergeSpatiallyIndexedSkeletonOverlaySegmentIds", () => {
  it("dedupes and sorts active and retained segment ids", () => {
    expect(
      mergeSpatiallyIndexedSkeletonOverlaySegmentIds(
        [7n, 3n, 7n],
        [9n, 3n, 5n],
      ),
    ).toEqual([3n, 5n, 7n, 9n]);
  });

  it("ignores invalid segment ids", () => {
    expect(
      mergeSpatiallyIndexedSkeletonOverlaySegmentIds([1n, 0n, -2n], [4n]),
    ).toEqual([1n, 4n]);
  });
});

describe("retainSpatiallyIndexedSkeletonOverlaySegment", () => {
  it("sets the touched segment's recency counter", () => {
    const retained = retainSpatiallyIndexedSkeletonOverlaySegment(
      new Map([
        [2n, 0],
        [4n, 1],
        [6n, 2],
      ]),
      4n,
      10,
    );
    expect([...retained.entries()]).toEqual([
      [2n, 0],
      [4n, 10],
      [6n, 2],
    ]);
  });

  it("keeps only the most recently touched segments", () => {
    let retained = new Map<bigint, number>();
    for (
      let segmentId = 1;
      segmentId <= DEFAULT_MAX_RETAINED_OVERLAY_SEGMENTS + 2;
      ++segmentId
    ) {
      retained = retainSpatiallyIndexedSkeletonOverlaySegment(
        retained,
        BigInt(segmentId),
        segmentId,
      );
    }
    const firstRetainedSegmentId = 3n;
    expect([...retained.keys()].sort(bigintCompare)).toEqual(
      Array.from(
        { length: DEFAULT_MAX_RETAINED_OVERLAY_SEGMENTS },
        (_, index) => firstRetainedSegmentId + BigInt(index),
      ),
    );
  });
});
