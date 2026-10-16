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
  createCompleteSkeletonSnapshot,
  mergeCompleteSkeletonSnapshots,
  patchCompleteSkeletonSnapshot,
  remapCompleteSkeletonSnapshot,
  splitCompleteSkeletonSnapshot,
} from "#src/skeleton/complete_skeleton_snapshot.js";
import {
  getSkeletonNodeConfidence,
  getSkeletonNodeRadius,
} from "#src/skeleton/node_attributes.js";

function makeNode(
  nodeId: bigint,
  segmentId: bigint,
  parentNodeId?: bigint,
): SkeletonNode {
  return {
    nodeId,
    segmentId,
    parentNodeId,
    position: new Float32Array([
      Number(nodeId),
      Number(nodeId) + 1,
      Number(nodeId) + 2,
    ]),
    attributes: { confidence: [5] },
  };
}

describe("complete skeleton snapshots", () => {
  it("captures an immutable base exactly once", () => {
    const input = [makeNode(1n, 10n), makeNode(2n, 10n, 1n)];
    const snapshot = createCompleteSkeletonSnapshot(input);
    const first = snapshot.materialize();

    (input[0].position as Float32Array)[0] = 999;
    input[0] = { ...input[0], attributes: { confidence: [100] } };
    input.pop();

    expect(snapshot.kind).toBe("base");
    expect(snapshot.nodeCount).toBe(2);
    expect(first).toBe(snapshot.materialize());
    expect(snapshot.materializationCount).toBe(1);
    expect(first[0].position[0]).toBe(1);
    expect(getSkeletonNodeConfidence(first[0])).toBe(5);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
    expect(Object.isFrozen(first[0].position)).toBe(true);
  });

  it("stores compact patches and shares unchanged nodes", () => {
    const base = createCompleteSkeletonSnapshot([
      makeNode(1n, 10n),
      makeNode(2n, 10n, 1n),
      makeNode(3n, 10n, 2n),
    ]);
    const patched = patchCompleteSkeletonSnapshot(base, [
      { kind: "update", nodeId: 2n, changes: { attributes: { radius: [12] } } },
      { kind: "delete", nodeId: 3n },
      { kind: "insert", node: makeNode(4n, 10n, 2n) },
    ]);

    expect(patched.nodeCount).toBe(3);
    expect(patched.materializationCount).toBe(0);
    expect(getSkeletonNodeRadius(patched.getNode(2n)!)).toBe(12);
    expect(patched.getNode(3n)).toBeUndefined();
    expect(patched.getNode(4n)?.parentNodeId).toBe(2n);
    expect(patched.materializationCount).toBe(0);

    const result = patched.materialize();
    expect(result.map(({ nodeId }) => nodeId)).toEqual([1n, 2n, 4n]);
    expect(result[0]).toBe(base.getNode(1n));
    expect(result[1]).not.toBe(base.getNode(2n));
    expect(getSkeletonNodeRadius(base.getNode(2n)!)).toBeUndefined();
    expect(result).toBe(patched.materialize());
    expect(patched.materializationCount).toBe(1);
  });

  it("represents both split sides as membership views over one snapshot", () => {
    const base = createCompleteSkeletonSnapshot([
      makeNode(1n, 10n),
      makeNode(2n, 10n, 1n),
      makeNode(3n, 10n, 2n),
      makeNode(4n, 10n, 3n),
    ]);
    const { selected, remainder } = splitCompleteSkeletonSnapshot(base, [
      3n,
      4n,
    ]);

    expect(selected.kind).toBe("split-view");
    expect(selected.nodeCount).toBe(2);
    expect(remainder.nodeCount).toBe(2);
    expect(selected.materializationCount).toBe(0);
    expect(remainder.materializationCount).toBe(0);

    const selectedNodes = selected.materialize();
    const remainderNodes = remainder.materialize();
    expect(selectedNodes.map(({ nodeId }) => nodeId)).toEqual([3n, 4n]);
    expect(remainderNodes.map(({ nodeId }) => nodeId)).toEqual([1n, 2n]);
    expect(selectedNodes[0]).toBe(base.getNode(3n));
    expect(remainderNodes[0]).toBe(base.getNode(1n));
    expect(base.materializationCount).toBe(1);
  });

  it("merges component views with lazy segment and endpoint overrides", () => {
    const first = createCompleteSkeletonSnapshot([
      makeNode(1n, 99n),
      makeNode(2n, 99n, 1n),
    ]);
    const second = createCompleteSkeletonSnapshot([
      makeNode(3n, 20n),
      makeNode(4n, 20n, 3n),
    ]);
    const merged = mergeCompleteSkeletonSnapshots(
      [
        { snapshot: first, segmentId: 99n },
        { snapshot: second, segmentId: 99n },
      ],
      {
        overrides: [
          { nodeId: 3n, changes: { parentNodeId: 2n } },
          { nodeId: 4n, changes: { description: "path override" } },
        ],
      },
    );

    expect(merged.kind).toBe("merge");
    expect(merged.nodeCount).toBe(4);
    expect(merged.materializationCount).toBe(0);
    expect(merged.getNode(3n)).toMatchObject({
      nodeId: 3n,
      segmentId: 99n,
      parentNodeId: 2n,
    });
    expect(merged.materializationCount).toBe(0);

    const nodes = merged.materialize();
    expect(nodes.map(({ nodeId }) => nodeId)).toEqual([1n, 2n, 3n, 4n]);
    expect(nodes.every(({ segmentId }) => segmentId === 99n)).toBe(true);
    expect(nodes[0]).toBe(first.getNode(1n));
    expect(nodes[3].description).toBe("path override");
    expect(first.materializationCount).toBe(1);
    expect(second.materializationCount).toBe(1);
    expect(merged.materialize()).toBe(nodes);
    expect(merged.materializationCount).toBe(1);
  });

  it("materializes only the requested snapshot in a patch chain", () => {
    const base = createCompleteSkeletonSnapshot([
      makeNode(1n, 10n),
      makeNode(2n, 10n, 1n),
    ]);
    const radiusSnapshot = patchCompleteSkeletonSnapshot(base, [
      { kind: "update", nodeId: 1n, changes: { attributes: { radius: [8] } } },
    ]);
    const descriptionSnapshot = patchCompleteSkeletonSnapshot(radiusSnapshot, [
      { kind: "update", nodeId: 1n, changes: { description: "after" } },
    ]);

    const nodes = descriptionSnapshot.materialize();
    expect(nodes[0]).toMatchObject({
      attributes: { radius: [8] },
      description: "after",
    });
    expect(nodes[1]).toBe(base.getNode(2n));
    expect(radiusSnapshot.materializationCount).toBe(0);
    expect(descriptionSnapshot.materializationCount).toBe(1);
  });

  it("remaps physical ids lazily and snapshots mutable mapping inputs", () => {
    const base = createCompleteSkeletonSnapshot([
      makeNode(1n, 10n),
      makeNode(2n, 10n, 1n),
      makeNode(3n, 20n, 2n),
    ]);
    const patched = patchCompleteSkeletonSnapshot(base, [
      { kind: "update", nodeId: 3n, changes: { attributes: { radius: [7] } } },
    ]);
    const nodeIds = new Map([[2n, 12n]]);
    const segmentIds = new Map([
      [10n, 110n],
      [20n, 120n],
    ]);
    const remapped = remapCompleteSkeletonSnapshot(patched, {
      nodeIds,
      segmentIds,
    });

    nodeIds.set(3n, 13n);
    segmentIds.set(10n, 999n);

    expect(remapped.kind).toBe("remap");
    expect(remapped.nodeCount).toBe(3);
    expect(remapped.materializationCount).toBe(0);
    expect(remapped.getNode(2n)).toBeUndefined();
    expect(remapped.getNode(12n)).toMatchObject({
      nodeId: 12n,
      segmentId: 110n,
      parentNodeId: 1n,
    });
    expect(remapped.getNode(3n)).toMatchObject({
      nodeId: 3n,
      segmentId: 120n,
      parentNodeId: 12n,
      attributes: { radius: [7] },
    });
    expect(remapped.materializationCount).toBe(0);
    expect(patched.materializationCount).toBe(0);

    const nodes = remapped.materialize();
    expect(nodes.map(({ nodeId }) => nodeId)).toEqual([1n, 12n, 3n]);
    expect(nodes.map(({ segmentId }) => segmentId)).toEqual([110n, 110n, 120n]);
    expect(remapped.materializationCount).toBe(1);
    expect(patched.materializationCount).toBe(0);
    expect(base.materializationCount).toBe(1);
  });

  it("rejects colliding physical node-id remaps without materializing", () => {
    const base = createCompleteSkeletonSnapshot([
      makeNode(1n, 10n),
      makeNode(2n, 10n, 1n),
    ]);

    expect(() =>
      remapCompleteSkeletonSnapshot(base, {
        nodeIds: new Map([[1n, 2n]]),
      }),
    ).toThrow(/nodes 1 and 2.*duplicate node 2/);
    expect(base.materializationCount).toBe(1);
  });

  it("retains sixty-four edits as patches without intermediate arrays", () => {
    const base = createCompleteSkeletonSnapshot(
      Array.from({ length: 128 }, (_, index) =>
        makeNode(
          BigInt(index + 1),
          10n,
          index === 0 ? undefined : BigInt(index),
        ),
      ),
    );
    const snapshots = [base];
    for (let nodeId = 1; nodeId <= 64; ++nodeId) {
      snapshots.push(
        patchCompleteSkeletonSnapshot(snapshots.at(-1)!, [
          {
            kind: "update",
            nodeId: BigInt(nodeId),
            changes: { attributes: { confidence: [nodeId] } },
          },
        ]),
      );
    }

    const result = snapshots.at(-1)!.materialize();
    expect(result).toHaveLength(128);
    expect(getSkeletonNodeConfidence(result[63])).toBe(64);
    expect(result[64]).toBe(base.getNode(65n));
    expect(
      snapshots
        .slice(1, -1)
        .every((snapshot) => snapshot.materializationCount === 0),
    ).toBe(true);
  });

  it("rebases projection chains at each private sixty-four-level boundary", () => {
    const base = createCompleteSkeletonSnapshot([makeNode(1n, 10n)]);
    let current = base;
    const boundaries = new Map<
      number,
      ReturnType<typeof createCompleteSkeletonSnapshot>
    >();

    for (let edit = 1; edit <= 193; ++edit) {
      current = patchCompleteSkeletonSnapshot(current, [
        {
          kind: "update",
          nodeId: 1n,
          changes: { attributes: { confidence: [edit] } },
        },
      ]);
      if (edit === 64 || edit === 128 || edit === 192) {
        boundaries.set(edit, current);
        expect(current.materializationCount).toBe(0);
      }
      if (edit === 65 || edit === 129 || edit === 193) {
        expect(boundaries.get(edit - 1)?.materializationCount).toBe(1);
      }
    }

    expect(getSkeletonNodeConfidence(current.getNode(1n)!)).toBe(193);
    expect(getSkeletonNodeConfidence(current.materialize()[0])).toBe(193);
    expect(base.materializationCount).toBe(1);
  });

  it("preserves handle, node, and array identity while rebasing", () => {
    let boundary = createCompleteSkeletonSnapshot([
      makeNode(1n, 10n),
      makeNode(2n, 10n, 1n),
    ]);
    for (let edit = 1; edit <= 64; ++edit) {
      boundary = patchCompleteSkeletonSnapshot(boundary, [
        {
          kind: "update",
          nodeId: 1n,
          changes: { attributes: { confidence: [edit] } },
        },
      ]);
    }

    const handle = boundary;
    const firstNode = boundary.getNode(1n);
    const unchangedNode = boundary.getNode(2n);
    const nodes = boundary.materialize();

    expect(boundary).toBe(handle);
    expect(boundary.kind).toBe("patch");
    expect(boundary.getNode(1n)).toBe(firstNode);
    expect(boundary.getNode(2n)).toBe(unchangedNode);
    expect(nodes[0]).toBe(firstNode);
    expect(boundary.materialize()).toBe(nodes);

    const child = patchCompleteSkeletonSnapshot(boundary, [
      { kind: "update", nodeId: 2n, changes: { attributes: { radius: [8] } } },
    ]);
    expect(child.getNode(1n)).toBe(firstNode);
    expect(boundary.materialize()).toBe(nodes);
  });

  it("applies retained inverse and forward deltas across a rebased boundary", () => {
    const initial = { ...makeNode(1n, 10n), attributes: { radius: [1] } };
    let s62 = createCompleteSkeletonSnapshot([initial]);
    for (let edit = 1; edit <= 62; ++edit) {
      s62 = patchCompleteSkeletonSnapshot(s62, [
        {
          kind: "update",
          nodeId: 1n,
          changes: { description: `edit ${edit}` },
        },
      ]);
    }
    const s63 = patchCompleteSkeletonSnapshot(s62, [
      { kind: "update", nodeId: 1n, changes: { attributes: { radius: [2] } } },
    ]);
    const s64 = patchCompleteSkeletonSnapshot(s63, [
      {
        kind: "update",
        nodeId: 1n,
        changes: { position: Object.freeze([9, 10, 11]) },
      },
    ]);
    const s63BeforeRebase = s63.materialize();
    const s64Nodes = s64.materialize();

    const undo64 = patchCompleteSkeletonSnapshot(s64, [
      {
        kind: "update",
        nodeId: 1n,
        changes: { position: Object.freeze([1, 2, 3]) },
      },
    ]);
    const undo63 = patchCompleteSkeletonSnapshot(undo64, [
      { kind: "update", nodeId: 1n, changes: { attributes: { radius: [1] } } },
    ]);

    expect(undo64.materialize()).toEqual(s63BeforeRebase);
    expect(undo63.materialize()).toEqual(s62.materialize());
    expect(s63.materialize()).toBe(s63BeforeRebase);
    expect(s63.getNode(1n)).toBe(s63BeforeRebase[0]);

    const redo63 = patchCompleteSkeletonSnapshot(undo63, [
      { kind: "update", nodeId: 1n, changes: { attributes: { radius: [2] } } },
    ]);
    const redo64 = patchCompleteSkeletonSnapshot(redo63, [
      {
        kind: "update",
        nodeId: 1n,
        changes: { position: Object.freeze([9, 10, 11]) },
      },
    ]);
    expect(redo63.materialize()).toEqual(s63BeforeRebase);
    expect(redo64.materialize()).toEqual(s64Nodes);
  });

  it("builds thousands of lazy patches without unbounded traversal", () => {
    let snapshot = createCompleteSkeletonSnapshot([makeNode(1n, 10n)]);
    for (let edit = 1; edit <= 4096; ++edit) {
      snapshot = patchCompleteSkeletonSnapshot(snapshot, [
        {
          kind: "update",
          nodeId: 1n,
          changes: { attributes: { radius: [edit] } },
        },
      ]);
    }
    expect(getSkeletonNodeRadius(snapshot.getNode(1n)!)).toBe(4096);
    expect(getSkeletonNodeRadius(snapshot.materialize()[0])).toBe(4096);
  });

  it("rebases deep remap, split, and merge projections without changing topology", () => {
    let snapshot = createCompleteSkeletonSnapshot([
      makeNode(1n, 10n),
      makeNode(2n, 10n, 1n),
      makeNode(3n, 10n, 2n),
    ]);
    for (let edit = 1; edit <= 63; ++edit) {
      snapshot = patchCompleteSkeletonSnapshot(snapshot, [
        {
          kind: "update",
          nodeId: 3n,
          changes: { attributes: { confidence: [edit] } },
        },
      ]);
    }
    const remapped = remapCompleteSkeletonSnapshot(snapshot, {
      nodeIds: new Map([
        [1n, 101n],
        [2n, 102n],
        [3n, 103n],
      ]),
      segmentIds: new Map([[10n, 110n]]),
    });
    const remappedNodes = remapped.materialize();
    expect(remappedNodes).toMatchObject([
      { nodeId: 101n, segmentId: 110n, parentNodeId: undefined },
      { nodeId: 102n, segmentId: 110n, parentNodeId: 101n },
      {
        nodeId: 103n,
        segmentId: 110n,
        parentNodeId: 102n,
        attributes: { confidence: [63] },
      },
    ]);

    const { selected, remainder } = splitCompleteSkeletonSnapshot(remapped, [
      102n,
      103n,
    ]);
    const merged = mergeCompleteSkeletonSnapshots([
      { snapshot: remainder },
      { snapshot: selected },
    ]);
    expect(merged.materialize()).toEqual(remappedNodes);
    expect(remapped.materialize()).toBe(remappedNodes);
  });

  it("counts a merge override patch as an additional projection level", () => {
    let source = createCompleteSkeletonSnapshot([makeNode(1n, 10n)]);
    for (let edit = 1; edit <= 62; ++edit) {
      source = patchCompleteSkeletonSnapshot(source, [
        {
          kind: "update",
          nodeId: 1n,
          changes: { attributes: { confidence: [edit] } },
        },
      ]);
    }
    const merged = mergeCompleteSkeletonSnapshots([{ snapshot: source }], {
      overrides: [
        { nodeId: 1n, changes: { position: Object.freeze([7, 7, 7]) } },
      ],
    });
    expect(merged.materializationCount).toBe(0);

    const child = patchCompleteSkeletonSnapshot(merged, [
      { kind: "update", nodeId: 1n, changes: { description: "after merge" } },
    ]);

    expect(merged.materializationCount).toBe(1);
    expect(child.getNode(1n)).toMatchObject({
      attributes: { confidence: [62] },
      position: [7, 7, 7],
      description: "after merge",
    });
  });

  it("rejects invalid patches, memberships, and overlapping merges", () => {
    expect(() =>
      createCompleteSkeletonSnapshot([makeNode(1n, 10n), makeNode(1n, 10n)]),
    ).toThrow(/duplicate node 1/);

    const first = createCompleteSkeletonSnapshot([makeNode(1n, 10n)]);
    expect(() =>
      patchCompleteSkeletonSnapshot(first, [
        {
          kind: "update",
          nodeId: 2n,
          changes: { attributes: { radius: [1] } },
        },
      ]),
    ).toThrow(/update missing.*2/);
    expect(() => splitCompleteSkeletonSnapshot(first, [2n])).toThrow(
      /missing.*2.*split view/,
    );

    const duplicate = createCompleteSkeletonSnapshot([makeNode(1n, 20n)]);
    expect(() =>
      mergeCompleteSkeletonSnapshots([
        { snapshot: first },
        { snapshot: duplicate },
      ]),
    ).toThrow(/merge.*duplicate node 1/);
  });
});
