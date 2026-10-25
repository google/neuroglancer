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

import {
  SkeletonEdgeDirection,
  type EditableSkeletonSource,
  type SkeletonEdge,
  type SkeletonFragment,
  type SkeletonFragmentNode,
  type SkeletonNode,
} from "#src/skeleton/api.js";
import type { SpatialSkeletonLayerContext } from "#src/skeleton/edit/spatial_skeleton_edit_session.js";
import {
  editableSpatiallyIndexedSkeletonSourceSupportsAction,
  ensureSpatialSkeletonEditQueue,
  SpatialSkeletonEditSession,
} from "#src/skeleton/edit/spatial_skeleton_edit_session.js";
import { SpatialSkeletonActions } from "#src/skeleton/edit_commands.js";
import type {
  SpatialSkeletonEditPlannerRegistration,
  SpatialSkeletonEditPlannerProvider,
} from "#src/skeleton/edit_queue/api.js";
import { SpatialSkeletonDatasourceContractError } from "#src/skeleton/edit_queue/api.js";
import type { CompleteSkeleton } from "#src/skeleton/edit_queue/complete_skeleton.js";
import {
  createCompleteSkeleton,
  patchCompleteSkeleton,
} from "#src/skeleton/edit_queue/complete_skeleton.js";
import { SpatialSkeletonInspectionRequiredError } from "#src/skeleton/edit_queue/edit_errors.js";
import type { SpatialSkeletonPreparedPreviewCachePublication } from "#src/skeleton/edit_queue/preview.js";
import type { SpatialSkeletonEditExecution } from "#src/skeleton/edit_queue/types.js";
import {
  SpatialSkeletonReloadRequiredError,
  unchangedSpatialSkeletonEditSettlement,
} from "#src/skeleton/edit_queue/types.js";

function makeWholeSkeletonReads(
  getSkeleton: (
    skeletonId: bigint,
    options: { signal: AbortSignal },
  ) => unknown,
) {
  return {
    edgeDirection: SkeletonEdgeDirection.CHILD_TO_PARENT,
    getSkeletonManifest: async () => ({ fragmentKeys: ["skeleton"] }),
    getSkeletonFragment: async (
      skeletonId: bigint,
      _fragmentKey: string,
      signal: AbortSignal,
    ) => {
      const skeletonNodes = (await getSkeleton(skeletonId, {
        signal,
      })) as SkeletonNode[];
      return {
        nodes: skeletonNodes.map(({ parentNodeId: _, ...node }) => node),
        edges: skeletonNodes.flatMap(({ nodeId, parentNodeId }) =>
          parentNodeId === undefined
            ? []
            : [{ firstNodeId: nodeId, secondNodeId: parentNodeId }],
        ),
      };
    },
  };
}

function resolvedExecution(value: boolean): SpatialSkeletonEditExecution {
  const execution = Promise.resolve(value);
  Object.defineProperty(execution, "acceptedByQueue", {
    configurable: true,
    value: Promise.resolve(),
  });
  Object.defineProperty(execution, "settled", {
    configurable: true,
    value: Promise.resolve(unchangedSpatialSkeletonEditSettlement("no-op")),
  });
  return execution as SpatialSkeletonEditExecution;
}

function makeCommandFactory(action: string) {
  return {
    action,
    createCommand: vi.fn(),
  };
}

