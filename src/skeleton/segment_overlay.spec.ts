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

describe("buildSpatiallyIndexedSkeletonOverlayGeometry", () => {
  it("packs inspected segment nodes into overlay geometry with deduped nodes", () => {
    const geometry = buildSpatiallyIndexedSkeletonOverlayGeometry(
      [
        [
          {
            nodeId: 1,
            segmentId: 11,
            position: new Float32Array([1, 2, 3]),
          },
          {
            nodeId: 2,
            segmentId: 11,
            position: new Float32Array([4, 5, 6]),
            parentNodeId: 1,
          },
        ],
        [
          {
            nodeId: 2,
            segmentId: 11,
            position: new Float32Array([40, 50, 60]),
            parentNodeId: 1,
          },
          {
            nodeId: 3,
            segmentId: 13,
            position: new Float32Array([7, 8, 9]),
          },
        ],
      ],
      {
        getPendingNodePosition: (nodeId) =>
          nodeId === 3 ? new Float32Array([70, 80, 90]) : undefined,
      },
    );

    expect(geometry.numVertices).toBe(3);
    expect([...geometry.nodeIds]).toEqual([1, 2, 3]);
    expect([...geometry.segmentIds]).toEqual([11, 11, 13]);
    expect([...geometry.positions]).toEqual([1, 2, 3, 4, 5, 6, 70, 80, 90]);
    expect([...geometry.indices]).toEqual([1, 0]);
    expect([...geometry.pickEdgeSegmentIds]).toEqual([11]);
  });
});

describe("mergeSpatiallyIndexedSkeletonOverlaySegmentIds", () => {
  it("dedupes and sorts active and retained segment ids", () => {
    expect(
      mergeSpatiallyIndexedSkeletonOverlaySegmentIds([7, 3, 7], [9, 3, 5]),
    ).toEqual([3, 5, 7, 9]);
  });

  it("ignores invalid segment ids", () => {
    expect(
      mergeSpatiallyIndexedSkeletonOverlaySegmentIds([1, 0, -2], [NaN, 4]),
    ).toEqual([1, 4]);
  });
});

describe("retainSpatiallyIndexedSkeletonOverlaySegment", () => {
  it("moves retained segments to the most recent position", () => {
    expect(retainSpatiallyIndexedSkeletonOverlaySegment([2, 4, 6], 4)).toEqual([
      2, 6, 4,
    ]);
  });

  it("keeps only the most recent retained segments", () => {
    const retained: number[] = [];
    for (
      let segmentId = 1;
      segmentId <= DEFAULT_MAX_RETAINED_OVERLAY_SEGMENTS + 2;
      ++segmentId
    ) {
      retained.splice(
        0,
        retained.length,
        ...retainSpatiallyIndexedSkeletonOverlaySegment(retained, segmentId),
      );
    }
    const firstRetainedSegmentId = 3;
    expect(retained).toEqual(
      Array.from(
        { length: DEFAULT_MAX_RETAINED_OVERLAY_SEGMENTS },
        (_, index) => firstRetainedSegmentId + index,
      ),
    );
  });
});
