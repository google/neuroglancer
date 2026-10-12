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

import type { SpatiallyIndexedSkeletonNode } from "#src/skeleton/api.js";
import {
  createCompleteSkeletonSnapshot,
  mergeCompleteSkeletonSnapshots,
  patchCompleteSkeletonSnapshot,
  remapCompleteSkeletonSnapshot,
  splitCompleteSkeletonSnapshot,
} from "#src/skeleton/complete_skeleton_snapshot.js";

function makeNode(
  nodeId: number,
  segmentId: number,
  parentNodeId?: number,
): SpatiallyIndexedSkeletonNode {
  return {
    nodeId,
    segmentId,
    parentNodeId,
    position: new Float32Array([nodeId, nodeId + 1, nodeId + 2]),
    confidence: 5,
  };
}

describe("complete skeleton snapshots", () => {
  it("captures an immutable base exactly once", () => {
    const input = [makeNode(1, 10), makeNode(2, 10, 1)];
    const snapshot = createCompleteSkeletonSnapshot(input);
    const first = snapshot.materialize();

    (input[0].position as Float32Array)[0] = 999;
    input[0].confidence = 100;
    input.pop();

    expect(snapshot.kind).toBe("base");
    expect(snapshot.nodeCount).toBe(2);
    expect(first).toBe(snapshot.materialize());
    expect(snapshot.materializationCount).toBe(1);
    expect(first[0].position[0]).toBe(1);
    expect(first[0].confidence).toBe(5);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
    expect(Object.isFrozen(first[0].position)).toBe(true);
  });

  it("stores compact patches and shares unchanged nodes", () => {
    const base = createCompleteSkeletonSnapshot([
      makeNode(1, 10),
      makeNode(2, 10, 1),
      makeNode(3, 10, 2),
    ]);
    const patched = patchCompleteSkeletonSnapshot(base, [
      { kind: "update", nodeId: 2, changes: { radius: 12 } },
      { kind: "delete", nodeId: 3 },
      { kind: "insert", node: makeNode(4, 10, 2) },
    ]);

    expect(patched.nodeCount).toBe(3);
    expect(patched.materializationCount).toBe(0);
    expect(patched.getNode(2)?.radius).toBe(12);
    expect(patched.getNode(3)).toBeUndefined();
    expect(patched.getNode(4)?.parentNodeId).toBe(2);
    expect(patched.materializationCount).toBe(0);

    const result = patched.materialize();
    expect(result.map(({ nodeId }) => nodeId)).toEqual([1, 2, 4]);
    expect(result[0]).toBe(base.getNode(1));
    expect(result[1]).not.toBe(base.getNode(2));
    expect(base.getNode(2)?.radius).toBeUndefined();
    expect(result).toBe(patched.materialize());
    expect(patched.materializationCount).toBe(1);
  });

  it("represents both split sides as membership views over one snapshot", () => {
    const base = createCompleteSkeletonSnapshot([
      makeNode(1, 10),
      makeNode(2, 10, 1),
      makeNode(3, 10, 2),
      makeNode(4, 10, 3),
    ]);
    const { selected, remainder } = splitCompleteSkeletonSnapshot(base, [3, 4]);

    expect(selected.kind).toBe("split-view");
    expect(selected.nodeCount).toBe(2);
    expect(remainder.nodeCount).toBe(2);
    expect(selected.materializationCount).toBe(0);
    expect(remainder.materializationCount).toBe(0);

    const selectedNodes = selected.materialize();
    const remainderNodes = remainder.materialize();
    expect(selectedNodes.map(({ nodeId }) => nodeId)).toEqual([3, 4]);
    expect(remainderNodes.map(({ nodeId }) => nodeId)).toEqual([1, 2]);
    expect(selectedNodes[0]).toBe(base.getNode(3));
    expect(remainderNodes[0]).toBe(base.getNode(1));
    expect(base.materializationCount).toBe(1);
  });

  it("merges component views with lazy segment and endpoint overrides", () => {
    const first = createCompleteSkeletonSnapshot([
      makeNode(1, 99),
      makeNode(2, 99, 1),
    ]);
    const second = createCompleteSkeletonSnapshot([
      makeNode(3, 20),
      makeNode(4, 20, 3),
    ]);
    const merged = mergeCompleteSkeletonSnapshots(
      [
        { snapshot: first, segmentId: 99 },
        { snapshot: second, segmentId: 99 },
      ],
      {
        overrides: [
          { nodeId: 3, changes: { parentNodeId: 2 } },
          { nodeId: 4, changes: { description: "path override" } },
        ],
      },
    );

    expect(merged.kind).toBe("merge");
    expect(merged.nodeCount).toBe(4);
    expect(merged.materializationCount).toBe(0);
    expect(merged.getNode(3)).toMatchObject({
      nodeId: 3,
      segmentId: 99,
      parentNodeId: 2,
    });
    expect(merged.materializationCount).toBe(0);

    const nodes = merged.materialize();
    expect(nodes.map(({ nodeId }) => nodeId)).toEqual([1, 2, 3, 4]);
    expect(nodes.every(({ segmentId }) => segmentId === 99)).toBe(true);
    expect(nodes[0]).toBe(first.getNode(1));
    expect(nodes[3].description).toBe("path override");
    expect(first.materializationCount).toBe(1);
    expect(second.materializationCount).toBe(1);
    expect(merged.materialize()).toBe(nodes);
    expect(merged.materializationCount).toBe(1);
  });

  it("materializes only the requested snapshot in a patch chain", () => {
    const base = createCompleteSkeletonSnapshot([
      makeNode(1, 10),
      makeNode(2, 10, 1),
    ]);
    const radiusSnapshot = patchCompleteSkeletonSnapshot(base, [
      { kind: "update", nodeId: 1, changes: { radius: 8 } },
    ]);
    const confidenceSnapshot = patchCompleteSkeletonSnapshot(radiusSnapshot, [
      { kind: "update", nodeId: 1, changes: { confidence: 3 } },
    ]);

    const nodes = confidenceSnapshot.materialize();
    expect(nodes[0]).toMatchObject({ radius: 8, confidence: 3 });
    expect(nodes[1]).toBe(base.getNode(2));
    expect(radiusSnapshot.materializationCount).toBe(0);
    expect(confidenceSnapshot.materializationCount).toBe(1);
  });

  it("remaps physical ids lazily and snapshots mutable mapping inputs", () => {
    const base = createCompleteSkeletonSnapshot([
      makeNode(1, 10),
      makeNode(2, 10, 1),
      makeNode(3, 20, 2),
    ]);
    const patched = patchCompleteSkeletonSnapshot(base, [
      { kind: "update", nodeId: 3, changes: { radius: 7 } },
    ]);
    const nodeIds = new Map([[2, 12]]);
    const segmentIds = new Map([
      [10, 110],
      [20, 120],
    ]);
    const remapped = remapCompleteSkeletonSnapshot(patched, {
      nodeIds,
      segmentIds,
    });

    nodeIds.set(3, 13);
    segmentIds.set(10, 999);

    expect(remapped.kind).toBe("remap");
    expect(remapped.nodeCount).toBe(3);
    expect(remapped.materializationCount).toBe(0);
    expect(remapped.getNode(2)).toBeUndefined();
    expect(remapped.getNode(12)).toMatchObject({
      nodeId: 12,
      segmentId: 110,
      parentNodeId: 1,
    });
    expect(remapped.getNode(3)).toMatchObject({
      nodeId: 3,
      segmentId: 120,
      parentNodeId: 12,
      radius: 7,
    });
    expect(remapped.materializationCount).toBe(0);
    expect(patched.materializationCount).toBe(0);

    const nodes = remapped.materialize();
    expect(nodes.map(({ nodeId }) => nodeId)).toEqual([1, 12, 3]);
    expect(nodes.map(({ segmentId }) => segmentId)).toEqual([110, 110, 120]);
    expect(remapped.materializationCount).toBe(1);
    expect(patched.materializationCount).toBe(0);
    expect(base.materializationCount).toBe(1);
  });

  it("rejects colliding physical node-id remaps without materializing", () => {
    const base = createCompleteSkeletonSnapshot([
      makeNode(1, 10),
      makeNode(2, 10, 1),
    ]);

    expect(() =>
      remapCompleteSkeletonSnapshot(base, {
        nodeIds: new Map([[1, 2]]),
      }),
    ).toThrow(/nodes 1 and 2.*duplicate node 2/);
    expect(base.materializationCount).toBe(1);
  });

  it("retains sixty-four edits as patches without intermediate arrays", () => {
    const base = createCompleteSkeletonSnapshot(
      Array.from({ length: 128 }, (_, index) =>
        makeNode(index + 1, 10, index === 0 ? undefined : index),
      ),
    );
    const snapshots = [base];
    for (let nodeId = 1; nodeId <= 64; ++nodeId) {
      snapshots.push(
        patchCompleteSkeletonSnapshot(snapshots.at(-1)!, [
          { kind: "update", nodeId, changes: { confidence: nodeId } },
        ]),
      );
    }

    const result = snapshots.at(-1)!.materialize();
    expect(result).toHaveLength(128);
    expect(result[63].confidence).toBe(64);
    expect(result[64]).toBe(base.getNode(65));
    expect(
      snapshots
        .slice(1, -1)
        .every((snapshot) => snapshot.materializationCount === 0),
    ).toBe(true);
  });

  it("rebases projection chains at each private sixty-four-level boundary", () => {
    const base = createCompleteSkeletonSnapshot([makeNode(1, 10)]);
    let current = base;
    const boundaries = new Map<
      number,
      ReturnType<typeof createCompleteSkeletonSnapshot>
    >();

    for (let edit = 1; edit <= 193; ++edit) {
      current = patchCompleteSkeletonSnapshot(current, [
        { kind: "update", nodeId: 1, changes: { confidence: edit } },
      ]);
      if (edit === 64 || edit === 128 || edit === 192) {
        boundaries.set(edit, current);
        expect(current.materializationCount).toBe(0);
      }
      if (edit === 65 || edit === 129 || edit === 193) {
        expect(boundaries.get(edit - 1)?.materializationCount).toBe(1);
      }
    }

    expect(current.getNode(1)?.confidence).toBe(193);
    expect(current.materialize()[0].confidence).toBe(193);
    expect(base.materializationCount).toBe(1);
  });

  it("preserves handle, node, and array identity while rebasing", () => {
    let boundary = createCompleteSkeletonSnapshot([
      makeNode(1, 10),
      makeNode(2, 10, 1),
    ]);
    for (let edit = 1; edit <= 64; ++edit) {
      boundary = patchCompleteSkeletonSnapshot(boundary, [
        { kind: "update", nodeId: 1, changes: { confidence: edit } },
      ]);
    }

    const handle = boundary;
    const firstNode = boundary.getNode(1);
    const unchangedNode = boundary.getNode(2);
    const nodes = boundary.materialize();

    expect(boundary).toBe(handle);
    expect(boundary.kind).toBe("patch");
    expect(boundary.getNode(1)).toBe(firstNode);
    expect(boundary.getNode(2)).toBe(unchangedNode);
    expect(nodes[0]).toBe(firstNode);
    expect(boundary.materialize()).toBe(nodes);

    const child = patchCompleteSkeletonSnapshot(boundary, [
      { kind: "update", nodeId: 2, changes: { radius: 8 } },
    ]);
    expect(child.getNode(1)).toBe(firstNode);
    expect(boundary.materialize()).toBe(nodes);
  });

  it("applies retained inverse and forward deltas across a rebased boundary", () => {
    const initial = { ...makeNode(1, 10), radius: 1 };
    let s62 = createCompleteSkeletonSnapshot([initial]);
    for (let edit = 1; edit <= 62; ++edit) {
      s62 = patchCompleteSkeletonSnapshot(s62, [
        { kind: "update", nodeId: 1, changes: { confidence: edit } },
      ]);
    }
    const s63 = patchCompleteSkeletonSnapshot(s62, [
      { kind: "update", nodeId: 1, changes: { radius: 2 } },
    ]);
    const s64 = patchCompleteSkeletonSnapshot(s63, [
      {
        kind: "update",
        nodeId: 1,
        changes: { position: Object.freeze([9, 10, 11]) },
      },
    ]);
    const s63BeforeRebase = s63.materialize();
    const s64Nodes = s64.materialize();

    const undo64 = patchCompleteSkeletonSnapshot(s64, [
      {
        kind: "update",
        nodeId: 1,
        changes: { position: Object.freeze([1, 2, 3]) },
      },
    ]);
    const undo63 = patchCompleteSkeletonSnapshot(undo64, [
      { kind: "update", nodeId: 1, changes: { radius: 1 } },
    ]);

    expect(undo64.materialize()).toEqual(s63BeforeRebase);
    expect(undo63.materialize()).toEqual(s62.materialize());
    expect(s63.materialize()).toBe(s63BeforeRebase);
    expect(s63.getNode(1)).toBe(s63BeforeRebase[0]);

    const redo63 = patchCompleteSkeletonSnapshot(undo63, [
      { kind: "update", nodeId: 1, changes: { radius: 2 } },
    ]);
    const redo64 = patchCompleteSkeletonSnapshot(redo63, [
      {
        kind: "update",
        nodeId: 1,
        changes: { position: Object.freeze([9, 10, 11]) },
      },
    ]);
    expect(redo63.materialize()).toEqual(s63BeforeRebase);
    expect(redo64.materialize()).toEqual(s64Nodes);
  });

  it("builds thousands of lazy patches without unbounded traversal", () => {
    let snapshot = createCompleteSkeletonSnapshot([makeNode(1, 10)]);
    for (let edit = 1; edit <= 4096; ++edit) {
      snapshot = patchCompleteSkeletonSnapshot(snapshot, [
        { kind: "update", nodeId: 1, changes: { radius: edit } },
      ]);
    }
    expect(snapshot.getNode(1)?.radius).toBe(4096);
    expect(snapshot.materialize()[0].radius).toBe(4096);
  });

  it("rebases deep remap, split, and merge projections without changing topology", () => {
    let snapshot = createCompleteSkeletonSnapshot([
      makeNode(1, 10),
      makeNode(2, 10, 1),
      makeNode(3, 10, 2),
    ]);
    for (let edit = 1; edit <= 63; ++edit) {
      snapshot = patchCompleteSkeletonSnapshot(snapshot, [
        { kind: "update", nodeId: 3, changes: { confidence: edit } },
      ]);
    }
    const remapped = remapCompleteSkeletonSnapshot(snapshot, {
      nodeIds: new Map([
        [1, 101],
        [2, 102],
        [3, 103],
      ]),
      segmentIds: new Map([[10, 110]]),
    });
    const remappedNodes = remapped.materialize();
    expect(remappedNodes).toMatchObject([
      { nodeId: 101, segmentId: 110, parentNodeId: undefined },
      { nodeId: 102, segmentId: 110, parentNodeId: 101 },
      { nodeId: 103, segmentId: 110, parentNodeId: 102, confidence: 63 },
    ]);

    const { selected, remainder } = splitCompleteSkeletonSnapshot(
      remapped,
      [102, 103],
    );
    const merged = mergeCompleteSkeletonSnapshots([
      { snapshot: remainder },
      { snapshot: selected },
    ]);
    expect(merged.materialize()).toEqual(remappedNodes);
    expect(remapped.materialize()).toBe(remappedNodes);
  });

  it("counts a merge override patch as an additional projection level", () => {
    let source = createCompleteSkeletonSnapshot([makeNode(1, 10)]);
    for (let edit = 1; edit <= 62; ++edit) {
      source = patchCompleteSkeletonSnapshot(source, [
        { kind: "update", nodeId: 1, changes: { confidence: edit } },
      ]);
    }
    const merged = mergeCompleteSkeletonSnapshots([{ snapshot: source }], {
      overrides: [{ nodeId: 1, changes: { radius: 7 } }],
    });
    expect(merged.materializationCount).toBe(0);

    const child = patchCompleteSkeletonSnapshot(merged, [
      { kind: "update", nodeId: 1, changes: { description: "after merge" } },
    ]);

    expect(merged.materializationCount).toBe(1);
    expect(child.getNode(1)).toMatchObject({
      confidence: 62,
      radius: 7,
      description: "after merge",
    });
  });

  it("rejects invalid patches, memberships, and overlapping merges", () => {
    expect(() =>
      createCompleteSkeletonSnapshot([makeNode(1, 10), makeNode(1, 10)]),
    ).toThrow(/duplicate node 1/);

    const first = createCompleteSkeletonSnapshot([makeNode(1, 10)]);
    expect(() =>
      patchCompleteSkeletonSnapshot(first, [
        { kind: "update", nodeId: 2, changes: { radius: 1 } },
      ]),
    ).toThrow(/update missing.*2/);
    expect(() => splitCompleteSkeletonSnapshot(first, [2])).toThrow(
      /missing.*2.*split view/,
    );

    const duplicate = createCompleteSkeletonSnapshot([makeNode(1, 20)]);
    expect(() =>
      mergeCompleteSkeletonSnapshots([
        { snapshot: first },
        { snapshot: duplicate },
      ]),
    ).toThrow(/merge.*duplicate node 1/);
  });
});
