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
  createCompleteSkeleton,
  patchCompleteSkeleton,
  remapCompleteSkeleton,
} from "#src/skeleton/edit_queue/complete_skeleton.js";
import type {
  SpatialSkeletonEditDelta,
  SpatialSkeletonEditForwardDelta,
} from "#src/skeleton/edit_queue/complete_skeleton_edits.js";
import {
  applySpatialSkeletonEditDelta,
  CompleteSkeletonSet,
} from "#src/skeleton/edit_queue/complete_skeleton_edits.js";
import type {
  SpatialSkeletonStableNodeHandle,
  SpatialSkeletonStableSegmentHandle,
} from "#src/skeleton/edit_queue/stable_id_handles.js";
import {
  SpatialSkeletonStableIdHandles,
  spatialSkeletonStableNode,
  spatialSkeletonStableSegment,
} from "#src/skeleton/edit_queue/stable_id_handles.js";
import {
  getSkeletonNodeConfidence,
  getSkeletonNodeRadius,
  isSkeletonNodeTrueEnd,
} from "#src/skeleton/node_attributes.js";
import { bigintCompare } from "#src/util/bigint.js";

function node(
  nodeId: bigint,
  segmentId: bigint,
  parentNodeId?: bigint,
  options: Partial<SkeletonNode> = {},
): SkeletonNode {
  return {
    nodeId,
    segmentId,
    parentNodeId,
    position: [Number(nodeId), Number(nodeId) + 0.25, Number(nodeId) + 0.5],
    attributes: {
      confidence: [
        parentNodeId === undefined ? 100 : 70 + Number(nodeId % 20n),
      ],
    },
    ...options,
  };
}

interface Fixture {
  mappings: SpatialSkeletonStableIdHandles<bigint, bigint>;
  baseline: CompleteSkeletonSet;
  segmentA: SpatialSkeletonStableSegmentHandle;
  segmentB: SpatialSkeletonStableSegmentHandle;
  segmentC: SpatialSkeletonStableSegmentHandle;
  splitSegment: SpatialSkeletonStableSegmentHandle;
  nodes: Record<string, SpatialSkeletonStableNodeHandle>;
}

function fixture(): Fixture {
  const mappings = new SpatialSkeletonStableIdHandles<bigint, bigint>();
  const segmentA = spatialSkeletonStableSegment("A");
  const segmentB = spatialSkeletonStableSegment("B");
  const segmentC = spatialSkeletonStableSegment("C");
  const splitSegment = spatialSkeletonStableSegment("A:split");
  mappings.apply({
    segments: [
      [segmentA, 10n],
      [segmentB, 20n],
      [segmentC, 30n],
      [splitSegment, 31n],
    ],
  });
  const nodes = Object.fromEntries(
    [1, 2, 3, 4, 10, 11, 12, 100, 101, 200].map((id) => [
      `n${id}`,
      spatialSkeletonStableNode(`node:${id}`),
    ]),
  );
  mappings.apply({
    nodes: Object.entries(nodes).map(([key, handle]) => [
      handle,
      BigInt(key.slice(1)),
    ]),
  });
  const baseline = new CompleteSkeletonSet([
    {
      segment: segmentA,
      snapshot: createCompleteSkeleton([
        node(1n, 10n),
        node(2n, 10n, 1n),
        node(3n, 10n, 2n),
        node(4n, 10n, 2n),
      ]),
    },
    {
      segment: segmentB,
      snapshot: createCompleteSkeleton([
        node(10n, 20n),
        node(11n, 20n, 10n),
        node(12n, 20n, 11n),
      ]),
    },
  ]);
  return {
    mappings,
    baseline,
    segmentA,
    segmentB,
    segmentC,
    splitSegment,
    nodes,
  };
}

