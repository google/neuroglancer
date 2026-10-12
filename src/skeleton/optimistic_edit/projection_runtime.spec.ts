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

import { describe, expect, it, vi } from "vitest";

import type { SpatiallyIndexedSkeletonNode } from "#src/skeleton/api.js";
import {
  createCompleteSkeletonSnapshot,
  patchCompleteSkeletonSnapshot,
} from "#src/skeleton/complete_skeleton_snapshot.js";
import {
  SpatialSkeletonLogicalHandleMappings,
  spatialSkeletonLogicalNode,
  spatialSkeletonLogicalSegment,
} from "#src/skeleton/logical_identity.js";
import {
  SpatialSkeletonOptimisticProjectionRuntime,
  SpatialSkeletonProjectionPublicationFenceError,
  type SpatialSkeletonProjectionIntentDelta,
} from "#src/skeleton/optimistic_edit/projection_runtime.js";
import { SpatialSkeletonState } from "#src/skeleton/spatial_skeleton_manager.js";
import { SpatialSkeletonProjectionWorkspace } from "#src/skeleton/spatial_skeleton_projection_reducer.js";

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
    ...options,
  };
}

function captureCachedSegmentRevisions(
  state: SpatialSkeletonState,
  segmentIds: readonly number[],
) {
  return new Map(
    segmentIds.map((segmentId) => [
      segmentId,
      state.getCachedSegmentRevision(segmentId),
    ]),
  );
}

function fixture() {
  const state = new SpatialSkeletonState();
  state.replaceCachedSegmentSnapshots(
    [[10, [node(1, 10), node(2, 10, 1), node(3, 10, 1)]]],
    { notify: false },
  );
  const segment = spatialSkeletonLogicalSegment("segment-a");
  const nodes = {
    root: spatialSkeletonLogicalNode("root"),
    first: spatialSkeletonLogicalNode("first"),
    second: spatialSkeletonLogicalNode("second"),
    added: spatialSkeletonLogicalNode("added"),
    missing: spatialSkeletonLogicalNode("missing"),
  };
  const mappings = new SpatialSkeletonLogicalHandleMappings<number, number>();
  mappings.apply({
    segments: [[segment, 10]],
    nodes: [
      [nodes.root, 1],
      [nodes.first, 2],
      [nodes.second, 3],
    ],
  });
  const baselineHandle = state.getCachedSegmentSnapshotHandle(10)!.handle;
  const baseline = new SpatialSkeletonProjectionWorkspace([
    { segment, snapshot: baselineHandle },
  ]);
  const auxiliaryErrors = vi.fn();
  const runtime = new SpatialSkeletonOptimisticProjectionRuntime(state, {
    retainedHistoryWorkspace: baseline,
    mappings,
    onAuxiliaryError: auxiliaryErrors,
  });
  return {
    state,
    segment,
    nodes,
    mappings,
    baseline,
    baselineHandle,
    runtime,
    auxiliaryErrors,
  };
}

function move(
  segment: ReturnType<typeof spatialSkeletonLogicalSegment>,
  nodeHandle: ReturnType<typeof spatialSkeletonLogicalNode>,
  position: readonly number[],
): SpatialSkeletonProjectionIntentDelta {
  return {
    delta: { kind: "move", segment, node: nodeHandle, position },
  };
}

function exactArtifact(
  intentId: number,
  prepared: ReturnType<
    SpatialSkeletonOptimisticProjectionRuntime["prepareExact"]
  >,
) {
  return {
    intentId,
    projection: prepared.projection,
    inverseProjection: prepared.inverseProjection,
  };
}

