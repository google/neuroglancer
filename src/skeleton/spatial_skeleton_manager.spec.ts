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

import type { SkeletonNode } from "#src/skeleton/api.js";
import { SpatialSkeletonActions } from "#src/skeleton/command_protocol.js";
import {
  createCompleteSkeletonSnapshot,
  patchCompleteSkeletonSnapshot,
  type CompleteSkeletonSnapshotHandle,
} from "#src/skeleton/complete_skeleton_snapshot.js";
import { SpatialSkeletonInspectionRequiredError } from "#src/skeleton/edit_errors.js";
import { SpatialSkeletonOptimisticReloadRequiredError } from "#src/skeleton/optimistic_edit/fatal.js";
import { unchangedSpatialSkeletonOptimisticEditSettlement } from "#src/skeleton/optimistic_edit/lifecycle.js";
import {
  editableSpatiallyIndexedSkeletonSourceSupportsAction,
  getEditableSpatiallyIndexedSkeletonSource,
  getSpatialSkeletonEditCommandFactoryForAction,
  isSpatiallyIndexedSkeletonSourceReadOnly,
  SpatialSkeletonState,
  type SpatialSkeletonPreparedProjectionStatePublication,
  type SpatialSkeletonOptimisticEditExecution,
  type SpatialSkeletonOptimisticEditQueue,
} from "#src/skeleton/spatial_skeleton_manager.js";

function resolvedOptimisticExecution(
  value: boolean,
): SpatialSkeletonOptimisticEditExecution {
  const execution = Promise.resolve(value);
  Object.defineProperty(execution, "acceptedByQueue", {
    configurable: true,
    value: Promise.resolve(),
  });
  Object.defineProperty(execution, "settled", {
    configurable: true,
    value: Promise.resolve(
      unchangedSpatialSkeletonOptimisticEditSettlement("no-op"),
    ),
  });
  return execution as SpatialSkeletonOptimisticEditExecution;
}

function makeCommandFactory(action: string) {
  return {
    action,
    createCommand: vi.fn(),
  };
}

function makeEditableSourceCommands() {
  return {
    optimisticEditing: {
      createDriver: vi.fn(),
    },
    addNodesCommand: makeCommandFactory(SpatialSkeletonActions.addNodes),
    deleteNodesCommand: makeCommandFactory(SpatialSkeletonActions.deleteNodes),
    moveNodesCommand: makeCommandFactory(SpatialSkeletonActions.moveNodes),
    splitSkeletonsCommand: makeCommandFactory(
      SpatialSkeletonActions.splitSkeletons,
    ),
    mergeSkeletonsCommand: makeCommandFactory(
      SpatialSkeletonActions.mergeSkeletons,
    ),
  };
}

function makeOptimisticQueue(): SpatialSkeletonOptimisticEditQueue {
  return {
    canUndo: () => false,
    canRedo: () => false,
    dispose: async () => {},
    hasUnconfirmedActions: () => false,
    undoLatest: () => resolvedOptimisticExecution(false),
    redoLatest: () => resolvedOptimisticExecution(false),
    getSnapshot: () => [],
    getRecentActivity: () => [],
    getFatalState: () => undefined,
    handleFatalStateLatched: () => {},
    getProtectedProjectionSegmentIds: () => [],
    ownsAuthoritativeReadSegment: () => false,
  };
}

function getCachedSegmentRevisions(
  state: SpatialSkeletonState,
  segmentIds: Iterable<bigint>,
) {
  return new Map(
    [...segmentIds].map((segmentId) => [
      segmentId,
      state.getCachedSegmentRevision(segmentId),
    ]),
  );
}

function adoptPreparedProjectionSnapshots(
  state: SpatialSkeletonState,
  snapshots: readonly (readonly [
    bigint,
    CompleteSkeletonSnapshotHandle | undefined,
  ])[],
  options: {
    readonly expectedRevisions?: ReadonlyMap<bigint, number>;
    readonly notify?: boolean;
    readonly retiredSegmentIds?: ReadonlySet<bigint>;
  } = {},
) {
  const presentation = state.spatialSkeletonPresentation.value;
  const prepared = state.prepareSpatialSkeletonProjectionStatePublication({
    snapshots,
    retiredSegmentIds: options.retiredSegmentIds,
    expectedRevisions:
      options.expectedRevisions ??
      getCachedSegmentRevisions(
        state,
        snapshots.map(([segmentId]) => segmentId),
      ),
    activeLogicalOwners: presentation.activeLogicalOwners,
    numericAliases: presentation.numericAliases,
    provisionalNodeIds: presentation.provisionalNodeIds,
    preparationIntentIdsToRemove: [],
    notify: options.notify ?? true,
  });
  if (prepared === undefined) return false;
  let adopted = false;
  state.runSpatialSkeletonPresentationTransaction(() => {
    adopted =
      state.adoptPreparedSpatialSkeletonProjectionStatePublication(prepared) !==
      undefined;
  });
  if (!adopted) return false;
  state.finalizePreparedSpatialSkeletonProjectionStatePublication(prepared);
  return true;
}