function normalized(preview: CompleteSkeletonSet) {
  return preview.segments
    .map(({ segment, snapshot }) => ({
      segment: segment.stableId,
      nodes: snapshot
        .materialize()
        .map((value) => ({
          nodeId: value.nodeId,
          segmentId: value.segmentId,
          parentNodeId: value.parentNodeId,
          position: Array.from(value.position),
          radius: getSkeletonNodeRadius(value),
          confidence: getSkeletonNodeConfidence(value),
          description: value.description,
          isTrueEnd: isSkeletonNodeTrueEnd(value),
        }))
        .sort((a, b) => bigintCompare(a.nodeId, b.nodeId)),
    }))
    .sort((a, b) => a.segment.localeCompare(b.segment));
}

function deepenSnapshotToCheckpointBoundary(
  preview: CompleteSkeletonSet,
  segment: SpatialSkeletonStableSegmentHandle,
  nodeId: bigint,
) {
  let snapshot = preview.getSegment(segment)!.snapshot;
  for (let depth = 1; depth < 64; ++depth) {
    snapshot = patchCompleteSkeleton(snapshot, [
      {
        kind: "update",
        nodeId,
        changes: { description: `checkpoint-${depth}` },
      },
    ]);
  }
  return preview.withChanges([{ segment, snapshot }]);
}

function expectRoundTrip(delta: SpatialSkeletonEditForwardDelta) {
  const { baseline, mappings } = fixture();
  const applied = applySpatialSkeletonEditDelta(baseline, delta, mappings);
  const restored = applySpatialSkeletonEditDelta(
    applied.edit,
    applied.inverseDelta,
    mappings,
  );
  expect(normalized(restored.edit)).toEqual(normalized(baseline));
}

