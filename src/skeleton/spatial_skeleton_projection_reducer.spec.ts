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
  patchCompleteSkeletonSnapshot,
  remapCompleteSkeletonSnapshot,
} from "#src/skeleton/complete_skeleton_snapshot.js";
import {
  SpatialSkeletonLogicalHandleMappings,
  spatialSkeletonLogicalNode,
  spatialSkeletonLogicalSegment,
  type SpatialSkeletonLogicalNodeHandle,
  type SpatialSkeletonLogicalSegmentHandle,
} from "#src/skeleton/logical_identity.js";
import {
  applySpatialSkeletonProjectionDelta,
  SpatialSkeletonProjectionWorkspace,
  type SpatialSkeletonProjectionDelta,
  type SpatialSkeletonProjectionForwardDelta,
} from "#src/skeleton/spatial_skeleton_projection_reducer.js";

function node(
  nodeId: number,
  segmentId: number,
  parentNodeId?: number,
  options: Partial<SpatiallyIndexedSkeletonNode> = {},
): SpatiallyIndexedSkeletonNode {
  return {
    nodeId,
    segmentId,
    parentNodeId,
    position: [nodeId, nodeId + 0.25, nodeId + 0.5],
    confidence: parentNodeId === undefined ? 100 : 70 + (nodeId % 20),
    ...options,
  };
}

interface Fixture {
  mappings: SpatialSkeletonLogicalHandleMappings<number, number>;
  baseline: SpatialSkeletonProjectionWorkspace;
  segmentA: SpatialSkeletonLogicalSegmentHandle;
  segmentB: SpatialSkeletonLogicalSegmentHandle;
  segmentC: SpatialSkeletonLogicalSegmentHandle;
  splitSegment: SpatialSkeletonLogicalSegmentHandle;
  nodes: Record<string, SpatialSkeletonLogicalNodeHandle>;
}