async function flushMicrotasks() {
  for (let i = 0; i < 10; ++i) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("skeleton/spatial_skeleton_manager", () => {
  it.each([false, true])(
    "prepares confirmed retirement atomically when the snapshot is already absent: %s",
    (alreadyAbsent) => {
      const state = new SpatialSkeletonState();
      state.replaceCachedSegmentSnapshots([
        [11n, [{ nodeId: 1n, segmentId: 11n, position: [1, 2, 3] }]],
        [17n, [{ nodeId: 2n, segmentId: 17n, position: [4, 5, 6] }]],
      ]);
      if (alreadyAbsent)
        state.replaceCachedSegmentSnapshots([[11n, undefined]]);
      const revision = state.getCachedSegmentRevision(11n);
      const previous = state.getCachedSegmentSnapshotHandle(11n);
      const untouched = state.getCachedSegmentSnapshotHandle(17n);
      const presentation = state.spatialSkeletonPresentation.value;
      const notifications = vi.fn();
      state.spatialSkeletonPresentation.changed.add(notifications);
      const prepared = state.prepareSpatialSkeletonProjectionStatePublication({
        snapshots: [[11n, undefined]],
        expectedRevisions: getCachedSegmentRevisions(state, [11n]),
        retiredSegmentIds: new Set([11n]),
        activeLogicalOwners: [],
        numericAliases: [],
        provisionalNodeIds: [],
        preparationIntentIdsToRemove: [],
        notify: true,
      })!;

      expect(state.getCachedSegmentRevision(11n)).toBe(revision);
      expect(state.getCachedSegmentSnapshotHandle(11n)).toBe(previous);
      expect(state.spatialSkeletonPresentation.value).toBe(presentation);
      expect(notifications).not.toHaveBeenCalled();
      expect(prepared.cacheRevisions.get(11n)).toBeGreaterThan(revision);

      state.runSpatialSkeletonPresentationTransaction(() => {
        expect(
          state.adoptPreparedSpatialSkeletonProjectionStatePublication(
            prepared,
          ),
        ).toBeDefined();
        expect(state.getCachedSegmentRevision(11n)).toBe(
          prepared.cacheRevisions.get(11n),
        );
        expect(state.getCachedNode(1n)).toBeUndefined();
      });
      state.finalizePreparedSpatialSkeletonProjectionStatePublication(prepared);
      expect(state.getCachedSegmentSnapshotHandle(11n)).toBeUndefined();
      expect(state.spatialSkeletonPresentation.value.removedSegmentIds).toEqual(
        [11n],
      );
      expect(state.getCachedSegmentSnapshotHandle(17n)).toBe(untouched);
      expect(state.getCachedSegmentRevision(17n)).toBe(
        untouched!.cacheRevision,
      );
      expect(notifications).toHaveBeenCalledTimes(1);
    },
  );

  it("distinguishes projection removal from eviction and clears it on restoration or runtime reset", () => {
    const state = new SpatialSkeletonState();
    const snapshot = createCompleteSkeletonSnapshot([
      { nodeId: 1n, segmentId: 17n, position: [1, 2, 3] },
    ]);
    adoptPreparedProjectionSnapshots(state, [[17n, snapshot]]);
    state.evictInactiveSegmentNodes([]);
    expect(state.spatialSkeletonPresentation.value.removedSegmentIds).toEqual(
      [],
    );
    // Even an already-absent cache entry must record explicit removal.
    adoptPreparedProjectionSnapshots(state, [[17n, undefined]], {
      notify: false,
    });
    expect(state.spatialSkeletonPresentation.value.removedSegmentIds).toEqual([
      17n,
    ]);
    state.evictInactiveSegmentNodes([]);
    expect(state.spatialSkeletonPresentation.value.removedSegmentIds).toEqual([
      17n,
    ]);
    adoptPreparedProjectionSnapshots(state, [[17n, snapshot]]);
    expect(state.spatialSkeletonPresentation.value.removedSegmentIds).toEqual(
      [],
    );
    adoptPreparedProjectionSnapshots(state, [[17n, undefined]]);
    state.replaceCachedSegmentSnapshots([[17n, snapshot.materialize()]]);
    expect(state.spatialSkeletonPresentation.value.removedSegmentIds).toEqual(
      [],
    );
    adoptPreparedProjectionSnapshots(state, [[17n, undefined]]);
    state.clearRuntimeState();
    expect(state.spatialSkeletonPresentation.value.removedSegmentIds).toEqual(
      [],
    );
  });

  it("confirmed retirement cancels a retained read while unrelated reads continue", async () => {
    const state = new SpatialSkeletonState();
    const retiredRead = deferred<SkeletonNode[]>();
    const unrelatedRead = deferred<SkeletonNode[]>();
    const signals = new Map<bigint, AbortSignal>();
    const layer = {
      source: {
        readonly: false,
        listSkeletons: async () => [],
        getSkeleton: (id: bigint, options: { signal: AbortSignal }) => {
          signals.set(id, options.signal);
          // Deliberately ignore cancellation to exercise a late source result.
          return (id === 17n ? retiredRead : unrelatedRead).promise;
        },
        fetchNodes: async () => [],
        getSpatialIndexMetadata: async () => null,
      },
    } as any;
    const read = state.getFullSegmentNodes(layer, 17n, {
      retainWhileInactive: true,
    });
    const other = state.getFullSegmentNodes(layer, 29n, {
      retainWhileInactive: true,
    });
    const aborted = expect(read).rejects.toMatchObject({ name: "AbortError" });
    await flushMicrotasks();
    const revisions = getCachedSegmentRevisions(state, [17n, 29n]);
    const prepared = state.prepareSpatialSkeletonProjectionStatePublication({
      snapshots: [[17n, undefined]],
      expectedRevisions: revisions,
      retiredSegmentIds: new Set([17n]),
      activeLogicalOwners: [],
      numericAliases: [],
      provisionalNodeIds: [],
      preparationIntentIdsToRemove: [],
      notify: true,
    })!;
    expect(signals.get(17n)?.aborted).toBe(false);
    expect(state.getCachedSegmentRevision(17n)).toBe(revisions.get(17n));
    state.runSpatialSkeletonPresentationTransaction(() => {
      expect(
        state.adoptPreparedSpatialSkeletonProjectionStatePublication(prepared),
      ).toBeDefined();
    });
    expect(signals.get(17n)?.aborted).toBe(false);
    state.finalizePreparedSpatialSkeletonProjectionStatePublication(prepared);
    await aborted;
    expect(signals.get(17n)?.aborted).toBe(true);
    expect(signals.get(29n)?.aborted).toBe(false);
    expect(state.getCachedSegmentRevision(17n)).toBeGreaterThan(
      revisions.get(17n)!,
    );
    expect(state.getCachedSegmentRevision(29n)).toBe(revisions.get(29n));

    retiredRead.resolve([{ nodeId: 1n, segmentId: 17n, position: [1, 2, 3] }]);
    await flushMicrotasks();
    expect(state.getCachedNode(1n)).toBeUndefined();
    expect(state.getCachedSegmentNodes(17n)).toBeUndefined();
    unrelatedRead.resolve([
      { nodeId: 2n, segmentId: 29n, position: [4, 5, 6] },
    ]);
    await expect(other).resolves.toMatchObject([{ nodeId: 2n }]);
    expect(state.getCachedNode(2n)).toBeDefined();
  });

  it("rejects stale retirement preparation without deleting a newer snapshot", () => {
    const state = new SpatialSkeletonState();
    const prepared = state.prepareSpatialSkeletonProjectionStatePublication({
      snapshots: [[17n, undefined]],
      expectedRevisions: getCachedSegmentRevisions(state, [17n]),
      retiredSegmentIds: new Set([17n]),
      activeLogicalOwners: [],
      numericAliases: [],
      provisionalNodeIds: [],
      preparationIntentIdsToRemove: [],
      notify: true,
    })!;
    state.replaceCachedSegmentSnapshots([
      [17n, [{ nodeId: 1n, segmentId: 17n, position: [1, 2, 3] }]],
    ]);
    const current = state.getCachedSegmentSnapshotHandle(17n);
    const revision = state.getCachedSegmentRevision(17n);
    const presentation = state.spatialSkeletonPresentation.value;
    expect(
      state.adoptPreparedSpatialSkeletonProjectionStatePublication(prepared),
    ).toBeUndefined();
    expect(state.getCachedSegmentSnapshotHandle(17n)).toBe(current);
    expect(state.getCachedSegmentRevision(17n)).toBe(revision);
    expect(state.spatialSkeletonPresentation.value).toBe(presentation);
  });

  it("requires an explicit empty replacement for every retired segment", () => {
    const state = new SpatialSkeletonState();
    const snapshot = createCompleteSkeletonSnapshot([
      { nodeId: 1n, segmentId: 17n, position: [1, 2, 3] },
    ]);
    const revision = state.getCachedSegmentRevision(17n);
    const presentation = state.spatialSkeletonPresentation.value;
    for (const snapshots of [[], [[17n, snapshot]]] as const) {
      expect(() =>
        state.prepareSpatialSkeletonProjectionStatePublication({
          snapshots,
          expectedRevisions: getCachedSegmentRevisions(state, [17n]),
          retiredSegmentIds: new Set([17n]),
          activeLogicalOwners: [],
          numericAliases: [],
          provisionalNodeIds: [],
          preparationIntentIdsToRemove: [],
          notify: true,
        }),
      ).toThrow(/Retired spatial skeleton segment 17 must be removed/);
    }
    expect(state.getCachedSegmentRevision(17n)).toBe(revision);
    expect(state.getCachedSegmentNodes(17n)).toBeUndefined();
    expect(state.spatialSkeletonPresentation.value).toBe(presentation);
  });

  it("uses one validated configurable optimistic-edit capacity", () => {
    const defaultState = new SpatialSkeletonState();
    expect(defaultState.optimisticEditQueueCapacity).toBe(64);
    expect(defaultState.commandHistory.capacity).toBe(64);

    const smallState = new SpatialSkeletonState({
      optimisticEditQueueCapacity: 3,
    });
    expect(smallState.optimisticEditQueueCapacity).toBe(3);
    expect(smallState.commandHistory.capacity).toBe(3);

    expect(
      () => new SpatialSkeletonState({ optimisticEditQueueCapacity: 0 }),
    ).toThrow(RangeError);
  });

  it("routes only active or history-owned reads through the projection runtime", () => {
    const state = new SpatialSkeletonState();
    const publishAuthoritativeRead = vi.fn(() => true);
    (state as any).optimisticProjectionRuntime = { publishAuthoritativeRead };
    (state as any).optimisticEditQueue = {
      ownsAuthoritativeReadSegment: (segmentId: bigint) => segmentId === 17n,
    };

    expect(
      (state as any).publishAuthoritativeReadSnapshots(
        new Map([
          [
            11n,
            [
              {
                nodeId: 101n,
                segmentId: 11n,
                position: new Float32Array([1, 2, 3]),
              },
            ],
          ],
        ]),
        { expectedRevisions: new Map([[11n, 0]]) },
      ),
    ).toBe(true);
    expect(publishAuthoritativeRead).not.toHaveBeenCalled();
    expect(state.getCachedSegmentNodes(11n)).toHaveLength(1);

    expect(
      (state as any).publishAuthoritativeReadSnapshots(
        new Map([
          [
            17n,
            [
              {
                nodeId: 202n,
                segmentId: 17n,
                position: new Float32Array([4, 5, 6]),
              },
            ],
          ],
        ]),
        { expectedRevisions: new Map([[17n, 0]]) },
      ),
    ).toBe(true);
    expect(publishAuthoritativeRead).toHaveBeenCalledTimes(1);
    expect(state.getCachedSegmentNodes(17n)).toBeUndefined();
  });

  it("defers old datasource cleanup without blocking replacement engine installation", async () => {
    const state = new SpatialSkeletonState();
    const oldDisposal = deferred<void>();
    const oldCleanup = vi.fn();
    const oldQueue = {
      ...makeOptimisticQueue(),
      dispose: vi.fn(() => oldDisposal.promise),
    };
    (state as any).optimisticEditQueue = oldQueue;
    (state as any).optimisticEditSource = { name: "old" };
    (state as any).optimisticDatasourceCleanup = oldCleanup;

    expect(state.releaseOptimisticEditingEngine()).toBe(true);
    expect(oldQueue.dispose).toHaveBeenCalledTimes(1);
    expect(oldCleanup).not.toHaveBeenCalled();
    expect(state.releaseOptimisticEditingEngine()).toBe(false);

    const replacementCleanup = vi.fn();
    const replacementQueue = {
      ...makeOptimisticQueue(),
      dispose: vi.fn(async () => {}),
    };
    (state as any).optimisticEditQueue = replacementQueue;
    (state as any).optimisticEditSource = { name: "replacement" };
    (state as any).optimisticDatasourceCleanup = replacementCleanup;

    oldDisposal.resolve();
    await flushMicrotasks();
    expect(oldCleanup).toHaveBeenCalledTimes(1);
    expect((state as any).optimisticEditQueue).toBe(replacementQueue);
    expect(replacementCleanup).not.toHaveBeenCalled();

    expect(state.releaseOptimisticEditingEngine()).toBe(true);
    await flushMicrotasks();
    expect(replacementCleanup).toHaveBeenCalledTimes(1);
  });

  it("keeps the first Reload required state across queue and source clearing", async () => {
    const state = new SpatialSkeletonState();
    state.editMode.value = true;
    state.mergeMode.value = true;
    state.splitMode.value = true;
    state.setMergeAnchor(17n);
    state.suppressSelectedNodeHighlight.value = true;
    const versionBeforeFatal = state.optimisticEditQueueVersion.value;
    const cause = new Error("ambiguous transport");

    expect(
      state.latchOptimisticEditFatalState({
        reason: "authority-indeterminate",
        authority: "indeterminate",
        intentId: 5,
        cause,
      }),
    ).toBe(true);

    const fatalState = state.getOptimisticEditFatalState();
    expect(fatalState).toEqual({
      reason: "authority-indeterminate",
      authority: "indeterminate",
      intentId: 5,
      cause,
    });
    expect(Object.isFrozen(fatalState)).toBe(true);
    expect(state.optimisticEditQueueVersion.value).toBe(versionBeforeFatal + 1);
    expect(state.editMode.value).toBe(false);
    expect(state.mergeMode.value).toBe(false);
    expect(state.splitMode.value).toBe(false);
    expect(state.mergeAnchorNodeId.value).toBeUndefined();
    expect(state.suppressSelectedNodeHighlight.value).toBe(false);
    expect(state.hasUnconfirmedOptimisticEdits()).toBe(true);

    expect(
      state.latchOptimisticEditFatalState({
        reason: "committed-local-publication-failed",
        authority: "committed",
        intentId: 9,
      }),
    ).toBe(false);
    expect(state.getOptimisticEditFatalState()).toBe(fatalState);

    expect(state.canUndoOptimisticEdit()).toBe(false);
    expect(state.canRedoOptimisticEdit()).toBe(false);
    const undo = state.undoLatestOptimisticEdit();
    await expect(undo).rejects.toBeInstanceOf(
      SpatialSkeletonOptimisticReloadRequiredError,
    );
    await expect(undo.settled).resolves.toMatchObject({
      outcome: "unchanged",
      reason: "not-started",
    });

    state.clearRuntimeState();
    state.updateCommandHistorySource({ replacement: true });
    expect(state.getOptimisticEditFatalState()).toBe(fatalState);
    expect(() => state.assertOptimisticEditingAllowed()).toThrow(
      SpatialSkeletonOptimisticReloadRequiredError,
    );
  });

  it("retires a segment and aborts an in-flight retained read", async () => {
    const state = new SpatialSkeletonState();
    const segmentId = 17n;
    const node: SkeletonNode = {
      nodeId: 5n,
      segmentId,
      position: new Float32Array([1, 2, 3]),
    };
    state.replaceCachedSegmentSnapshots([[segmentId, [node]]], {
      notify: false,
    });
    state.replaceCachedSegmentSnapshots([[segmentId, undefined]], {
      notify: false,
    });
    const beforeRevision = state.getCachedSegmentRevision(segmentId);
    let requestSignal: AbortSignal | undefined;
    let resolveLateRead!: (nodes: SkeletonNode[]) => void;
    const getSkeleton = vi.fn(
      (_segmentId: bigint, options?: { signal?: AbortSignal }) => {
        requestSignal = options?.signal;
        return new Promise<SkeletonNode[]>((resolve) => {
          resolveLateRead = resolve;
        });
      },
    );
    const skeletonLayer = {
      source: {
        readonly: false,
        listSkeletons: async () => [],
        getSkeleton,
        fetchNodes: async () => [],
        getSpatialIndexMetadata: async () => null,
      },
    } as any;

    const read = state.getFullSegmentNodes(skeletonLayer, segmentId, {
      retainWhileInactive: true,
    });
    await flushMicrotasks();
    expect(requestSignal?.aborted).toBe(false);

    expect(
      adoptPreparedProjectionSnapshots(state, [[segmentId, undefined]], {
        notify: false,
        retiredSegmentIds: new Set([segmentId]),
      }),
    ).toBe(true);

    expect(requestSignal?.aborted).toBe(true);
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
    expect(state.getCachedSegmentNodes(segmentId)).toBeUndefined();
    expect(state.getCachedSegmentRevision(segmentId)).toBeGreaterThan(
      beforeRevision,
    );

    // A source that ignores AbortSignal may still settle later; its detached
    // result cannot repopulate the retired physical id.
    resolveLateRead([node]);
    await flushMicrotasks();
    expect(state.getCachedSegmentNodes(segmentId)).toBeUndefined();
  });

  it("publishes ordered add, remove, and clear preparation changes", () => {
    const state = new SpatialSkeletonState();
    let notifications = 0;
    state.spatialSkeletonPresentation.changed.add(() => {
      notifications += 1;
    });
    const capturedPosition = new Float32Array([1, 2, 3]);

    expect(
      state.addSpatialSkeletonPreparation({
        intentId: 1,
        sequence: 20,
        direction: "execute",
        kind: "merge",
        lifecycle: "preparing",
        segmentIds: [11n, 12n],
        endpointNodeIds: [101n, 102n],
        lastKnownPositions: [{ nodeId: 101n, position: capturedPosition }],
      }),
    ).toBe(true);
    capturedPosition[0] = 99;
    expect(
      state.spatialSkeletonPresentation.value.preparations[0]
        .lastKnownPositions?.[0].position[0],
    ).toBe(1);

    expect(
      state.addSpatialSkeletonPreparation({
        intentId: 2,
        sequence: 10,
        direction: "redo",
        kind: "delete",
        lifecycle: "preparing",
        segmentIds: [17n],
        nodeId: 202n,
      }),
    ).toBe(true);
    expect(
      state.spatialSkeletonPresentation.value.preparations.map(
        ({ intentId }) => intentId,
      ),
    ).toEqual([2, 1]);
    expect(state.removeSpatialSkeletonPreparation(1)).toBe(true);
    expect(
      state.spatialSkeletonPresentation.value.preparations.map(
        ({ intentId }) => intentId,
      ),
    ).toEqual([2]);
    expect(state.clearSpatialSkeletonPreparations()).toBe(true);
    expect(state.spatialSkeletonPresentation.value.preparations).toEqual([]);
    expect(notifications).toBe(4);
  });

  it("clears provisional intent cues with source runtime state", () => {
    const state = new SpatialSkeletonState();
    state.addSpatialSkeletonPreparation({
      intentId: 1,
      sequence: 1,
      direction: "execute",
      kind: "reroot",
      lifecycle: "preparing",
      segmentIds: [11n],
      rootNodeId: 101n,
    });

    expect(state.clearRuntimeState()).toBe(true);
    expect(state.spatialSkeletonPresentation.value.preparations).toEqual([]);
  });

  it("accepts a restore cue for delete Undo", () => {
    const state = new SpatialSkeletonState();
    expect(
      state.addSpatialSkeletonPreparation({
        intentId: 7,
        sequence: 7,
        direction: "undo",
        kind: "restore",
        lifecycle: "preparing",
        segmentIds: [11n],
        nodeId: 101n,
        lastKnownPositions: [
          { nodeId: 101n, position: new Float32Array([1, 2, 3]) },
        ],
      }),
    ).toBe(true);
    expect(state.spatialSkeletonPresentation.value.preparations).toEqual([
      expect.objectContaining({
        intentId: 7,
        kind: "restore",
        nodeId: 101n,
      }),
    ]);
  });

  it("publishes exact topology and preparation removal atomically", () => {
    const state = new SpatialSkeletonState();
    state.addSpatialSkeletonPreparation({
      intentId: 9,
      sequence: 9,
      direction: "execute",
      kind: "split",
      lifecycle: "preparing",
      segmentIds: [11n],
      cutNodeId: 101n,
    });
    const handle = createCompleteSkeletonSnapshot([
      {
        nodeId: 101n,
        segmentId: 11n,
        position: new Float32Array([1, 2, 3]),
      },
    ]);
    const observed: Array<{
      revision: number;
      preparations: number;
      exactSegments: bigint[];
    }> = [];
    state.spatialSkeletonPresentation.changed.add(() => {
      const presentation = state.spatialSkeletonPresentation.value;
      observed.push({
        revision: presentation.revision,
        preparations: presentation.preparations.length,
        exactSegments: presentation.exactSegmentSnapshots.map(
          ({ segmentId }) => segmentId,
        ),
      });
    });
    let nodeNotifications = 0;
    state.nodeDataVersion.changed.add(() => ++nodeNotifications);

    const resultSegment = {
      kind: "segment" as const,
      stableId: "result",
    };
    const prepared = state.prepareSpatialSkeletonProjectionStatePublication({
      snapshots: [[11n, handle]],
      expectedRevisions: getCachedSegmentRevisions(state, [11n]),
      activeLogicalOwners: [{ segmentId: 11n, logicalHandle: resultSegment }],
      numericAliases: [
        { logicalHandle: resultSegment, segmentId: 11n, authoritative: true },
      ],
      provisionalNodeIds: [],
      preparationIntentIdsToRemove: [9],
      notify: true,
    })!;
    state.runSpatialSkeletonPresentationTransaction(() => {
      expect(
        state.adoptPreparedSpatialSkeletonProjectionStatePublication(prepared),
      ).toBeDefined();
    });
    state.finalizePreparedSpatialSkeletonProjectionStatePublication(prepared);

    expect(observed).toEqual([
      {
        revision: 2,
        preparations: 0,
        exactSegments: [11n],
      },
    ]);
    expect(nodeNotifications).toBe(1);
    expect(state.spatialSkeletonPresentation.value.activeLogicalOwners).toEqual(
      [
        expect.objectContaining({
          segmentId: 11n,
          logicalHandle: { kind: "segment", stableId: "result" },
        }),
      ],
    );
  });

  it("returns an editable source when mandatory edit actions are present", () => {
    const source = {
      ...makeEditableSourceCommands(),
      readonly: false,
      listSkeletons: async () => [],
      getSkeleton: async () => [],
      fetchNodes: async () => [],
      getSpatialIndexMetadata: async () => null,
    };

    expect(getEditableSpatiallyIndexedSkeletonSource({ source })).toBe(source);
  });

  it("does not treat a source missing mandatory edit actions as editable", () => {
    const source = {
      ...makeEditableSourceCommands(),
      mergeSkeletonsCommand: undefined,
      readonly: false,
      listSkeletons: async () => [],
      getSkeleton: async () => [],
      fetchNodes: async () => [],
      getSpatialIndexMetadata: async () => null,
    };

    expect(
      getEditableSpatiallyIndexedSkeletonSource({ source }),
    ).toBeUndefined();
  });

  it("does not treat a writable source without a queue provider as editable", () => {
    const { optimisticEditing: _optimisticEditing, ...commands } =
      makeEditableSourceCommands();
    const source = {
      ...commands,
      readonly: false,
      listSkeletons: async () => [],
      getSkeleton: async () => [],
      fetchNodes: async () => [],
      getSpatialIndexMetadata: async () => null,
    };

    expect(
      getEditableSpatiallyIndexedSkeletonSource({ source }),
    ).toBeUndefined();
  });

  it("does not treat a command factory for the wrong action as editable", () => {
    const source = {
      ...makeEditableSourceCommands(),
      moveNodesCommand: makeCommandFactory(SpatialSkeletonActions.addNodes),
      readonly: false,
      listSkeletons: async () => [],
      getSkeleton: async () => [],
      fetchNodes: async () => [],
      getSpatialIndexMetadata: async () => null,
    };

    expect(
      getEditableSpatiallyIndexedSkeletonSource({ source }),
    ).toBeUndefined();
  });

  it("does not require optional edit actions for editable source validation", () => {
    const source = {
      ...makeEditableSourceCommands(),
      readonly: false,
      listSkeletons: async () => [],
      getSkeleton: async () => [],
      fetchNodes: async () => [],
      getSpatialIndexMetadata: async () => null,
    };

    expect(getEditableSpatiallyIndexedSkeletonSource({ source })).toBe(source);
  });

  it("looks up edit command factories from shared action metadata", () => {
    const source = {
      ...makeEditableSourceCommands(),
      rerootCommand: makeCommandFactory(SpatialSkeletonActions.reroot),
      readonly: false,
      listSkeletons: async () => [],
      getSkeleton: async () => [],
      fetchNodes: async () => [],
      getSpatialIndexMetadata: async () => null,
    };

    expect(
      getSpatialSkeletonEditCommandFactoryForAction(
        source as any,
        SpatialSkeletonActions.moveNodes,
      ),
    ).toBe(source.moveNodesCommand);
    expect(
      getSpatialSkeletonEditCommandFactoryForAction(
        source as any,
        SpatialSkeletonActions.reroot,
      ),
    ).toBe(source.rerootCommand);
    expect(
      getSpatialSkeletonEditCommandFactoryForAction(
        source as any,
        SpatialSkeletonActions.inspect,
      ),
    ).toBeUndefined();
  });

  it("validates optional confidence configuration for editable sources", () => {
    const source = {
      ...makeEditableSourceCommands(),
      editNodeConfidenceCommand: makeCommandFactory(
        SpatialSkeletonActions.editNodeConfidence,
      ),
      spatialSkeletonConfidenceConfiguration: {
        values: [0, 50, 100],
      },
      readonly: false,
      listSkeletons: async () => [],
      getSkeleton: async () => [],
      fetchNodes: async () => [],
      getSpatialIndexMetadata: async () => null,
    };

    expect(getEditableSpatiallyIndexedSkeletonSource({ source })).toBe(source);

    expect(
      getEditableSpatiallyIndexedSkeletonSource({
        source: {
          ...source,
          spatialSkeletonConfidenceConfiguration: {
            values: [0, Number.NaN, 100],
          },
        },
      }),
    ).toBeUndefined();
  });

  it("requires confidence configuration only for confidence edit support", () => {
    const source = {
      ...makeEditableSourceCommands(),
      editNodeConfidenceCommand: makeCommandFactory(
        SpatialSkeletonActions.editNodeConfidence,
      ),
      readonly: false,
      listSkeletons: async () => [],
      getSkeleton: async () => [],
      fetchNodes: async () => [],
      getSpatialIndexMetadata: async () => null,
    };

    expect(getEditableSpatiallyIndexedSkeletonSource({ source })).toBe(source);
    expect(
      editableSpatiallyIndexedSkeletonSourceSupportsAction(
        source as any,
        SpatialSkeletonActions.addNodes,
      ),
    ).toBe(true);
    expect(
      editableSpatiallyIndexedSkeletonSourceSupportsAction(
        source as any,
        SpatialSkeletonActions.editNodeConfidence,
      ),
    ).toBe(false);

    expect(
      editableSpatiallyIndexedSkeletonSourceSupportsAction(
        {
          ...source,
          spatialSkeletonConfidenceConfiguration: {
            values: [0, 50, 100],
          },
        } as any,
        SpatialSkeletonActions.editNodeConfidence,
      ),
    ).toBe(true);
  });

  it("does not treat a read-only source with edit commands as editable", () => {
    const source = {
      ...makeEditableSourceCommands(),
      readonly: true,
      listSkeletons: async () => [],
      getSkeleton: async () => [],
      fetchNodes: async () => [],
      getSpatialIndexMetadata: async () => null,
    };

    expect(
      getEditableSpatiallyIndexedSkeletonSource({ source }),
    ).toBeUndefined();
  });

  it("treats missing or invalid spatial skeleton sources as read-only", () => {
    expect(isSpatiallyIndexedSkeletonSourceReadOnly(undefined)).toBe(true);
    expect(
      isSpatiallyIndexedSkeletonSourceReadOnly({ source: undefined }),
    ).toBe(true);
    expect(
      isSpatiallyIndexedSkeletonSourceReadOnly({
        source: {
          readonly: false,
        },
      }),
    ).toBe(true);
  });

  it("reads spatial skeleton source read-only state", () => {
    const source = {
      readonly: false,
      listSkeletons: async () => [],
      getSkeleton: async () => [],
      fetchNodes: async () => [],
      getSpatialIndexMetadata: async () => null,
    };

    expect(isSpatiallyIndexedSkeletonSourceReadOnly({ source })).toBe(false);
    expect(
      isSpatiallyIndexedSkeletonSourceReadOnly({
        source: {
          ...source,
          readonly: true,
        },
      }),
    ).toBe(true);
  });

  it("clears the full skeleton cache before notifying node data listeners", () => {
    const state = new SpatialSkeletonState();
    const cachedSegmentId = 11n;
    (state as any).fullSegmentNodeCache.set(cachedSegmentId, [
      {
        nodeId: 1n,
        segmentId: cachedSegmentId,
        position: new Float32Array([1, 2, 3]),
      },
    ]);

    let cachePresentDuringNotification: boolean | undefined;
    state.nodeDataVersion.changed.add(() => {
      cachePresentDuringNotification = (state as any).fullSegmentNodeCache.has(
        cachedSegmentId,
      );
    });

    state.markNodeDataChanged();

    expect(cachePresentDuringNotification).toBe(false);
    expect((state as any).fullSegmentNodeCache.has(cachedSegmentId)).toBe(
      false,
    );
  });

  it("clears inspected cache state and pending node positions together", () => {
    const state = new SpatialSkeletonState();
    state.replaceCachedSegmentSnapshots(
      [
        [
          11n,
          [
            {
              nodeId: 5n,
              segmentId: 11n,
              position: new Float32Array([1, 2, 3]),
            },
          ],
        ],
      ],
      { notify: false },
    );
    state.setPendingNodePosition(5n, [4, 5, 6]);
    const nodeDataVersion = state.nodeDataVersion.value;
    const pendingNodePositionVersion = state.pendingNodePositionVersion.value;

    expect(state.clearInspectedSkeletonCache()).toBe(true);
    expect(state.getCachedSegmentNodes(11n)).toBeUndefined();
    expect(state.getCachedNode(5n)).toBeUndefined();
    expect(state.getPendingNodePosition(5n)).toBeUndefined();
    expect(state.nodeDataVersion.value).toBe(nodeDataVersion + 1);
    expect(state.pendingNodePositionVersion.value).toBe(
      pendingNodePositionVersion + 1,
    );
  });

  it("keeps only the active interaction position", () => {
    const state = new SpatialSkeletonState();
    expect(state.setPendingNodePosition(5n, [1, 2, 3])).toBe(true);
    expect(state.setPendingNodePosition(5n, [1, 2, 3])).toBe(false);
    expect(Array.from(state.getPendingNodePosition(5n)!)).toEqual([1, 2, 3]);

    // Pointer events keep reporting the originally picked id if that identity
    // is remapped mid-drag, so updates preserve the active identity.
    expect(state.setPendingNodePosition(6n, [4, 5, 6])).toBe(true);
    expect(Array.from(state.getPendingNodePosition(5n)!)).toEqual([4, 5, 6]);
    expect(state.getPendingNodePosition(6n)).toBeUndefined();
    expect([...state.getPendingNodeIds()]).toEqual([5n]);
    expect(state.clearPendingNodePositions()).toBe(true);
    expect(state.setPendingNodePosition(6n, [7, 8, 9])).toBe(true);
    expect(state.clearPendingNodePositions()).toBe(true);
    expect([...state.getPendingNodeIds()]).toEqual([]);
  });

  it("remaps the active interaction position by node id", () => {
    const state = new SpatialSkeletonState();

    state.setPendingNodePosition(1_000_000_000n, [9, 9, 9]);
    const version = state.pendingNodePositionVersion.value;

    expect(
      state.remapPendingNodePositions(new Map([[1_000_000_000n, 20n]])),
    ).toBe(true);
    expect(state.pendingNodePositionVersion.value).toBe(version + 1);
    expect(state.getPendingNodePosition(1_000_000_000n)).toBeUndefined();
    expect(Array.from(state.getPendingNodePosition(20n)!)).toEqual([9, 9, 9]);
    expect(state.setPendingNodePosition(1_000_000_000n, [10, 10, 10])).toBe(
      true,
    );
    expect(state.getPendingNodePosition(1_000_000_000n)).toBeUndefined();
    expect(Array.from(state.getPendingNodePosition(20n)!)).toEqual([
      10, 10, 10,
    ]);
  });

  it("atomically repartitions cached segments from immutable replacement input", () => {
    const state = new SpatialSkeletonState();
    const originalNodes = [
      {
        nodeId: 1n,
        segmentId: 11n,
        position: new Float32Array([1, 1, 1]),
        parentNodeId: undefined,
      },
      {
        nodeId: 2n,
        segmentId: 11n,
        position: new Float32Array([2, 2, 2]),
        parentNodeId: 1n,
      },
      {
        nodeId: 3n,
        segmentId: 11n,
        position: new Float32Array([3, 3, 3]),
        parentNodeId: 2n,
      },
    ];
    state.replaceCachedSegmentSnapshots([[11n, originalNodes] as const], {
      notify: false,
    });

    // Replacement clones keep the caller's immutable input independent.
    (state.getCachedNode(2n)!.position as Float32Array)[0] = 99;
    expect(originalNodes[1].position).toEqual(new Float32Array([2, 2, 2]));

    const splitRoot = {
      ...state.getCachedNode(2n)!,
      segmentId: 999n,
      position: new Float32Array([2, 2, 2]),
      parentNodeId: undefined,
    };
    const notificationSnapshots: unknown[] = [];
    state.nodeDataVersion.changed.add(() => {
      notificationSnapshots.push({
        originalNodeIds: state
          .getCachedSegmentNodes(11n)
          ?.map((node) => node.nodeId),
        splitNodeIds: state
          .getCachedSegmentNodes(17n)
          ?.map((node) => node.nodeId),
        splitRootSegmentId: state.getCachedNode(2n)?.segmentId,
      });
    });

    expect(
      state.replaceCachedSegmentSnapshots([
        [11n, [state.getCachedNode(1n)!]] as const,
        [
          17n,
          [
            splitRoot,
            {
              ...state.getCachedNode(3n)!,
              segmentId: 999n,
            },
          ],
        ] as const,
      ]),
    ).toBe(true);

    expect(notificationSnapshots).toEqual([
      {
        originalNodeIds: [1n],
        splitNodeIds: [2n, 3n],
        splitRootSegmentId: 17n,
      },
    ]);
    expect(state.getCachedNode(3n)).toBe(state.getCachedSegmentNodes(17n)?.[1]);
    expect(state.getCachedNode(2n)?.segmentId).toBe(17n);

    // Replacement inputs are cloned and cannot mutate the live cache later.
    splitRoot.position[0] = 123;
    expect(state.getCachedNode(2n)?.position).toEqual(
      new Float32Array([2, 2, 2]),
    );

    expect(
      state.replaceCachedSegmentSnapshots([
        [11n, originalNodes] as const,
        [17n, undefined] as const,
      ]),
    ).toBe(true);
    expect(state.getCachedSegmentNodes(17n)).toBeUndefined();
    expect(state.getCachedNode(2n)?.segmentId).toBe(11n);
    expect(state.getCachedNode(2n)?.position).toEqual(
      new Float32Array([2, 2, 2]),
    );
  });

  it("preflights inspected nodes from the current complete snapshot handle", () => {
    const state = new SpatialSkeletonState();
    state.replaceCachedSegmentSnapshots(
      [
        [
          11n,
          [
            {
              nodeId: 5n,
              segmentId: 11n,
              position: new Float32Array([1, 2, 3]),
            },
          ],
        ],
      ],
      { notify: false },
    );

    const inspected = state.tryAcquireInputReference({
      segmentId: 11n,
      nodeId: 5n,
    });
    expect(inspected?.snapshot).toEqual(
      state.getCachedSegmentSnapshotHandle(11n),
    );
    expect(inspected?.snapshot.handle.getNode(5n)?.segmentId).toBe(11n);
    inspected?.release();
    expect(
      state.tryAcquireInputReference({
        segmentId: 11n,
        nodeId: 6n,
      }),
    ).toBeUndefined();
    expect(
      state.tryAcquireInputReference({
        segmentId: 17n,
        nodeId: 5n,
      }),
    ).toBeUndefined();
    expect(() =>
      state.tryAcquireInputReference({
        segmentId: 11n,
        nodeId: 0n,
      }),
    ).toThrowError("Invalid spatial skeleton node id: 0");
    expect(() =>
      state.tryAcquireInputReference({
        segmentId: 0n,
      }),
    ).toThrowError("Invalid spatial skeleton segment id: 0");
  });

  it("keeps a snapshot available until every input reference is released", () => {
    const state = new SpatialSkeletonState();
    state.replaceCachedSegmentSnapshots(
      [
        [
          11n,
          [
            {
              nodeId: 5n,
              segmentId: 11n,
              position: new Float32Array([1, 2, 3]),
            },
          ],
        ],
        [
          17n,
          [
            {
              nodeId: 7n,
              segmentId: 17n,
              position: new Float32Array([4, 5, 6]),
            },
          ],
        ],
      ],
      { notify: false },
    );
    const requirement = {
      segmentId: 11n,
      nodeId: 5n,
    } as const;
    const firstInput = state.tryAcquireInputReference(requirement)!;
    const secondInput = state.acquireInputReference(
      requirement,
      SpatialSkeletonActions.moveNodes,
    );

    expect(firstInput.isCurrent()).toBe(true);
    expect(secondInput.isCurrent()).toBe(true);
    expect(state.evictInactiveSegmentNodes([])).toBe(true);
    expect(state.getCachedSegmentNodes(11n)).toHaveLength(1);
    expect(state.getCachedSegmentNodes(17n)).toBeUndefined();

    firstInput.release();
    firstInput.release();
    expect(firstInput.isCurrent()).toBe(false);
    expect(state.evictInactiveSegmentNodes([])).toBe(false);
    expect(state.getCachedSegmentNodes(11n)).toHaveLength(1);

    secondInput.release();
    expect(state.evictInactiveSegmentNodes([])).toBe(true);
    expect(state.getCachedSegmentNodes(11n)).toBeUndefined();
  });

  it("invalidates an input reference when its snapshot is replaced", () => {
    const state = new SpatialSkeletonState();
    state.replaceCachedSegmentSnapshots(
      [
        [
          11n,
          [
            {
              nodeId: 5n,
              segmentId: 11n,
              position: new Float32Array([1, 2, 3]),
            },
          ],
        ],
      ],
      { notify: false },
    );
    const inputReference = state.acquireInputReference({
      segmentId: 11n,
      nodeId: 5n,
    });

    expect(
      state.replaceCachedSegmentSnapshots([
        [
          11n,
          [
            {
              nodeId: 5n,
              segmentId: 11n,
              position: new Float32Array([4, 5, 6]),
            },
          ],
        ],
      ]),
    ).toBe(true);
    expect(inputReference.isCurrent()).toBe(false);
    expect(state.evictInactiveSegmentNodes([])).toBe(true);
    expect(state.getCachedSegmentNodes(11n)).toBeUndefined();
    inputReference.release();
  });

  it("reports typed snapshot requirement failures without starting a read", () => {
    const state = new SpatialSkeletonState();
    const coldRequirement = {
      segmentId: 11n,
      nodeId: 5n,
    } as const;

    expect(() =>
      state.acquireInputReference(
        coldRequirement,
        SpatialSkeletonActions.moveNodes,
      ),
    ).toThrowError(SpatialSkeletonInspectionRequiredError);
    try {
      state.acquireInputReference(
        coldRequirement,
        SpatialSkeletonActions.moveNodes,
      );
    } catch (error) {
      expect(error).toMatchObject({
        reason: "snapshot-unavailable",
        action: SpatialSkeletonActions.moveNodes,
        requirement: coldRequirement,
      });
      expect((error as Error).message).toBe(
        "Inspect skeleton 11 before node movement.",
      );
    }

    state.replaceCachedSegmentSnapshots([[11n, []]], { notify: false });
    try {
      state.acquireInputReference(coldRequirement);
    } catch (error) {
      expect(error).toMatchObject({ reason: "node-unavailable" });
      expect((error as Error).message).toContain(
        "Node 5 is not present in inspected skeleton 11.",
      );
    }
  });

  it("adopts one trusted materialization and exposes its cache revision", () => {
    const state = new SpatialSkeletonState();
    state.replaceCachedSegmentSnapshots(
      [
        [
          11n,
          [
            {
              nodeId: 1n,
              segmentId: 11n,
              position: new Float32Array([1, 1, 1]),
            },
            {
              nodeId: 2n,
              segmentId: 11n,
              position: new Float32Array([2, 2, 2]),
              parentNodeId: 1n,
            },
          ],
        ] as const,
      ],
      { notify: false },
    );
    const baseline = state.getCachedSegmentSnapshotHandle(11n)!;
    const projected = patchCompleteSkeletonSnapshot(baseline.handle, [
      {
        kind: "update",
        nodeId: 1n,
        changes: { confidence: 75 },
      },
    ]);
    const expectedRevisions = getCachedSegmentRevisions(state, [11n]);

    expect(projected.materializationCount).toBe(0);
    expect(
      adoptPreparedProjectionSnapshots(state, [[11n, projected]], {
        expectedRevisions,
        notify: false,
      }),
    ).toBe(true);
    const materialized = projected.materialize();
    expect(projected.materializationCount).toBe(1);
    expect(state.getCachedSegmentNodes(11n)).toBe(materialized);
    expect(projected.materialize()).toBe(materialized);
    expect(projected.materializationCount).toBe(1);

    const adopted = state.getCachedSegmentSnapshotHandle(11n)!;
    expect(adopted.handle).toBe(projected);
    expect(adopted.cacheRevision).toBe(state.getCachedSegmentRevision(11n));
    expect(adopted.cacheRevision).toBeGreaterThan(baseline.cacheRevision);
  });

  it("prepares a state-owned projection artifact and adopts it without rematerializing", () => {
    const state = new SpatialSkeletonState();
    state.replaceCachedSegmentSnapshots(
      [
        [
          11n,
          [
            {
              nodeId: 1n,
              segmentId: 11n,
              position: new Float32Array([1, 1, 1]),
            },
          ],
        ],
      ],
      { notify: false },
    );
    const baseline = state.getCachedSegmentSnapshotHandle(11n)!;
    const projected = patchCompleteSkeletonSnapshot(baseline.handle, [
      {
        kind: "update",
        nodeId: 1n,
        changes: { position: [7, 8, 9] },
      },
    ]);
    const prepared = state.prepareSpatialSkeletonProjectionStatePublication({
      snapshots: [[11n, projected]],
      expectedRevisions: getCachedSegmentRevisions(state, [11n]),
      activeLogicalOwners: [],
      numericAliases: [],
      provisionalNodeIds: [],
      preparationIntentIdsToRemove: [],
      notify: true,
    })!;

    expect(projected.materializationCount).toBe(1);
    expect(state.getCachedSegmentSnapshotHandle(11n)?.handle).toBe(
      baseline.handle,
    );
    let adopted:
      | ReturnType<
          SpatialSkeletonState["adoptPreparedSpatialSkeletonProjectionStatePublication"]
        >
      | undefined;
    state.runSpatialSkeletonPresentationTransaction(() => {
      adopted =
        state.adoptPreparedSpatialSkeletonProjectionStatePublication(prepared);
    });

    expect(adopted).toBeDefined();
    expect(projected.materializationCount).toBe(1);
    expect(state.getCachedSegmentSnapshotHandle(11n)?.handle).toBe(projected);
    expect(state.getCachedNode(1n)?.position).toEqual([7, 8, 9]);
    expect(() =>
      state.adoptPreparedSpatialSkeletonProjectionStatePublication(prepared),
    ).toThrow(/already adopted/);
    expect(() =>
      state.adoptPreparedSpatialSkeletonProjectionStatePublication(
        {} as SpatialSkeletonPreparedProjectionStatePublication,
      ),
    ).toThrow(/belongs to another state/);
  });

  it("rejects a stale or duplicate-owner prepared publication before adoption", () => {
    const state = new SpatialSkeletonState();
    state.replaceCachedSegmentSnapshots(
      [
        [11n, [{ nodeId: 1n, segmentId: 11n, position: [1, 1, 1] }]],
        [17n, [{ nodeId: 2n, segmentId: 17n, position: [2, 2, 2] }]],
      ],
      { notify: false },
    );
    const baseline = state.getCachedSegmentSnapshotHandle(11n)!;
    const projected = patchCompleteSkeletonSnapshot(baseline.handle, [
      { kind: "update", nodeId: 1n, changes: { confidence: 70 } },
    ]);
    const prepared = state.prepareSpatialSkeletonProjectionStatePublication({
      snapshots: [[11n, projected]],
      expectedRevisions: getCachedSegmentRevisions(state, [11n]),
      activeLogicalOwners: [],
      numericAliases: [],
      provisionalNodeIds: [],
      preparationIntentIdsToRemove: [],
      notify: true,
    })!;
    state.replaceCachedSegmentSnapshots([
      [
        11n,
        [
          {
            nodeId: 1n,
            segmentId: 11n,
            position: new Float32Array([3, 3, 3]),
          },
        ],
      ],
    ]);
    const beforeStaleAdoption = state.getCachedSegmentSnapshotHandle(11n)!;

    expect(
      state.adoptPreparedSpatialSkeletonProjectionStatePublication(prepared),
    ).toBeUndefined();
    expect(state.getCachedSegmentSnapshotHandle(11n)).toBe(beforeStaleAdoption);
    expect(state.getCachedNode(1n)?.confidence).toBeUndefined();

    const duplicateOwner = createCompleteSkeletonSnapshot([
      { nodeId: 2n, segmentId: 11n, position: [9, 9, 9] },
    ]);
    const presentation = state.spatialSkeletonPresentation.value;
    expect(() =>
      state.prepareSpatialSkeletonProjectionStatePublication({
        snapshots: [[11n, duplicateOwner]],
        expectedRevisions: getCachedSegmentRevisions(state, [11n]),
        activeLogicalOwners: [],
        numericAliases: [],
        provisionalNodeIds: [],
        preparationIntentIdsToRemove: [],
        notify: true,
      }),
    ).toThrow(/node 2 is present in both segment 17 and segment 11/);
    expect(state.getCachedSegmentSnapshotHandle(11n)).toBe(beforeStaleAdoption);
    expect(state.spatialSkeletonPresentation.value).toBe(presentation);
  });

  it("shares unchanged nodes through trusted patch adoption", () => {
    const state = new SpatialSkeletonState();
    const baseline = createCompleteSkeletonSnapshot([
      {
        nodeId: 1n,
        segmentId: 11n,
        position: new Float32Array([1, 1, 1]),
      },
      {
        nodeId: 2n,
        segmentId: 11n,
        position: new Float32Array([2, 2, 2]),
        parentNodeId: 1n,
      },
    ]);
    expect(
      adoptPreparedProjectionSnapshots(state, [[11n, baseline]], {
        notify: false,
      }),
    ).toBe(true);
    const projected = patchCompleteSkeletonSnapshot(baseline, [
      {
        kind: "update",
        nodeId: 1n,
        changes: { radius: 4 },
      },
    ]);

    expect(
      adoptPreparedProjectionSnapshots(state, [[11n, projected]], {
        notify: false,
      }),
    ).toBe(true);
    expect(state.getCachedSegmentNodes(11n)?.[1]).toBe(baseline.getNode(2n));
    expect(state.getCachedSegmentNodes(11n)?.[0]).not.toBe(
      baseline.getNode(1n),
    );
  });

  it("retains sixty-four lazy patch handles and materializes only the adopted revision", () => {
    const state = new SpatialSkeletonState();
    const baseline = createCompleteSkeletonSnapshot(
      Array.from({ length: 128 }, (_, index) => ({
        nodeId: BigInt(index + 1),
        segmentId: 11n,
        position: new Float32Array([index, index + 1, index + 2]),
        parentNodeId: index === 0 ? undefined : BigInt(index),
      })),
    );
    const revisions = [baseline];
    for (let nodeId = 1; nodeId <= 64; ++nodeId) {
      revisions.push(
        patchCompleteSkeletonSnapshot(revisions.at(-1)!, [
          {
            kind: "update",
            nodeId: BigInt(nodeId),
            changes: { confidence: nodeId },
          },
        ]),
      );
    }

    expect(
      revisions.slice(1).every((handle) => handle.materializationCount === 0),
    ).toBe(true);
    const projected = revisions.at(-1)!;
    expect(
      adoptPreparedProjectionSnapshots(state, [[11n, projected]], {
        notify: false,
      }),
    ).toBe(true);
    expect(projected.materializationCount).toBe(1);
    expect(
      revisions
        .slice(1, -1)
        .every((handle) => handle.materializationCount === 0),
    ).toBe(true);
    expect(state.getCachedSegmentNodes(11n)).toBe(projected.materialize());
    expect(state.getCachedNode(64n)?.confidence).toBe(64);
    expect(state.getCachedNode(65n)).toBe(baseline.getNode(65n));
  });

  it("rejects stale trusted adoption before materializing and supports deletion", () => {
    const state = new SpatialSkeletonState();
    const baseline = createCompleteSkeletonSnapshot([
      {
        nodeId: 1n,
        segmentId: 11n,
        position: new Float32Array([1, 2, 3]),
      },
    ]);
    adoptPreparedProjectionSnapshots(state, [[11n, baseline]], {
      notify: false,
    });
    const expectedRevisions = getCachedSegmentRevisions(state, [11n]);
    const stale = patchCompleteSkeletonSnapshot(baseline, [
      { kind: "update", nodeId: 1n, changes: { radius: 8 } },
    ]);
    expect(
      state.replaceCachedSegmentSnapshots([
        [
          11n,
          [
            {
              nodeId: 1n,
              segmentId: 11n,
              position: new Float32Array([4, 5, 6]),
            },
          ],
        ],
      ]),
    ).toBe(true);

    expect(
      adoptPreparedProjectionSnapshots(state, [[11n, stale]], {
        expectedRevisions,
        notify: false,
      }),
    ).toBe(false);
    expect(stale.materializationCount).toBe(0);

    const deletionRevision = getCachedSegmentRevisions(state, [11n]);
    expect(
      adoptPreparedProjectionSnapshots(state, [[11n, undefined]], {
        expectedRevisions: deletionRevision,
        notify: false,
      }),
    ).toBe(true);
    expect(state.getCachedSegmentNodes(11n)).toBeUndefined();
    expect(state.getCachedSegmentSnapshotHandle(11n)).toBeUndefined();
  });

  it("distinguishes known-empty and uncached segment snapshots", () => {
    const state = new SpatialSkeletonState();

    expect(state.getCachedSegmentNodes(21n)).toBeUndefined();
    expect(
      state.replaceCachedSegmentSnapshots([[21n, []] as const], {
        notify: false,
      }),
    ).toBe(true);
    expect(state.getCachedSegmentNodes(21n)).toEqual([]);

    expect(
      state.replaceCachedSegmentSnapshots([[21n, undefined]], {
        notify: false,
      }),
    ).toBe(true);
    expect(state.getCachedSegmentNodes(21n)).toBeUndefined();
    expect(
      state.replaceCachedSegmentSnapshots([[21n, undefined]], {
        notify: false,
      }),
    ).toBe(false);
  });

  it("rejects an inconsistent atomic replacement before changing the cache", () => {
    const state = new SpatialSkeletonState();
    state.replaceCachedSegmentSnapshots(
      [
        [
          11n,
          [
            {
              nodeId: 1n,
              segmentId: 11n,
              position: new Float32Array([1, 1, 1]),
            },
          ],
        ] as const,
        [
          13n,
          [
            {
              nodeId: 2n,
              segmentId: 13n,
              position: new Float32Array([2, 2, 2]),
            },
          ],
        ] as const,
      ],
      { notify: false },
    );
    const beforeSegment11 = state.getCachedSegmentNodes(11n);
    const beforeSegment13 = state.getCachedSegmentNodes(13n);
    const beforeHandle11 = state.getCachedSegmentSnapshotHandle(11n);
    const beforeHandle13 = state.getCachedSegmentSnapshotHandle(13n);
    const nodeDataVersion = state.nodeDataVersion.value;

    expect(() =>
      state.replaceCachedSegmentSnapshots([
        [
          11n,
          [
            {
              nodeId: 3n,
              segmentId: 11n,
              position: new Float32Array([3, 3, 3]),
            },
          ],
        ] as const,
        [
          13n,
          [
            {
              nodeId: 3n,
              segmentId: 13n,
              position: new Float32Array([4, 4, 4]),
            },
          ],
        ] as const,
      ]),
    ).toThrow("node 3 is present in both segment 11 and segment 13");

    expect(state.getCachedSegmentNodes(11n)).toBe(beforeSegment11);
    expect(state.getCachedSegmentNodes(13n)).toBe(beforeSegment13);
    expect(state.getCachedSegmentSnapshotHandle(11n)).toBe(beforeHandle11);
    expect(state.getCachedSegmentSnapshotHandle(13n)).toBe(beforeHandle13);
    expect(state.getCachedNode(1n)?.segmentId).toBe(11n);
    expect(state.getCachedNode(2n)?.segmentId).toBe(13n);
    expect(state.getCachedNode(3n)).toBeUndefined();
    expect(state.nodeDataVersion.value).toBe(nodeDataVersion);
  });

  it("updates the reverse index without iterating unaffected segment snapshots", () => {
    const state = new SpatialSkeletonState();
    state.replaceCachedSegmentSnapshots(
      [
        [
          11n,
          [
            {
              nodeId: 1n,
              segmentId: 11n,
              position: new Float32Array([1, 1, 1]),
            },
          ],
        ] as const,
        [
          13n,
          [
            {
              nodeId: 2n,
              segmentId: 13n,
              position: new Float32Array([2, 2, 2]),
            },
            {
              nodeId: 3n,
              segmentId: 13n,
              position: new Float32Array([3, 3, 3]),
              parentNodeId: 2n,
            },
          ],
        ] as const,
      ],
      { notify: false },
    );
    const unaffectedNodes = state.getCachedSegmentNodes(13n)!;
    const unaffectedNode = state.getCachedNode(2n);
    const iterateUnaffected = vi.fn((): IterableIterator<SkeletonNode> => {
      throw new Error("unaffected segment was iterated");
    });
    Object.defineProperty(unaffectedNodes, Symbol.iterator, {
      configurable: true,
      value: iterateUnaffected,
    });

    expect(
      state.replaceCachedSegmentSnapshots([
        [
          11n,
          [
            {
              nodeId: 1n,
              segmentId: 11n,
              position: new Float32Array([4, 5, 6]),
            },
          ],
        ],
      ]),
    ).toBe(true);

    expect(iterateUnaffected).not.toHaveBeenCalled();
    expect(state.getCachedNode(2n)).toBe(unaffectedNode);
    expect(state.getCachedNode(3n)?.segmentId).toBe(13n);
    expect(state.getCachedNode(1n)?.position).toEqual(
      new Float32Array([4, 5, 6]),
    );
  });

  it("rejects a reverse-index collision with an unaffected segment atomically", () => {
    const state = new SpatialSkeletonState();
    state.replaceCachedSegmentSnapshots(
      [
        [
          11n,
          [
            {
              nodeId: 1n,
              segmentId: 11n,
              position: new Float32Array([1, 1, 1]),
            },
          ],
        ] as const,
        [
          13n,
          [
            {
              nodeId: 2n,
              segmentId: 13n,
              position: new Float32Array([2, 2, 2]),
            },
          ],
        ] as const,
      ],
      { notify: false },
    );
    const segment11Nodes = state.getCachedSegmentNodes(11n);
    const segment13Nodes = state.getCachedSegmentNodes(13n);
    const node1 = state.getCachedNode(1n);
    const node2 = state.getCachedNode(2n);
    const segment11Revision = state.getCachedSegmentRevision(11n);
    const segment13Revision = state.getCachedSegmentRevision(13n);
    const nodeDataVersion = state.nodeDataVersion.value;

    expect(() =>
      state.replaceCachedSegmentSnapshots([
        [
          11n,
          [
            {
              nodeId: 2n,
              segmentId: 11n,
              position: new Float32Array([9, 9, 9]),
            },
          ],
        ] as const,
      ]),
    ).toThrow("node 2 is present in both segment 13 and segment 11");

    expect(state.getCachedSegmentNodes(11n)).toBe(segment11Nodes);
    expect(state.getCachedSegmentNodes(13n)).toBe(segment13Nodes);
    expect(state.getCachedNode(1n)).toBe(node1);
    expect(state.getCachedNode(2n)).toBe(node2);
    expect(state.getCachedSegmentRevision(11n)).toBe(segment11Revision);
    expect(state.getCachedSegmentRevision(13n)).toBe(segment13Revision);
    expect(state.nodeDataVersion.value).toBe(nodeDataVersion);
  });

  it("rejects and does not cache a non-cooperative fetch evicted while pending", async () => {
    const state = new SpatialSkeletonState();
    let resolveFetch:
      | ((
          value: Array<{
            nodeId: bigint;
            parentNodeId?: bigint;
            position: Float32Array;
            segmentId: bigint;
            isTrueEnd: boolean;
          }>,
        ) => void)
      | undefined;
    const getSkeleton = vi.fn(
      () =>
        new Promise<
          Array<{
            nodeId: bigint;
            parentNodeId?: bigint;
            position: Float32Array;
            segmentId: bigint;
            isTrueEnd: boolean;
          }>
        >((resolve) => {
          resolveFetch = resolve as typeof resolveFetch;
        }),
    );
    const skeletonLayer = {
      source: {
        readonly: false,
        listSkeletons: async () => [],
        getSkeleton,
        fetchNodes: async () => [],
        getSpatialIndexMetadata: async () => null,
      },
    } as any;

    const pending = state
      .getFullSegmentNodes(skeletonLayer, 11n)
      .catch((error) => error);

    state.evictInactiveSegmentNodes([]);
    resolveFetch?.([
      {
        nodeId: 5n,
        parentNodeId: undefined,
        position: new Float32Array([1, 2, 3]),
        segmentId: 11n,
        isTrueEnd: false,
      },
    ]);

    await expect(pending).resolves.toMatchObject({ name: "AbortError" });
    expect(state.getCachedSegmentNodes(11n)).toBeUndefined();
    expect(state.getCachedNode(5n)).toBeUndefined();
  });

  it("tracks monotonic segment revisions across atomic replacement and clearing", () => {
    const state = new SpatialSkeletonState();
    const initialRevision = state.getCachedSegmentRevision(11n);

    state.replaceCachedSegmentSnapshots(
      [
        [
          11n,
          [
            {
              nodeId: 5n,
              segmentId: 11n,
              position: new Float32Array([1, 2, 3]),
            },
          ],
        ] as const,
      ],
      { notify: false },
    );
    const replacedRevision = state.getCachedSegmentRevision(11n);
    expect(replacedRevision).toBeGreaterThan(initialRevision);

    expect(
      state.replaceCachedSegmentSnapshots(
        [
          [
            11n,
            [
              {
                nodeId: 5n,
                segmentId: 11n,
                position: new Float32Array([4, 5, 6]),
              },
            ],
          ],
        ],
        { notify: false },
      ),
    ).toBe(true);
    const secondReplacementRevision = state.getCachedSegmentRevision(11n);
    expect(secondReplacementRevision).toBeGreaterThan(replacedRevision);

    expect(state.clearInspectedSkeletonCache()).toBe(true);
    expect(state.getCachedSegmentRevision(11n)).toBeGreaterThan(
      secondReplacementRevision,
    );
  });

  it("rejects an atomic publication when a captured segment revision changed", () => {
    const state = new SpatialSkeletonState();
    state.replaceCachedSegmentSnapshots(
      [
        [
          11n,
          [
            {
              nodeId: 5n,
              segmentId: 11n,
              position: new Float32Array([1, 2, 3]),
            },
          ],
        ] as const,
      ],
      { notify: false },
    );
    const expectedRevisions = getCachedSegmentRevisions(state, [11n]);
    expect(
      state.replaceCachedSegmentSnapshots([
        [
          11n,
          [
            {
              nodeId: 5n,
              segmentId: 11n,
              position: new Float32Array([4, 5, 6]),
            },
          ],
        ],
      ]),
    ).toBe(true);
    const previewRevision = state.getCachedSegmentRevision(11n);

    expect(
      state.replaceCachedSegmentSnapshots(
        [
          [
            11n,
            [
              {
                nodeId: 5n,
                segmentId: 11n,
                position: new Float32Array([7, 8, 9]),
              },
            ],
          ] as const,
        ],
        { expectedRevisions },
      ),
    ).toBe(false);
    expect(state.getCachedNode(5n)?.position).toEqual(
      new Float32Array([4, 5, 6]),
    );
    expect(state.getCachedSegmentRevision(11n)).toBe(previewRevision);
  });

  it("does not publish a retained read over a newer atomic replacement", async () => {
    const state = new SpatialSkeletonState();
    let receivedSignal: AbortSignal | undefined;
    let resolveFetch: ((nodes: SkeletonNode[]) => void) | undefined;
    const getSkeleton = vi.fn(
      (_segmentId: bigint, options?: { signal?: AbortSignal }) =>
        new Promise<SkeletonNode[]>((resolve, reject) => {
          receivedSignal = options?.signal;
          resolveFetch = resolve;
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        }),
    );
    const skeletonLayer = {
      source: {
        readonly: false,
        listSkeletons: async () => [],
        getSkeleton,
        fetchNodes: async () => [],
        getSpatialIndexMetadata: async () => null,
      },
    } as any;
    const pending = state.getFullSegmentNodes(skeletonLayer, 11n, {
      retainWhileInactive: true,
    });

    state.replaceCachedSegmentSnapshots(
      [
        [
          11n,
          [
            {
              nodeId: 5n,
              segmentId: 11n,
              position: new Float32Array([4, 5, 6]),
            },
          ],
        ] as const,
      ],
      { notify: false },
    );
    expect(receivedSignal?.aborted).toBe(false);
    expect(getSkeleton).toHaveBeenCalledTimes(1);

    resolveFetch?.([
      {
        nodeId: 5n,
        segmentId: 11n,
        position: new Float32Array([7, 8, 9]),
      },
    ]);
    await expect(pending).resolves.toEqual([
      {
        nodeId: 5n,
        segmentId: 11n,
        position: new Float32Array([7, 8, 9]),
        parentNodeId: undefined,
        description: undefined,
        isTrueEnd: false,
      },
    ]);
    expect(state.getCachedNode(5n)?.position).toEqual(
      new Float32Array([4, 5, 6]),
    );
  });

  it("aborts a command-owned full-segment read when its sole owner releases it", async () => {
    const state = new SpatialSkeletonState();
    const owner = {};
    let receivedSignal: AbortSignal | undefined;
    const getSkeleton = vi.fn(
      (_segmentId: bigint, options?: { signal?: AbortSignal }) =>
        new Promise<never>(() => {
          receivedSignal = options?.signal;
          // Deliberately ignore AbortSignal. The manager's owner-release race
          // must still settle without cooperation from the source.
        }),
    );
    const skeletonLayer = {
      source: {
        readonly: false,
        listSkeletons: async () => [],
        getSkeleton,
        fetchNodes: async () => [],
        getSpatialIndexMetadata: async () => null,
      },
    } as any;
    const outcome = state
      .getFullSegmentNodes(skeletonLayer, 11n, {
        requestOwner: owner,
        retainWhileInactive: true,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(receivedSignal?.aborted).toBe(false);
    expect(state.releaseFullSegmentNodeFetchOwner(owner)).toBe(true);
    expect(receivedSignal?.aborted).toBe(true);
    await expect(outcome).resolves.toMatchObject({ name: "AbortError" });
    expect(getSkeleton).toHaveBeenCalledTimes(1);
    expect(state.releaseFullSegmentNodeFetchOwner(owner)).toBe(false);
  });

  it("keeps a shared full-segment read alive until its final owner releases it", async () => {
    const state = new SpatialSkeletonState();
    const firstOwner = {};
    const secondOwner = {};
    let receivedSignal: AbortSignal | undefined;
    const getSkeleton = vi.fn(
      (_segmentId: bigint, options?: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          receivedSignal = options?.signal;
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        }),
    );
    const skeletonLayer = {
      source: {
        readonly: false,
        listSkeletons: async () => [],
        getSkeleton,
        fetchNodes: async () => [],
        getSpatialIndexMetadata: async () => null,
      },
    } as any;
    const firstOutcome = state
      .getFullSegmentNodes(skeletonLayer, 11n, {
        requestOwner: firstOwner,
      })
      .catch((error) => error);
    const secondOutcome = state
      .getFullSegmentNodes(skeletonLayer, 11n, {
        requestOwner: secondOwner,
      })
      .catch((error) => error);

    expect(getSkeleton).toHaveBeenCalledTimes(1);
    expect(state.releaseFullSegmentNodeFetchOwner(firstOwner)).toBe(true);
    expect(receivedSignal?.aborted).toBe(false);
    expect(state.releaseFullSegmentNodeFetchOwner(secondOwner)).toBe(true);
    expect(receivedSignal?.aborted).toBe(true);
    await expect(firstOutcome).resolves.toMatchObject({ name: "AbortError" });
    await expect(secondOutcome).resolves.toMatchObject({ name: "AbortError" });
  });

  it("does not abort a shared visual read when its command owner releases it", async () => {
    const state = new SpatialSkeletonState();
    const owner = {};
    let receivedSignal: AbortSignal | undefined;
    let resolveFetch: ((nodes: SkeletonNode[]) => void) | undefined;
    const getSkeleton = vi.fn(
      (_segmentId: bigint, options?: { signal?: AbortSignal }) =>
        new Promise<SkeletonNode[]>((resolve, reject) => {
          receivedSignal = options?.signal;
          resolveFetch = resolve;
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        }),
    );
    const skeletonLayer = {
      source: {
        readonly: false,
        listSkeletons: async () => [],
        getSkeleton,
        fetchNodes: async () => [],
        getSpatialIndexMetadata: async () => null,
      },
    } as any;
    const commandFetch = state.getFullSegmentNodes(skeletonLayer, 11n, {
      requestOwner: owner,
      retainWhileInactive: true,
    });
    const visualFetch = state.getFullSegmentNodes(skeletonLayer, 11n);

    expect(getSkeleton).toHaveBeenCalledTimes(1);
    expect(state.releaseFullSegmentNodeFetchOwner(owner)).toBe(true);
    expect(receivedSignal?.aborted).toBe(false);
    resolveFetch?.([
      {
        nodeId: 5n,
        segmentId: 11n,
        position: new Float32Array([1, 2, 3]),
      },
    ]);

    await expect(commandFetch).resolves.toHaveLength(1);
    await expect(visualFetch).resolves.toHaveLength(1);
    expect(state.getCachedSegmentNodes(11n)).toHaveLength(1);
  });

  it("times out an underlying full-segment source request", async () => {
    vi.useFakeTimers();
    try {
      const state = new SpatialSkeletonState();
      let receivedSignal: AbortSignal | undefined;
      const getSkeleton = vi.fn(
        (_segmentId: bigint, options?: { signal?: AbortSignal }) =>
          new Promise<never>(() => {
            receivedSignal = options?.signal;
            // Deliberately ignore AbortSignal. The deadline itself must reject
            // the public request and release the limiter slot.
          }),
      );
      const pending = state
        .getFullSegmentNodes(
          {
            source: {
              readonly: false,
              listSkeletons: async () => [],
              getSkeleton,
              fetchNodes: async () => [],
              getSpatialIndexMetadata: async () => null,
            },
          } as any,
          11n,
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(receivedSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(receivedSignal?.aborted).toBe(true);
      await expect(pending).resolves.toMatchObject({ name: "TimeoutError" });
      expect(getSkeleton).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("performs one full-segment request per call and permits a later request after failure", async () => {
    const state = new SpatialSkeletonState();
    const getSkeleton = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary read failure"))
      .mockResolvedValueOnce([]);
    const skeletonLayer = {
      source: {
        readonly: false,
        listSkeletons: async () => [],
        getSkeleton,
        fetchNodes: async () => [],
        getSpatialIndexMetadata: async () => null,
      },
    } as any;

    await expect(
      state.getFullSegmentNodes(skeletonLayer, 11n, {
        retainWhileInactive: true,
      }),
    ).rejects.toThrow("temporary read failure");
    expect(getSkeleton).toHaveBeenCalledTimes(1);

    await expect(
      state.getFullSegmentNodes(skeletonLayer, 11n, {
        retainWhileInactive: true,
      }),
    ).resolves.toEqual([]);
    expect(getSkeleton).toHaveBeenCalledTimes(2);
  });

  it("permits a new full-segment request after a timeout", async () => {
    vi.useFakeTimers();
    try {
      const state = new SpatialSkeletonState();
      const getSkeleton = vi.fn(
        (_segmentId: bigint, _options?: { signal?: AbortSignal }) => {
          if (getSkeleton.mock.calls.length === 2) return Promise.resolve([]);
          return new Promise<never>(() => {});
        },
      );
      const pending = state.getFullSegmentNodes(
        {
          source: {
            readonly: false,
            listSkeletons: async () => [],
            getSkeleton,
            fetchNodes: async () => [],
            getSpatialIndexMetadata: async () => null,
          },
        } as any,
        11n,
        { retainWhileInactive: true },
      );
      const timedOut = pending.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(120_000);
      await expect(timedOut).resolves.toMatchObject({ name: "TimeoutError" });
      await expect(
        state.getFullSegmentNodes(
          {
            source: {
              readonly: false,
              listSkeletons: async () => [],
              getSkeleton,
              fetchNodes: async () => [],
              getSpatialIndexMetadata: async () => null,
            },
          } as any,
          11n,
          { retainWhileInactive: true },
        ),
      ).resolves.toEqual([]);
      expect(getSkeleton).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts command-owned hydration after a source reset", async () => {
    const state = new SpatialSkeletonState();
    const getSkeleton = vi.fn(
      (_segmentId: bigint, _options?: { signal?: AbortSignal }) =>
        new Promise<never>(() => {}),
    );
    const pending = state.getFullSegmentNodes(
      {
        source: {
          readonly: false,
          listSkeletons: async () => [],
          getSkeleton,
          fetchNodes: async () => [],
          getSpatialIndexMetadata: async () => null,
        },
      } as any,
      11n,
      { retainWhileInactive: true },
    );

    expect(state.clearInspectedSkeletonCache()).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(getSkeleton).toHaveBeenCalledTimes(1);
  });

  it("aborts pending full segment fetches when the cache is cleared", async () => {
    const state = new SpatialSkeletonState();
    let receivedSignal: AbortSignal | undefined;
    const getSkeleton = vi.fn(
      (_segmentId: bigint, options?: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          receivedSignal = options?.signal;
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        }),
    );

    const pending = state.getFullSegmentNodes(
      {
        source: {
          readonly: false,
          listSkeletons: async () => [],
          getSkeleton,
          fetchNodes: async () => [],
          getSpatialIndexMetadata: async () => null,
        },
      } as any,
      11n,
    );

    expect(receivedSignal?.aborted).toBe(false);
    expect(state.clearInspectedSkeletonCache()).toBe(true);
    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(state.getCachedSegmentNodes(11n)).toBeUndefined();
    expect(state.getCachedNode(11n)).toBeUndefined();
  });

  it("aborts pending full segment fetches when a segment is evicted", async () => {
    const state = new SpatialSkeletonState();
    let receivedSignal: AbortSignal | undefined;
    const getSkeleton = vi.fn(
      (_segmentId: bigint, options?: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          receivedSignal = options?.signal;
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        }),
    );

    const pending = state.getFullSegmentNodes(
      {
        source: {
          readonly: false,
          listSkeletons: async () => [],
          getSkeleton,
          fetchNodes: async () => [],
          getSpatialIndexMetadata: async () => null,
        },
      } as any,
      11n,
    );

    expect(receivedSignal?.aborted).toBe(false);
    expect(state.evictInactiveSegmentNodes([])).toBe(false);
    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(state.getCachedSegmentNodes(11n)).toBeUndefined();
    expect(state.getCachedNode(11n)).toBeUndefined();
  });

  it("retains exact optimistic projection segments during visual eviction", () => {
    const state = new SpatialSkeletonState();
    state.replaceCachedSegmentSnapshots([
      [
        11n,
        [
          {
            nodeId: 5n,
            segmentId: 11n,
            position: new Float32Array([1, 2, 3]),
          },
        ],
      ],
      [
        17n,
        [
          {
            nodeId: 7n,
            segmentId: 17n,
            position: new Float32Array([4, 5, 6]),
          },
        ],
      ],
    ]);
    (state as any).optimisticEditQueue = {
      canUndo: () => false,
      canRedo: () => false,
      hasUnconfirmedActions: () => true,
      getProtectedProjectionSegmentIds: () => [11n],
      undoLatest: () => resolvedOptimisticExecution(false),
      redoLatest: () => resolvedOptimisticExecution(false),
    };

    expect(state.evictInactiveSegmentNodes([])).toBe(true);
    expect(state.getCachedSegmentNodes(11n)).toHaveLength(1);
    expect(state.getCachedSegmentNodes(17n)).toBeUndefined();
  });

  it("retains a pending visual fetch when a command joins it", async () => {
    const state = new SpatialSkeletonState();
    let receivedSignal: AbortSignal | undefined;
    let resolveFetch: ((nodes: SkeletonNode[]) => void) | undefined;
    const getSkeleton = vi.fn(
      (_segmentId: bigint, options?: { signal?: AbortSignal }) =>
        new Promise<SkeletonNode[]>((resolve, reject) => {
          receivedSignal = options?.signal;
          resolveFetch = resolve;
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        }),
    );
    const skeletonLayer = {
      source: {
        readonly: false,
        listSkeletons: async () => [],
        getSkeleton,
        fetchNodes: async () => [],
        getSpatialIndexMetadata: async () => null,
      },
    } as any;

    const visualFetch = state.getFullSegmentNodes(skeletonLayer, 11n);
    const commandFetch = state.getFullSegmentNodes(skeletonLayer, 11n, {
      retainWhileInactive: true,
    });

    expect(getSkeleton).toHaveBeenCalledTimes(1);
    expect(state.evictInactiveSegmentNodes([])).toBe(false);
    expect(receivedSignal?.aborted).toBe(false);

    const fetchedNodes: SkeletonNode[] = [
      {
        nodeId: 5n,
        segmentId: 11n,
        position: new Float32Array([1, 2, 3]),
        isTrueEnd: false,
      },
    ];
    resolveFetch?.(fetchedNodes);

    await expect(visualFetch).resolves.toEqual(fetchedNodes);
    await expect(commandFetch).resolves.toEqual(fetchedNodes);
    expect(
      state.getCachedSegmentNodes(11n)?.map((node) => node.nodeId),
    ).toEqual([5n]);
  });

  it("aborts a pending fetch before atomically replacing its segment", async () => {
    const state = new SpatialSkeletonState();
    let receivedSignal: AbortSignal | undefined;
    const getSkeleton = vi.fn(
      (_segmentId: bigint, options?: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          receivedSignal = options?.signal;
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        }),
    );
    const pending = state.getFullSegmentNodes(
      {
        source: {
          readonly: false,
          listSkeletons: async () => [],
          getSkeleton,
          fetchNodes: async () => [],
          getSpatialIndexMetadata: async () => null,
        },
      } as any,
      11n,
    );
    let notifications = 0;
    state.nodeDataVersion.changed.add(() => {
      notifications += 1;
    });

    expect(receivedSignal?.aborted).toBe(false);
    expect(
      state.replaceCachedSegmentSnapshots([
        [
          11n,
          [
            {
              nodeId: 5n,
              segmentId: 11n,
              position: new Float32Array([1, 2, 3]),
            },
          ],
        ] as const,
      ]),
    ).toBe(true);

    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(
      state.getCachedSegmentNodes(11n)?.map((node) => node.nodeId),
    ).toEqual([5n]);
    expect(state.getCachedNode(5n)).toBe(state.getCachedSegmentNodes(11n)?.[0]);
    expect(notifications).toBe(1);
  });

  it("notifies node data listeners after caching a fetched full segment", async () => {
    const state = new SpatialSkeletonState();
    const getSkeleton = vi.fn(async () => [
      {
        nodeId: 5n,
        parentNodeId: undefined,
        position: new Float32Array([1, 2, 3]),
        segmentId: 11n,
        isTrueEnd: false,
      },
    ]);
    const skeletonLayer = {
      source: {
        readonly: false,
        listSkeletons: async () => [],
        getSkeleton,
        fetchNodes: async () => [],
        getSpatialIndexMetadata: async () => null,
      },
    } as any;
    let notifications = 0;
    state.nodeDataVersion.changed.add(() => {
      notifications += 1;
    });

    await expect(
      state.getFullSegmentNodes(skeletonLayer, 11n),
    ).resolves.toEqual([
      {
        nodeId: 5n,
        segmentId: 11n,
        position: new Float32Array([1, 2, 3]),
        parentNodeId: undefined,
        description: undefined,
        isTrueEnd: false,
      },
    ]);

    expect(notifications).toBe(1);
    expect(state.getCachedNode(5n)).toEqual({
      nodeId: 5n,
      segmentId: 11n,
      position: new Float32Array([1, 2, 3]),
      parentNodeId: undefined,
      description: undefined,
      isTrueEnd: false,
    });
  });

  it("caches inspected nodes from full skeleton inspection", async () => {
    const state = new SpatialSkeletonState();
    const getSkeleton = vi.fn(async () => [
      {
        nodeId: 5n,
        parentNodeId: undefined,
        position: new Float32Array([1, 2, 3]),
        segmentId: 11n,
        isTrueEnd: false,
      },
    ]);

    await expect(
      state.getFullSegmentNodes(
        {
          source: {
            readonly: false,
            listSkeletons: async () => [],
            getSkeleton,
            fetchNodes: async () => [],
            getSpatialIndexMetadata: async () => null,
          },
        } as any,
        11n,
      ),
    ).resolves.toEqual([
      {
        nodeId: 5n,
        segmentId: 11n,
        position: new Float32Array([1, 2, 3]),
        parentNodeId: undefined,
        description: undefined,
        isTrueEnd: false,
      },
    ]);

    expect(getSkeleton).toHaveBeenCalledTimes(1);
    expect(state.getCachedNode(5n)).toEqual({
      nodeId: 5n,
      segmentId: 11n,
      position: new Float32Array([1, 2, 3]),
      parentNodeId: undefined,
      description: undefined,
      isTrueEnd: false,
    });
  });

  it("stores merge anchor state only when the node id is valid", () => {
    const state = new SpatialSkeletonState();

    expect(state.setMergeAnchor(5n)).toBe(true);
    expect(state.mergeAnchorNodeId.value).toBe(5n);

    expect(state.setMergeAnchor(0n)).toBe(true);
    expect(state.mergeAnchorNodeId.value).toBeUndefined();
  });

  function makeLimiterTestLayer(itemLimit?: number) {
    const resolvers: Array<
      (
        value: Array<{
          nodeId: bigint;
          parentNodeId?: bigint;
          position: Float32Array;
          segmentId: bigint;
          isTrueEnd: boolean;
        }>,
      ) => void
    > = [];
    const getSkeleton = vi.fn(
      (_segmentId: bigint, options?: { signal?: AbortSignal }) =>
        new Promise<
          Array<{
            nodeId: bigint;
            parentNodeId?: bigint;
            position: Float32Array;
            segmentId: bigint;
            isTrueEnd: boolean;
          }>
        >((resolve, reject) => {
          resolvers.push(resolve);
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        }),
    );
    const skeletonLayer = {
      source: {
        readonly: false,
        listSkeletons: async () => [],
        getSkeleton,
        fetchNodes: async () => [],
        getSpatialIndexMetadata: async () => null,
      },
      ...(itemLimit === undefined
        ? {}
        : {
            chunkManager: {
              chunkQueueManager: {
                capacities: { download: { itemLimit: { value: itemLimit } } },
              },
            },
          }),
    } as any;
    return { skeletonLayer, getSkeleton, resolvers };
  }

  it("caps concurrent full segment fetches at the download item limit", async () => {
    const state = new SpatialSkeletonState();
    const { skeletonLayer, getSkeleton, resolvers } = makeLimiterTestLayer(2);

    const pending = [11n, 12n, 13n, 14n].map((segmentId) =>
      state.getFullSegmentNodes(skeletonLayer, segmentId),
    );

    expect(getSkeleton).toHaveBeenCalledTimes(2);
    resolvers[0]([]);
    await pending[0];
    expect(getSkeleton).toHaveBeenCalledTimes(3);
    resolvers[1]([]);
    resolvers[2]([]);
    await Promise.all([pending[1], pending[2]]);
    expect(getSkeleton).toHaveBeenCalledTimes(4);
    resolvers[3]([]);
    await pending[3];
  });

  it("starts a skeleton read an edit awaits before queued display reads", async () => {
    const state = new SpatialSkeletonState();
    const { skeletonLayer, getSkeleton, resolvers } = makeLimiterTestLayer(1);

    const first = state.getFullSegmentNodes(skeletonLayer, 11n);
    void state.getFullSegmentNodes(skeletonLayer, 12n).catch(() => undefined);
    void state.getFullSegmentNodes(skeletonLayer, 13n).catch(() => undefined);
    void state
      .getFullSegmentNodes(skeletonLayer, 13n, {
        retainWhileInactive: true,
        requestOwner: {},
      })
      .catch(() => undefined);

    expect(getSkeleton).toHaveBeenCalledTimes(1);
    resolvers[0]([]);
    await first;
    expect(getSkeleton).toHaveBeenCalledTimes(2);
    expect(getSkeleton.mock.calls[1][0]).toBe(13n);
  });

  it("starts queued display reads in order again once an edit stops awaiting one", async () => {
    const state = new SpatialSkeletonState();
    const { skeletonLayer, getSkeleton, resolvers } = makeLimiterTestLayer(1);
    const requestOwner = {};

    const first = state.getFullSegmentNodes(skeletonLayer, 11n);
    void state.getFullSegmentNodes(skeletonLayer, 12n).catch(() => undefined);
    void state.getFullSegmentNodes(skeletonLayer, 13n).catch(() => undefined);
    void state
      .getFullSegmentNodes(skeletonLayer, 13n, {
        retainWhileInactive: true,
        requestOwner,
      })
      .catch(() => undefined);
    state.releaseFullSegmentNodeFetchOwner(requestOwner);

    resolvers[0]([]);
    await first;
    expect(getSkeleton).toHaveBeenCalledTimes(2);
    expect(getSkeleton.mock.calls[1][0]).toBe(12n);
  });

  it("releases a limiter slot when a non-cooperative source times out", async () => {
    vi.useFakeTimers();
    try {
      const state = new SpatialSkeletonState();
      const getSkeleton = vi.fn((segmentId: bigint) =>
        segmentId === 11n ? new Promise<never>(() => {}) : Promise.resolve([]),
      );
      const skeletonLayer = {
        source: {
          readonly: false,
          listSkeletons: async () => [],
          getSkeleton,
          fetchNodes: async () => [],
          getSpatialIndexMetadata: async () => null,
        },
        chunkManager: {
          chunkQueueManager: {
            capacities: { download: { itemLimit: { value: 1 } } },
          },
        },
      } as any;
      const firstOutcome = state
        .getFullSegmentNodes(skeletonLayer, 11n)
        .catch((error) => error);
      const second = state.getFullSegmentNodes(skeletonLayer, 12n);

      expect(getSkeleton).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(120_000);
      await expect(firstOutcome).resolves.toMatchObject({
        name: "TimeoutError",
      });
      await expect(second).resolves.toEqual([]);
      expect(getSkeleton).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps concurrent full segment fetches when no chunk manager is available", () => {
    const state = new SpatialSkeletonState();
    const { skeletonLayer, getSkeleton } = makeLimiterTestLayer();

    for (let segmentId = 1; segmentId <= 10; ++segmentId) {
      void state
        .getFullSegmentNodes(skeletonLayer, BigInt(segmentId))
        .catch(() => undefined);
    }

    expect(getSkeleton).toHaveBeenCalledTimes(8);
  });

  it("never starts a queued full segment fetch that is evicted first", async () => {
    const state = new SpatialSkeletonState();
    const { skeletonLayer, getSkeleton, resolvers } = makeLimiterTestLayer(1);

    const first = state.getFullSegmentNodes(skeletonLayer, 11n);
    const queued = state.getFullSegmentNodes(skeletonLayer, 12n);
    expect(getSkeleton).toHaveBeenCalledTimes(1);

    expect(state.evictInactiveSegmentNodes([11n])).toBe(false);
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });

    resolvers[0]([]);
    await first;
    expect(getSkeleton).toHaveBeenCalledTimes(1);
  });
});