describe("SpatialSkeletonOptimisticProjectionRuntime", () => {
  it("retires the authoritative singleton while preserving a pending Undo replacement", () => {
    const state = new SpatialSkeletonState();
    state.replaceCachedSegmentSnapshots([[10, [node(1, 10)]]]);
    const snapshot = state.getCachedSegmentSnapshotHandle(10)!.handle;
    const segment = spatialSkeletonLogicalSegment("singleton");
    const root = spatialSkeletonLogicalNode("root");
    const mappings = new SpatialSkeletonLogicalHandleMappings<number, number>();
    mappings.apply({ segments: [[segment, 10]], nodes: [[root, 1]] });
    const runtime = new SpatialSkeletonOptimisticProjectionRuntime(state, {
      mappings,
      retainedHistoryWorkspace: new SpatialSkeletonProjectionWorkspace([
        { segment, snapshot },
      ]),
    });
    const deletion = runtime.prepareExact(1, {
      delta: { kind: "delete", segment, node: root },
    });
    runtime.publishExact(1, deletion.projection);
    expect(state.spatialSkeletonPresentation.value.removedSegmentIds).toEqual([
      10,
    ]);
    // Admit the replacement before the delete commits. It must not change
    // either the delete's input identity or the retired authoritative id.
    const restoration = runtime.prepareExact(2, {
      delta: deletion.inverseProjection,
      provisionalBindings: {
        segments: [[segment, 1010]],
        nodes: [[root, 1001]],
      },
    });
    runtime.publishExact(2, restoration.projection);
    expect(runtime.ownsAuthoritativeReadSegment(10)).toBe(true);

    // A fresh baseline read stays under the replacement preview. It must not
    // publish the original root beside its provisional restoration.
    const fresh = createCompleteSkeletonSnapshot([node(1, 10)]);
    expect(
      runtime.publishAuthoritativeRead([{ segmentId: 10, snapshot: fresh }], {
        expectedCacheRevisions: captureCachedSegmentRevisions(state, [10]),
      }),
    ).toBe(true);
    expect(state.getCachedNode(1)).toBeUndefined();
    expect(state.getCachedNode(1001)?.segmentId).toBe(1010);
    const expectedCacheRevisions = captureCachedSegmentRevisions(state, [10]);

    runtime.publishAuthoritative({
      intentId: 1,
      reconciliation: { retiredResources: [root, segment] },
      activePreviews: [exactArtifact(2, restoration)],
    });
    expect(state.getCachedSegmentRevision(10)).toBeGreaterThan(
      expectedCacheRevisions.get(10)!,
    );
    expect(state.getCachedSegmentNodes(10)).toBeUndefined();
    expect(state.getCachedNode(1001)).toMatchObject({
      segmentId: 1010,
      position: [1, 1.25, 1.5],
    });
    expect(state.spatialSkeletonPresentation.value.removedSegmentIds).toEqual([
      10,
    ]);
    expect(
      runtime.publishAuthoritativeRead([{ segmentId: 10, snapshot }], {
        expectedCacheRevisions,
      }),
    ).toBe(false);

    runtime.publishAuthoritative({
      intentId: 2,
      reconciliation: {
        bindings: { segments: [[segment, 20]], nodes: [[root, 2]] },
      },
      activePreviews: [],
    });
    expect(state.getCachedNode(1001)).toBeUndefined();
    expect(state.getCachedNode(2)).toMatchObject({
      segmentId: 20,
      position: [1, 1.25, 1.5],
    });
  });

  it("retains initial history snapshots without materializing them", () => {
    const segment = spatialSkeletonLogicalSegment("retained");
    const mappings = new SpatialSkeletonLogicalHandleMappings<number, number>();
    mappings.bindSegment(segment, 10);
    const snapshot = patchCompleteSkeletonSnapshot(
      createCompleteSkeletonSnapshot([node(1, 10), node(2, 10, 1)]),
      [
        {
          kind: "update",
          nodeId: 2,
          changes: { description: "retained" },
        },
      ],
    );
    const retainedHistoryWorkspace = new SpatialSkeletonProjectionWorkspace([
      { segment, snapshot },
    ]);

    expect(snapshot.materializationCount).toBe(0);
    const runtime = new SpatialSkeletonOptimisticProjectionRuntime(
      new SpatialSkeletonState(),
      { mappings, retainedHistoryWorkspace },
    );

    expect(runtime.retainedHistoryWorkspace.getSegment(segment)?.snapshot).toBe(
      snapshot,
    );
    expect(snapshot.materializationCount).toBe(0);
  });

  it("gets or creates a node-handle batch atomically with one mapping revision", () => {
    const known = spatialSkeletonLogicalNode("known");
    const occupiedCanonical = spatialSkeletonLogicalNode("authority:12");
    const mappings = new SpatialSkeletonLogicalHandleMappings<number, number>();
    mappings.bindNodes([
      [known, 11],
      [occupiedCanonical, 91],
    ]);
    const runtime = new SpatialSkeletonOptimisticProjectionRuntime(
      new SpatialSkeletonState(),
      { mappings },
    );

    const beforeInvalidBatch = runtime.mappingRevision;
    expect(() => runtime.getOrCreateNodeHandles([13, 0, 14])).toThrow(
      /positive numeric id/,
    );
    expect(runtime.mappingRevision).toBe(beforeInvalidBatch);

    const handles = runtime.getOrCreateNodeHandles([11, 12, 12, 13]);
    expect([...handles.keys()]).toEqual([11, 12, 13]);
    expect(handles.get(11)).toEqual(known);
    expect(handles.get(12)?.stableId).toBe("authority:12:read:1");
    expect(handles.get(13)?.stableId).toBe("authority:13");
    expect(runtime.mappingRevision).toBe(beforeInvalidBatch + 1);

    const repeated = runtime.getOrCreateNodeHandles([13, 11, 12]);
    expect(repeated.get(11)).toBe(handles.get(11));
    expect(repeated.get(12)).toBe(handles.get(12));
    expect(repeated.get(13)).toBe(handles.get(13));
    expect(runtime.mappingRevision).toBe(beforeInvalidBatch + 1);
  });

  it("rebuilds a prepared preview after a later admission adds identity bindings", () => {
    const { runtime, state, segment, nodes } = fixture();
    const prepared = runtime.prepareExact(
      1,
      move(segment, nodes.first, [20, 21, 22]),
    );
    const preparedGeneration = runtime.generation;
    const preparedMappingRevision = runtime.mappingRevision;

    // This models another command being admitted after the first candidate was
    // prepared but before its engine continuation publishes the exact preview.
    const laterNode = runtime.getOrCreateNodeHandle(20);
    const laterSegment = runtime.getOrCreateSegmentHandle(30);
    expect(runtime.generation).toBe(preparedGeneration);
    expect(runtime.mappingRevision).toBeGreaterThan(preparedMappingRevision);

    runtime.publishExact(1, prepared.projection);

    expect(runtime.resolveNode(laterNode)).toBe(20);
    expect(runtime.resolveSegment(laterSegment)).toBe(30);
    expect(Array.from(state.getCachedNode(2)!.position)).toEqual([20, 21, 22]);
  });

  it("uses fresh authority handles when canonical node and segment ids were rebound", () => {
    const reboundNode = spatialSkeletonLogicalNode("authority:11");
    const reboundSegment = spatialSkeletonLogicalSegment("authority:17");
    const mappings = new SpatialSkeletonLogicalHandleMappings<number, number>();
    mappings.apply({
      nodes: [[reboundNode, 91]],
      segments: [[reboundSegment, 97]],
    });
    const runtime = new SpatialSkeletonOptimisticProjectionRuntime(
      new SpatialSkeletonState(),
      { mappings },
    );

    const freshNode = runtime.getOrCreateNodeHandle(11);
    const freshSegment = runtime.getOrCreateSegmentHandle(17);

    expect(freshNode.stableId).toBe("authority:11:read:1");
    expect(freshSegment.stableId).toBe("authority:17:read:1");
    expect(runtime.resolveNode(reboundNode)).toBe(91);
    expect(runtime.resolveSegment(reboundSegment)).toBe(97);
    expect(runtime.resolveNode(freshNode)).toBe(11);
    expect(runtime.resolveSegment(freshSegment)).toBe(17);
  });

  it("does not undo a reversed merge binding during a later physical lookup", () => {
    const state = new SpatialSkeletonState();
    state.replaceCachedSegmentSnapshots(
      [
        [11, [node(101, 11), node(102, 11, 101)]],
        [17, [node(201, 17), node(202, 17, 201)]],
      ],
      { notify: false },
    );
    const runtime = new SpatialSkeletonOptimisticProjectionRuntime(state);
    const firstSegment = runtime.getOrCreateSegmentHandle(11);
    const secondSegment = runtime.getOrCreateSegmentHandle(17);
    const firstRoot = runtime.getOrCreateNodeHandle(101);
    const firstEndpoint = runtime.getOrCreateNodeHandle(102);
    const secondRoot = runtime.getOrCreateNodeHandle(201);
    const secondChild = runtime.getOrCreateNodeHandle(202);
    const merge = runtime.prepareExact(1, {
      delta: {
        kind: "merge",
        firstSegment,
        secondSegment,
        resultSegment: firstSegment,
        firstNode: firstEndpoint,
        secondNode: secondRoot,
      },
      inspectionSeed: {
        segments: [
          {
            segment: firstSegment,
            snapshot: state.getCachedSegmentSnapshotHandle(11)!.handle,
          },
          {
            segment: secondSegment,
            snapshot: state.getCachedSegmentSnapshotHandle(17)!.handle,
          },
        ],
        authoritativeBindings: {
          segments: [
            [firstSegment, 11],
            [secondSegment, 17],
          ],
          nodes: [
            [firstRoot, 101],
            [firstEndpoint, 102],
            [secondRoot, 201],
            [secondChild, 202],
          ],
        },
        expectedCacheRevisions: captureCachedSegmentRevisions(state, [11, 17]),
      },
    });
    runtime.publishExact(1, merge.projection);
    runtime.publishAuthoritative({
      intentId: 1,
      reconciliation: {
        bindings: {
          segments: [
            [firstSegment, 17],
            [secondSegment, 17],
          ],
        },
      },
      activePreviews: [],
    });

    const laterPhysicalEleven = runtime.getOrCreateSegmentHandle(11);
    expect(laterPhysicalEleven).toBe(firstSegment);
    expect(runtime.resolveSegment(firstSegment)).toBe(17);
    expect(runtime.resolveSegment(secondSegment)).toBe(17);
    expect(runtime.resolveSegment(laterPhysicalEleven)).toBe(17);
  });

  it("removes a losing seeded segment in the first atomic merge preview", () => {
    const state = new SpatialSkeletonState();
    state.replaceCachedSegmentSnapshots(
      [
        [11, [node(101, 11), node(102, 11, 101)]],
        [17, [node(201, 17), node(202, 17, 201)]],
      ],
      { notify: false },
    );
    const firstSegment = spatialSkeletonLogicalSegment("seed:first");
    const secondSegment = spatialSkeletonLogicalSegment("seed:second");
    const firstRoot = spatialSkeletonLogicalNode("seed:first-root");
    const firstEndpoint = spatialSkeletonLogicalNode("seed:first-endpoint");
    const secondRoot = spatialSkeletonLogicalNode("seed:second-root");
    const secondChild = spatialSkeletonLogicalNode("seed:second-child");
    const runtime = new SpatialSkeletonOptimisticProjectionRuntime(state);
    const exact = runtime.prepareExact(1, {
      delta: {
        kind: "merge",
        firstSegment,
        secondSegment,
        resultSegment: firstSegment,
        firstNode: firstEndpoint,
        secondNode: secondRoot,
      },
      inspectionSeed: {
        segments: [
          {
            segment: firstSegment,
            snapshot: state.getCachedSegmentSnapshotHandle(11)!.handle,
          },
          {
            segment: secondSegment,
            snapshot: state.getCachedSegmentSnapshotHandle(17)!.handle,
          },
        ],
        authoritativeBindings: {
          segments: [
            [firstSegment, 11],
            [secondSegment, 17],
          ],
          nodes: [
            [firstRoot, 101],
            [firstEndpoint, 102],
            [secondRoot, 201],
            [secondChild, 202],
          ],
        },
        expectedCacheRevisions: captureCachedSegmentRevisions(state, [11, 17]),
      },
    });

    expect(() => runtime.publishExact(1, exact.projection)).not.toThrow();
    expect(state.getCachedSegmentSnapshotHandle(17)).toBeUndefined();
    expect(state.getCachedNode(201)).toMatchObject({
      segmentId: 11,
      parentNodeId: 102,
    });
  });

  it("does not seed an earlier active provisional segment into the baseline", () => {
    const state = new SpatialSkeletonState();
    const runtime = new SpatialSkeletonOptimisticProjectionRuntime(state);
    const segment = spatialSkeletonLogicalSegment("provisional-root-segment");
    const root = spatialSkeletonLogicalNode("provisional-root");
    const child = spatialSkeletonLogicalNode("provisional-child");
    const rootAdd = runtime.prepareExact(1, {
      delta: {
        kind: "add",
        segment,
        node: root,
        parent: undefined,
        position: [1, 2, 3],
      },
      provisionalBindings: {
        segments: [[segment, 1002]],
        nodes: [[root, 1001]],
      },
    });
    runtime.publishExact(1, rootAdd.projection);
    const projectedRoot = state.getCachedSegmentSnapshotHandle(1002)!;

    const childAdd = runtime.prepareExact(2, {
      delta: {
        kind: "add",
        segment,
        node: child,
        parent: root,
        position: [4, 5, 6],
      },
      provisionalBindings: { nodes: [[child, 1003]] },
      inspectionSeed: {
        segments: [{ segment, snapshot: projectedRoot.handle }],
        authoritativeBindings: {
          segments: [[segment, 1002]],
          nodes: [[root, 1001]],
        },
        expectedCacheRevisions: new Map([[1002, projectedRoot.cacheRevision]]),
      },
    });

    expect(() => runtime.publishExact(2, childAdd.projection)).not.toThrow();
    expect(
      state.getCachedSegmentNodes(1002)?.map(({ nodeId }) => nodeId),
    ).toEqual([1001, 1003]);
    expect(runtime.retainedHistoryWorkspace.segments).toEqual([]);
  });

  it("prepares off-screen and adopts cache, identities, and cue removal in one frame", () => {
    const { state, segment, nodes, runtime, baselineHandle } = fixture();
    state.addSpatialSkeletonPreparation({
      intentId: 1,
      sequence: 1,
      direction: "execute",
      kind: "reroot",
      lifecycle: "preparing",
      segmentIds: [10],
      nodeId: 2,
    });
    const beforeRevision = state.spatialSkeletonPresentation.value.revision;
    const frames: Array<{
      readonly nodePosition: readonly number[] | undefined;
      readonly preparations: number;
      readonly owners: readonly string[];
    }> = [];
    state.spatialSkeletonPresentation.changed.add(() => {
      frames.push({
        nodePosition:
          state.getCachedNode(2) === undefined
            ? undefined
            : Array.from(state.getCachedNode(2)!.position),
        preparations:
          state.spatialSkeletonPresentation.value.preparations.length,
        owners: state.spatialSkeletonPresentation.value.activeLogicalOwners.map(
          ({ logicalHandle }) => logicalHandle.stableId,
        ),
      });
    });

    const prepared = runtime.prepareExact(
      1,
      move(segment, nodes.first, [20, 21, 22]),
    );

    expect(state.getCachedSegmentSnapshotHandle(10)!.handle).toBe(
      baselineHandle,
    );
    expect(Array.from(state.getCachedNode(2)!.position)).toEqual([
      2, 2.25, 2.5,
    ]);
    expect(state.spatialSkeletonPresentation.value.preparations).toHaveLength(
      1,
    );
    expect(prepared.inverseProjection).toMatchObject({
      kind: "move",
      position: [2, 2.25, 2.5],
    });

    runtime.publishExact(1, prepared.projection);

    expect(state.getCachedNode(2)?.position).toEqual([20, 21, 22]);
    expect(state.spatialSkeletonPresentation.value.revision).toBe(
      beforeRevision + 1,
    );
    expect(frames).toEqual([
      {
        nodePosition: [20, 21, 22],
        preparations: 0,
        owners: ["segment-a"],
      },
    ]);
  });

  it("accepts a retained inspected handle whose owned cache revision advanced", () => {
    const { state, segment, nodes, runtime } = fixture();
    const first = runtime.prepareExact(1, {
      delta: {
        kind: "node-attributes",
        segment,
        node: nodes.first,
        changes: { description: "first" },
      },
    });
    runtime.publishExact(1, first.projection);
    runtime.publishAuthoritative({
      intentId: 1,
      reconciliation: {},
      activePreviews: [],
    });

    const staleCapturedRevision = state.getCachedSegmentRevision(10) - 1;
    const currentHandle = state.getCachedSegmentSnapshotHandle(10)!.handle;
    const second = runtime.prepareExact(2, {
      delta: {
        kind: "node-attributes",
        segment,
        node: nodes.first,
        changes: { description: "second" },
      },
      inspectionSeed: {
        segments: [{ segment, snapshot: currentHandle }],
        authoritativeBindings: {},
        expectedCacheRevisions: new Map([[10, staleCapturedRevision]]),
      },
    });

    expect(() => runtime.publishExact(2, second.projection)).not.toThrow();
    expect(state.getCachedNode(2)?.description).toBe("second");
  });

  it("isolates preview observers after every core reference is adopted", () => {
    const { state, segment, nodes, runtime, auxiliaryErrors } = fixture();
    state.addSpatialSkeletonPreparation({
      intentId: 1,
      sequence: 1,
      direction: "execute",
      kind: "reroot",
      lifecycle: "preparing",
      segmentIds: [10],
      nodeId: 2,
    });
    const observerFailure = new Error("preview observer failed");
    state.spatialSkeletonPresentation.changed.add(() => {
      throw observerFailure;
    });
    const observed = vi.fn(() => {
      expect(runtime.generation).toBe(1);
      expect(state.getCachedNode(2)?.position).toEqual([20, 21, 22]);
      expect(state.spatialSkeletonPresentation.value.preparations).toHaveLength(
        0,
      );
      expect(
        state.spatialSkeletonPresentation.value.exactSegmentSnapshots[0]
          ?.snapshot.handle,
      ).toBe(state.getCachedSegmentSnapshotHandle(10)?.handle);
    });
    state.spatialSkeletonPresentation.changed.add(observed);
    const nodeObserverFailure = new Error("node observer failed");
    state.nodeDataVersion.changed.add(() => {
      throw nodeObserverFailure;
    });
    const notificationOrder: string[] = [];
    state.spatialSkeletonPresentation.changed.add(() => {
      notificationOrder.push("presentation");
    });
    const laterNodeObserver = vi.fn(() => {
      notificationOrder.push("nodes");
      expect(state.spatialSkeletonPresentation.value.preparations).toHaveLength(
        0,
      );
      expect(
        state.spatialSkeletonPresentation.value.exactSegmentSnapshots[0]
          ?.snapshot.handle,
      ).toBe(state.getCachedSegmentSnapshotHandle(10)?.handle);
    });
    state.nodeDataVersion.changed.add(laterNodeObserver);
    const prepared = runtime.prepareExact(
      1,
      move(segment, nodes.first, [20, 21, 22]),
    );

    expect(() => runtime.publishExact(1, prepared.projection)).not.toThrow();

    expect(observed).toHaveBeenCalledTimes(1);
    expect(laterNodeObserver).toHaveBeenCalledTimes(1);
    expect(notificationOrder).toEqual(["presentation", "nodes"]);
    expect(auxiliaryErrors).toHaveBeenCalledWith(observerFailure);
    expect(auxiliaryErrors).toHaveBeenCalledWith(nodeObserverFailure);
  });

  it("isolates authoritative observers after bindings and baseline are adopted", () => {
    const { state, segment, nodes, runtime, auxiliaryErrors } = fixture();
    const add = runtime.prepareExact(1, {
      delta: {
        kind: "add",
        segment,
        node: nodes.added,
        parent: nodes.root,
        position: [4, 4, 4],
      },
      provisionalBindings: { nodes: [[nodes.added, 1001]] },
    });
    runtime.publishExact(1, add.projection);
    auxiliaryErrors.mockClear();

    const observerFailure = new Error("authority observer failed");
    state.spatialSkeletonPresentation.changed.add(() => {
      throw observerFailure;
    });
    const observed = vi.fn(() => {
      expect(runtime.generation).toBe(2);
      expect(runtime.resolveNode(nodes.added)).toBe(9);
      expect(state.getCachedNode(1001)).toBeUndefined();
      expect(state.getCachedNode(9)?.position).toEqual([4, 4, 4]);
      expect(
        state.spatialSkeletonPresentation.value.provisionalNodeIds,
      ).toEqual([]);
    });
    state.spatialSkeletonPresentation.changed.add(observed);

    expect(() =>
      runtime.publishAuthoritative({
        intentId: 1,
        reconciliation: { bindings: { nodes: [[nodes.added, 9]] } },
        activePreviews: [],
      }),
    ).not.toThrow();

    expect(observed).toHaveBeenCalledTimes(1);
    expect(auxiliaryErrors).toHaveBeenCalledWith(observerFailure);
    expect(
      runtime.retainedHistoryWorkspace.getSegment(segment)?.snapshot.getNode(9),
    ).toMatchObject({ position: [4, 4, 4] });
  });

  it("returns an exact canonical pair for an authority-finalized delta", () => {
    const { state, segment, nodes, runtime } = fixture();
    const preview = runtime.prepareExact(
      1,
      move(segment, nodes.first, [20, 20, 20]),
    );
    runtime.publishExact(1, preview.projection);

    const finalized = runtime.publishAuthoritative({
      intentId: 1,
      reconciliation: {
        finalizedProjectionDelta: {
          kind: "move",
          segment,
          node: nodes.first,
          position: [15, 15, 15],
        },
      },
      activePreviews: [],
    });

    expect(finalized.projection.delta).toMatchObject({
      kind: "move",
      position: [15, 15, 15],
    });
    expect(finalized.inverseProjection).toMatchObject({
      kind: "move",
      position: [2, 2.25, 2.5],
    });
    expect(state.getCachedNode(2)?.position).toEqual([15, 15, 15]);

    const undo = runtime.prepareExact(2, {
      delta: finalized.inverseProjection,
    });
    runtime.publishExact(2, undo.projection);
    expect(state.getCachedNode(2)?.position).toEqual([2, 2.25, 2.5]);
  });

  it("refolds surviving intents without exposing retained history state", () => {
    const { state, segment, nodes, runtime } = fixture();
    const first = runtime.prepareExact(
      1,
      move(segment, nodes.first, [20, 20, 20]),
    );
    runtime.publishExact(1, first.projection);
    const second = runtime.prepareExact(
      2,
      move(segment, nodes.second, [30, 30, 30]),
    );
    runtime.publishExact(2, second.projection);

    const beforeRevision = state.spatialSkeletonPresentation.value.revision;
    const frames: Array<readonly [number, number]> = [];
    state.spatialSkeletonPresentation.changed.add(() => {
      frames.push([
        state.getCachedNode(2)!.position[0],
        state.getCachedNode(3)!.position[0],
      ]);
    });

    runtime.rollbackAndReplay({
      rollbackIntents: [exactArtifact(1, first)],
      replayIntents: [],
    });

    expect(state.spatialSkeletonPresentation.value.revision).toBe(
      beforeRevision + 1,
    );
    expect(frames).toEqual([[2, 30]]);
    expect(state.getCachedNode(2)?.position).toEqual([2, 2.25, 2.5]);
    expect(state.getCachedNode(3)?.position).toEqual([30, 30, 30]);
  });

  it("retains baseline slices still owned by an active projection", () => {
    const { state, segment, nodes, runtime } = fixture();
    const prepared = runtime.prepareExact(
      1,
      move(segment, nodes.first, [20, 20, 20]),
    );
    runtime.publishExact(1, prepared.projection);

    // Simulates history capacity evicting this entry while its authority
    // request remains unresolved.
    runtime.setRetainedHistoryProjections([]);
    runtime.rollbackAndReplay({
      rollbackIntents: [exactArtifact(1, prepared)],
      replayIntents: [],
    });

    expect(state.getCachedNode(2)?.position).toEqual([2, 2.25, 2.5]);
  });

  it("remaps provisional ids, promotes authority, and refolds later previews atomically", () => {
    const { state, segment, nodes, runtime } = fixture();
    const add = runtime.prepareExact(1, {
      delta: {
        kind: "add",
        segment,
        node: nodes.added,
        parent: nodes.root,
        position: [4, 4, 4],
      },
      provisionalBindings: { nodes: [[nodes.added, 1001]] },
    });
    runtime.publishExact(1, add.projection);
    expect(state.getCachedNode(1001)?.position).toEqual([4, 4, 4]);
    expect(state.spatialSkeletonPresentation.value.provisionalNodeIds).toEqual([
      1001,
    ]);

    const laterMove = runtime.prepareExact(
      2,
      move(segment, nodes.added, [8, 8, 8]),
    );
    runtime.publishExact(2, laterMove.projection);

    const observed: Array<{
      readonly ids: readonly number[];
      readonly provisional: readonly number[];
    }> = [];
    state.spatialSkeletonPresentation.changed.add(() => {
      observed.push({
        ids: state
          .getCachedSegmentNodes(10)!
          .map(({ nodeId }) => nodeId)
          .sort((a, b) => a - b),
        provisional: state.spatialSkeletonPresentation.value.provisionalNodeIds,
      });
    });

    runtime.publishAuthoritative({
      intentId: 1,
      reconciliation: {
        bindings: { nodes: [[nodes.added, 9]] },
      },
      activePreviews: [exactArtifact(2, laterMove)],
    });

    expect(observed).toEqual([{ ids: [1, 2, 3, 9], provisional: [] }]);
    expect(state.getCachedNode(1001)).toBeUndefined();
    expect(state.getCachedNode(9)).toMatchObject({
      position: [8, 8, 8],
    });
    expect(runtime.resolveNode(nodes.added)).toBe(9);
    expect(runtime.resolveNodeTarget(nodes.added)).toEqual({
      state: "authoritative",
      physicalId: 9,
    });

    runtime.publishAuthoritative({
      intentId: 2,
      reconciliation: {},
      activePreviews: [],
    });
    expect(
      runtime.retainedHistoryWorkspace.getSegment(segment)?.snapshot.getNode(9),
    ).toMatchObject({ position: [8, 8, 8] });
  });

  it("resolves UI hints only after adoption and isolates hint failures", () => {
    const { state, segment, nodes, mappings, baseline } = fixture();
    const auxiliaryErrors = vi.fn();
    const applyHints = vi.fn((hints) => {
      expect(state.getCachedNode(1001)?.position).toEqual([4, 4, 4]);
      expect(hints.selectedNode).toMatchObject({
        kind: "select",
        nodeId: 1001,
        segmentId: 10,
      });
      throw new Error("selection UI unavailable");
    });
    const runtime = new SpatialSkeletonOptimisticProjectionRuntime(state, {
      retainedHistoryWorkspace: baseline,
      mappings,
      uiHints: { apply: applyHints },
      onAuxiliaryError: auxiliaryErrors,
    });
    const exact = runtime.prepareExact(1, {
      delta: {
        kind: "add",
        segment,
        node: nodes.added,
        parent: nodes.root,
        position: [4, 4, 4],
      },
      provisionalBindings: { nodes: [[nodes.added, 1001]] },
      uiHints: {
        segmentVisibility: [{ segment, visible: true, select: "pin" }],
        selectedNode: {
          kind: "select",
          node: nodes.added,
          segment,
          position: [4, 4, 4],
          moveView: true,
        },
        retainSegments: [segment],
      },
    });

    expect(() => runtime.publishExact(1, exact.projection)).not.toThrow();
    expect(applyHints).toHaveBeenCalledTimes(1);
    expect(auxiliaryErrors).toHaveBeenCalledWith(
      expect.objectContaining({ message: "selection UI unavailable" }),
    );
    expect(runtime.generation).toBe(1);
  });

  it("uses the retired provisional mapping for post-rollback UI cleanup", () => {
    const { state, mappings, baseline } = fixture();
    const applyHints = vi.fn();
    const runtime = new SpatialSkeletonOptimisticProjectionRuntime(state, {
      retainedHistoryWorkspace: baseline,
      mappings,
      uiHints: { apply: applyHints },
    });
    const createdSegment = spatialSkeletonLogicalSegment("rollback-segment");
    const createdRoot = spatialSkeletonLogicalNode("rollback-root");
    const exact = runtime.prepareExact(1, {
      delta: {
        kind: "add",
        segment: createdSegment,
        node: createdRoot,
        parent: undefined,
        position: [4, 4, 4],
      },
      provisionalBindings: {
        nodes: [[createdRoot, 1001]],
        segments: [[createdSegment, 1002]],
      },
      rollbackUiHints: {
        segmentVisibility: [
          { segment: createdSegment, visible: false, deselect: true },
        ],
        selectedNode: { kind: "clear" },
      },
    });
    runtime.publishExact(1, exact.projection);

    runtime.rollbackAndReplay({
      rollbackIntents: [exactArtifact(1, exact)],
      replayIntents: [],
    });

    expect(applyHints).toHaveBeenCalledWith(
      expect.objectContaining({
        segmentVisibility: [
          expect.objectContaining({ segmentId: 1002, visible: false }),
        ],
        selectedNode: { kind: "clear" },
      }),
    );
    expect(runtime.resolveSegment(createdSegment)).toBeUndefined();
    expect(state.getCachedNode(1001)).toBeUndefined();
  });

  it("skips unchanged replay and repeated disposal rollback of a provisional intent", () => {
    const { state, mappings, baseline } = fixture();
    const applyHints = vi.fn();
    const auxiliaryErrors = vi.fn();
    const runtime = new SpatialSkeletonOptimisticProjectionRuntime(state, {
      retainedHistoryWorkspace: baseline,
      mappings,
      uiHints: { apply: applyHints },
      onAuxiliaryError: auxiliaryErrors,
    });
    const createdSegment = spatialSkeletonLogicalSegment(
      "repeated-rollback-segment",
    );
    const createdRoot = spatialSkeletonLogicalNode("repeated-rollback-root");
    const exact = runtime.prepareExact(1, {
      delta: {
        kind: "add",
        segment: createdSegment,
        node: createdRoot,
        parent: undefined,
        position: [4, 4, 4],
      },
      provisionalBindings: {
        nodes: [[createdRoot, 1001]],
        segments: [[createdSegment, 1002]],
      },
      rollbackUiHints: {
        segmentVisibility: [
          { segment: createdSegment, visible: false, deselect: true },
        ],
      },
    });
    runtime.publishExact(1, exact.projection);
    const artifact = exactArtifact(1, exact);

    const previewGeneration = runtime.generation;
    const previewRevision = state.spatialSkeletonPresentation.value.revision;
    runtime.rollbackAndReplay({
      rollbackIntents: [],
      replayIntents: [artifact],
    });
    expect(runtime.generation).toBe(previewGeneration);
    expect(state.spatialSkeletonPresentation.value.revision).toBe(
      previewRevision,
    );

    runtime.rollbackAndReplay({
      rollbackIntents: [artifact],
      replayIntents: [],
    });
    expect(applyHints).toHaveBeenCalledTimes(1);
    expect(state.getCachedNode(1001)).toBeUndefined();

    applyHints.mockClear();
    auxiliaryErrors.mockClear();
    const rolledBackGeneration = runtime.generation;
    const rolledBackRevision = state.spatialSkeletonPresentation.value.revision;

    // Fatal cleanup may remove the preview before layer disposal asks the old
    // runtime to roll it back again. The stale request has no model or UI work.
    expect(() =>
      runtime.rollbackAndReplay({
        rollbackIntents: [artifact],
        replayIntents: [],
      }),
    ).not.toThrow();

    expect(runtime.generation).toBe(rolledBackGeneration);
    expect(state.spatialSkeletonPresentation.value.revision).toBe(
      rolledBackRevision,
    );
    expect(applyHints).not.toHaveBeenCalled();
    expect(auxiliaryErrors).not.toHaveBeenCalled();
  });

  it("automatically publishes authoritative node and segment membership remaps", () => {
    const { state, mappings, baseline } = fixture();
    const applyHints = vi.fn((hints) => {
      expect(state.getCachedNode(9)).toBeDefined();
      expect(state.getCachedNode(1001)).toBeUndefined();
      expect(hints.nodeIdRemappings).toEqual(new Map([[1001, 9]]));
      expect(hints.segmentIdRemappings).toEqual(new Map([[1002, 19]]));
    });
    const runtime = new SpatialSkeletonOptimisticProjectionRuntime(state, {
      retainedHistoryWorkspace: baseline,
      mappings,
      uiHints: { apply: applyHints },
    });
    const createdSegment = spatialSkeletonLogicalSegment("created-segment");
    const createdRoot = spatialSkeletonLogicalNode("created-root");
    const exact = runtime.prepareExact(1, {
      delta: {
        kind: "add",
        segment: createdSegment,
        node: createdRoot,
        parent: undefined,
        position: [4, 4, 4],
      },
      provisionalBindings: {
        nodes: [[createdRoot, 1001]],
        segments: [[createdSegment, 1002]],
      },
    });
    runtime.publishExact(1, exact.projection);
    applyHints.mockClear();

    runtime.publishAuthoritative({
      intentId: 1,
      reconciliation: {
        bindings: {
          nodes: [[createdRoot, 9]],
          segments: [[createdSegment, 19]],
        },
      },
      activePreviews: [],
    });

    expect(applyHints).toHaveBeenCalledTimes(1);
    expect(state.getCachedNode(9)).toMatchObject({ segmentId: 19 });
  });

  it.each([false, true])(
    "retires the physical Merge target while retaining logical aliases (pending Undo: %s)",
    (pendingUndo) => {
      const state = new SpatialSkeletonState();
      state.replaceCachedSegmentSnapshots(
        [
          [11, [node(101, 11), node(102, 11, 101)]],
          [17, [node(201, 17), node(202, 17, 201)]],
        ],
        { notify: false },
      );
      const firstSegment = spatialSkeletonLogicalSegment("merge:first");
      const secondSegment = spatialSkeletonLogicalSegment("merge:second");
      const firstRoot = spatialSkeletonLogicalNode("merge:first-root");
      const firstEndpoint = spatialSkeletonLogicalNode("merge:first-endpoint");
      const secondRoot = spatialSkeletonLogicalNode("merge:second-root");
      const secondChild = spatialSkeletonLogicalNode("merge:second-child");
      const runtime = new SpatialSkeletonOptimisticProjectionRuntime(state);
      const exact = runtime.prepareExact(1, {
        delta: {
          kind: "merge",
          firstSegment,
          secondSegment,
          resultSegment: firstSegment,
          firstNode: firstEndpoint,
          secondNode: secondRoot,
        },
        inspectionSeed: {
          segments: [
            {
              segment: firstSegment,
              snapshot: state.getCachedSegmentSnapshotHandle(11)!.handle,
            },
            {
              segment: secondSegment,
              snapshot: state.getCachedSegmentSnapshotHandle(17)!.handle,
            },
          ],
          authoritativeBindings: {
            segments: [
              [firstSegment, 11],
              [secondSegment, 17],
            ],
            nodes: [
              [firstRoot, 101],
              [firstEndpoint, 102],
              [secondRoot, 201],
              [secondChild, 202],
            ],
          },
          expectedCacheRevisions: captureCachedSegmentRevisions(
            state,
            [11, 17],
          ),
        },
      });
      runtime.publishExact(1, exact.projection);
      const expectedCacheRevisions = captureCachedSegmentRevisions(state, [17]);
      const restoration = {
        projection: {
          delta: exact.inverseProjection,
          provisionalBindings: { segments: [[secondSegment, 1017]] },
        } satisfies SpatialSkeletonProjectionIntentDelta,
        inverseProjection: exact.projection.delta,
      };

      expect(() =>
        runtime.publishAuthoritative({
          intentId: 1,
          reconciliation: {
            retiredSegmentIds: [17],
            bindings: {
              segments: [
                [firstSegment, 11],
                [secondSegment, 11],
              ],
            },
          },
          activePreviews: pendingUndo ? [exactArtifact(2, restoration)] : [],
        }),
      ).not.toThrow();
      expect(state.getCachedSegmentSnapshotHandle(17)).toBeUndefined();
      expect(state.getCachedSegmentRevision(17)).toBeGreaterThan(
        expectedCacheRevisions.get(17)!,
      );
      expect(state.getCachedNode(201)).toMatchObject({
        segmentId: pendingUndo ? 1017 : 11,
        parentNodeId: pendingUndo ? undefined : 102,
      });
      expect(runtime.resolveSegment(firstSegment)).toBe(11);
      expect(runtime.resolveSegment(secondSegment)).toBe(
        pendingUndo ? 1017 : 11,
      );
      expect(
        runtime.publishAuthoritativeRead(
          [
            {
              segmentId: 17,
              snapshot: createCompleteSkeletonSnapshot([
                node(201, 17),
                node(202, 17, 201),
              ]),
            },
          ],
          { expectedCacheRevisions },
        ),
      ).toBe(false);
      if (pendingUndo) {
        runtime.publishAuthoritative({
          intentId: 2,
          reconciliation: { bindings: { segments: [[secondSegment, 27]] } },
          activePreviews: [],
        });
        expect(state.getCachedSegmentNodes(1017)).toBeUndefined();
        expect(state.getCachedNode(201)).toMatchObject({
          segmentId: 27,
          parentNodeId: undefined,
        });
        expect(state.getCachedNode(202)).toMatchObject({
          segmentId: 27,
          parentNodeId: 201,
        });
        expect(runtime.resolveSegment(firstSegment)).toBe(11);
        expect(runtime.resolveSegment(secondSegment)).toBe(27);
      }
    },
  );

  it("applies reversed-winner merge corrections before authoritative aliasing", () => {
    const state = new SpatialSkeletonState();
    state.replaceCachedSegmentSnapshots(
      [
        [11, [node(101, 11), node(102, 11, 101)]],
        [17, [node(201, 17), node(202, 17, 201)]],
      ],
      { notify: false },
    );
    const firstSegment = spatialSkeletonLogicalSegment("reverse:first");
    const secondSegment = spatialSkeletonLogicalSegment("reverse:second");
    const firstRoot = spatialSkeletonLogicalNode("reverse:first-root");
    const firstEndpoint = spatialSkeletonLogicalNode("reverse:first-endpoint");
    const secondRoot = spatialSkeletonLogicalNode("reverse:second-root");
    const secondChild = spatialSkeletonLogicalNode("reverse:second-child");
    const runtime = new SpatialSkeletonOptimisticProjectionRuntime(state);
    const exact = runtime.prepareExact(1, {
      delta: {
        kind: "merge",
        firstSegment,
        secondSegment,
        resultSegment: firstSegment,
        firstNode: firstEndpoint,
        secondNode: secondRoot,
      },
      inspectionSeed: {
        segments: [
          {
            segment: firstSegment,
            snapshot: state.getCachedSegmentSnapshotHandle(11)!.handle,
          },
          {
            segment: secondSegment,
            snapshot: state.getCachedSegmentSnapshotHandle(17)!.handle,
          },
        ],
        authoritativeBindings: {
          segments: [
            [firstSegment, 11],
            [secondSegment, 17],
          ],
          nodes: [
            [firstRoot, 101],
            [firstEndpoint, 102],
            [secondRoot, 201],
            [secondChild, 202],
          ],
        },
        expectedCacheRevisions: captureCachedSegmentRevisions(state, [11, 17]),
      },
    });
    runtime.publishExact(1, exact.projection);

    runtime.publishAuthoritative({
      intentId: 1,
      reconciliation: {
        bindings: {
          segments: [
            [firstSegment, 17],
            [secondSegment, 17],
          ],
        },
        finalizedProjectionDelta: {
          kind: "merge",
          firstSegment: secondSegment,
          secondSegment: firstSegment,
          resultSegment: secondSegment,
          firstNode: secondRoot,
          secondNode: firstEndpoint,
        },
      },
      activePreviews: [],
    });

    expect(state.getCachedSegmentSnapshotHandle(11)).toBeUndefined();
    expect(state.getCachedNode(102)).toMatchObject({
      segmentId: 17,
      parentNodeId: 201,
    });
    expect(state.getCachedNode(201)).toMatchObject({
      segmentId: 17,
      parentNodeId: undefined,
    });
    expect(runtime.resolveSegment(firstSegment)).toBe(17);
    expect(runtime.resolveSegment(secondSegment)).toBe(17);
  });

  it("rejects a stale cache fence without adopting any part of a preview", () => {
    const { state, segment, nodes, runtime, baselineHandle } = fixture();
    state.addSpatialSkeletonPreparation({
      intentId: 1,
      sequence: 1,
      direction: "execute",
      kind: "reroot",
      lifecycle: "preparing",
      segmentIds: [10],
      nodeId: 2,
    });
    const prepared = runtime.prepareExact(
      1,
      move(segment, nodes.first, [20, 20, 20]),
    );
    state.replaceCachedSegmentSnapshots(
      [[10, [node(1, 10), node(2, 10, 1, { position: [99, 99, 99] })]]],
      { notify: false },
    );
    const beforePresentation = state.spatialSkeletonPresentation.value;
    const beforeGeneration = runtime.generation;

    expect(() => runtime.publishExact(1, prepared.projection)).toThrow(
      SpatialSkeletonProjectionPublicationFenceError,
    );

    expect(runtime.generation).toBe(beforeGeneration);
    expect(runtime.projectedWorkspace.segments).toHaveLength(0);
    expect(runtime.retainedHistoryWorkspace.getSegment(segment)?.snapshot).toBe(
      baselineHandle,
    );
    expect(Array.from(state.getCachedNode(2)!.position)).toEqual([99, 99, 99]);
    expect(state.spatialSkeletonPresentation.value).toBe(beforePresentation);
    expect(state.spatialSkeletonPresentation.value.preparations).toHaveLength(
      1,
    );
  });

  it("fails local reducer and reconciliation guards before touching visible state", () => {
    const { state, segment, nodes, runtime, baselineHandle } = fixture();
    const beforePresentation = state.spatialSkeletonPresentation.value;

    expect(() =>
      runtime.prepareExact(1, {
        delta: {
          kind: "add",
          segment,
          node: nodes.added,
          parent: nodes.root,
          position: [4, 4, 4],
        },
        // Trusted cache adoption only accepts positive numeric identities.
        provisionalBindings: { nodes: [[nodes.added, -1]] },
      }),
    ).toThrow(/positive numeric id/);
    expect(state.getCachedSegmentSnapshotHandle(10)?.handle).toBe(
      baselineHandle,
    );
    expect(state.spatialSkeletonPresentation.value).toBe(beforePresentation);

    const exact = runtime.prepareExact(
      2,
      move(segment, nodes.first, [20, 20, 20]),
    );
    runtime.publishExact(2, exact.projection);
    const exactHandle = state.getCachedSegmentSnapshotHandle(10)!.handle;
    const exactPresentation = state.spatialSkeletonPresentation.value;

    expect(() =>
      runtime.publishAuthoritative({
        intentId: 2,
        reconciliation: {
          finalizedProjectionDelta: {
            kind: "move",
            segment,
            node: nodes.missing,
            position: [20, 20, 20],
          },
        },
        activePreviews: [],
      }),
    ).toThrow("Logical node missing has no physical mapping.");
    expect(state.getCachedSegmentSnapshotHandle(10)!.handle).toBe(exactHandle);
    expect(state.spatialSkeletonPresentation.value).toBe(exactPresentation);
    expect(runtime.resolveNode(nodes.first)).toBe(2);
  });

  it("keeps rebased history bindings private when the candidate cannot be reduced", () => {
    const { state, segment, nodes, runtime } = fixture();
    const first = runtime.prepareExact(
      1,
      move(segment, nodes.first, [20, 20, 20]),
    );
    runtime.publishExact(1, first.projection);
    const second = runtime.prepareExact(2, {
      delta: {
        kind: "add",
        segment,
        node: nodes.added,
        parent: nodes.root,
        position: [4, 4, 4],
      },
      provisionalBindings: { nodes: [[nodes.added, 500]] },
    });
    runtime.publishExact(2, second.projection);
    const snapshot = state.getCachedSegmentSnapshotHandle(10);
    const presentation = state.spatialSkeletonPresentation.value;
    const baseline = runtime.retainedHistoryWorkspace;
    const publication = {
      intentId: 1,
      reconciliation: {},
      activePreviews: [exactArtifact(2, second)],
    };
    expect(() =>
      runtime.publishAuthoritative({
        ...publication,
        rebaseActivePreview: () => ({
          delta: {
            kind: "add",
            segment,
            node: nodes.added,
            parent: nodes.missing,
            position: [4, 4, 4],
          },
          provisionalBindings: { nodes: [[nodes.added, 600]] },
        }),
      }),
    ).toThrow("Logical node missing has no physical mapping.");
    expect(state.getCachedSegmentSnapshotHandle(10)).toBe(snapshot);
    expect(state.spatialSkeletonPresentation.value).toBe(presentation);
    expect(runtime.retainedHistoryWorkspace).toBe(baseline);
    expect(runtime.resolveNode(nodes.added)).toBe(500);
    runtime.publishAuthoritative(publication);
    expect(runtime.resolveNode(nodes.added)).toBe(500);
    expect(state.getCachedNode(500)?.parentNodeId).toBe(1);
  });

  it("rebuilds independently prepared previews against the latest adopted generation", () => {
    const { state, segment, nodes, runtime } = fixture();
    const first = runtime.prepareExact(
      1,
      move(segment, nodes.first, [20, 20, 20]),
    );
    const second = runtime.prepareExact(
      2,
      move(segment, nodes.second, [30, 30, 30]),
    );

    runtime.publishExact(1, first.projection);
    runtime.publishExact(2, second.projection);

    expect(state.getCachedNode(2)?.position).toEqual([20, 20, 20]);
    expect(state.getCachedNode(3)?.position).toEqual([30, 30, 30]);
    expect(second.inverseProjection).toMatchObject({
      kind: "move",
      position: [3, 3.25, 3.5],
    });
  });

  it("discards a same-segment ordinary read whose cache revision predates a preview", () => {
    const { state, segment, nodes, runtime } = fixture();
    const expectedCacheRevisions = captureCachedSegmentRevisions(state, [10]);
    const exact = runtime.prepareExact(
      1,
      move(segment, nodes.first, [20, 20, 20]),
    );
    runtime.publishExact(1, exact.projection);
    const presentation = state.spatialSkeletonPresentation.value;
    expect(state.getCachedSegmentRevision(10)).not.toBe(
      expectedCacheRevisions.get(10),
    );

    expect(
      runtime.publishAuthoritativeRead(
        [
          {
            segmentId: 10,
            snapshot: createCompleteSkeletonSnapshot([
              node(1, 10),
              node(2, 10, 1, { position: [7, 7, 7] }),
              node(3, 10, 1),
            ]),
          },
        ],
        { expectedCacheRevisions },
      ),
    ).toBe(false);
    expect(state.getCachedNode(2)?.position).toEqual([20, 20, 20]);
    expect(state.spatialSkeletonPresentation.value).toBe(presentation);
  });

  it("accepts an unrelated ordinary read across another segment's projection", () => {
    const { state, segment, nodes, runtime } = fixture();
    state.replaceCachedSegmentSnapshots(
      [[20, [node(21, 20), node(22, 20, 21)]]],
      { notify: false },
    );
    const expectedCacheRevisions = captureCachedSegmentRevisions(state, [20]);
    const readGeneration = runtime.generation;
    const exact = runtime.prepareExact(
      1,
      move(segment, nodes.first, [20, 20, 20]),
    );
    runtime.publishExact(1, exact.projection);

    expect(runtime.generation).toBeGreaterThan(readGeneration);
    expect(state.getCachedSegmentRevision(20)).toBe(
      expectedCacheRevisions.get(20),
    );
    expect(
      runtime.publishAuthoritativeRead(
        [
          {
            segmentId: 20,
            snapshot: createCompleteSkeletonSnapshot([
              node(21, 20),
              node(22, 20, 21, { position: [44, 44, 44] }),
            ]),
          },
        ],
        { expectedCacheRevisions },
      ),
    ).toBe(true);
    expect(state.getCachedNode(2)?.position).toEqual([20, 20, 20]);
    expect(state.getCachedNode(22)?.position).toEqual([44, 44, 44]);
  });

  it("does not bind every node while adopting an authoritative read", () => {
    const state = new SpatialSkeletonState();
    state.replaceCachedSegmentSnapshots(
      [[20, [node(21, 20), node(22, 20, 21)]]],
      { notify: false },
    );
    const runtime = new SpatialSkeletonOptimisticProjectionRuntime(state);
    const expectedCacheRevisions = captureCachedSegmentRevisions(state, [20]);

    expect(
      runtime.publishAuthoritativeRead(
        [
          {
            segmentId: 20,
            snapshot: createCompleteSkeletonSnapshot([
              node(21, 20),
              node(22, 20, 21, { position: [44, 44, 44] }),
            ]),
          },
        ],
        { expectedCacheRevisions },
      ),
    ).toBe(true);
    const revisionAfterRead = runtime.mappingRevision;

    const handles = runtime.getOrCreateNodeHandles([21, 22]);
    expect(handles.get(21)?.stableId).toBe("authority:21");
    expect(handles.get(22)?.stableId).toBe("authority:22");
    expect(runtime.mappingRevision).toBe(revisionAfterRead + 1);
  });

  it("adopts a later ordinary read into the baseline and refolds active previews once", () => {
    const { state, segment, nodes, runtime, auxiliaryErrors } = fixture();
    const artifactFrames: Array<
      readonly {
        readonly intentId: number;
        readonly inverseProjection: unknown;
      }[]
    > = [];
    runtime.subscribeProjectionArtifacts((artifacts) =>
      artifactFrames.push(artifacts),
    );
    runtime.subscribeProjectionArtifacts(() => {
      throw new Error("artifact observer failed");
    });
    const exact = runtime.prepareExact(
      1,
      move(segment, nodes.first, [20, 20, 20]),
    );
    runtime.publishExact(1, exact.projection);
    const expectedCacheRevisions = captureCachedSegmentRevisions(state, [10]);
    const frames: Array<readonly [number, number]> = [];
    state.spatialSkeletonPresentation.changed.add(() => {
      frames.push([
        state.getCachedNode(2)!.position[0],
        state.getCachedNode(3)!.position[0],
      ]);
    });

    expect(
      runtime.publishAuthoritativeRead(
        [
          {
            segmentId: 10,
            snapshot: createCompleteSkeletonSnapshot([
              node(1, 10),
              node(2, 10, 1, { position: [7, 7, 7] }),
              node(3, 10, 1, { position: [33, 33, 33] }),
            ]),
          },
        ],
        { expectedCacheRevisions },
      ),
    ).toBe(true);

    expect(frames).toEqual([[20, 33]]);
    expect(state.getCachedNode(2)?.position).toEqual([20, 20, 20]);
    expect(state.getCachedNode(3)?.position).toEqual([33, 33, 33]);
    expect(
      runtime.retainedHistoryWorkspace.getSegment(segment)?.snapshot.getNode(2)
        ?.position,
    ).toEqual([7, 7, 7]);
    expect(artifactFrames.at(-1)).toEqual([
      expect.objectContaining({
        intentId: 1,
        inverseProjection: expect.objectContaining({
          kind: "move",
          position: [7, 7, 7],
        }),
      }),
    ]);
    expect(auxiliaryErrors).toHaveBeenCalledWith(
      expect.objectContaining({ message: "artifact observer failed" }),
    );

    runtime.rollbackAndReplay({
      rollbackIntents: [exactArtifact(1, exact)],
      replayIntents: [],
    });
    expect(state.getCachedNode(2)?.position).toEqual([7, 7, 7]);
    expect(state.getCachedNode(3)?.position).toEqual([33, 33, 33]);
  });
});