function makeEditableSourceCommands() {
  return {
    editPlannerProvider: {
      createPlanner: vi.fn(),
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

function getCachedSegmentRevisions(
  state: SpatialSkeletonEditSession,
  segmentIds: Iterable<bigint>,
) {
  return new Map(
    [...segmentIds].map((segmentId) => [
      segmentId,
      state.getCachedSegmentRevision(segmentId),
    ]),
  );
}

function prepareEditPreview(
  state: SpatialSkeletonEditSession,
  snapshots: readonly (readonly [bigint, CompleteSkeleton | undefined])[],
  options: {
    readonly expectedRevisions?: ReadonlyMap<bigint, number>;
    readonly notify?: boolean;
    readonly retiredSegmentIds?: ReadonlySet<bigint>;
  } = {},
) {
  const display = state.spatialSkeletonDisplay.value;
  return state.prepareSpatialSkeletonPreviewCachePublication({
    snapshots,
    retiredSegmentIds: options.retiredSegmentIds,
    expectedRevisions:
      options.expectedRevisions ??
      getCachedSegmentRevisions(
        state,
        snapshots.map(([segmentId]) => segmentId),
      ),
    activeStableOwners: display.activeStableOwners,
    numericAliases: display.numericAliases,
    provisionalNodeIds: display.provisionalNodeIds,
    pendingEditIntentIdsToRemove: [],
    notify: options.notify ?? true,
  });
}

function applyEditPreview(
  state: SpatialSkeletonEditSession,
  prepared: SpatialSkeletonPreparedPreviewCachePublication | undefined,
) {
  if (prepared === undefined) return false;
  let adopted = false;
  state.runSpatialSkeletonDisplayTransaction(() => {
    adopted =
      state.adoptPreparedSpatialSkeletonPreviewCachePublication(prepared);
  });
  if (!adopted) return false;
  state.finalizePreparedSpatialSkeletonPreviewCachePublication(prepared);
  return true;
}

function adoptPreparedPreviewSnapshots(
  state: SpatialSkeletonEditSession,
  snapshots: readonly (readonly [bigint, CompleteSkeleton | undefined])[],
  options: Parameters<typeof prepareEditPreview>[2] = {},
) {
  return applyEditPreview(state, prepareEditPreview(state, snapshots, options));
}

async function flushMicrotasks() {
  for (let index = 0; index < 10; ++index) await Promise.resolve();
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

function makeFragmentNode(nodeId: bigint): SkeletonFragmentNode {
  return { nodeId, segmentId: 7n, position: new Float32Array([0, 0, 0]) };
}

function makeEdge(firstNodeId: bigint, secondNodeId: bigint): SkeletonEdge {
  return { firstNodeId, secondNodeId };
}

function makeFragmentedSkeletonLayer(
  fragments: Record<string, SkeletonFragment | Error>,
  options: {
    edgeDirection?: SkeletonEdgeDirection;
    manifestReady?: Promise<void>;
  } = {},
) {
  const {
    edgeDirection = SkeletonEdgeDirection.CHILD_TO_PARENT,
    manifestReady = Promise.resolve(),
  } = options;
  const requestedFragmentKeys: string[] = [];
  const layer = {
    fragmentSource: {
      edgeDirection,
      async getSkeletonManifest() {
        await manifestReady;
        return { fragmentKeys: Object.keys(fragments) };
      },
      async getSkeletonFragment(_skeletonId: bigint, fragmentKey: string) {
        requestedFragmentKeys.push(fragmentKey);
        const fragment = fragments[fragmentKey];
        if (fragment instanceof Error) throw fragment;
        return fragment;
      },
    },
  } as any;
  return { layer, requestedFragmentKeys };
}
function makeLimiterTestLayer(itemLimit?: number) {
  const resolvers: Array<
    (
      value: Array<{
        nodeId: bigint;
        parentNodeId?: bigint;
        position: Float32Array;
        segmentId: bigint;
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
    fragmentSource: {
      ...makeWholeSkeletonReads(getSkeleton),
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
function publishSplitOutputAlias(
  state: SpatialSkeletonEditSession,
  options: { authoritative: boolean; activeOwner: boolean },
) {
  const stableHandle = { kind: "segment" as const, stableId: "split-output" };
  const prepared = state.prepareSpatialSkeletonPreviewCachePublication({
    snapshots: [],
    expectedRevisions: new Map(),
    activeStableOwners: options.activeOwner
      ? [{ segmentId: 17n, stableHandle }]
      : [],
    numericAliases: [
      { segmentId: 17n, stableHandle, authoritative: options.authoritative },
    ],
    provisionalNodeIds: [],
    pendingEditIntentIdsToRemove: [],
    notify: true,
  })!;
  state.runSpatialSkeletonDisplayTransaction(() => {
    state.adoptPreparedSpatialSkeletonPreviewCachePublication(prepared);
  });
  state.finalizePreparedSpatialSkeletonPreviewCachePublication(prepared);
}

function makeSource(editPlannerProvider?: unknown): EditableSkeletonSource {
  return {
    readonly: false,
    editPlannerProvider,
  } as unknown as EditableSkeletonSource;
}

function makeRegistration(
  cleanup = vi.fn(),
): SpatialSkeletonEditPlannerRegistration {
  return {
    planner: {
      describeIntent: () => ({ kind: "test", commandLabel: "Test" }),
      planIntent: (_command, context) => ({
        kind: "test",
        commandLabel: "Test",
        stableResources: [],
        plan: { intentId: context.intentId },
        preview: undefined as never,
      }),
      nextAttempt: () => undefined,
      createReconciliation: () => ({}),
    },
    editRequestAdapter: {
      editRequestScope: {},
      commit: async () => ({}),
      classifyFailure: () => "indeterminate",
    },
    cleanup,
  };
}

function makeEditQueueLayer(editPlannerProvider?: unknown) {
  const state = new SpatialSkeletonEditSession();
  const source = makeSource(editPlannerProvider);
  const layer = {
    spatialSkeletonEditSession: state,
    getSpatiallyIndexedSkeletonLayer: () => undefined,
  } as SpatialSkeletonLayerContext;
  return { state, source, layer };
}

interface HeldEditRequest {
  readonly operation: "edit";
}

interface HeldCommit {
  readonly editRequest: HeldEditRequest;
  resolve(result: { readonly ok: true }): void;
  reject(error: unknown): void;
}

function makeHeldCommitProvider(cleanup = vi.fn()) {
  const commits: HeldCommit[] = [];
  const provider: SpatialSkeletonEditPlannerProvider = {
    createPlanner: ({ identities }) => {
      const segment = identities.getOrCreateSegmentHandle(11n);
      const node = identities.getOrCreateNodeHandle(21n);
      return {
        planner: {
          describeIntent: () => ({ kind: "test", commandLabel: "Test" }),
          planIntent: () => ({
            kind: "test",
            commandLabel: "Controlled edit",
            stableResources: [
              { handle: segment, access: "write" },
              { handle: node, access: "write" },
            ],
            plan: Object.freeze({}),
            preview: {
              delta: {
                kind: "add",
                segment,
                node,
                position: [1, 2, 3],
              },
            },
          }),
          nextAttempt: (_plan, context) => {
            if (context.committedAttempts.length !== 0) return undefined;
            const editRequest = { operation: "edit" } as const;
            return {
              materializeEditRequest: () => editRequest,
            };
          },
          createReconciliation: () => ({}),
        },
        editRequestAdapter: {
          editRequestScope: {},
          commit: (editRequest) =>
            new Promise<{ readonly ok: true }>((resolve, reject) => {
              commits.push({ editRequest, resolve, reject });
            }),
          classifyFailure: (error) =>
            (
              error as Error & {
                disposition?: "not-started" | "rejected" | "indeterminate";
              }
            ).disposition ?? "indeterminate",
        },
        cleanup,
      };
    },
  };
  return { provider, commits, cleanup };
}

function makeAddNodesCommand() {
  return Object.freeze({
    action: SpatialSkeletonActions.addNodes,
    label: "Controlled edit",
    payload: Object.freeze({}),
    getQueueInputRequirements: () => ({ required: [] }),
  });
}

function makeUnsavedMoveProvider(
  state: SpatialSkeletonEditSession,
  move: {
    segmentId: bigint;
    nodeId: bigint;
    position: [number, number, number];
  },
): SpatialSkeletonEditPlannerProvider {
  return {
    createPlanner: ({ identities }) => {
      const segment = identities.getOrCreateSegmentHandle(move.segmentId);
      const node = identities.getOrCreateNodeHandle(move.nodeId);
      return {
        planner: {
          describeIntent: () => ({ kind: "move", commandLabel: "Move" }),
          planIntent: () => {
            const inspected = state.getCachedSegmentSnapshotHandle(
              move.segmentId,
            )!;
            return {
              kind: "move",
              commandLabel: "Move",
              stableResources: [
                { handle: segment, access: "write" },
                { handle: node, access: "write" },
              ],
              plan: Object.freeze({}),
              preview: {
                delta: { kind: "move", segment, node, position: move.position },
                inspectionSeed: {
                  segments: [{ segment, snapshot: inspected.handle }],
                  authoritativeBindings: {
                    segments: [[segment, move.segmentId]],
                    nodes: [[node, move.nodeId]],
                  },
                  expectedCacheRevisions: new Map([
                    [move.segmentId, inspected.cacheRevision],
                  ]),
                },
              },
            };
          },
          nextAttempt: (_plan, context) =>
            context.committedAttempts.length !== 0
              ? undefined
              : { materializeEditRequest: () => ({}) },
          createReconciliation: () => ({}),
        },
        editRequestAdapter: {
          editRequestScope: {},
          commit: () => new Promise<never>(() => {}),
          classifyFailure: () => "indeterminate",
        },
        cleanup: vi.fn(),
      };
    },
  };
}

describe("skeleton edit session", () => {
  describe("edit queue for a source", () => {
    it("edits to one source share one edit queue, set up once", () => {
      const createPlanner = vi.fn<
        SpatialSkeletonEditPlannerProvider["createPlanner"]
      >(() => makeRegistration());
      const { state, layer, source } = makeEditQueueLayer({ createPlanner });

      const first = ensureSpatialSkeletonEditQueue(layer, source);
      const second = ensureSpatialSkeletonEditQueue(layer, source);

      expect(second).toBe(first);
      expect(createPlanner).toHaveBeenCalledOnce();
      expect(createPlanner.mock.calls[0]![0]).toMatchObject({ source });
      expect(createPlanner.mock.calls[0]![0]).not.toHaveProperty("layer");
      expect(createPlanner.mock.calls[0]![0].identities).toBeDefined();
      expect(createPlanner.mock.calls[0]![0].provisionalIds).toBeDefined();
      state.dispose();
    });

    it("a source whose edit setup fails leaves the current edit queue working", () => {
      const cleanup = vi.fn();
      const currentProvider = {
        createPlanner: () => makeRegistration(cleanup),
      };
      const { state, layer, source } = makeEditQueueLayer(currentProvider);
      const current = ensureSpatialSkeletonEditQueue(layer, source);
      const replacementError = new Error("provider setup failed");
      const replacement = makeSource({
        createPlanner: () => {
          throw replacementError;
        },
      });

      expect(() => ensureSpatialSkeletonEditQueue(layer, replacement)).toThrow(
        replacementError,
      );
      expect(ensureSpatialSkeletonEditQueue(layer, source)).toBe(current);
      expect(cleanup).not.toHaveBeenCalled();
      state.dispose();
    });

    it("closing the edit queue runs the source's cleanup once", async () => {
      const cleanup = vi.fn();
      const { state, layer, source } = makeEditQueueLayer({
        createPlanner: () => makeRegistration(cleanup),
      });
      ensureSpatialSkeletonEditQueue(layer, source);

      expect(state.releaseEditQueue()).toBe(true);
      expect(state.releaseEditQueue()).toBe(false);
      await flushMicrotasks();
      expect(cleanup).toHaveBeenCalledOnce();
      state.dispose();
    });

    it.each([
      [
        "saved",
        {
          answer: (commit: HeldCommit) => commit.resolve({ ok: true }),
          reloadRequiredReason: "committed-local-publication-failed",
        },
      ],
      [
        "lost",
        {
          answer: (commit: HeldCommit) =>
            commit.reject(new Error("connection lost")),
          reloadRequiredReason: "authority-indeterminate",
        },
      ],
      [
        "rejected",
        {
          answer: (commit: HeldCommit) =>
            commit.reject(
              Object.assign(new Error("not saved"), {
                disposition: "rejected" as const,
              }),
            ),
          reloadRequiredReason: undefined,
        },
      ],
    ])(
      "the old source's cleanup waits until the edit it was saving is known to be saved, rejected, or lost: %s",
      async (_outcome, { answer, reloadRequiredReason }) => {
        const { provider, commits, cleanup } = makeHeldCommitProvider();
        const { state, layer, source } = makeEditQueueLayer(provider);
        const queue = ensureSpatialSkeletonEditQueue(layer, source);
        await state.executeEdit(makeAddNodesCommand(), { segments: [] });
        await flushMicrotasks();
        expect(commits).toHaveLength(1);

        expect(state.releaseEditQueue()).toBe(true);
        await flushMicrotasks();
        expect(cleanup).not.toHaveBeenCalled();

        answer(commits[0]!);
        await queue.dispose();
        expect(cleanup).toHaveBeenCalledOnce();
        expect(state.getReloadRequired()?.reason).toBe(reloadRequiredReason);
        state.dispose();
      },
    );

    it("switching sources starts a new edit queue at once while the old source's cleanup waits for its unsaved edit", async () => {
      const { provider, commits, cleanup } = makeHeldCommitProvider();
      const { state, layer, source } = makeEditQueueLayer(provider);
      const oldQueue = ensureSpatialSkeletonEditQueue(layer, source);
      const execution = state.executeEdit(makeAddNodesCommand(), {
        segments: [],
      });
      await execution;
      await flushMicrotasks();
      expect(commits).toHaveLength(1);

      const replacementCleanup = vi.fn();
      const replacementSource = makeSource({
        createPlanner: () => makeRegistration(replacementCleanup),
      });
      const replacementQueue = ensureSpatialSkeletonEditQueue(
        layer,
        replacementSource,
      );
      expect(replacementQueue).not.toBe(oldQueue);
      expect(cleanup).not.toHaveBeenCalled();
      expect(ensureSpatialSkeletonEditQueue(layer, replacementSource)).toBe(
        replacementQueue,
      );

      commits[0]!.resolve({ ok: true });
      await oldQueue.dispose();

      expect(cleanup).toHaveBeenCalledOnce();
      expect(ensureSpatialSkeletonEditQueue(layer, replacementSource)).toBe(
        replacementQueue,
      );
      state.dispose();
      await flushMicrotasks();
      expect(replacementCleanup).toHaveBeenCalledOnce();
    });

    it.each([
      ["no planner", undefined],
      ["planner without createPlanner", { supportsAction: () => true }],
    ])(
      "a writable source without an edit planner cannot start editing: %s",
      (_description, editPlannerProvider) => {
        const { state, layer, source } =
          makeEditQueueLayer(editPlannerProvider);
        expect(() => ensureSpatialSkeletonEditQueue(layer, source)).toThrow(
          SpatialSkeletonDatasourceContractError,
        );
        state.dispose();
      },
    );

    it("a source that supplies its own queue state is rejected", () => {
      const registration = makeRegistration();
      const { state, layer, source } = makeEditQueueLayer({
        createPlanner: () => ({ ...registration, queue: {} }) as any,
      });
      expect(() => ensureSpatialSkeletonEditQueue(layer, source)).toThrow(
        /engine-owned field "queue"/,
      );
      state.dispose();
    });

    it.each<[string, PropertyDescriptor]>([
      ["missing", { value: undefined }],
      ["null", { value: null }],
      ["a number", { value: 17 }],
      [
        "a throwing getter",
        {
          get() {
            throw new Error("scope setup failed");
          },
        },
      ],
    ])(
      "a source whose edit request scope is %s is rejected as a datasource error",
      (_description, editRequestScope) => {
        const registration = makeRegistration();
        const editRequestAdapter = Object.defineProperty(
          {
            commit: registration.editRequestAdapter.commit,
            classifyFailure: registration.editRequestAdapter.classifyFailure,
          },
          "editRequestScope",
          { ...editRequestScope, enumerable: true },
        ) as SpatialSkeletonEditPlannerRegistration["editRequestAdapter"];
        const { state, layer, source } = makeEditQueueLayer({
          createPlanner: () => ({ ...registration, editRequestAdapter }),
        });
        expect(() => ensureSpatialSkeletonEditQueue(layer, source)).toThrow(
          SpatialSkeletonDatasourceContractError,
        );
        state.dispose();
      },
    );

    it("Undo and Redo with no edit queue do nothing and report a no-op", async () => {
      const state = new SpatialSkeletonEditSession();

      const undo = state.undoLatestEdit();
      const redo = state.redoLatestEdit();

      expect(state.canUndoEdit()).toBe(false);
      expect(state.canRedoEdit()).toBe(false);
      for (const execution of [undo, redo]) {
        await expect(execution).resolves.toBe(false);
        await expect(execution.acceptedByQueue).resolves.toBeUndefined();
        await expect(execution.settled).resolves.toEqual({
          outcome: "unchanged",
          reason: "no-op",
        });
      }
    });

    it("Undo and Redo are not sent to an edit queue that has nothing to undo or redo", async () => {
      const { state, layer, source } = makeEditQueueLayer({
        createPlanner: () => makeRegistration(),
      });
      const queue = ensureSpatialSkeletonEditQueue(layer, source);
      const undoLatest = vi.spyOn(queue, "undoLatest");
      const redoLatest = vi.spyOn(queue, "redoLatest");

      const undo = state.undoLatestEdit();
      const redo = state.redoLatestEdit();

      await expect(undo).resolves.toBe(false);
      await expect(redo).resolves.toBe(false);
      await expect(undo.settled).resolves.toEqual({
        outcome: "unchanged",
        reason: "no-op",
      });
      expect(undoLatest).not.toHaveBeenCalled();
      expect(redoLatest).not.toHaveBeenCalled();
      state.dispose();
    });

    it("the edit queue and Undo history hold 64 edits by default, or a configured number of at least one", () => {
      const defaultState = new SpatialSkeletonEditSession();
      expect(defaultState.editQueueCapacity).toBe(64);
      expect(defaultState.commandHistory.capacity).toBe(64);

      const smallState = new SpatialSkeletonEditSession({
        editQueueCapacity: 3,
      });
      expect(smallState.editQueueCapacity).toBe(3);
      expect(smallState.commandHistory.capacity).toBe(3);

      expect(
        () => new SpatialSkeletonEditSession({ editQueueCapacity: 0 }),
      ).toThrow(RangeError);
    });
  });

  describe("Reload required", () => {
    it("Reload required ends edit mode, refuses Undo and Redo, survives a source reset, and keeps its first cause", async () => {
      const state = new SpatialSkeletonEditSession();
      state.editMode.value = true;
      state.mergeMode.value = true;
      state.splitMode.value = true;
      state.setMergeAnchor(17n);
      state.suppressSelectedNodeHighlight.value = true;
      const versionBeforeReloadRequired = state.editQueueVersion.value;
      const cause = new Error("ambiguous transport");

      expect(
        state.latchReloadRequired({
          reason: "authority-indeterminate",
          authority: "indeterminate",
          intentId: 5,
          cause,
        }),
      ).toBe(true);

      const reloadRequired = state.getReloadRequired();
      expect(reloadRequired).toEqual({
        reason: "authority-indeterminate",
        authority: "indeterminate",
        intentId: 5,
        cause,
      });
      expect(Object.isFrozen(reloadRequired)).toBe(true);
      expect(state.editQueueVersion.value).toBe(
        versionBeforeReloadRequired + 1,
      );
      expect(state.editMode.value).toBe(false);
      expect(state.mergeMode.value).toBe(false);
      expect(state.splitMode.value).toBe(false);
      expect(state.mergeAnchorNodeId.value).toBeUndefined();
      expect(state.suppressSelectedNodeHighlight.value).toBe(false);
      expect(state.hasUnconfirmedEdits()).toBe(true);

      expect(
        state.latchReloadRequired({
          reason: "committed-local-publication-failed",
          authority: "committed",
          intentId: 9,
        }),
      ).toBe(false);
      expect(state.getReloadRequired()).toBe(reloadRequired);

      expect(state.canUndoEdit()).toBe(false);
      expect(state.canRedoEdit()).toBe(false);
      const undo = state.undoLatestEdit();
      await expect(undo).rejects.toBeInstanceOf(
        SpatialSkeletonReloadRequiredError,
      );
      await expect(undo.settled).resolves.toMatchObject({
        outcome: "unchanged",
        reason: "not-started",
      });

      state.clearRuntimeState();
      expect(state.getReloadRequired()).toBe(reloadRequired);
      expect(() => state.assertEditingAllowed()).toThrow(
        SpatialSkeletonReloadRequiredError,
      );
    });
  });

  describe("edit previews", () => {
    it.each([
      ["a node edit on a cached skeleton", "node edit"],
      ["deleting a cached skeleton for good", "delete cached"],
      ["deleting for good a skeleton that is not cached", "delete uncached"],
    ] as const)(
      "an edit preview changes nothing until it is applied, then shows in one redraw and cannot be applied twice: %s",
      (_description, edit) => {
        const state = new SpatialSkeletonEditSession();
        state.replaceCachedSegmentSnapshots([
          [11n, [{ nodeId: 1n, segmentId: 11n, position: [1, 2, 3] }]],
          [17n, [{ nodeId: 2n, segmentId: 17n, position: [4, 5, 6] }]],
        ]);
        if (edit === "delete uncached") {
          state.replaceCachedSegmentSnapshots([[11n, undefined]]);
        }
        const previous = state.getCachedSegmentSnapshotHandle(11n);
        const revision = state.getCachedSegmentRevision(11n);
        const untouched = state.getCachedSegmentSnapshotHandle(17n)!;
        const display = state.spatialSkeletonDisplay.value;
        const previewed =
          edit === "node edit"
            ? patchCompleteSkeleton(previous!.handle, [
                {
                  kind: "update",
                  nodeId: 1n,
                  changes: { position: [7, 8, 9] },
                },
              ])
            : undefined;
        const notifications = vi.fn();
        state.spatialSkeletonDisplay.changed.add(notifications);

        const prepared = prepareEditPreview(state, [[11n, previewed]], {
          retiredSegmentIds:
            previewed === undefined ? new Set([11n]) : undefined,
        })!;
        expect(state.getCachedSegmentSnapshotHandle(11n)).toBe(previous);
        expect(state.getCachedSegmentRevision(11n)).toBe(revision);
        expect(state.spatialSkeletonDisplay.value).toBe(display);
        expect(notifications).not.toHaveBeenCalled();
        expect(prepared.cacheRevisions.get(11n)).toBeGreaterThan(revision);
        if (previewed !== undefined) {
          expect(previewed.materializationCount).toBe(1);
        }

        state.runSpatialSkeletonDisplayTransaction(() => {
          expect(
            state.adoptPreparedSpatialSkeletonPreviewCachePublication(prepared),
          ).toBe(true);
        });
        expect(state.getCachedSegmentRevision(11n)).toBe(
          prepared.cacheRevisions.get(11n),
        );
        if (previewed === undefined) {
          expect(state.getCachedNode(1n)).toBeUndefined();
        } else {
          expect(state.getCachedSegmentSnapshotHandle(11n)?.handle).toBe(
            previewed,
          );
          expect(state.getCachedSegmentNodes(11n)).toBe(
            previewed.materialize(),
          );
          expect(previewed.materializationCount).toBe(1);
          expect(state.getCachedNode(1n)?.position).toEqual([7, 8, 9]);
        }

        state.finalizePreparedSpatialSkeletonPreviewCachePublication(prepared);
        expect(notifications).toHaveBeenCalledTimes(1);
        if (previewed === undefined) {
          expect(state.getCachedSegmentSnapshotHandle(11n)).toBeUndefined();
          expect(state.spatialSkeletonDisplay.value.removedSegmentIds).toEqual([
            11n,
          ]);
        }
        expect(state.getCachedSegmentSnapshotHandle(17n)).toBe(untouched);
        expect(state.getCachedSegmentRevision(17n)).toBe(
          untouched.cacheRevision,
        );
        expect(() =>
          state.adoptPreparedSpatialSkeletonPreviewCachePublication(prepared),
        ).toThrow(/already adopted/);
        expect(() =>
          state.adoptPreparedSpatialSkeletonPreviewCachePublication(
            {} as SpatialSkeletonPreparedPreviewCachePublication,
          ),
        ).toThrow(/belongs to another edit session/);
      },
    );

    it.each<
      [
        string,
        {
          readonly editedSegmentId: bigint;
          readonly preview: "node edit" | "delete for good";
          readonly changed: "before prepare" | "after prepare";
          readonly change: (state: SpatialSkeletonEditSession) => void;
        },
      ]
    >([
      [
        "skeleton changed before the preview was prepared",
        {
          editedSegmentId: 11n,
          preview: "node edit",
          changed: "before prepare",
          change: (state) =>
            state.replaceCachedSegmentSnapshots([
              [11n, [{ nodeId: 1n, segmentId: 11n, position: [7, 8, 9] }]],
            ]),
        },
      ],
      [
        "skeleton changed after the preview was prepared",
        {
          editedSegmentId: 11n,
          preview: "node edit",
          changed: "after prepare",
          change: (state) =>
            state.replaceCachedSegmentSnapshots([
              [11n, [{ nodeId: 1n, segmentId: 11n, position: [7, 8, 9] }]],
            ]),
        },
      ],
      [
        "skeleton loaded after its deletion was prepared",
        {
          editedSegmentId: 29n,
          preview: "delete for good",
          changed: "after prepare",
          change: (state) =>
            state.replaceCachedSegmentSnapshots([
              [29n, [{ nodeId: 3n, segmentId: 29n, position: [7, 8, 9] }]],
            ]),
        },
      ],
      [
        "source reset after the preview was prepared",
        {
          editedSegmentId: 11n,
          preview: "node edit",
          changed: "after prepare",
          change: (state) => state.clearRuntimeState(),
        },
      ],
      [
        "a different skeleton changed between prepare and apply",
        {
          editedSegmentId: 11n,
          preview: "node edit",
          changed: "after prepare",
          change: (state) =>
            state.replaceCachedSegmentSnapshots([
              [17n, [{ nodeId: 2n, segmentId: 17n, position: [7, 8, 9] }]],
            ]),
        },
      ],
    ])(
      "an edit preview made from an outdated skeleton changes nothing: %s",
      (_description, { editedSegmentId, preview, changed, change }) => {
        const state = new SpatialSkeletonEditSession();
        state.replaceCachedSegmentSnapshots([
          [11n, [{ nodeId: 1n, segmentId: 11n, position: [1, 2, 3] }]],
          [17n, [{ nodeId: 2n, segmentId: 17n, position: [4, 5, 6] }]],
        ]);
        const expectedRevisions = getCachedSegmentRevisions(state, [
          editedSegmentId,
        ]);
        const previewed =
          preview === "node edit"
            ? patchCompleteSkeleton(
                state.getCachedSegmentSnapshotHandle(editedSegmentId)!.handle,
                [
                  {
                    kind: "update",
                    nodeId: 1n,
                    changes: { attributes: { confidence: [70] } },
                  },
                ],
              )
            : undefined;

        if (changed === "before prepare") change(state);
        const prepared = prepareEditPreview(
          state,
          [[editedSegmentId, previewed]],
          {
            expectedRevisions,
            retiredSegmentIds:
              previewed === undefined ? new Set([editedSegmentId]) : undefined,
          },
        );
        if (changed === "after prepare") change(state);
        const handle = state.getCachedSegmentSnapshotHandle(editedSegmentId);
        const nodes = state.getCachedSegmentNodes(editedSegmentId);
        const revision = state.getCachedSegmentRevision(editedSegmentId);
        const display = state.spatialSkeletonDisplay.value;

        expect(applyEditPreview(state, prepared)).toBe(false);
        expect(state.getCachedSegmentSnapshotHandle(editedSegmentId)).toBe(
          handle,
        );
        expect(state.getCachedSegmentNodes(editedSegmentId)).toBe(nodes);
        expect(state.getCachedSegmentRevision(editedSegmentId)).toBe(revision);
        expect(state.spatialSkeletonDisplay.value).toBe(display);
        if (changed === "before prepare") {
          expect(prepared).toBeUndefined();
          expect(previewed!.materializationCount).toBe(0);
        }
      },
    );

    it.each<[string, (state: SpatialSkeletonEditSession) => void, string]>([
      [
        "edit preview claims a node of another cached skeleton",
        (state) =>
          prepareEditPreview(state, [
            [
              11n,
              createCompleteSkeleton([
                { nodeId: 2n, segmentId: 11n, position: [9, 9, 9] },
              ]),
            ],
          ]),
        "node 2 is present in both segment 17 and segment 11",
      ],
      [
        "one replacement puts a node in two skeletons",
        (state) =>
          state.replaceCachedSegmentSnapshots([
            [11n, [{ nodeId: 3n, segmentId: 11n, position: [3, 3, 3] }]],
            [17n, [{ nodeId: 3n, segmentId: 17n, position: [4, 4, 4] }]],
          ]),
        "node 3 is present in both segment 11 and segment 17",
      ],
      [
        "replacement claims a node of a skeleton it does not touch",
        (state) =>
          state.replaceCachedSegmentSnapshots([
            [11n, [{ nodeId: 2n, segmentId: 11n, position: [9, 9, 9] }]],
          ]),
        "node 2 is present in both segment 17 and segment 11",
      ],
    ])(
      "a change that would put one node in two skeletons is refused and changes nothing: %s",
      (_description, change, message) => {
        const state = new SpatialSkeletonEditSession();
        state.replaceCachedSegmentSnapshots([
          [11n, [{ nodeId: 1n, segmentId: 11n, position: [1, 1, 1] }]],
          [17n, [{ nodeId: 2n, segmentId: 17n, position: [2, 2, 2] }]],
        ]);
        const handle11 = state.getCachedSegmentSnapshotHandle(11n);
        const handle17 = state.getCachedSegmentSnapshotHandle(17n);
        const node1 = state.getCachedNode(1n);
        const node2 = state.getCachedNode(2n);
        const revisions = getCachedSegmentRevisions(state, [11n, 17n]);
        const nodeDataVersion = state.nodeDataVersion.value;
        const display = state.spatialSkeletonDisplay.value;

        expect(() => change(state)).toThrow(message);
        expect(state.getCachedSegmentSnapshotHandle(11n)).toBe(handle11);
        expect(state.getCachedSegmentSnapshotHandle(17n)).toBe(handle17);
        expect(state.getCachedNode(1n)).toBe(node1);
        expect(state.getCachedNode(2n)).toBe(node2);
        expect(state.getCachedNode(3n)).toBeUndefined();
        expect(getCachedSegmentRevisions(state, [11n, 17n])).toEqual(revisions);
        expect(state.nodeDataVersion.value).toBe(nodeDataVersion);
        expect(state.spatialSkeletonDisplay.value).toBe(display);
      },
    );

    it("a skeleton an edit deletes stays hidden through eviction until it is restored, reloaded, or the source resets", () => {
      const state = new SpatialSkeletonEditSession();
      const snapshot = createCompleteSkeleton([
        { nodeId: 1n, segmentId: 17n, position: [1, 2, 3] },
      ]);
      adoptPreparedPreviewSnapshots(state, [[17n, snapshot]]);
      state.evictInactiveSegmentNodes([]);
      expect(state.spatialSkeletonDisplay.value.removedSegmentIds).toEqual([]);
      // Even an already-absent cache entry must record explicit removal.
      adoptPreparedPreviewSnapshots(state, [[17n, undefined]], {
        notify: false,
      });
      expect(state.spatialSkeletonDisplay.value.removedSegmentIds).toEqual([
        17n,
      ]);
      state.evictInactiveSegmentNodes([]);
      expect(state.spatialSkeletonDisplay.value.removedSegmentIds).toEqual([
        17n,
      ]);
      adoptPreparedPreviewSnapshots(state, [[17n, snapshot]]);
      expect(state.spatialSkeletonDisplay.value.removedSegmentIds).toEqual([]);
      adoptPreparedPreviewSnapshots(state, [[17n, undefined]]);
      state.replaceCachedSegmentSnapshots([[17n, snapshot.materialize()]]);
      expect(state.spatialSkeletonDisplay.value.removedSegmentIds).toEqual([]);
      adoptPreparedPreviewSnapshots(state, [[17n, undefined]]);
      state.clearRuntimeState();
      expect(state.spatialSkeletonDisplay.value.removedSegmentIds).toEqual([]);
    });

    it("deleting a skeleton for good cancels its download once the edit is applied, while other downloads continue", async () => {
      const state = new SpatialSkeletonEditSession();
      const retiredRead = deferred<SkeletonNode[]>();
      const unrelatedRead = deferred<SkeletonNode[]>();
      const signals = new Map<bigint, AbortSignal>();
      const layer = {
        fragmentSource: {
          ...makeWholeSkeletonReads(
            (id: bigint, options: { signal: AbortSignal }) => {
              signals.set(id, options.signal);
              // Deliberately ignore cancellation to exercise a late source result.
              return (id === 17n ? retiredRead : unrelatedRead).promise;
            },
          ),
        },
      } as any;
      const read = state.getFullSegmentNodes(layer, 17n, {
        retainWhileInactive: true,
      });
      const other = state.getFullSegmentNodes(layer, 29n, {
        retainWhileInactive: true,
      });
      const aborted = expect(read).rejects.toMatchObject({
        name: "AbortError",
      });
      await flushMicrotasks();
      const revisions = getCachedSegmentRevisions(state, [17n, 29n]);
      const prepared = state.prepareSpatialSkeletonPreviewCachePublication({
        snapshots: [[17n, undefined]],
        expectedRevisions: revisions,
        retiredSegmentIds: new Set([17n]),
        activeStableOwners: [],
        numericAliases: [],
        provisionalNodeIds: [],
        pendingEditIntentIdsToRemove: [],
        notify: true,
      })!;
      expect(signals.get(17n)?.aborted).toBe(false);
      expect(state.getCachedSegmentRevision(17n)).toBe(revisions.get(17n));
      state.runSpatialSkeletonDisplayTransaction(() => {
        expect(
          state.adoptPreparedSpatialSkeletonPreviewCachePublication(prepared),
        ).toBe(true);
      });
      expect(signals.get(17n)?.aborted).toBe(false);
      state.finalizePreparedSpatialSkeletonPreviewCachePublication(prepared);
      await aborted;
      expect(signals.get(17n)?.aborted).toBe(true);
      expect(signals.get(29n)?.aborted).toBe(false);
      expect(state.getCachedSegmentRevision(17n)).toBeGreaterThan(
        revisions.get(17n)!,
      );
      expect(state.getCachedSegmentRevision(29n)).toBe(revisions.get(29n));

      retiredRead.resolve([
        { nodeId: 1n, segmentId: 17n, position: [1, 2, 3] },
      ]);
      await flushMicrotasks();
      expect(state.getCachedNode(1n)).toBeUndefined();
      expect(state.getCachedSegmentNodes(17n)).toBeUndefined();
      unrelatedRead.resolve([
        { nodeId: 2n, segmentId: 29n, position: [4, 5, 6] },
      ]);
      await expect(other).resolves.toMatchObject([{ nodeId: 2n }]);
      expect(state.getCachedNode(2n)).toBeDefined();
    });

    it("an edit that deletes a skeleton for good must remove it from the preview", () => {
      const state = new SpatialSkeletonEditSession();
      const snapshot = createCompleteSkeleton([
        { nodeId: 1n, segmentId: 17n, position: [1, 2, 3] },
      ]);
      const revision = state.getCachedSegmentRevision(17n);
      const display = state.spatialSkeletonDisplay.value;
      for (const snapshots of [[], [[17n, snapshot]]] as const) {
        expect(() =>
          state.prepareSpatialSkeletonPreviewCachePublication({
            snapshots,
            expectedRevisions: getCachedSegmentRevisions(state, [17n]),
            retiredSegmentIds: new Set([17n]),
            activeStableOwners: [],
            numericAliases: [],
            provisionalNodeIds: [],
            pendingEditIntentIdsToRemove: [],
            notify: true,
          }),
        ).toThrow(/Retired spatial skeleton segment 17 must be removed/);
      }
      expect(state.getCachedSegmentRevision(17n)).toBe(revision);
      expect(state.getCachedSegmentNodes(17n)).toBeUndefined();
      expect(state.spatialSkeletonDisplay.value).toBe(display);
    });

    it("a complete preview replaces its Preparing marker in a single redraw", () => {
      const state = new SpatialSkeletonEditSession();
      state.addSpatialSkeletonPendingEdit({
        intentId: 9,
        sequence: 9,
        direction: "execute",
        kind: "split",
        lifecycle: "preparing",
        segmentIds: [11n],
        cutNodeId: 101n,
      });
      const handle = createCompleteSkeleton([
        {
          nodeId: 101n,
          segmentId: 11n,
          position: new Float32Array([1, 2, 3]),
        },
      ]);
      const observed: Array<{
        revision: number;
        pendingEdits: number;
        exactTopology: unknown;
      }> = [];
      state.spatialSkeletonDisplay.changed.add(() => {
        const display = state.spatialSkeletonDisplay.value;
        observed.push({
          revision: display.revision,
          pendingEdits: display.pendingEdits.length,
          exactTopology: state.getCachedSegmentSnapshotHandle(11n)?.handle,
        });
      });
      let nodeNotifications = 0;
      state.nodeDataVersion.changed.add(() => ++nodeNotifications);

      const resultSegment = {
        kind: "segment" as const,
        stableId: "result",
      };
      const prepared = state.prepareSpatialSkeletonPreviewCachePublication({
        snapshots: [[11n, handle]],
        expectedRevisions: getCachedSegmentRevisions(state, [11n]),
        activeStableOwners: [{ segmentId: 11n, stableHandle: resultSegment }],
        numericAliases: [
          { stableHandle: resultSegment, segmentId: 11n, authoritative: true },
        ],
        provisionalNodeIds: [],
        pendingEditIntentIdsToRemove: [9],
        notify: true,
      })!;
      state.runSpatialSkeletonDisplayTransaction(() => {
        expect(
          state.adoptPreparedSpatialSkeletonPreviewCachePublication(prepared),
        ).toBe(true);
      });
      state.finalizePreparedSpatialSkeletonPreviewCachePublication(prepared);

      expect(observed).toEqual([
        {
          revision: 2,
          pendingEdits: 0,
          exactTopology: handle,
        },
      ]);
      expect(nodeNotifications).toBe(1);
      expect(state.spatialSkeletonDisplay.value.activeStableOwners).toEqual([
        expect.objectContaining({
          segmentId: 11n,
          stableHandle: { kind: "segment", stableId: "result" },
        }),
      ]);
    });

    describe("provisional skeletons", () => {
      it("lists a skeleton as provisional until its creating edit is confirmed", () => {
        const state = new SpatialSkeletonEditSession();

        publishSplitOutputAlias(state, {
          authoritative: false,
          activeOwner: true,
        });
        expect([...state.provisionalSegmentIds]).toEqual([17n]);

        publishSplitOutputAlias(state, {
          authoritative: true,
          activeOwner: true,
        });
        expect([...state.provisionalSegmentIds]).toEqual([]);
      });

      it("does not list a provisional ID whose skeleton is no longer shown", () => {
        const state = new SpatialSkeletonEditSession();

        publishSplitOutputAlias(state, {
          authoritative: false,
          activeOwner: false,
        });

        expect([...state.provisionalSegmentIds]).toEqual([]);
      });
    });
  });

  describe("queued-edit markers", () => {
    it("queued-edit markers are listed in edit order and redraw on each add, remove and clear", () => {
      const state = new SpatialSkeletonEditSession();
      let notifications = 0;
      state.spatialSkeletonDisplay.changed.add(() => {
        notifications += 1;
      });
      const capturedPosition = new Float32Array([1, 2, 3]);

      expect(
        state.addSpatialSkeletonPendingEdit({
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
        state.spatialSkeletonDisplay.value.pendingEdits[0]
          .lastKnownPositions?.[0].position[0],
      ).toBe(1);

      expect(
        state.addSpatialSkeletonPendingEdit({
          intentId: 2,
          sequence: 10,
          direction: "undo",
          kind: "restore",
          lifecycle: "preparing",
          segmentIds: [17n],
          nodeId: 202n,
        }),
      ).toBe(true);
      expect(
        state.spatialSkeletonDisplay.value.pendingEdits.map(
          ({ intentId }) => intentId,
        ),
      ).toEqual([2, 1]);
      expect(state.removeSpatialSkeletonPendingEdit(1)).toBe(true);
      expect(
        state.spatialSkeletonDisplay.value.pendingEdits.map(
          ({ intentId }) => intentId,
        ),
      ).toEqual([2]);
      expect(state.clearSpatialSkeletonPendingEdits()).toBe(true);
      expect(state.spatialSkeletonDisplay.value.pendingEdits).toEqual([]);
      expect(notifications).toBe(4);
    });
  });

  describe("cached skeletons", () => {
    it("a split moves nodes to the new skeleton in one notification, and the caller's arrays cannot change the cache later", () => {
      const state = new SpatialSkeletonEditSession();
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
      expect(state.getCachedNode(3n)).toBe(
        state.getCachedSegmentNodes(17n)?.[1],
      );
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

    it("a skeleton known to have no nodes differs from one that is not loaded", () => {
      const state = new SpatialSkeletonEditSession();

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

    it("replacing one skeleton does not walk the nodes of other cached skeletons", () => {
      const state = new SpatialSkeletonEditSession();
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

    it("a cache replacement based on an outdated skeleton is refused", () => {
      const state = new SpatialSkeletonEditSession();
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

    it("a download that finishes after a newer edit returns its nodes but does not overwrite the edit", async () => {
      const state = new SpatialSkeletonEditSession();
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
        fragmentSource: {
          ...makeWholeSkeletonReads(getSkeleton),
        },
      } as any;
      const pending = state.getFullSegmentNodes(skeletonLayer, 11n, {
        retainWhileInactive: true,
      });
      await flushMicrotasks();

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
        },
      ]);
      expect(state.getCachedNode(5n)?.position).toEqual(
        new Float32Array([4, 5, 6]),
      );
    });

    it("a source reset forgets loaded skeletons, the dragged node's position and queued-edit markers", () => {
      const state = new SpatialSkeletonEditSession();
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
      state.addSpatialSkeletonPendingEdit({
        intentId: 1,
        sequence: 1,
        direction: "execute",
        kind: "reroot",
        lifecycle: "preparing",
        segmentIds: [11n],
        rootNodeId: 101n,
      });
      const nodeDataVersion = state.nodeDataVersion.value;
      const pendingNodePositionVersion = state.pendingNodePositionVersion.value;

      expect(state.clearRuntimeState()).toBe(true);
      expect(state.getCachedSegmentNodes(11n)).toBeUndefined();
      expect(state.getCachedNode(5n)).toBeUndefined();
      expect(state.getPendingNodePosition(5n)).toBeUndefined();
      expect(state.spatialSkeletonDisplay.value.pendingEdits).toEqual([]);
      expect(state.nodeDataVersion.value).toBe(nodeDataVersion + 1);
      expect(state.pendingNodePositionVersion.value).toBe(
        pendingNodePositionVersion + 1,
      );
    });

    it("evicting inactive skeletons keeps the ones an unsaved edit is showing", () => {
      const state = new SpatialSkeletonEditSession();
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
      (state as any).editQueue = {
        canUndo: () => false,
        canRedo: () => false,
        hasUnconfirmedActions: () => true,
        getProtectedPreviewSegmentIds: () => [11n],
        undoLatest: () => resolvedExecution(false),
        redoLatest: () => resolvedExecution(false),
      };

      expect(state.evictInactiveSegmentNodes([])).toBe(true);
      expect(state.getCachedSegmentNodes(11n)).toHaveLength(1);
      expect(state.getCachedSegmentNodes(17n)).toBeUndefined();
    });

    it("a skeleton downloaded again while a Move is unsaved still shows the node at its moved position", async () => {
      const state = new SpatialSkeletonEditSession();
      state.replaceCachedSegmentSnapshots([
        [
          11n,
          [
            {
              nodeId: 21n,
              segmentId: 11n,
              position: new Float32Array([1, 2, 3]),
            },
          ],
        ],
      ]);
      ensureSpatialSkeletonEditQueue(
        {
          spatialSkeletonEditSession: state,
          getSpatiallyIndexedSkeletonLayer: () => undefined,
        },
        makeSource(
          makeUnsavedMoveProvider(state, {
            segmentId: 11n,
            nodeId: 21n,
            position: [7, 8, 9],
          }),
        ),
      );
      await state.executeEdit(
        Object.freeze({
          action: SpatialSkeletonActions.moveNodes,
          label: "Move",
          payload: Object.freeze({}),
          getQueueInputRequirements: () => ({ required: [] }),
        }),
        { segments: [] },
      );
      await flushMicrotasks();
      expect(state.getCachedNode(21n)?.position).toEqual([7, 8, 9]);

      state.replaceCachedSegmentSnapshots([[11n, undefined]]);
      const { skeletonLayer, resolvers } = makeLimiterTestLayer();
      const download = state.getFullSegmentNodes(skeletonLayer, 11n);
      await flushMicrotasks();
      resolvers[0]!([
        { nodeId: 21n, segmentId: 11n, position: new Float32Array([1, 2, 3]) },
      ]);
      await download;

      expect(state.getCachedNode(21n)?.position).toEqual([7, 8, 9]);
      state.dispose();
    });
  });

  describe("inputs for an edit", () => {
    it("an edit reads its node from the current inspected skeleton and finds nothing for a missing node or skeleton", () => {
      const state = new SpatialSkeletonEditSession();
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
      const state = new SpatialSkeletonEditSession();
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

    it("an edit's input goes out of date when its skeleton changes and stops keeping it cached", () => {
      const state = new SpatialSkeletonEditSession();
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

    it("an edit on an uninspected skeleton or a missing node fails with a message naming what to inspect, without downloading", () => {
      const state = new SpatialSkeletonEditSession();
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
  });

  describe("dragged node position", () => {
    it("only the dragged node has a pending position, under the ID picked when the drag began", () => {
      const state = new SpatialSkeletonEditSession();
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

    it("the dragged node keeps its position when the server renumbers it", () => {
      const state = new SpatialSkeletonEditSession();

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
  });

  describe("source capabilities", () => {
    it("supports confidence editing for a source that does not list its confidence values", () => {
      const source = {
        ...makeEditableSourceCommands(),
        editNodeConfidenceCommand: makeCommandFactory(
          SpatialSkeletonActions.editNodeConfidence,
        ),
        getSkeletonManifest: async () => ({ fragmentKeys: [] }),
        getSkeletonFragment: async () => ({ nodes: [], edges: [] }),
      };

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
      ).toBe(true);
    });
  });

  describe("skeleton downloads", () => {
    it("evicting a skeleton cancels its pending download, and a late answer is not cached", async () => {
      const state = new SpatialSkeletonEditSession();
      let receivedSignal: AbortSignal | undefined;
      let resolveFetch: ((nodes: SkeletonNode[]) => void) | undefined;
      const getSkeleton = vi.fn(
        (_segmentId: bigint, options?: { signal?: AbortSignal }) =>
          new Promise<SkeletonNode[]>((resolve) => {
            receivedSignal = options?.signal;
            resolveFetch = resolve;
          }),
      );
      const pending = state
        .getFullSegmentNodes(
          {
            fragmentSource: {
              ...makeWholeSkeletonReads(getSkeleton),
            },
          } as any,
          11n,
        )
        .catch((error) => error);
      await flushMicrotasks();

      expect(receivedSignal?.aborted).toBe(false);
      expect(state.evictInactiveSegmentNodes([])).toBe(false);
      expect(receivedSignal?.aborted).toBe(true);
      resolveFetch?.([
        {
          nodeId: 5n,
          segmentId: 11n,
          position: new Float32Array([1, 2, 3]),
        },
      ]);
      await expect(pending).resolves.toMatchObject({ name: "AbortError" });
      await flushMicrotasks();
      expect(state.getCachedSegmentNodes(11n)).toBeUndefined();
      expect(state.getCachedNode(5n)).toBeUndefined();
    });

    it("an edit that stops waiting for a skeleton download cancels it, even if the source ignores cancellation", async () => {
      const state = new SpatialSkeletonEditSession();
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
        fragmentSource: {
          ...makeWholeSkeletonReads(getSkeleton),
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
      await flushMicrotasks();

      expect(receivedSignal?.aborted).toBe(false);
      expect(state.releaseFullSegmentNodeFetchOwner(owner)).toBe(true);
      expect(receivedSignal?.aborted).toBe(true);
      await expect(outcome).resolves.toMatchObject({ name: "AbortError" });
      expect(getSkeleton).toHaveBeenCalledTimes(1);
      expect(state.releaseFullSegmentNodeFetchOwner(owner)).toBe(false);
    });

    it("a download two edits wait for continues until both stop waiting", async () => {
      const state = new SpatialSkeletonEditSession();
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
        fragmentSource: {
          ...makeWholeSkeletonReads(getSkeleton),
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
      await flushMicrotasks();

      expect(getSkeleton).toHaveBeenCalledTimes(1);
      expect(state.releaseFullSegmentNodeFetchOwner(firstOwner)).toBe(true);
      expect(receivedSignal?.aborted).toBe(false);
      expect(state.releaseFullSegmentNodeFetchOwner(secondOwner)).toBe(true);
      expect(receivedSignal?.aborted).toBe(true);
      await expect(firstOutcome).resolves.toMatchObject({ name: "AbortError" });
      await expect(secondOutcome).resolves.toMatchObject({
        name: "AbortError",
      });
    });

    it("a download the display also needs continues after the edit stops waiting and is cached", async () => {
      const state = new SpatialSkeletonEditSession();
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
        fragmentSource: {
          ...makeWholeSkeletonReads(getSkeleton),
        },
      } as any;
      const commandFetch = state.getFullSegmentNodes(skeletonLayer, 11n, {
        requestOwner: owner,
        retainWhileInactive: true,
      });
      const visualFetch = state.getFullSegmentNodes(skeletonLayer, 11n);
      await flushMicrotasks();

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

    it.each([
      [
        "an error",
        {
          failFirstRequest: () =>
            Promise.reject(new Error("temporary read failure")),
          expectedError: { message: "temporary read failure" },
        },
      ],
      [
        "a timeout",
        {
          failFirstRequest: () => new Promise<never>(() => {}),
          expectedError: { name: "TimeoutError" },
        },
      ],
    ])(
      "a failed skeleton download can be retried: after %s",
      async (_failure, { failFirstRequest, expectedError }) => {
        vi.useFakeTimers();
        try {
          const state = new SpatialSkeletonEditSession();
          const getSkeleton = vi.fn((_segmentId: bigint) =>
            getSkeleton.mock.calls.length === 1
              ? failFirstRequest()
              : Promise.resolve([]),
          );
          const skeletonLayer = {
            fragmentSource: {
              ...makeWholeSkeletonReads(getSkeleton),
            },
          } as any;
          const failed = state
            .getFullSegmentNodes(skeletonLayer, 11n, {
              retainWhileInactive: true,
            })
            .catch((error: unknown) => error);

          await vi.advanceTimersByTimeAsync(120_000);
          await expect(failed).resolves.toMatchObject(expectedError);
          expect(getSkeleton).toHaveBeenCalledTimes(1);

          await expect(
            state.getFullSegmentNodes(skeletonLayer, 11n, {
              retainWhileInactive: true,
            }),
          ).resolves.toEqual([]);
          expect(getSkeleton).toHaveBeenCalledTimes(2);
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it.each([
      ["for display", {}],
      ["for an edit", { retainWhileInactive: true }],
    ])(
      "a source reset cancels pending skeleton downloads: %s",
      async (_description, downloadOptions) => {
        const state = new SpatialSkeletonEditSession();
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
            fragmentSource: {
              ...makeWholeSkeletonReads(getSkeleton),
            },
          } as any,
          11n,
          downloadOptions,
        );
        await flushMicrotasks();

        expect(receivedSignal?.aborted).toBe(false);
        expect(state.clearRuntimeState()).toBe(true);
        expect(receivedSignal?.aborted).toBe(true);
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        expect(state.getCachedSegmentNodes(11n)).toBeUndefined();
        expect(state.getCachedNode(11n)).toBeUndefined();
      },
    );

    it("a display download that an edit joins survives eviction and serves both", async () => {
      const state = new SpatialSkeletonEditSession();
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
        fragmentSource: {
          ...makeWholeSkeletonReads(getSkeleton),
        },
      } as any;

      const visualFetch = state.getFullSegmentNodes(skeletonLayer, 11n);
      const commandFetch = state.getFullSegmentNodes(skeletonLayer, 11n, {
        retainWhileInactive: true,
      });
      await flushMicrotasks();

      expect(getSkeleton).toHaveBeenCalledTimes(1);
      expect(state.evictInactiveSegmentNodes([])).toBe(false);
      expect(receivedSignal?.aborted).toBe(false);

      const fetchedNodes: SkeletonNode[] = [
        {
          nodeId: 5n,
          segmentId: 11n,
          position: new Float32Array([1, 2, 3]),
        },
      ];
      resolveFetch?.(fetchedNodes);

      await expect(visualFetch).resolves.toEqual(fetchedNodes);
      await expect(commandFetch).resolves.toEqual(fetchedNodes);
      expect(
        state.getCachedSegmentNodes(11n)?.map((node) => node.nodeId),
      ).toEqual([5n]);
    });

    it("replacing a skeleton cancels its pending download and notifies once", async () => {
      const state = new SpatialSkeletonEditSession();
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
          fragmentSource: {
            ...makeWholeSkeletonReads(getSkeleton),
          },
        } as any,
        11n,
      );
      let notifications = 0;
      state.nodeDataVersion.changed.add(() => {
        notifications += 1;
      });
      await flushMicrotasks();

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
      expect(state.getCachedNode(5n)).toBe(
        state.getCachedSegmentNodes(11n)?.[0],
      );
      expect(notifications).toBe(1);
    });

    it("a finished download caches the skeleton's nodes and notifies once", async () => {
      const state = new SpatialSkeletonEditSession();
      const getSkeleton = vi.fn(async () => [
        {
          nodeId: 5n,
          parentNodeId: undefined,
          position: new Float32Array([1, 2, 3]),
          segmentId: 11n,
        },
      ]);
      const skeletonLayer = {
        fragmentSource: {
          ...makeWholeSkeletonReads(getSkeleton),
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
        },
      ]);

      expect(notifications).toBe(1);
      expect(state.getCachedNode(5n)).toEqual({
        nodeId: 5n,
        segmentId: 11n,
        position: new Float32Array([1, 2, 3]),
        parentNodeId: undefined,
        description: undefined,
      });
    });

    it.each([
      [2, "when the download limit is 2", 2],
      [8, "without a chunk manager", undefined],
    ])(
      "runs at most %i skeleton downloads at once %s",
      async (limit, _condition, itemLimit) => {
        const state = new SpatialSkeletonEditSession();
        const { skeletonLayer, getSkeleton, resolvers } =
          makeLimiterTestLayer(itemLimit);

        const pending = Array.from({ length: limit + 2 }, (_, index) =>
          state.getFullSegmentNodes(skeletonLayer, BigInt(index + 1)),
        );
        await flushMicrotasks();

        expect(getSkeleton).toHaveBeenCalledTimes(limit);
        resolvers[0]([]);
        await pending[0];
        expect(getSkeleton).toHaveBeenCalledTimes(limit + 1);
      },
    );

    it("starts a skeleton read an edit awaits before queued display reads", async () => {
      const state = new SpatialSkeletonEditSession();
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
      await flushMicrotasks();

      expect(getSkeleton).toHaveBeenCalledTimes(1);
      resolvers[0]([]);
      await first;
      expect(getSkeleton).toHaveBeenCalledTimes(2);
      expect(getSkeleton.mock.calls[1][0]).toBe(13n);
    });

    it("starts queued display reads in order again once an edit stops awaiting one", async () => {
      const state = new SpatialSkeletonEditSession();
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
      await flushMicrotasks();

      resolvers[0]([]);
      await first;
      expect(getSkeleton).toHaveBeenCalledTimes(2);
      expect(getSkeleton.mock.calls[1][0]).toBe(12n);
    });

    it("a download that never answers fails after two minutes, is cancelled, and lets the next download start", async () => {
      vi.useFakeTimers();
      try {
        const state = new SpatialSkeletonEditSession();
        let timedOutSignal: AbortSignal | undefined;
        const getSkeleton = vi.fn(
          (segmentId: bigint, options: { signal: AbortSignal }) => {
            if (segmentId !== 11n) return Promise.resolve([]);
            timedOutSignal = options.signal;
            return new Promise<never>(() => {});
          },
        );
        const skeletonLayer = {
          fragmentSource: {
            ...makeWholeSkeletonReads(getSkeleton),
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
        await flushMicrotasks();

        expect(getSkeleton).toHaveBeenCalledTimes(1);
        expect(timedOutSignal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(timedOutSignal?.aborted).toBe(true);
        await expect(firstOutcome).resolves.toMatchObject({
          name: "TimeoutError",
        });
        await expect(second).resolves.toEqual([]);
        expect(getSkeleton).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a queued download whose skeleton is evicted never starts", async () => {
      const state = new SpatialSkeletonEditSession();
      const { skeletonLayer, getSkeleton, resolvers } = makeLimiterTestLayer(1);

      const first = state.getFullSegmentNodes(skeletonLayer, 11n);
      const queued = state.getFullSegmentNodes(skeletonLayer, 12n);
      await flushMicrotasks();
      expect(getSkeleton).toHaveBeenCalledTimes(1);

      expect(state.evictInactiveSegmentNodes([11n])).toBe(false);
      await expect(queued).rejects.toMatchObject({ name: "AbortError" });

      resolvers[0]([]);
      await first;
      expect(getSkeleton).toHaveBeenCalledTimes(1);
    });

    describe("full skeleton read from a manifest", () => {
      it("returns the nodes of every fragment that the manifest lists", async () => {
        const state = new SpatialSkeletonEditSession();
        const { layer } = makeFragmentedSkeletonLayer({
          "0.0.0": {
            nodes: [makeFragmentNode(1n), makeFragmentNode(2n)],
            edges: [makeEdge(2n, 1n)],
          },
          "0.0.1": { nodes: [makeFragmentNode(3n)], edges: [makeEdge(3n, 2n)] },
        });

        const nodes = await state.getFullSegmentNodes(layer, 7n);

        expect(nodes.map((node) => node.nodeId)).toEqual([1n, 2n, 3n]);
        expect(nodes[2].parentNodeId).toBe(2n);
      });

      it("fails the whole read when one fragment fails", async () => {
        const state = new SpatialSkeletonEditSession();
        const { layer } = makeFragmentedSkeletonLayer({
          "0.0.0": { nodes: [makeFragmentNode(1n)], edges: [] },
          "0.0.1": new Error("fragment missing"),
        });

        await expect(state.getFullSegmentNodes(layer, 7n)).rejects.toThrow(
          "fragment missing",
        );
      });

      it("does not request the next fragment after one fails", async () => {
        const state = new SpatialSkeletonEditSession();
        const { layer, requestedFragmentKeys } = makeFragmentedSkeletonLayer({
          "0.0.0": new Error("fragment missing"),
          "0.0.1": { nodes: [makeFragmentNode(2n)], edges: [] },
        });

        await expect(state.getFullSegmentNodes(layer, 7n)).rejects.toThrow(
          "fragment missing",
        );
        expect(requestedFragmentKeys).toEqual(["0.0.0"]);
      });

      it("requests no fragment once the read is aborted", async () => {
        const state = new SpatialSkeletonEditSession();
        const manifestReady = deferred<void>();
        const { layer, requestedFragmentKeys } = makeFragmentedSkeletonLayer(
          { "0.0.0": { nodes: [makeFragmentNode(1n)], edges: [] } },
          { manifestReady: manifestReady.promise },
        );
        const read = state.getFullSegmentNodes(layer, 7n);
        const aborted = expect(read).rejects.toMatchObject({
          name: "AbortError",
        });
        await flushMicrotasks();

        state.clearRuntimeState();
        manifestReady.resolve();
        await aborted;
        await flushMicrotasks();

        expect(requestedFragmentKeys).toEqual([]);
      });

      it("rejects a skeleton that has one node in two fragments", async () => {
        const state = new SpatialSkeletonEditSession();
        const { layer } = makeFragmentedSkeletonLayer({
          "0.0.0": {
            nodes: [makeFragmentNode(1n), makeFragmentNode(2n)],
            edges: [],
          },
          "0.0.1": {
            nodes: [makeFragmentNode(2n), makeFragmentNode(3n)],
            edges: [],
          },
        });

        await expect(state.getFullSegmentNodes(layer, 7n)).rejects.toThrow(
          "Skeleton 7 has node 2 in more than one fragment.",
        );
      });

      it("joins a node to a parent that another fragment links to it", async () => {
        const state = new SpatialSkeletonEditSession();
        const { layer } = makeFragmentedSkeletonLayer({
          "0.0.0": { nodes: [makeFragmentNode(3n)], edges: [] },
          "0.0.1": {
            nodes: [makeFragmentNode(1n), makeFragmentNode(2n)],
            edges: [makeEdge(2n, 1n), makeEdge(3n, 2n)],
          },
        });

        const nodes = await state.getFullSegmentNodes(layer, 7n);

        expect(nodes.find((node) => node.nodeId === 3n)?.parentNodeId).toBe(2n);
      });

      it("takes the first node of each edge as the parent when the source lists edges parent to child", async () => {
        const state = new SpatialSkeletonEditSession();
        const { layer } = makeFragmentedSkeletonLayer(
          {
            skeleton: {
              nodes: [makeFragmentNode(1n), makeFragmentNode(2n)],
              edges: [makeEdge(1n, 2n)],
            },
          },
          { edgeDirection: SkeletonEdgeDirection.PARENT_TO_CHILD },
        );

        const nodes = await state.getFullSegmentNodes(layer, 7n);

        expect(nodes.map((node) => [node.nodeId, node.parentNodeId])).toEqual([
          [1n, undefined],
          [2n, 1n],
        ]);
      });

      it("rejects a directed skeleton that gives one node two parents", async () => {
        const state = new SpatialSkeletonEditSession();
        const { layer } = makeFragmentedSkeletonLayer({
          "0.0.0": {
            nodes: [makeFragmentNode(1n), makeFragmentNode(2n)],
            edges: [makeEdge(2n, 1n)],
          },
          "0.0.1": { nodes: [makeFragmentNode(3n)], edges: [makeEdge(2n, 3n)] },
        });

        await expect(state.getFullSegmentNodes(layer, 7n)).rejects.toThrow(
          "Skeleton 7 gives node 2 two parents.",
        );
      });

      it("rejects a directed edge to a node that no fragment has", async () => {
        const state = new SpatialSkeletonEditSession();
        const { layer } = makeFragmentedSkeletonLayer({
          skeleton: {
            nodes: [makeFragmentNode(2n)],
            edges: [makeEdge(2n, 1n)],
          },
        });

        await expect(state.getFullSegmentNodes(layer, 7n)).rejects.toThrow(
          "Skeleton 7 has an edge to node 1, which no fragment has.",
        );
      });

      it("infers parents from the first node of each part when the source's edges have no direction", async () => {
        const state = new SpatialSkeletonEditSession();
        const { layer } = makeFragmentedSkeletonLayer(
          {
            "0.0.0": {
              nodes: [makeFragmentNode(1n), makeFragmentNode(2n)],
              edges: [makeEdge(2n, 3n)],
            },
            "0.0.1": {
              nodes: [makeFragmentNode(3n), makeFragmentNode(4n)],
              edges: [makeEdge(1n, 3n)],
            },
          },
          { edgeDirection: SkeletonEdgeDirection.UNDIRECTED },
        );

        const nodes = await state.getFullSegmentNodes(layer, 7n);

        expect(nodes.map((node) => [node.nodeId, node.parentNodeId])).toEqual([
          [1n, undefined],
          [2n, 3n],
          [3n, 1n],
          [4n, undefined],
        ]);
      });

      it("returns no nodes for a skeleton the source does not have", async () => {
        const state = new SpatialSkeletonEditSession();
        const { layer } = makeFragmentedSkeletonLayer({});

        expect(await state.getFullSegmentNodes(layer, 7n)).toEqual([]);
      });
    });
  });
});