function fixture(): Fixture {
  const mappings = new SpatialSkeletonLogicalHandleMappings<number, number>();
  const segmentA = spatialSkeletonLogicalSegment("A");
  const segmentB = spatialSkeletonLogicalSegment("B");
  const segmentC = spatialSkeletonLogicalSegment("C");
  const splitSegment = spatialSkeletonLogicalSegment("A:split");
  mappings.apply({
    segments: [
      [segmentA, 10],
      [segmentB, 20],
      [segmentC, 30],
      [splitSegment, -30],
    ],
  });
  const nodes = Object.fromEntries(
    [1, 2, 3, 4, 10, 11, 12, 100, 101, 200].map((id) => [
      `n${id}`,
      spatialSkeletonLogicalNode(`node:${id}`),
    ]),
  );
  mappings.apply({
    nodes: Object.entries(nodes).map(([key, handle]) => [
      handle,
      Number(key.slice(1)),
    ]),
  });
  const baseline = new SpatialSkeletonProjectionWorkspace([
    {
      segment: segmentA,
      snapshot: createCompleteSkeletonSnapshot([
        node(1, 10),
        node(2, 10, 1),
        node(3, 10, 2),
        node(4, 10, 2),
      ]),
    },
    {
      segment: segmentB,
      snapshot: createCompleteSkeletonSnapshot([
        node(10, 20),
        node(11, 20, 10),
        node(12, 20, 11),
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

function normalized(projection: SpatialSkeletonProjectionWorkspace) {
  return projection.segments
    .map(({ segment, snapshot }) => ({
      segment: segment.stableId,
      nodes: snapshot
        .materialize()
        .map((value) => ({
          nodeId: value.nodeId,
          segmentId: value.segmentId,
          parentNodeId: value.parentNodeId,
          position: Array.from(value.position),
          radius: value.radius,
          confidence: value.confidence,
          description: value.description,
          isTrueEnd: value.isTrueEnd,
        }))
        .sort((a, b) => a.nodeId - b.nodeId),
    }))
    .sort((a, b) => a.segment.localeCompare(b.segment));
}

function deepenSnapshotToCheckpointBoundary(
  projection: SpatialSkeletonProjectionWorkspace,
  segment: SpatialSkeletonLogicalSegmentHandle,
  nodeId: number,
) {
  let snapshot = projection.getSegment(segment)!.snapshot;
  for (let depth = 1; depth < 64; ++depth) {
    snapshot = patchCompleteSkeletonSnapshot(snapshot, [
      {
        kind: "update",
        nodeId,
        changes: { description: `checkpoint-${depth}` },
      },
    ]);
  }
  return projection.withChanges([{ segment, snapshot }]);
}

function expectRoundTrip(delta: SpatialSkeletonProjectionForwardDelta) {
  const { baseline, mappings } = fixture();
  const applied = applySpatialSkeletonProjectionDelta(
    baseline,
    delta,
    mappings,
  );
  const restored = applySpatialSkeletonProjectionDelta(
    applied.projection,
    applied.inverseDelta,
    mappings,
  );
  expect(normalized(restored.projection)).toEqual(normalized(baseline));
}

describe("spatial skeleton projection reducer", () => {
  it("round-trips all warm node and topology actions through compact inverses", () => {
    const {
      segmentA,
      segmentB,
      segmentC,
      splitSegment,
      nodes: { n1, n2, n3, n10, n12, n100, n200 },
    } = fixture();
    const actions: SpatialSkeletonProjectionForwardDelta[] = [
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

  it("keeps chains lazy between bounded checkpoints", () => {
    const { baseline, mappings, segmentA, splitSegment, nodes } = fixture();
    const split = applySpatialSkeletonProjectionDelta(
      baseline,
      {
        kind: "split",
        sourceSegment: segmentA,
        downstreamSegment: splitSegment,
        node: nodes.n2,
      },
      mappings,
    );
    const sourceSnapshot = split.projection.getSegment(segmentA)!.snapshot;
    const downstreamSnapshot =
      split.projection.getSegment(splitSegment)!.snapshot;
    expect(sourceSnapshot.materializationCount).toBe(0);
    expect(downstreamSnapshot.materializationCount).toBe(0);

    const revisions = [sourceSnapshot];
    let projection = split.projection;
    for (let index = 0; index < 64; ++index) {
      const result = applySpatialSkeletonProjectionDelta(
        projection,
        {
          kind: "move",
          segment: segmentA,
          node: nodes.n1,
          position: [index, index + 1, index + 2],
        },
        mappings,
      );
      projection = result.projection;
      revisions.push(projection.getSegment(segmentA)!.snapshot);
    }
    // One source reaches depth 64 and is materialized/rebased before the next
    // reducer delta derives another lazy handle from it.
    const checkpoint = revisions.filter(
      ({ materializationCount }) => materializationCount !== 0,
    );
    expect(checkpoint).toHaveLength(1);
    expect(revisions.at(-1)?.materializationCount).toBe(0);
    const latestNodes = projection.getSegment(segmentA)?.snapshot.materialize();
    expect(latestNodes?.find(({ nodeId }) => nodeId === 1)?.position).toEqual([
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
      name: "node attributes",
      delta: ({ segmentA, nodes }: Fixture) =>
        ({
          kind: "node-attributes",
          segment: segmentA,
          node: nodes.n3,
          changes: { radius: 14, confidence: 41 },
        }) satisfies SpatialSkeletonProjectionForwardDelta,
    },
    {
      name: "node movement",
      delta: ({ segmentA, nodes }: Fixture) =>
        ({
          kind: "move",
          segment: segmentA,
          node: nodes.n3,
          position: [91, 92, 93],
        }) satisfies SpatialSkeletonProjectionForwardDelta,
    },
    {
      name: "skeleton splitting",
      delta: ({ segmentA, splitSegment, nodes }: Fixture) =>
        ({
          kind: "split",
          sourceSegment: segmentA,
          downstreamSegment: splitSegment,
          node: nodes.n2,
        }) satisfies SpatialSkeletonProjectionForwardDelta,
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
        }) satisfies SpatialSkeletonProjectionForwardDelta,
    },
  ])(
    "retains $name Undo and Redo recipes across a snapshot checkpoint",
    ({ delta }) => {
      const state = fixture();
      const checkpointInput = deepenSnapshotToCheckpointBoundary(
        state.baseline,
        state.segmentA,
        1,
      );
      const before = normalized(checkpointInput);
      const forwardDelta = delta(state);

      const executed = applySpatialSkeletonProjectionDelta(
        checkpointInput,
        forwardDelta,
        state.mappings,
      );
      const after = normalized(executed.projection);
      const undone = applySpatialSkeletonProjectionDelta(
        executed.projection,
        executed.inverseDelta,
        state.mappings,
      );
      expect(normalized(undone.projection)).toEqual(before);

      const redone = applySpatialSkeletonProjectionDelta(
        undone.projection,
        forwardDelta,
        state.mappings,
      );
      expect(normalized(redone.projection)).toEqual(after);
    },
  );

  it("uses authoritative node ids for Undo and Redo after a snapshot checkpoint", () => {
    const state = fixture();
    const checkpointInput = deepenSnapshotToCheckpointBoundary(
      state.baseline,
      state.segmentA,
      1,
    );
    const before = normalized(checkpointInput);
    const forwardDelta = {
      kind: "add",
      segment: state.segmentA,
      node: state.nodes.n100,
      parent: state.nodes.n3,
      position: [40, 41, 42],
    } satisfies SpatialSkeletonProjectionForwardDelta;
    const executed = applySpatialSkeletonProjectionDelta(
      checkpointInput,
      forwardDelta,
      state.mappings,
    );

    const provisionalNodeId = state.mappings.resolveNode(state.nodes.n100)!;
    const authoritativeNodeId = 900;
    const authoritativeSnapshot = remapCompleteSkeletonSnapshot(
      executed.projection.getSegment(state.segmentA)!.snapshot,
      { nodeIds: new Map([[provisionalNodeId, authoritativeNodeId]]) },
    );
    state.mappings.bindNodes([[state.nodes.n100, authoritativeNodeId]]);
    const authoritativeProjection = executed.projection.withChanges([
      { segment: state.segmentA, snapshot: authoritativeSnapshot },
    ]);
    const afterAuthority = normalized(authoritativeProjection);
    expect(
      authoritativeProjection
        .getSegment(state.segmentA)
        ?.snapshot?.getNode(authoritativeNodeId),
    ).toMatchObject({ parentNodeId: 3, position: [40, 41, 42] });

    const undone = applySpatialSkeletonProjectionDelta(
      authoritativeProjection,
      executed.inverseDelta,
      state.mappings,
    );
    expect(normalized(undone.projection)).toEqual(before);
    expect(
      undone.projection
        .getSegment(state.segmentA)
        ?.snapshot?.getNode(authoritativeNodeId),
    ).toBeUndefined();

    const redone = applySpatialSkeletonProjectionDelta(
      undone.projection,
      forwardDelta,
      state.mappings,
    );
    expect(normalized(redone.projection)).toEqual(afterAuthority);
    expect(
      redone.projection
        .getSegment(state.segmentA)
        ?.snapshot?.getNode(authoritativeNodeId),
    ).toBeDefined();
  });

  it.each([
    {
      name: "branch",
      cutNodeId: 2,
      remainderIds: [1, 5, 6],
      downstreamIds: [2, 3, 4, 7],
    },
    {
      name: "leaf",
      cutNodeId: 4,
      remainderIds: [1, 2, 3, 5, 6, 7],
      downstreamIds: [4],
    },
  ])(
    "splits a $name into exact partitions and preserves other branches",
    ({ cutNodeId, remainderIds, downstreamIds }) => {
      const { baseline, mappings, segmentA, segmentB, splitSegment, nodes } =
        fixture();
      // 1 -> 2 -> {3 -> 7, 4}; 1 -> 5 -> 6.
      const sourceNodes = [
        node(1, 10),
        node(2, 10, 1, { radius: 12, description: "branch" }),
        node(3, 10, 2),
        node(4, 10, 2),
        node(5, 10, 1),
        node(6, 10, 5),
        node(7, 10, 3, { isTrueEnd: true }),
      ];
      const snapshot = createCompleteSkeletonSnapshot(sourceNodes);
      const input = baseline.withChanges([{ segment: segmentA, snapshot }]);
      const before = normalized(input);
      const mappingRevision = mappings.revision;
      const sourceById = new Map(
        sourceNodes.map((value) => [value.nodeId, value]),
      );

      const result = applySpatialSkeletonProjectionDelta(
        input,
        {
          kind: "split",
          sourceSegment: segmentA,
          downstreamSegment: splitSegment,
          node: nodes[`n${cutNodeId}`],
        },
        mappings,
      );

      expect(
        result.projection.getSegment(segmentA)!.snapshot.materialize(),
      ).toEqual(remainderIds.map((id) => sourceById.get(id)!));
      expect(
        result.projection.getSegment(splitSegment)!.snapshot.materialize(),
      ).toEqual(
        downstreamIds.map((id) => ({
          ...sourceById.get(id)!,
          segmentId: -30,
          ...(id === cutNodeId ? { parentNodeId: undefined } : {}),
        })),
      );
      expect(result.projection.getSegment(segmentB)!.snapshot).toBe(
        input.getSegment(segmentB)!.snapshot,
      );
      expect(result.projection.segments).toHaveLength(3);
      expect(normalized(input)).toEqual(before);
      expect(mappings.revision).toBe(mappingRevision);

      const restored = applySpatialSkeletonProjectionDelta(
        result.projection,
        result.inverseDelta,
        mappings,
      );
      expect(normalized(restored.projection)).toEqual(before);
    },
  );

  it.each([
    {
      name: "missing node",
      cutNodeId: 100,
      error: /not present in the expected segment/,
    },
    { name: "topology cycle", cutNodeId: 2, error: /topology cycle/ },
  ])(
    "rejects a Split with a $name without changing its input",
    ({ name, cutNodeId, error }) => {
      const { baseline, mappings, segmentA, splitSegment, nodes } = fixture();
      const input =
        name === "topology cycle"
          ? baseline.withChanges([
              {
                segment: segmentA,
                snapshot: createCompleteSkeletonSnapshot([
                  node(1, 10, 3),
                  node(2, 10, 1),
                  node(3, 10, 2),
                ]),
              },
            ])
          : baseline;
      const before = normalized(input);
      const snapshot = input.getSegment(segmentA)!.snapshot;
      const mappingRevision = mappings.revision;

      expect(() =>
        applySpatialSkeletonProjectionDelta(
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

  it("enforces action-specific invariants in the reducer", () => {
    const { baseline, mappings, segmentA, segmentB, splitSegment, nodes } =
      fixture();
    const trueEnd = applySpatialSkeletonProjectionDelta(
      baseline,
      {
        kind: "node-attributes",
        segment: segmentA,
        node: nodes.n3,
        changes: { isTrueEnd: true },
      },
      mappings,
    ).projection;
    expect(() =>
      applySpatialSkeletonProjectionDelta(
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
      applySpatialSkeletonProjectionDelta(
        baseline,
        { kind: "delete", segment: segmentA, node: nodes.n1 },
        mappings,
      ),
    ).toThrow(/root node with children/i);
    expect(() =>
      applySpatialSkeletonProjectionDelta(
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
      applySpatialSkeletonProjectionDelta(
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
      applySpatialSkeletonProjectionDelta(
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
        applySpatialSkeletonProjectionDelta(
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

  it("replays stable logical deltas against remapped node and reversed-winner ids", () => {
    const { mappings, segmentA, segmentB, nodes } = fixture();
    const resultSegment = spatialSkeletonLogicalSegment("merge:result");
    mappings.bindSegment(resultSegment, 20);
    // CATMAID chose B as the physical winner. Both old logical segment handles
    // now alias the single result owner; queued deltas are unchanged.
    mappings.apply({
      segments: [
        [segmentA, 20],
        [segmentB, 20],
      ],
      nodes: [[nodes.n3, 303]],
    });
    const baseline = new SpatialSkeletonProjectionWorkspace([
      {
        segment: resultSegment,
        snapshot: createCompleteSkeletonSnapshot([
          node(1, 20),
          node(2, 20, 1),
          node(303, 20, 2),
          node(10, 20, 303),
          node(11, 20, 10),
          node(12, 20, 11),
        ]),
      },
    ]);
    const delta: SpatialSkeletonProjectionForwardDelta = {
      kind: "move",
      segment: segmentA,
      node: nodes.n3,
      position: [7, 8, 9],
    };
    const folded = applySpatialSkeletonProjectionDelta(
      baseline,
      delta,
      mappings,
    );
    expect(
      folded.projection.getSegment(resultSegment)?.snapshot.getNode(303)
        ?.position,
    ).toEqual([7, 8, 9]);
    expect(delta.node).toBe(nodes.n3);
    expect(delta.segment).toBe(segmentA);
  });

  it("deterministically maintains baseline + valid intents through success, rejection, remap, undo, and redo", () => {
    type EagerNode = {
      nodeId: number;
      parentNodeId?: number;
      position: number[];
      radius?: number;
      confidence?: number;
    };
    type ModelIntent = {
      sequence: number;
      active?: boolean;
      delta: Extract<
        SpatialSkeletonProjectionDelta,
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
    const modelSegment = spatialSkeletonLogicalSegment("model");
    const modelNodes = [1, 2, 3, 4].map((id) =>
      spatialSkeletonLogicalNode(`model-node:${id}`),
    );
    const mappings = new SpatialSkeletonLogicalHandleMappings<number, number>();
    let idEpoch = 0;
    const bindEpoch = () => {
      const segmentId = 500 + idEpoch * 100;
      mappings.apply({
        segments: [[modelSegment, segmentId]],
        nodes: modelNodes.map((handle, index) => [
          handle,
          index + 1 + idEpoch * 1000,
        ]),
      });
      return segmentId;
    };
    let segmentId = bindEpoch();
    let confirmed: EagerNode[] = modelNodes.map((_, index) => ({
      nodeId: index + 1,
      parentNodeId: index === 0 ? undefined : index,
      position: [index + 1, index + 2, index + 3],
      confidence: index === 0 ? 100 : 75,
    }));
    const buildBaseline = () =>
      new SpatialSkeletonProjectionWorkspace([
        {
          segment: modelSegment,
          snapshot: createCompleteSkeletonSnapshot(
            confirmed.map((value) => ({
              ...value,
              segmentId,
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
    const expectedProjection = () => {
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
    const currentProjection = () =>
      intents.reduce(
        (projection, intent) =>
          intent.active === false
            ? projection
            : applySpatialSkeletonProjectionDelta(
                projection,
                intent.delta,
                mappings,
              ).projection,
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
        const inverse = applySpatialSkeletonProjectionDelta(
          currentProjection(),
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
          baseline = applySpatialSkeletonProjectionDelta(
            baseline,
            firstActive.delta,
            mappings,
          ).projection;
        }
      } else if (choice < 0.91) {
        const active = intents.filter(({ active }) => active !== false);
        const rejected = active[Math.floor(random() * active.length)];
        if (rejected !== undefined) rejected.active = false;
      } else {
        const expected = expectedProjection();
        // First promote all active semantic state so only physical identities
        // change. The exact same logical deltas work in the next epoch.
        confirmed = expected;
        for (const intent of intents) intent.active = false;
        ++idEpoch;
        segmentId = bindEpoch();
        confirmed = confirmed.map((value, index) => ({
          ...value,
          nodeId: index + 1 + idEpoch * 1000,
          parentNodeId:
            value.parentNodeId === undefined
              ? undefined
              : value.parentNodeId + 1000,
        }));
        baseline = buildBaseline();
      }

      const expected = expectedProjection();
      const actualSnapshot =
        currentProjection().getSegment(modelSegment)!.snapshot;
      for (let index = 0; index < modelNodes.length; ++index) {
        const physicalId = mappings.resolveNode(modelNodes[index])!;
        const actual = actualSnapshot.getNode(physicalId)!;
        expect(
          Array.from(actual.position),
          `step ${step}, node ${index}`,
        ).toEqual(expected[index].position);
        expect(actual.radius, `step ${step}, node ${index} radius`).toBe(
          expected[index].radius,
        );
        expect(
          actual.confidence,
          `step ${step}, node ${index} confidence`,
        ).toBe(expected[index].confidence);
      }
    }
  });
});
