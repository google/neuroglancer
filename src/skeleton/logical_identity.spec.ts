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
  SpatialSkeletonLogicalHandleMappings,
  spatialSkeletonLogicalNode,
  spatialSkeletonLogicalSegment,
} from "#src/skeleton/logical_identity.js";

describe("skeleton/logical_identity", () => {
  it("keeps logical handles stable while physical node and segment ids remap", () => {
    const mappings = new SpatialSkeletonLogicalHandleMappings<number, number>();
    const node = spatialSkeletonLogicalNode("created:1");
    const firstSegment = spatialSkeletonLogicalSegment("merge:first");
    const secondSegment = spatialSkeletonLogicalSegment("merge:second");

    expect(mappings.bindNodes([[node, -1]])).toBe(true);
    expect(mappings.bindSegment(firstSegment, -2)).toBe(true);
    expect(mappings.revision).toBe(2);

    const beforeWinnerResolution = mappings.cloneSnapshot();
    expect(
      mappings.apply({
        nodes: [[node, 101]],
        segments: [
          [firstSegment, 202],
          [secondSegment, 202],
        ],
      }),
    ).toBe(true);
    expect(mappings.revision).toBe(3);
    expect(mappings.resolveNode(node)).toBe(101);
    expect(mappings.resolveSegment(firstSegment)).toBe(202);
    expect(mappings.resolveSegment(secondSegment)).toBe(202);
    expect(mappings.findSegments(202)).toEqual([firstSegment, secondSegment]);

    mappings.restoreSnapshot(beforeWinnerResolution);
    expect(mappings.resolveNode(node)).toBe(-1);
    expect(mappings.resolveSegment(firstSegment)).toBe(-2);
    expect(mappings.resolveSegment(secondSegment)).toBeUndefined();
    expect(mappings.revision).toBe(4);
  });

  it("binds a complete snapshot node set with one mapping revision", () => {
    const mappings = new SpatialSkeletonLogicalHandleMappings<number, number>();
    const bindings = Array.from(
      { length: 5_000 },
      (_, index) =>
        [spatialSkeletonLogicalNode(`snapshot:${index}`), index + 1] as const,
    );

    expect(mappings.bindNodes(bindings)).toBe(true);
    expect(mappings.revision).toBe(1);
    expect(mappings.bindNodes(bindings)).toBe(false);
    expect(mappings.revision).toBe(1);
    expect(mappings.resolveNode(bindings.at(-1)![0])).toBe(5_000);
  });

  it("finds the first logical handles for many physical node ids", () => {
    const mappings = new SpatialSkeletonLogicalHandleMappings<number, number>();
    const first = spatialSkeletonLogicalNode("first");
    const alias = spatialSkeletonLogicalNode("alias");
    const second = spatialSkeletonLogicalNode("second");
    mappings.bindNodes([
      [first, 11],
      [alias, 11],
      [second, 12],
    ]);

    expect(mappings.findFirstNodes([12, 11, 99])).toEqual(
      new Map([
        [11, first],
        [12, second],
      ]),
    );
  });

  it("rolls back only the provisional mapping owned by an intent", () => {
    const mappings = new SpatialSkeletonLogicalHandleMappings<number, number>();
    const segment = spatialSkeletonLogicalSegment("restored");
    mappings.bindSegment(segment, 17);

    const first = mappings.stage(1, { segments: [[segment, 1001]] });
    const second = mappings.stage(2, { segments: [[segment, 1002]] });
    expect(mappings.resolveSegmentTarget(segment)).toEqual({
      state: "provisional",
      physicalId: 1002,
      ownerSequence: 2,
    });

    expect(mappings.rollback(first)).toBe(true);
    expect(mappings.resolveSegmentTarget(segment)).toEqual({
      state: "provisional",
      physicalId: 1002,
      ownerSequence: 2,
    });
    expect(mappings.rollback(first)).toBe(false);

    expect(mappings.commit(second, { segments: [[segment, 202]] })).toBe(true);
    expect(mappings.resolveSegmentTarget(segment)).toEqual({
      state: "authoritative",
      physicalId: 202,
    });
  });

  it("keeps confirmed ids accessible beneath later recreation previews", () => {
    const mappings = new SpatialSkeletonLogicalHandleMappings<number, number>();
    const node = spatialSkeletonLogicalNode("recreated-node");
    const segment = spatialSkeletonLogicalSegment("recreated-segment");
    const first = mappings.stage(1, {
      nodes: [[node, 1001]],
      segments: [[segment, 1010]],
    });
    const later = mappings.stage(3, {
      nodes: [[node, 1003]],
      segments: [[segment, 1030]],
    });
    const firstView = mappings.clone(1);
    expect(firstView.resolveNode(node)).toBe(1001);
    expect(firstView.resolveSegment(segment)).toBe(1010);
    expect(mappings.clone(0).resolveNode(node)).toBeUndefined();
    expect(mappings.resolveAuthoritativeNode(node)).toBeUndefined();
    expect(mappings.resolveAuthoritativeSegment(segment)).toBeUndefined();
    mappings.commit(first, { nodes: [[node, 1]], segments: [[segment, 10]] });
    expect(mappings.resolveNode(node)).toBe(1003);
    expect(mappings.resolveSegment(segment)).toBe(1030);
    expect(mappings.resolveAuthoritativeNode(node)).toBe(1);
    expect(mappings.resolveAuthoritativeSegment(segment)).toBe(10);
    expect(mappings.clone(0).resolveNode(node)).toBe(1);
    expect(firstView.resolveAuthoritativeNode(node)).toBeUndefined();
    mappings.rollback(later);
    expect(mappings.resolveNodeTarget(node)).toEqual({
      state: "authoritative",
      physicalId: 1,
    });
    expect(mappings.resolveSegmentTarget(segment)).toEqual({
      state: "authoritative",
      physicalId: 10,
    });
  });

  it("supports multiple historical handles for one authoritative segment", () => {
    const mappings = new SpatialSkeletonLogicalHandleMappings<number, number>();
    const result = spatialSkeletonLogicalSegment("merge-result");
    const deleted = spatialSkeletonLogicalSegment("merge-deleted");
    mappings.apply({
      segments: [
        [result, 101],
        [deleted, 101],
      ],
    });

    expect(mappings.resolveSegmentTarget(result).state).toBe("authoritative");
    expect(mappings.resolveSegmentTarget(deleted).state).toBe("authoritative");
    expect(mappings.findSegments(101)).toEqual([result, deleted]);
  });
});