describe("complete skeleton edits", () => {
  it("Undo restores the skeleton after every kind of edit", () => {
    const {
      segmentA,
      segmentB,
      segmentC,
      splitSegment,
      nodes: { n1, n2, n3, n10, n12, n100, n200 },
    } = fixture();
    const actions: SpatialSkeletonEditForwardDelta[] = [
      {
        kind: "add",
        segment: segmentA,
        node: n100,
        parent: n3,
        position: [4, 5, 6],
        attributes: { confidence: 88, radius: 2 },
      },
      {
        kind: "add",
        segment: segmentC,
        node: n200,
        position: [20, 21, 22],
      },
      { kind: "move", segment: segmentA, node: n3, position: [90, 91, 92] },
      { kind: "delete", segment: segmentA, node: n2 },
      { kind: "reroot", segment: segmentA, node: n3 },
      {
        kind: "node-attributes",
        segment: segmentA,
        node: n3,
        changes: {
          radius: 9,
          confidence: 42,
          description: "annotated",
          isTrueEnd: true,
        },
      },
      {
        kind: "split",
        sourceSegment: segmentA,
        downstreamSegment: splitSegment,
        node: n2,
      },
      {
        kind: "merge",
        firstSegment: segmentA,
        secondSegment: segmentB,
        resultSegment: segmentA,
        firstNode: n3,
        secondNode: n12,
      },
    ];
    for (const action of actions) expectRoundTrip(action);

    // Keep a direct reference to every logical identity used above so this
    // test also guards accidental physical-id fields in public deltas.
    expect([n1, n10].every(({ kind }) => kind === "node")).toBe(true);
  });

  it("an edit after a split counts the split as one level", () => {
    const { baseline, mappings, segmentA, splitSegment, nodes } = fixture();
    const split = applySpatialSkeletonEditDelta(
      baseline,
      {
        kind: "split",
        sourceSegment: segmentA,
        downstreamSegment: splitSegment,
        node: nodes.n2,
      },
      mappings,
    );
    const sourceSnapshot = split.edit.getSegment(segmentA)!.snapshot;
    const downstreamSnapshot = split.edit.getSegment(splitSegment)!.snapshot;
    expect(sourceSnapshot.materializationCount).toBe(0);
    expect(downstreamSnapshot.materializationCount).toBe(0);

    const revisions = [sourceSnapshot];
    let preview = split.edit;
    for (let index = 0; index < 64; ++index) {
      const result = applySpatialSkeletonEditDelta(
        preview,
        {
          kind: "move",
          segment: segmentA,
          node: nodes.n1,
          position: [index, index + 1, index + 2],
        },
        mappings,
      );
      preview = result.edit;
      revisions.push(preview.getSegment(segmentA)!.snapshot);
    }
    // One source reaches depth 64 and is materialized/rebased before the next
    // reducer delta derives another lazy handle from it.
    const checkpoint = revisions.filter(
      ({ materializationCount }) => materializationCount !== 0,
    );
    expect(checkpoint).toHaveLength(1);
    expect(revisions.at(-1)?.materializationCount).toBe(0);
    const latestNodes = preview.getSegment(segmentA)?.snapshot.materialize();
    expect(latestNodes?.find(({ nodeId }) => nodeId === 1n)?.position).toEqual([
      63, 64, 65,
    ]);
    expect(
      revisions.filter(
        ({ materializationCount }) => materializationCount !== 0,
      ),
    ).toEqual([checkpoint[0], revisions.at(-1)]);
    expect(revisions.at(-1)?.materializationCount).toBe(1);
  });

  it.each([
    {
      name: "skeleton splitting",
      delta: ({ segmentA, splitSegment, nodes }: Fixture) =>
        ({
          kind: "split",
          sourceSegment: segmentA,
          downstreamSegment: splitSegment,
          node: nodes.n2,
        }) satisfies SpatialSkeletonEditForwardDelta,
    },
    {
      name: "skeleton merging",
      delta: ({ segmentA, segmentB, nodes }: Fixture) =>
        ({
          kind: "merge",
          firstSegment: segmentA,
          secondSegment: segmentB,
          resultSegment: segmentA,
          firstNode: nodes.n3,
          secondNode: nodes.n12,
        }) satisfies SpatialSkeletonEditForwardDelta,
    },
  ])("Undo and Redo of $name work on a long-edited skeleton", ({ delta }) => {
    const state = fixture();
    const checkpointInput = deepenSnapshotToCheckpointBoundary(
      state.baseline,
      state.segmentA,
      1n,
    );
    const before = normalized(checkpointInput);
    const forwardDelta = delta(state);

    const executed = applySpatialSkeletonEditDelta(
      checkpointInput,
      forwardDelta,
      state.mappings,
    );
    const after = normalized(executed.edit);
    const undone = applySpatialSkeletonEditDelta(
      executed.edit,
      executed.inverseDelta,
      state.mappings,
    );
    expect(normalized(undone.edit)).toEqual(before);

    const redone = applySpatialSkeletonEditDelta(
      undone.edit,
      forwardDelta,
      state.mappings,
    );
    expect(normalized(redone.edit)).toEqual(after);
  });

  it("Undo and Redo of an added node use the ID the server assigned", () => {
    const state = fixture();
    const checkpointInput = deepenSnapshotToCheckpointBoundary(
      state.baseline,
      state.segmentA,
      1n,
    );
    const before = normalized(checkpointInput);
    const forwardDelta = {
      kind: "add",
      segment: state.segmentA,
      node: state.nodes.n100,
      parent: state.nodes.n3,
      position: [40, 41, 42],
    } satisfies SpatialSkeletonEditForwardDelta;
    const executed = applySpatialSkeletonEditDelta(
      checkpointInput,
      forwardDelta,
      state.mappings,
    );

    const provisionalNodeId = state.mappings.resolveNode(state.nodes.n100)!;
    const authoritativeNodeId = 900n;
    const authoritativeSnapshot = remapCompleteSkeleton(
      executed.edit.getSegment(state.segmentA)!.snapshot,
      { nodeIds: new Map([[provisionalNodeId, authoritativeNodeId]]) },
    );
    state.mappings.bindNodes([[state.nodes.n100, authoritativeNodeId]]);
    const authoritativePreview = executed.edit.withChanges([
      { segment: state.segmentA, snapshot: authoritativeSnapshot },
    ]);
    const afterAuthority = normalized(authoritativePreview);
    expect(
      authoritativePreview
        .getSegment(state.segmentA)
        ?.snapshot?.getNode(authoritativeNodeId),
    ).toMatchObject({ parentNodeId: 3n, position: [40, 41, 42] });

    const undone = applySpatialSkeletonEditDelta(
      authoritativePreview,
      executed.inverseDelta,
      state.mappings,
    );
    expect(normalized(undone.edit)).toEqual(before);
    expect(
      undone.edit
        .getSegment(state.segmentA)
        ?.snapshot?.getNode(authoritativeNodeId),
    ).toBeUndefined();

    const redone = applySpatialSkeletonEditDelta(
      undone.edit,
      forwardDelta,
      state.mappings,
    );
    expect(normalized(redone.edit)).toEqual(afterAuthority);
    expect(
      redone.edit
        .getSegment(state.segmentA)
        ?.snapshot?.getNode(authoritativeNodeId),
    ).toBeDefined();
  });

  it.each([
    {
      name: "branch",
      cutNodeId: 2n,
      remainderIds: [1n, 5n, 6n],
      downstreamIds: [2n, 3n, 4n, 7n],
    },
    {
      name: "leaf",
      cutNodeId: 4n,
      remainderIds: [1n, 2n, 3n, 5n, 6n, 7n],
      downstreamIds: [4n],
    },
  ])(
    "splits a $name into exact partitions and preserves other branches",
    ({ cutNodeId, remainderIds, downstreamIds }) => {
      const { baseline, mappings, segmentA, segmentB, splitSegment, nodes } =
        fixture();
      // 1 -> 2 -> {3 -> 7, 4}; 1 -> 5 -> 6.
      const sourceNodes = [
        node(1n, 10n),
        node(2n, 10n, 1n, {
          attributes: { radius: [12], confidence: [72] },
          description: "branch",
        }),
        node(3n, 10n, 2n),
        node(4n, 10n, 2n),
        node(5n, 10n, 1n),
        node(6n, 10n, 5n),
        node(7n, 10n, 3n, {
          attributes: { confidence: [77], true_end: [1] },
        }),
      ];
      const snapshot = createCompleteSkeleton(sourceNodes);
      const input = baseline.withChanges([{ segment: segmentA, snapshot }]);
      const before = normalized(input);
      const mappingRevision = mappings.revision;
      const sourceById = new Map(
        sourceNodes.map((value) => [value.nodeId, value]),
      );

      const result = applySpatialSkeletonEditDelta(
        input,
        {
          kind: "split",
          sourceSegment: segmentA,
          downstreamSegment: splitSegment,
          node: nodes[`n${cutNodeId}`],
        },
        mappings,
      );

      expect(result.edit.getSegment(segmentA)!.snapshot.materialize()).toEqual(
        remainderIds.map((id) => sourceById.get(id)!),
      );
      expect(
        result.edit.getSegment(splitSegment)!.snapshot.materialize(),
      ).toEqual(
        downstreamIds.map((id) => ({
          ...sourceById.get(id)!,
          segmentId: 31n,
          ...(id === cutNodeId ? { parentNodeId: undefined } : {}),
        })),
      );
      expect(result.edit.getSegment(segmentB)!.snapshot).toBe(
        input.getSegment(segmentB)!.snapshot,
      );
      expect(result.edit.segments).toHaveLength(3);
      expect(normalized(input)).toEqual(before);
      expect(mappings.revision).toBe(mappingRevision);

      const restored = applySpatialSkeletonEditDelta(
        result.edit,
        result.inverseDelta,
        mappings,
      );
      expect(normalized(restored.edit)).toEqual(before);
    },
  );

  it.each([
    {
      name: "missing node",
      cutNodeId: 100n,
      error: /not present in the expected segment/,
    },
    { name: "topology cycle", cutNodeId: 2n, error: /topology cycle/ },
  ])(
    "rejects a Split with a $name without changing its input",
    ({ name, cutNodeId, error }) => {
      const { baseline, mappings, segmentA, splitSegment, nodes } = fixture();
      const input =
        name === "topology cycle"
          ? baseline.withChanges([
              {
                segment: segmentA,
                snapshot: createCompleteSkeleton([
                  node(1n, 10n, 3n),
                  node(2n, 10n, 1n),
                  node(3n, 10n, 2n),
                ]),
              },
            ])
          : baseline;
      const before = normalized(input);
      const snapshot = input.getSegment(segmentA)!.snapshot;
      const mappingRevision = mappings.revision;

      expect(() =>
        applySpatialSkeletonEditDelta(
          input,
          {
            kind: "split",
            sourceSegment: segmentA,
            downstreamSegment: splitSegment,
            node: nodes[`n${cutNodeId}`],
          },
          mappings,
        ),
      ).toThrow(error);

      expect(normalized(input)).toEqual(before);
      expect(input.getSegment(segmentA)!.snapshot).toBe(snapshot);
      expect(input.getSegment(splitSegment)).toBeUndefined();
      expect(mappings.revision).toBe(mappingRevision);
    },
  );

  it("refuses edits that would break the skeleton: a child of a true end, deleting a root with children, a split at the root, a true end that is not a leaf, a merge into itself, and a non-finite position", () => {
    const { baseline, mappings, segmentA, segmentB, splitSegment, nodes } =
      fixture();
    const trueEnd = applySpatialSkeletonEditDelta(
      baseline,
      {
        kind: "node-attributes",
        segment: segmentA,
        node: nodes.n3,
        changes: { isTrueEnd: true },
      },
      mappings,
    ).edit;
    expect(() =>
      applySpatialSkeletonEditDelta(
        trueEnd,
        {
          kind: "add",
          segment: segmentA,
          node: nodes.n100,
          parent: nodes.n3,
          position: [1, 2, 3],
        },
        mappings,
      ),
    ).toThrow(/true end/i);
    expect(() =>
      applySpatialSkeletonEditDelta(
        baseline,
        { kind: "delete", segment: segmentA, node: nodes.n1 },
        mappings,
      ),
    ).toThrow(/root node with children/i);
    expect(() =>
      applySpatialSkeletonEditDelta(
        baseline,
        {
          kind: "split",
          sourceSegment: segmentA,
          downstreamSegment: splitSegment,
          node: nodes.n1,
        },
        mappings,
      ),
    ).toThrow(/split at the root/i);
    expect(() =>
      applySpatialSkeletonEditDelta(
        baseline,
        {
          kind: "node-attributes",
          segment: segmentA,
          node: nodes.n2,
          changes: { isTrueEnd: true },
        },
        mappings,
      ),
    ).toThrow(/leaf nodes/i);
    expect(() =>
      applySpatialSkeletonEditDelta(
        baseline,
        {
          kind: "merge",
          firstSegment: segmentA,
          secondSegment: segmentA,
          resultSegment: segmentB,
          firstNode: nodes.n2,
          secondNode: nodes.n3,
        },
        mappings,
      ),
    ).toThrow(/itself/i);
    for (const position of [
      [],
      [Number.NaN, 1, 2],
      [1, Number.POSITIVE_INFINITY, 2],
    ]) {
      expect(() =>
        applySpatialSkeletonEditDelta(
          baseline,
          {
            kind: "move",
            segment: segmentA,
            node: nodes.n2,
            position,
          },
          mappings,
        ),
      ).toThrow(/finite coordinates/i);
    }
  });

  it("an edit still applies after the server renumbers its nodes or keeps the other skeleton in a merge", () => {
    const { mappings, segmentA, segmentB, nodes } = fixture();
    const resultSegment = spatialSkeletonStableSegment("merge:result");
    mappings.bindSegment(resultSegment, 20n);
    // CATMAID chose B as the physical winner. Both old logical segment handles
    // now alias the single result owner; queued deltas are unchanged.
    mappings.apply({
      segments: [
        [segmentA, 20n],
        [segmentB, 20n],
      ],
      nodes: [[nodes.n3, 303n]],
    });
    const baseline = new CompleteSkeletonSet([
      {
        segment: resultSegment,
        snapshot: createCompleteSkeleton([
          node(1n, 20n),
          node(2n, 20n, 1n),
          node(303n, 20n, 2n),
          node(10n, 20n, 303n),
          node(11n, 20n, 10n),
          node(12n, 20n, 11n),
        ]),
      },
    ]);
    const delta: SpatialSkeletonEditForwardDelta = {
      kind: "move",
      segment: segmentA,
      node: nodes.n3,
      position: [7, 8, 9],
    };
    const folded = applySpatialSkeletonEditDelta(baseline, delta, mappings);
    expect(
      folded.edit.getSegment(resultSegment)?.snapshot.getNode(303n)?.position,
    ).toEqual([7, 8, 9]);
    expect(delta.node).toBe(nodes.n3);
    expect(delta.segment).toBe(segmentA);
  });

  it("the shown skeleton always equals the saved skeleton plus the edits still pending", () => {
    type EagerNode = {
      nodeId: bigint;
      parentNodeId?: bigint;
      position: number[];
      radius?: number;
      confidence?: number;
    };
    type ModelIntent = {
      sequence: number;
      active?: boolean;
      delta: Extract<
        SpatialSkeletonEditDelta,
        { kind: "move" | "node-attributes" }
      >;
    };
    type HistoryEntry = {
      forward: ModelIntent["delta"];
      inverse: ModelIntent["delta"];
    };

    let seed = 0x5eeda11;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const modelSegment = spatialSkeletonStableSegment("model");
    const modelNodes = [1, 2, 3, 4].map((id) =>
      spatialSkeletonStableNode(`model-node:${id}`),
    );
    const mappings = new SpatialSkeletonStableIdHandles<bigint, bigint>();
    let idEpoch = 0;
    const bindEpoch = () => {
      const segmentId = BigInt(500 + idEpoch * 100);
      mappings.apply({
        segments: [[modelSegment, segmentId]],
        nodes: modelNodes.map((handle, index) => [
          handle,
          BigInt(index + 1 + idEpoch * 1000),
        ]),
      });
      return segmentId;
    };
    let segmentId = bindEpoch();
    let confirmed: EagerNode[] = modelNodes.map((_, index) => ({
      nodeId: BigInt(index + 1),
      parentNodeId: index === 0 ? undefined : BigInt(index),
      position: [index + 1, index + 2, index + 3],
      confidence: index === 0 ? 100 : 75,
    }));
    const buildBaseline = () =>
      new CompleteSkeletonSet([
        {
          segment: modelSegment,
          snapshot: createCompleteSkeleton(
            confirmed.map(({ radius, confidence, ...value }) => ({
              ...value,
              segmentId,
              attributes: {
                ...(radius === undefined ? {} : { radius: [radius] }),
                ...(confidence === undefined
                  ? {}
                  : { confidence: [confidence] }),
              },
            })),
          ),
        },
      ]);
    let baseline = buildBaseline();
    let sequence = 0;
    const intents: ModelIntent[] = [];
    const history: HistoryEntry[] = [];
    let historyCursor = 0;

    const applyEager = (nodes: EagerNode[], delta: ModelIntent["delta"]) => {
      const nodeIndex = modelNodes.findIndex(
        (handle) => handle.stableId === delta.node.stableId,
      );
      const target = nodes[nodeIndex];
      if (delta.kind === "move") {
        target.position = Array.from(delta.position);
        return;
      }
      for (const key of Object.keys(delta.changes) as (
        | "radius"
        | "confidence"
      )[]) {
        Object.assign(target, { [key]: delta.changes[key] });
      }
    };
    const expectedPreview = () => {
      const nodes = confirmed.map((value) => ({
        ...value,
        position: [...value.position],
      }));
      for (const intent of intents) {
        if (intent.active !== false) applyEager(nodes, intent.delta);
      }
      return nodes;
    };
    const appendIntent = (delta: ModelIntent["delta"]) => {
      intents.push({ sequence: ++sequence, delta });
    };
    const currentPreview = () =>
      intents.reduce(
        (preview, intent) =>
          intent.active === false
            ? preview
            : applySpatialSkeletonEditDelta(preview, intent.delta, mappings)
                .edit,
        baseline,
      );

    for (let step = 0; step < 350; ++step) {
      const choice = random();
      if (choice < 0.43) {
        const nodeIndex = Math.floor(random() * modelNodes.length);
        const forward: ModelIntent["delta"] =
          random() < 0.55
            ? {
                kind: "move",
                segment: modelSegment,
                node: modelNodes[nodeIndex],
                position: [step, step + nodeIndex, step - nodeIndex],
              }
            : {
                kind: "node-attributes",
                segment: modelSegment,
                node: modelNodes[nodeIndex],
                changes:
                  random() < 0.5
                    ? { radius: step / 10 }
                    : { confidence: step % 101 },
              };
        const inverse = applySpatialSkeletonEditDelta(
          currentPreview(),
          forward,
          mappings,
        ).inverseDelta as ModelIntent["delta"];
        history.splice(historyCursor);
        history.push({ forward, inverse });
        ++historyCursor;
        appendIntent(forward);
      } else if (choice < 0.57 && historyCursor > 0) {
        appendIntent(history[--historyCursor].inverse);
      } else if (choice < 0.67 && historyCursor < history.length) {
        appendIntent(history[historyCursor++].forward);
      } else if (choice < 0.79) {
        const firstActive = intents.find(({ active }) => active !== false);
        if (firstActive !== undefined) {
          applyEager(confirmed, firstActive.delta);
          firstActive.active = false;
          baseline = applySpatialSkeletonEditDelta(
            baseline,
            firstActive.delta,
            mappings,
          ).edit;
        }
      } else if (choice < 0.91) {
        const active = intents.filter(({ active }) => active !== false);
        const rejected = active[Math.floor(random() * active.length)];
        if (rejected !== undefined) rejected.active = false;
      } else {
        const expected = expectedPreview();
        // First promote all active semantic state so only physical identities
        // change. The exact same logical deltas work in the next epoch.
        confirmed = expected;
        for (const intent of intents) intent.active = false;
        ++idEpoch;
        segmentId = bindEpoch();
        confirmed = confirmed.map((value, index) => ({
          ...value,
          nodeId: BigInt(index + 1 + idEpoch * 1000),
          parentNodeId:
            value.parentNodeId === undefined
              ? undefined
              : value.parentNodeId + 1000n,
        }));
        baseline = buildBaseline();
      }

      const expected = expectedPreview();
      const actualSnapshot =
        currentPreview().getSegment(modelSegment)!.snapshot;
      for (let index = 0; index < modelNodes.length; ++index) {
        const physicalId = mappings.resolveNode(modelNodes[index])!;
        const actual = actualSnapshot.getNode(physicalId)!;
        expect(
          Array.from(actual.position),
          `step ${step}, node ${index}`,
        ).toEqual(expected[index].position);
        expect(
          getSkeletonNodeRadius(actual),
          `step ${step}, node ${index} radius`,
        ).toBe(expected[index].radius);
        expect(
          getSkeletonNodeConfidence(actual),
          `step ${step}, node ${index} confidence`,
        ).toBe(expected[index].confidence);
      }
    }
  });
});
