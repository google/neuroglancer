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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emptyInvalidCoordinateSpace } from "#src/coordinate_transform.js";
import { CatmaidSpatialSkeletonEditCommands } from "#src/datasource/catmaid/spatial_skeleton_edit/command_factories.js";
import type {
  LayerSelectedValues,
  UserLayer,
  UserLayerSelectionState,
} from "#src/layer/index.js";
import { TrackableDataSelectionState } from "#src/layer/index.js";
import { SkeletonNodeSelection } from "#src/layer/segmentation/selection.js";
import { SkeletonSourceConnection } from "#src/layer/segmentation/skeleton_source_connection.js";
import type { SegmentationGroupState } from "#src/segmentation_display_state/frontend.js";
import { SkeletonEdgeDirection, type SkeletonNode } from "#src/skeleton/api.js";
import {
  SpatialSkeletonEditSession,
  ensureSpatialSkeletonEditQueue,
} from "#src/skeleton/edit/spatial_skeleton_edit_session.js";
import {
  createSpatialSkeletonQueueInputPreparation,
  executeSpatialSkeletonAddNode,
  executeSpatialSkeletonInsertNode,
  executeSpatialSkeletonDeleteNode,
  executeSpatialSkeletonMerge,
  executeSpatialSkeletonMoveNode,
  executeSpatialSkeletonNodeConfidenceUpdate,
  executeSpatialSkeletonNodeDescriptionUpdate,
  executeSpatialSkeletonNodeRadiusUpdate,
  executeSpatialSkeletonNodeTrueEndUpdate,
  executeSpatialSkeletonReroot,
  executeSpatialSkeletonSplit,
  prepareAndSubmitSpatialSkeletonEdit,
  redoSpatialSkeletonCommand,
  showSpatialSkeletonActionError,
  undoSpatialSkeletonCommand,
} from "#src/skeleton/edit/submit_edits.js";
import type { SpatialSkeletonEditCommand } from "#src/skeleton/edit_commands.js";
import { SpatialSkeletonActions } from "#src/skeleton/edit_commands.js";
import { SpatialSkeletonEditConflictError } from "#src/skeleton/edit_queue/edit_errors.js";
import { SpatialSkeletonEditPreview } from "#src/skeleton/edit_queue/preview.js";
import type { SpatialSkeletonQueueInputRequirement } from "#src/skeleton/edit_queue/queue_input.js";
import { resetGlobalSpatialSkeletonEditRequestLockForTesting } from "#src/skeleton/edit_queue/request_scheduler.js";
import type {
  SpatialSkeletonEditExecution,
  SpatialSkeletonEditSettlement,
} from "#src/skeleton/edit_queue/types.js";
import {
  SpatialSkeletonReloadRequiredError,
  committedSpatialSkeletonEditSettlement,
} from "#src/skeleton/edit_queue/types.js";
import { SpatialSkeletonUndoHistory } from "#src/skeleton/edit_queue/undo_history.js";
import { getSkeletonNodeConfidence } from "#src/skeleton/node_attributes.js";
import type { SkeletonNodeAccess } from "#src/skeleton/skeleton_navigator.js";
import type { SkeletonOverlaySegments } from "#src/skeleton/spatial/overlay_segments.js";
import type { SpatiallyIndexedSkeletonLayer } from "#src/skeleton/spatial/skeleton_render_layer.js";
import { StatusMessage } from "#src/status.js";
import { WatchableValue } from "#src/trackable_value.js";
import { SpatialSkeletonAuthorityNotificationController } from "#src/ui/skeleton_edit_queue_tab.js";
import { Uint64OrderedSet } from "#src/uint64_ordered_set.js";
import { Uint64Set } from "#src/uint64_set.js";
import { bigintCompare } from "#src/util/bigint.js";
import { HttpError } from "#src/util/http_request.js";
import { NullarySignal } from "#src/util/signal.js";

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

function cloneNode(node: SkeletonNode): SkeletonNode {
  return {
    ...node,
    position: new Float32Array(node.position),
    description: node.description,
  };
}

function cloneNodes(
  nodes: readonly SkeletonNode[] | undefined,
): SkeletonNode[] {
  return (nodes ?? []).map((node) => cloneNode(node));
}

function cachedTopologyForTest(
  state: SpatialSkeletonEditSession,
  segmentIds: readonly bigint[],
) {
  return segmentIds
    .flatMap((segmentId) => state.getCachedSegmentNodes(segmentId) ?? [])
    .map((node) => [node.nodeId, node.segmentId, node.parentNodeId ?? null])
    .sort((a, b) => bigintCompare(a[0]!, b[0]!));
}

function makeRootRestorationNodesForTest(): SkeletonNode[] {
  // A0 -> A1 and B0 -> B1 -> B2, with off-path branches at B1 and B2.
  // Attaching A1 to B2 must reverse the entire B0/B1/B2 path.
  return [
    [101n, 11n, undefined],
    [102n, 11n, 101n],
    [201n, 17n, undefined],
    [202n, 17n, 201n],
    [203n, 17n, 202n],
    [204n, 17n, 202n],
    [205n, 17n, 203n],
  ].map(([nodeId, segmentId, parentNodeId]) => ({
    nodeId: nodeId!,
    segmentId: segmentId!,
    parentNodeId,
    position: new Float32Array([
      Number(nodeId!),
      Number(nodeId!) + 1,
      Number(nodeId!) + 2,
    ]),
  }));
}

function replaceCachedSegmentForTest(
  state: SpatialSkeletonEditSession,
  segmentId: bigint,
  nodes: readonly SkeletonNode[] | undefined,
) {
  state.replaceCachedSegmentSnapshots([[segmentId, nodes]], {
    notify: false,
  });
}

function seedCachedNodesForTest(
  state: SpatialSkeletonEditSession,
  nodes: readonly SkeletonNode[],
) {
  const nodesBySegment = new Map<bigint, SkeletonNode[]>();
  for (const node of nodes) {
    const segmentNodes = nodesBySegment.get(node.segmentId) ?? [];
    segmentNodes.push(cloneNode(node));
    nodesBySegment.set(node.segmentId, segmentNodes);
  }
  state.replaceCachedSegmentSnapshots(nodesBySegment, { notify: false });
}

const catmaidEditClientMethodNames = new Set([
  "addNode",
  "insertNode",
  "moveNode",
  "deleteNode",
  "rerootSkeleton",
  "updateDescription",
  "toggleTrueEnd",
  "updateRadius",
  "updateConfidence",
  "mergeSkeletons",
  "splitSkeleton",
]);

function makeCatmaidClient(overrides: Record<string, unknown> = {}) {
  return {
    baseUrl: "https://catmaid.example.test",
    projectId: 1,
    addNode: vi.fn(),
    insertNode: vi.fn(),
    moveNode: vi.fn(),
    deleteNode: vi.fn(),
    rerootSkeleton: vi.fn(),
    updateDescription: vi.fn(),
    toggleTrueEnd: vi.fn(),
    updateRadius: vi.fn(),
    updateConfidence: vi.fn(),
    mergeSkeletons: vi.fn(),
    splitSkeleton: vi.fn(),
    ...overrides,
  };
}

function countSentRequests(client: ReturnType<typeof makeCatmaidClient>) {
  return [...catmaidEditClientMethodNames].reduce(
    (count, name) => count + (client as any)[name].mock.calls.length,
    0,
  );
}

function makeCatmaidEditCommands(client = makeCatmaidClient()) {
  return new CatmaidSpatialSkeletonEditCommands({
    getClient: () => client as any,
  });
}

function makeEditableSkeletonSource(overrides: Record<string, unknown> = {}) {
  const clientOverrides: Record<string, unknown> = {};
  const sourceOverrides: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (catmaidEditClientMethodNames.has(key)) {
      clientOverrides[key] = value;
    } else {
      sourceOverrides[key] = value;
    }
  }
  const commands = makeCatmaidEditCommands(makeCatmaidClient(clientOverrides));
  return {
    editPlannerProvider: commands.editPlannerProvider,
    addNodesCommand: commands.addNodesCommand,
    insertNodesCommand: commands.insertNodesCommand,
    moveNodesCommand: commands.moveNodesCommand,
    deleteNodesCommand: commands.deleteNodesCommand,
    rerootCommand: commands.rerootCommand,
    editNodeDescriptionCommand: commands.editNodeDescriptionCommand,
    editNodeTrueEndCommand: commands.editNodeTrueEndCommand,
    editNodeRadiusCommand: commands.editNodeRadiusCommand,
    editNodeConfidenceCommand: commands.editNodeConfidenceCommand,
    mergeSkeletonsCommand: commands.mergeSkeletonsCommand,
    splitSkeletonsCommand: commands.splitSkeletonsCommand,
    getSkeletonManifest: vi.fn(),
    getSkeletonFragment: vi.fn(),
    ...sourceOverrides,
  };
}

function suppressStatusMessages() {
  const fakeStatusMessage = {
    dispose() {},
  } as unknown as StatusMessage;
  vi.spyOn(StatusMessage, "showTemporaryMessage").mockImplementation(
    (_message: string, _closeAfter?: number) => fakeStatusMessage,
  );
  vi.spyOn(StatusMessage, "showMessage").mockImplementation(
    (_message: string) => fakeStatusMessage,
  );
  vi.spyOn(StatusMessage, "showErrorMessage").mockImplementation(
    (_message: string) => fakeStatusMessage,
  );
}

function attachAuthorityNotifications(layer: any) {
  const controller = new SpatialSkeletonAuthorityNotificationController(layer);
  const subscription =
    layer.spatialSkeletonEditSession.editQueueVersion.changed.add(() =>
      controller.update(),
    );
  return () => {
    if (typeof subscription === "function") subscription();
    else subscription.dispose();
    controller.dispose();
  };
}

function expectReloadRequired(
  state: SpatialSkeletonEditSession,
  authority: "committed" | "indeterminate",
) {
  expect(state.getReloadRequired()).toEqual(
    expect.objectContaining({
      authority,
      reason:
        authority === "committed"
          ? "committed-local-publication-failed"
          : "authority-indeterminate",
    }),
  );
}

function makeAvailableInputReferences() {
  const makeRetainedInput = (requirement: {
    segmentId: bigint;
    nodeId?: bigint;
  }) => ({
    segmentId: requirement.segmentId,
    snapshot: {},
    node:
      requirement.nodeId === undefined
        ? undefined
        : { nodeId: requirement.nodeId, segmentId: requirement.segmentId },
    isCurrent: () => true,
    release: vi.fn(),
  });
  return {
    assertEditingAllowed: vi.fn(),
    getEditingIdentityService: vi.fn(() => ({})),
    tryAcquireInputReference: vi.fn(makeRetainedInput),
    acquireInputReference: vi.fn(makeRetainedInput),
  };
}

function makeResolvedExecution(value = true) {
  const execution = Promise.resolve(value) as Promise<boolean> & {
    acceptedByQueue: Promise<void>;
    settled: Promise<{ outcome: "unchanged"; reason: "no-op" }>;
  };
  Object.defineProperties(execution, {
    acceptedByQueue: { configurable: true, value: Promise.resolve() },
    settled: {
      configurable: true,
      value: Promise.resolve({ outcome: "unchanged", reason: "no-op" }),
    },
  });
  return execution;
}

function makeAddNodeTestLayer(options: {
  addNode?: ReturnType<typeof vi.fn>;
  deleteNode?: ReturnType<typeof vi.fn>;
  insertNode?: ReturnType<typeof vi.fn>;
  mergeSkeletons?: ReturnType<typeof vi.fn>;
  moveNode?: ReturnType<typeof vi.fn>;
  rerootSkeleton?: ReturnType<typeof vi.fn>;
  splitSkeleton?: ReturnType<typeof vi.fn>;
  getSkeleton?: ReturnType<typeof vi.fn>;
  updateDescription?: ReturnType<typeof vi.fn>;
  toggleTrueEnd?: ReturnType<typeof vi.fn>;
  updateRadius?: ReturnType<typeof vi.fn>;
  updateConfidence?: ReturnType<typeof vi.fn>;
  initialNodes: readonly SkeletonNode[];
  segmentId: bigint;
  segmentIds?: readonly bigint[];
}) {
  const spatialSkeletonEditSession = new SpatialSkeletonEditSession();
  const initialNodesBySegment = new Map<bigint, SkeletonNode[]>();
  for (const node of options.initialNodes) {
    const segmentNodes = initialNodesBySegment.get(node.segmentId) ?? [];
    segmentNodes.push(node);
    initialNodesBySegment.set(node.segmentId, segmentNodes);
  }
  spatialSkeletonEditSession.replaceCachedSegmentSnapshots(
    [...initialNodesBySegment],
    { notify: false },
  );
  const getSkeleton =
    options.getSkeleton ??
    vi.fn(async (requestedSegmentId: bigint) =>
      (
        spatialSkeletonEditSession.getCachedSegmentNodes(requestedSegmentId) ??
        options.initialNodes.filter(
          (node) => node.segmentId === requestedSegmentId,
        )
      ).map((node) => ({
        ...node,
        position: new Float32Array(node.position),
      })),
    );
  const client = makeCatmaidClient({
    addNode: options.addNode ?? vi.fn(),
    deleteNode: options.deleteNode ?? vi.fn(),
    insertNode: options.insertNode ?? vi.fn(),
    mergeSkeletons: options.mergeSkeletons ?? vi.fn(),
    moveNode: options.moveNode ?? vi.fn(),
    rerootSkeleton: options.rerootSkeleton ?? vi.fn(),
    splitSkeleton: options.splitSkeleton ?? vi.fn(),
    getSkeleton,
    updateDescription: options.updateDescription ?? vi.fn(),
    toggleTrueEnd: options.toggleTrueEnd ?? vi.fn(),
    updateRadius: options.updateRadius ?? vi.fn(),
    updateConfidence: options.updateConfidence ?? vi.fn(),
  });
  const commands = makeCatmaidEditCommands(client);
  const skeletonSource = {
    ...makeEditableSkeletonSource(),
    addNodesCommand: commands.addNodesCommand,
    insertNodesCommand: commands.insertNodesCommand,
    deleteNodesCommand: commands.deleteNodesCommand,
    moveNodesCommand: commands.moveNodesCommand,
    rerootCommand: commands.rerootCommand,
    editNodeDescriptionCommand: commands.editNodeDescriptionCommand,
    editNodeTrueEndCommand: commands.editNodeTrueEndCommand,
    editNodeRadiusCommand: commands.editNodeRadiusCommand,
    editNodeConfidenceCommand: commands.editNodeConfidenceCommand,
    mergeSkeletonsCommand: commands.mergeSkeletonsCommand,
    splitSkeletonsCommand: commands.splitSkeletonsCommand,
    editPlannerProvider: commands.editPlannerProvider,
    ...makeWholeSkeletonReads(getSkeleton),
  };
  const skeletonLayer = {
    fragmentSource: skeletonSource,
    editableSource: skeletonSource,
    getNode: (nodeId: bigint) =>
      spatialSkeletonEditSession.getCachedNode(nodeId),
  };
  const layerSelectedValues = {
    changed: new NullarySignal(),
    mouseState: { active: false },
  } as unknown as LayerSelectedValues;
  const selectionState = new TrackableDataSelectionState(
    new WatchableValue(emptyInvalidCoordinateSpace),
    layerSelectedValues,
  );
  const userLayer = {
    manager: {
      layerSelectedValues,
      root: {
        selectionState,
        globalPosition: new WatchableValue(new Float32Array(3)),
      },
    },
    renderLayers: [],
    initializeSelectionState(state: UserLayerSelectionState) {
      state.value = undefined;
      (state as { nodeId?: bigint }).nodeId = undefined;
    },
    setLayerPosition: vi.fn(),
  } as unknown as UserLayer;
  const skeletonNodeAccess = new WatchableValue<SkeletonNodeAccess | undefined>(
    undefined,
  );
  const spatiallyIndexedSkeletonLayer = new WatchableValue(
    skeletonLayer as unknown as SpatiallyIndexedSkeletonLayer,
  );
  const selection = new SkeletonNodeSelection({
    layer: userLayer,
    skeletonNodeAccess,
    spatiallyIndexedSkeletonLayer,
    spatialSkeletonEditSession,
  });
  const group = {
    visibleSegments: new Uint64Set(),
    temporaryVisibleSegments: new Uint64Set(),
    selectedSegments: new Uint64OrderedSet(),
  };
  group.visibleSegments.add([...(options.segmentIds ?? [options.segmentId])]);
  const overlaySegments = {
    remap: vi.fn(),
    retain: vi.fn(),
    clear: vi.fn(),
  };
  const layer = new SkeletonSourceConnection({
    spatialSkeletonEditSession,
    selection,
    overlaySegments: overlaySegments as unknown as SkeletonOverlaySegments,
    segmentationGroupState: new WatchableValue(
      group as unknown as SegmentationGroupState,
    ),
    skeletonNodeAccess,
    spatiallyIndexedSkeletonLayer,
  });
  return {
    client,
    layer,
    skeletonLayer,
    spatialSkeletonEditSession,
    group,
    selection,
    overlaySegments,
  };
}

async function waitForMicrotasks(count = 3) {
  for (let i = 0; i < count; ++i) {
    await Promise.resolve();
  }
}

async function waitForDisplayTurn() {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

async function afterDisplayTurnWithFakeTimers<T>(execution: Promise<T>) {
  vi.advanceTimersToNextFrame();
  await vi.advanceTimersByTimeAsync(0);
  return execution;
}

function makeEditExecution<T>(
  execution: Promise<T>,
  settled: Promise<SpatialSkeletonEditSettlement> = Promise.resolve({
    outcome: "committed",
  }),
): SpatialSkeletonEditExecution<T> {
  Object.defineProperties(execution, {
    acceptedByQueue: { configurable: true, value: Promise.resolve() },
    settled: { configurable: true, value: settled },
  });
  return execution as SpatialSkeletonEditExecution<T>;
}

function makeQueueInputLayer(
  cachedSegmentIds: readonly bigint[] = [],
  getSkeleton = vi.fn(
    async (segmentId: bigint, _options: { signal: AbortSignal }) => [
      { nodeId: segmentId + 1n, segmentId, position: new Float32Array(3) },
    ],
  ),
) {
  const state = new SpatialSkeletonEditSession();
  state.replaceCachedSegmentSnapshots(
    cachedSegmentIds.map((segmentId) => [
      segmentId,
      [{ nodeId: segmentId + 1n, segmentId, position: new Float32Array(3) }],
    ]),
  );
  const skeletonSource = {
    ...makeEditableSkeletonSource(),
    ...makeWholeSkeletonReads(getSkeleton),
  };
  const layer = {
    spatialSkeletonEditSession: state,
    getSpatiallyIndexedSkeletonLayer: () =>
      ({ fragmentSource: skeletonSource }) as any,
  };
  ensureSpatialSkeletonEditQueue(layer, skeletonSource);
  return { layer, state, getSkeleton };
}

function makeQueueInputCommand(
  required: readonly SpatialSkeletonQueueInputRequirement[],
  loadable: readonly SpatialSkeletonQueueInputRequirement[] = [],
): SpatialSkeletonEditCommand {
  return {
    action: SpatialSkeletonActions.moveNodes,
    label: "Test edit",
    payload: Object.freeze({}),
    getQueueInputRequirements: () => ({ required, loadable }),
  };
}

describe("skeleton edit commands", () => {
  beforeEach(() => {
    // Keep presentation-turn tests deterministic. Production still uses a
    // real animation frame followed by a task so the admitted state paints.
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(
      (callback) => {
        setTimeout(() => callback(performance.now()), 0);
        return 1;
      },
    );
  });

  afterEach(() => {
    resetGlobalSpatialSkeletonEditRequestLockForTesting();
    vi.restoreAllMocks();
  });

  it.each([
    [
      "the source's factory cannot create commands",
      (source: ReturnType<typeof makeEditableSkeletonSource>) => ({
        editableSource: {
          ...source,
          moveNodesCommand: { action: SpatialSkeletonActions.moveNodes },
        },
      }),
    ],
    [
      "the source has no factory for the action",
      (source: ReturnType<typeof makeEditableSkeletonSource>) => ({
        editableSource: { ...source, moveNodesCommand: undefined },
      }),
    ],
    [
      "the source is read-only",
      (source: ReturnType<typeof makeEditableSkeletonSource>) => ({
        fragmentSource: source,
      }),
    ],
    ["no skeleton source is loaded", () => undefined],
  ])(
    "refuses an edit the active source cannot perform when %s, without queuing it",
    (_name, makeSkeletonLayer) => {
      const source = makeEditableSkeletonSource();
      const createCommand = vi.spyOn(source.moveNodesCommand, "createCommand");
      const ensureEditQueue = vi.fn();
      const layer = {
        spatialSkeletonEditSession: {
          ...makeAvailableInputReferences(),
          ensureEditQueue,
        },
        getSpatiallyIndexedSkeletonLayer: () => makeSkeletonLayer(source),
      };

      expect(() => executeSpatialSkeletonMoveNode(layer as any, {})).toThrow(
        "The active skeleton source does not support node movement.",
      );
      expect(createCommand).not.toHaveBeenCalled();
      expect(ensureEditQueue).not.toHaveBeenCalled();
    },
  );

  it("shows the pending message until the edit is previewed, and still reports when it is saved", async () => {
    let finishPreview!: () => void;
    let finishSave!: (result: SpatialSkeletonEditSettlement) => void;
    const submitted = Object.assign(
      new Promise<void>((resolve) => {
        finishPreview = resolve;
      }),
      {
        acceptedByQueue: Promise.resolve(),
        settled: new Promise<SpatialSkeletonEditSettlement>((resolve) => {
          finishSave = resolve;
        }),
      },
    );
    const dispose = vi.fn();
    vi.spyOn(StatusMessage, "showMessage").mockReturnValue({
      dispose,
    } as unknown as StatusMessage);
    const source = makeEditableSkeletonSource({
      splitSkeletonsCommand: {
        action: SpatialSkeletonActions.splitSkeletons,
        createCommand: () => ({
          action: SpatialSkeletonActions.splitSkeletons,
          label: "Split skeleton",
          payload: {},
          getQueueInputRequirements: () => ({ required: [] }),
        }),
      },
    });
    const layer = {
      spatialSkeletonEditSession: {
        ...makeAvailableInputReferences(),
        ensureEditQueue: vi.fn(),
        executeEdit: () => submitted,
      },
      getSpatiallyIndexedSkeletonLayer: () => ({ editableSource: source }),
    };

    const execution = executeSpatialSkeletonSplit(layer as any, {});
    const settled = vi.fn();
    void execution.settled.then(settled);
    await execution.acceptedByQueue;
    expect(dispose).not.toHaveBeenCalled();
    expect(execution.settled).toBe(submitted.settled);

    finishPreview();
    await execution;
    expect(dispose).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();

    const result = committedSpatialSkeletonEditSettlement();
    finishSave(result);
    await expect(execution.settled).resolves.toEqual(result);
  });

  it("every edit action submits one edit, and Add, Delete, Split and Merge show a pending message while it is previewed", async () => {
    const showMessage = vi.spyOn(StatusMessage, "showMessage").mockReturnValue({
      dispose: vi.fn(),
    } as unknown as StatusMessage);
    const makeCommandFactory = (action: string) => ({
      action,
      createCommand: vi.fn(() => ({
        action,
        label: action,
        payload: Object.freeze({}),
        getQueueInputRequirements: () => ({ required: [] }),
      })),
    });
    const source = makeEditableSkeletonSource({
      addNodesCommand: makeCommandFactory(SpatialSkeletonActions.addNodes),
      moveNodesCommand: makeCommandFactory(SpatialSkeletonActions.moveNodes),
      deleteNodesCommand: makeCommandFactory(
        SpatialSkeletonActions.deleteNodes,
      ),
      rerootCommand: makeCommandFactory(SpatialSkeletonActions.reroot),
      editNodeDescriptionCommand: makeCommandFactory(
        SpatialSkeletonActions.editNodeDescription,
      ),
      editNodeTrueEndCommand: makeCommandFactory(
        SpatialSkeletonActions.editNodeTrueEnd,
      ),
      editNodeRadiusCommand: makeCommandFactory(
        SpatialSkeletonActions.editNodeRadius,
      ),
      editNodeConfidenceCommand: makeCommandFactory(
        SpatialSkeletonActions.editNodeConfidence,
      ),
      mergeSkeletonsCommand: makeCommandFactory(
        SpatialSkeletonActions.mergeSkeletons,
      ),
      splitSkeletonsCommand: makeCommandFactory(
        SpatialSkeletonActions.splitSkeletons,
      ),
    });
    const executeEdit = vi.fn(() => makeResolvedExecution());
    const layer = {
      spatialSkeletonEditSession: {
        ...makeAvailableInputReferences(),
        commandHistory: new SpatialSkeletonUndoHistory(),
        ensureEditQueue: vi.fn(() => ({})),
        executeEdit,
      },
      getSpatiallyIndexedSkeletonLayer: () => ({ editableSource: source }),
    };
    const node: SkeletonNode = {
      nodeId: 17n,
      segmentId: 23n,
      position: new Float32Array([1, 2, 3]),
    };
    const firstNode = { nodeId: 17n, segmentId: 23n };
    const secondNode = { nodeId: 29n, segmentId: 31n };
    const cases = [
      {
        commandFactory: source.addNodesCommand,
        execute: () =>
          executeSpatialSkeletonAddNode(layer as any, {
            skeletonId: 23n,
            positionInModelSpace: new Float32Array([4, 5, 6]),
          }),
        pendingMessage: "Creating node...",
      },
      {
        commandFactory: source.moveNodesCommand,
        execute: () =>
          executeSpatialSkeletonMoveNode(layer as any, {
            node,
            nextPositionInModelSpace: new Float32Array([7, 8, 9]),
          }),
      },
      {
        commandFactory: source.deleteNodesCommand,
        execute: () => executeSpatialSkeletonDeleteNode(layer as any, node),
        pendingMessage: "Deleting node...",
      },
      {
        commandFactory: source.editNodeDescriptionCommand,
        execute: () =>
          executeSpatialSkeletonNodeDescriptionUpdate(layer as any, {
            node,
            nextDescription: "next",
          }),
      },
      {
        commandFactory: source.editNodeTrueEndCommand,
        execute: () =>
          executeSpatialSkeletonNodeTrueEndUpdate(layer as any, {
            node,
            nextIsTrueEnd: true,
          }),
      },
      {
        commandFactory: source.editNodeRadiusCommand,
        execute: () =>
          executeSpatialSkeletonNodeRadiusUpdate(layer as any, {
            node,
            nextRadius: 42,
          }),
      },
      {
        commandFactory: source.editNodeConfidenceCommand,
        execute: () =>
          executeSpatialSkeletonNodeConfidenceUpdate(layer as any, {
            node,
            nextConfidence: 5,
          }),
      },
      {
        commandFactory: source.rerootCommand,
        execute: () =>
          executeSpatialSkeletonReroot(layer as any, {
            ...node,
            parentNodeId: 11n,
          }),
      },
      {
        commandFactory: source.splitSkeletonsCommand,
        execute: () => executeSpatialSkeletonSplit(layer as any, node),
        pendingMessage: "Splitting skeleton...",
      },
      {
        commandFactory: source.mergeSkeletonsCommand,
        execute: () =>
          executeSpatialSkeletonMerge(layer as any, firstNode, secondNode),
        pendingMessage: "Merging skeletons...",
      },
    ];

    for (const testCase of cases) {
      const dispose = vi.fn();
      showMessage.mockReturnValue({ dispose } as unknown as StatusMessage);
      showMessage.mockClear();

      await testCase.execute();

      expect(testCase.commandFactory.createCommand).toHaveBeenCalledTimes(1);
      expect(executeEdit).toHaveBeenCalledTimes(1);
      executeEdit.mockClear();
      if (testCase.pendingMessage === undefined) {
        expect(showMessage).not.toHaveBeenCalled();
      } else {
        expect(showMessage).toHaveBeenCalledWith(testCase.pendingMessage);
        expect(dispose).toHaveBeenCalledTimes(1);
      }
    }
  });

  it("an inserted node appears at once and keeps its saved ID through Undo and Redo", async () => {
    suppressStatusMessages();
    let resolveInsert!: (result: { nodeId: bigint; segmentId: bigint }) => void;
    const heldInsert = new Promise<{ nodeId: bigint; segmentId: bigint }>(
      (resolve) => {
        resolveInsert = resolve;
      },
    );
    const insertNode = vi
      .fn()
      .mockReturnValueOnce(heldInsert)
      .mockResolvedValueOnce({ nodeId: 4n, segmentId: 23n });
    const deleteNode = vi.fn().mockResolvedValue({});
    const parent = {
      nodeId: 1n,
      segmentId: 23n,
      position: new Float32Array([0, 0, 0]),
    };
    const child = {
      nodeId: 2n,
      segmentId: 23n,
      parentNodeId: 1n,
      position: new Float32Array([2, 4, 6]),
    };
    const { layer, spatialSkeletonEditSession: state } = makeAddNodeTestLayer({
      insertNode,
      deleteNode,
      initialNodes: [parent, child],
      segmentId: 23n,
    });
    const execution = executeSpatialSkeletonInsertNode(layer as any, {
      skeletonId: 23n,
      parentNodeId: 1n,
      childNodeIds: [2n],
      positionInModelSpace: [1, 2, 3],
    });
    await execution;
    const preview = state
      .getCachedSegmentNodes(23n)!
      .find((node) => node.nodeId !== 1n && node.nodeId !== 2n)!;
    expect(preview).toMatchObject({ parentNodeId: 1n, position: [1, 2, 3] });
    expect(state.getCachedNode(2n)?.parentNodeId).toBe(preview.nodeId);
    expect(state.spatialSkeletonDisplay.value.provisionalNodeIds).toContain(
      preview.nodeId,
    );
    resolveInsert({ nodeId: 3n, segmentId: 23n });
    await execution.settled;
    expect(state.getCachedNode(3n)?.parentNodeId).toBe(1n);
    expect(state.getCachedNode(2n)?.parentNodeId).toBe(3n);

    const undo = undoSpatialSkeletonCommand(layer as any);
    await undo;
    await undo.settled;
    expect(state.getCachedNode(3n)).toBeUndefined();
    expect(state.getCachedNode(2n)?.parentNodeId).toBe(1n);
    expect(deleteNode).toHaveBeenCalledWith(3n);

    const redo = redoSpatialSkeletonCommand(layer as any);
    await redo;
    await redo.settled;
    expect(state.getCachedNode(4n)?.parentNodeId).toBe(1n);
    expect(state.getCachedNode(2n)?.parentNodeId).toBe(4n);
    expect(insertNode).toHaveBeenCalledTimes(2);
    expect(insertNode).toHaveBeenLastCalledWith(1, 2, 3, 1n, [2n]);
  });

  it("refuses an insertion, without sending it, when the chosen child is no longer attached to the parent", async () => {
    suppressStatusMessages();
    const insertNode = vi.fn();
    const { layer, spatialSkeletonEditSession: state } = makeAddNodeTestLayer({
      insertNode,
      segmentId: 23n,
      initialNodes: [
        { nodeId: 1n, segmentId: 23n, position: [0, 0, 0] },
        { nodeId: 2n, segmentId: 23n, parentNodeId: 1n, position: [1, 1, 1] },
        { nodeId: 3n, segmentId: 23n, parentNodeId: 2n, position: [2, 2, 2] },
      ],
    });
    const execution = executeSpatialSkeletonInsertNode(layer as any, {
      skeletonId: 23n,
      parentNodeId: 1n,
      childNodeIds: [3n],
      positionInModelSpace: [1, 1, 1],
    });
    await expect(execution).rejects.toThrow("Node 3 is not a child of node 1.");
    expect(insertNode).not.toHaveBeenCalled();
    expect(state.getCachedNode(3n)?.parentNodeId).toBe(2n);
  });

  it.each([
    {
      kind: "add",
      commandLabel: "Add node",
      initialNodes: [
        { nodeId: 1n, segmentId: 23n, position: new Float32Array([4, 5, 6]) },
      ],
      edit: (layer: unknown) =>
        executeSpatialSkeletonAddNode(layer as any, {
          skeletonId: 23n,
          parentNodeId: 1n,
          positionInModelSpace: new Float32Array([10, 11, 12]),
        }),
      expectPreviewed: (state: SpatialSkeletonEditSession) => {
        expect(state.spatialSkeletonDisplay.value.provisionalNodeIds).toEqual([
          2n ** 63n + 1n,
          2n ** 63n + 2n,
        ]);
      },
      expectRestored: (state: SpatialSkeletonEditSession) => {
        expect(state.spatialSkeletonDisplay.value.provisionalNodeIds).toEqual([
          2n ** 63n + 1n,
        ]);
      },
    },
    {
      kind: "move",
      commandLabel: "Move node",
      initialNodes: [
        { nodeId: 1n, segmentId: 23n, position: new Float32Array([4, 5, 6]) },
      ],
      edit: (layer: unknown, state: SpatialSkeletonEditSession) =>
        executeSpatialSkeletonMoveNode(layer as any, {
          node: state.getCachedNode(1n)!,
          nextPositionInModelSpace: new Float32Array([10, 11, 12]),
        }),
      expectPreviewed: (state: SpatialSkeletonEditSession) => {
        expect(Array.from(state.getCachedNode(1n)!.position)).toEqual([
          10, 11, 12,
        ]);
      },
      expectRestored: (state: SpatialSkeletonEditSession) => {
        expect(Array.from(state.getCachedNode(1n)!.position)).toEqual([
          4, 5, 6,
        ]);
      },
    },
    {
      kind: "delete",
      commandLabel: "Delete node",
      initialNodes: [
        { nodeId: 1n, segmentId: 23n, position: new Float32Array([1, 2, 3]) },
        {
          nodeId: 2n,
          segmentId: 23n,
          parentNodeId: 1n,
          position: new Float32Array([4, 5, 6]),
        },
        {
          nodeId: 3n,
          segmentId: 23n,
          parentNodeId: 2n,
          position: new Float32Array([7, 8, 9]),
        },
      ],
      edit: (layer: unknown, state: SpatialSkeletonEditSession) =>
        executeSpatialSkeletonDeleteNode(
          layer as any,
          state.getCachedNode(2n)!,
        ),
      expectPreviewed: (state: SpatialSkeletonEditSession) => {
        expect(state.getCachedNode(2n)).toBeUndefined();
        expect(state.getCachedNode(3n)?.parentNodeId).toBe(1n);
      },
      expectRestored: (state: SpatialSkeletonEditSession) => {
        expect(state.getCachedNode(2n)?.parentNodeId).toBe(1n);
        expect(state.getCachedNode(3n)?.parentNodeId).toBe(2n);
      },
    },
  ])(
    "Undo of an unsent $kind removes its preview without sending either",
    async ({
      commandLabel,
      initialNodes,
      edit,
      expectPreviewed,
      expectRestored,
    }) => {
      suppressStatusMessages();
      const showTemporaryMessage = vi.mocked(
        StatusMessage.showTemporaryMessage,
      );
      const heldAdd = Promise.withResolvers<{
        nodeId: bigint;
        segmentId: bigint;
      }>();
      const {
        client,
        layer,
        spatialSkeletonEditSession: state,
      } = makeAddNodeTestLayer({
        addNode: vi.fn(() => heldAdd.promise),
        initialNodes,
        segmentId: 23n,
      });

      await executeSpatialSkeletonAddNode(layer as any, {
        skeletonId: 23n,
        parentNodeId: 1n,
        positionInModelSpace: new Float32Array([7, 8, 9]),
      });
      await waitForMicrotasks();
      await edit(layer, state);
      await waitForMicrotasks();

      expect(countSentRequests(client)).toBe(1);
      expectPreviewed(state);

      await undoSpatialSkeletonCommand(layer as any);

      expect(countSentRequests(client)).toBe(1);
      expectRestored(state);
      expect(showTemporaryMessage).not.toHaveBeenCalled();
      expect(state.getEditQueueRecentActivity()).toEqual([
        expect.objectContaining({
          commandLabel,
          intent: "undo",
          status: "reverted",
        }),
        expect.objectContaining({
          commandLabel,
          intent: "execute",
          status: "reverted",
        }),
      ]);

      heldAdd.resolve({ nodeId: 40n, segmentId: 23n });
      await waitForMicrotasks(20);
      expect(state.spatialSkeletonDisplay.value.provisionalNodeIds).toEqual([]);
    },
  );

  it("Redo of an Add that was undone before it was sent saves it after the earlier save", async () => {
    suppressStatusMessages();

    const segmentId = 23n;
    const parentNode: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([4, 5, 6]),
    };
    let resolveBlockingAdd: ((value: any) => void) | undefined;
    const blockingAdd = new Promise<any>((resolve) => {
      resolveBlockingAdd = resolve;
    });
    const addNode = vi
      .fn()
      .mockReturnValueOnce(blockingAdd)
      .mockResolvedValueOnce({
        nodeId: 3n,
        segmentId,
      });
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      addNode,
      initialNodes: [parentNode],
      segmentId,
    });

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: segmentId,
      parentNodeId: parentNode.nodeId,
      positionInModelSpace: new Float32Array([7, 8, 9]),
    });
    await waitForMicrotasks();
    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: segmentId,
      parentNodeId: parentNode.nodeId,
      positionInModelSpace: new Float32Array([10, 11, 12]),
    });

    await undoSpatialSkeletonCommand(layer as any);
    expect(spatialSkeletonEditSession.commandHistory.canRedo.value).toBe(true);
    expect(addNode).toHaveBeenCalledTimes(1);

    await expect(redoSpatialSkeletonCommand(layer as any)).resolves.toBe(true);
    expect(spatialSkeletonEditSession.commandHistory.canRedo.value).toBe(false);
    expect(
      spatialSkeletonEditSession
        .getEditQueueRows()
        .some((entry) => entry.kind === "addNode" && entry.intent === "redo"),
    ).toBe(true);
    expect(addNode).toHaveBeenCalledTimes(1);

    resolveBlockingAdd!({
      nodeId: 2n,
      segmentId,
    });
    await waitForMicrotasks(40);

    expect(addNode).toHaveBeenCalledTimes(2);
    expect(spatialSkeletonEditSession.getCachedNode(3n)).toMatchObject({
      parentNodeId: parentNode.nodeId,
      position: new Float32Array([10, 11, 12]),
    });
  });

  it("sends an Add against its parent even after the parent's skeleton leaves the cache", async () => {
    suppressStatusMessages();

    const segmentId = 23n;
    const parentNode: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([4, 5, 6]),
    };
    let resolveAdd!: (value: { nodeId: bigint; segmentId: bigint }) => void;
    const addNode = vi.fn(
      () =>
        new Promise<any>((resolve) => {
          resolveAdd = resolve;
        }),
    );
    const getSkeleton = vi.fn(async () => [cloneNode(parentNode)]);
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      addNode,
      getSkeleton,
      initialNodes: [parentNode],
      segmentId,
    });

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: segmentId,
      parentNodeId: parentNode.nodeId,
      positionInModelSpace: new Float32Array([7, 8, 9]),
    });
    await waitForMicrotasks();
    replaceCachedSegmentForTest(
      spatialSkeletonEditSession,
      segmentId,
      undefined,
    );

    expect(addNode).toHaveBeenCalledTimes(1);
    const addCall = addNode.mock.calls[0] as unknown[] | undefined;
    expect(addCall?.[0]).toBe(7);
    expect(addCall?.[3]).toBe(parentNode.nodeId);
    expect(getSkeleton).not.toHaveBeenCalled();

    resolveAdd({
      nodeId: 2n,
      segmentId,
    });
    await waitForMicrotasks(20);
  });

  it("when the server rejects an Add, its pending Undo is dropped and neither can be redone", async () => {
    suppressStatusMessages();

    const segmentId = 23n;
    const parentNode: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([4, 5, 6]),
    };
    let rejectFirstAdd: ((error: Error) => void) | undefined;
    const firstAdd = new Promise<any>((_resolve, reject) => {
      rejectFirstAdd = reject;
    });
    const addNode = vi
      .fn()
      .mockReturnValueOnce(firstAdd)
      .mockResolvedValueOnce({
        nodeId: 3n,
        segmentId,
      });
    const deleteNode = vi.fn();
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      addNode,
      deleteNode,
      initialNodes: [parentNode],
      segmentId,
    });

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: segmentId,
      parentNodeId: parentNode.nodeId,
      positionInModelSpace: new Float32Array([7, 8, 9]),
    });
    await waitForMicrotasks();
    await expect(undoSpatialSkeletonCommand(layer as any)).resolves.toBe(true);

    rejectFirstAdd!(
      new HttpError(
        "https://catmaid.example.test/1/node/create",
        409,
        "Conflict",
      ),
    );
    await waitForMicrotasks(20);

    expect(deleteNode).not.toHaveBeenCalled();
    expect(spatialSkeletonEditSession.commandHistory.canUndo.value).toBe(false);
    expect(spatialSkeletonEditSession.commandHistory.canRedo.value).toBe(false);
    await expect(redoSpatialSkeletonCommand(layer as any)).resolves.toBe(false);
    const unavailableUndo = undoSpatialSkeletonCommand(layer as any);
    await expect(unavailableUndo).resolves.toBe(false);
    await expect(unavailableUndo.settled).resolves.toEqual({
      outcome: "unchanged",
      reason: "no-op",
    });
    expect(addNode).toHaveBeenCalledTimes(1);
    expect(spatialSkeletonEditSession.getCachedNode(3n)).toBeUndefined();
  });

  it.each(["split", "delete"] as const)(
    "saves %s, its Undo and its Redo in order when the user undoes and redoes before the first save finishes",
    async (kind) => {
      suppressStatusMessages();
      const nodes = [
        { nodeId: 101n, segmentId: 11n, position: new Float32Array([1, 2, 3]) },
        {
          nodeId: 102n,
          segmentId: 11n,
          parentNodeId: 101n,
          position: new Float32Array([4, 5, 6]),
        },
      ];
      const firstSave = Promise.withResolvers<unknown>();
      const splitSkeleton = vi
        .fn()
        .mockReturnValueOnce(firstSave.promise)
        .mockResolvedValue({ existingSegmentId: 11n, newSegmentId: 23n });
      const deleteNode = vi
        .fn()
        .mockReturnValueOnce(firstSave.promise)
        .mockResolvedValue(undefined);
      const mergeSkeletons = vi
        .fn()
        .mockResolvedValueOnce({
          resultSegmentId: 11n,
          deletedSegmentId: 17n,
          directionAdjusted: false,
        })
        .mockResolvedValue({
          resultSegmentId: 11n,
          deletedSegmentId: 23n,
          directionAdjusted: false,
        });
      const addNode = vi
        .fn()
        .mockResolvedValue({ nodeId: 202n, segmentId: 11n });
      const { layer, spatialSkeletonEditSession: state } = makeAddNodeTestLayer(
        {
          initialNodes: nodes,
          segmentId: 11n,
          splitSkeleton,
          deleteNode,
          mergeSkeletons,
          addNode,
        },
      );
      const original =
        kind === "split"
          ? executeSpatialSkeletonSplit(layer as any, nodes[1])
          : executeSpatialSkeletonDeleteNode(layer as any, nodes[1]);
      await original;
      const undo = undoSpatialSkeletonCommand(layer as any);
      await expect(undo).resolves.toBe(true);
      const redo = redoSpatialSkeletonCommand(layer as any);
      await expect(redo).resolves.toBe(true);
      expect(mergeSkeletons).not.toHaveBeenCalled();
      expect(addNode).not.toHaveBeenCalled();

      firstSave.resolve(
        kind === "split"
          ? { existingSegmentId: 11n, newSegmentId: 17n }
          : undefined,
      );
      const settlements = await Promise.all([
        original.settled,
        undo.settled,
        redo.settled,
      ]);
      expect(settlements.map(({ outcome }) => outcome)).toEqual([
        "committed",
        "committed",
        "committed",
      ]);
      expect(state.getReloadRequired()).toBeUndefined();
      expect(state.commandHistory.canUndo.value).toBe(true);
      expect(state.commandHistory.canRedo.value).toBe(false);
      if (kind === "split") {
        expect(splitSkeleton.mock.calls).toEqual([[102n], [102n]]);
        expect(mergeSkeletons).toHaveBeenCalledWith(101n, 102n);
        expect(state.getCachedNode(102n)).toMatchObject({
          segmentId: 23n,
          parentNodeId: undefined,
        });
        expect(state.getCachedSegmentNodes(17n)).toBeUndefined();
      } else {
        expect(deleteNode.mock.calls).toEqual([[102n], [202n]]);
        expect(addNode).toHaveBeenCalledWith(4, 5, 6, 101n);
        expect(
          state.getCachedSegmentNodes(11n)?.map(({ nodeId }) => nodeId),
        ).toEqual([101n]);
      }
      expect(
        state.getEditQueueRecentActivity().map(({ status }) => status),
      ).toEqual(["saved", "saved", "saved"]);

      const nextUndo = undoSpatialSkeletonCommand(layer as any);
      await nextUndo;
      expect((await nextUndo.settled).outcome).toBe("committed");
      expect(state.getCachedNode(kind === "split" ? 102n : 202n)).toMatchObject(
        {
          segmentId: 11n,
          parentNodeId: 101n,
        },
      );
      expect(state.commandHistory.canRedo.value).toBe(true);
    },
  );

  it.each([false, true])(
    "keeps the latest Add preview while earlier Add and Undo save (new root: %s)",
    async (newRoot) => {
      suppressStatusMessages();
      const parent = {
        nodeId: 101n,
        segmentId: 11n,
        position: new Float32Array([1, 2, 3]),
      };
      const firstAdd = Promise.withResolvers<{
        nodeId: bigint;
        segmentId: bigint;
      }>();
      const firstDelete = Promise.withResolvers<void>();
      const addNode = vi
        .fn()
        .mockReturnValueOnce(firstAdd.promise)
        .mockResolvedValue({ nodeId: 202n, segmentId: newRoot ? 23n : 11n });
      const deleteNode = vi
        .fn()
        .mockReturnValueOnce(firstDelete.promise)
        .mockResolvedValue(undefined);
      const {
        layer,
        spatialSkeletonEditSession: state,
        group,
        selection,
      } = makeAddNodeTestLayer({
        initialNodes: [parent],
        segmentId: 11n,
        addNode,
        deleteNode,
      });
      const add = executeSpatialSkeletonAddNode(layer as any, {
        skeletonId: newRoot ? 0n : 11n,
        parentNodeId: newRoot ? undefined : 101n,
        positionInModelSpace: new Float32Array([4, 5, 6]),
      });
      await add;
      const undo = undoSpatialSkeletonCommand(layer as any);
      await undo;
      const redo = redoSpatialSkeletonCommand(layer as any);
      await redo;
      const previewNodeId = 2n ** 63n + 3n;
      const preview = state.getCachedNode(previewNodeId)!;
      expect(preview).toBeDefined();

      firstAdd.resolve({ nodeId: 201n, segmentId: newRoot ? 17n : 11n });
      expect((await add.settled).outcome).toBe("committed");
      await waitForMicrotasks();
      expect(deleteNode).toHaveBeenCalledWith(201n);
      expect(addNode).toHaveBeenCalledTimes(1);
      expect(state.getCachedNode(201n)).toBeUndefined();
      expect(state.getCachedNode(previewNodeId)).toMatchObject({
        segmentId: preview.segmentId,
        position: preview.position,
      });
      expect(group.visibleSegments.has(preview.segmentId)).toBe(true);
      expect(selection.selected.value).toMatchObject({
        nodeId: previewNodeId,
        segmentId: preview.segmentId,
      });
      if (newRoot) expect(state.getCachedSegmentNodes(17n)).toBeUndefined();

      firstDelete.resolve();
      expect((await undo.settled).outcome).toBe("committed");
      expect((await redo.settled).outcome).toBe("committed");
      expect(state.getCachedNode(previewNodeId)).toBeUndefined();
      expect(state.getCachedNode(202n)).toMatchObject({
        segmentId: newRoot ? 23n : 11n,
        parentNodeId: newRoot ? undefined : 101n,
        position: [4, 5, 6],
      });
      expect(state.getReloadRequired()).toBeUndefined();
      expect(state.spatialSkeletonDisplay.value.provisionalNodeIds).toEqual([]);
      expect(
        state.getEditQueueRecentActivity().map(({ status }) => status),
      ).toEqual(["saved", "saved", "saved"]);

      const nextUndo = undoSpatialSkeletonCommand(layer as any);
      await nextUndo;
      expect((await nextUndo.settled).outcome).toBe("committed");
      expect(deleteNode.mock.calls).toEqual([[201n], [202n]]);
      expect(state.getCachedNode(202n)).toBeUndefined();
      expect(state.commandHistory.canRedo.value).toBe(true);
    },
  );

  it("cancels queued undo and redo when the original add is rejected", async () => {
    suppressStatusMessages();

    const segmentId = 23n;
    const parentNode: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([4, 5, 6]),
    };
    let rejectFirstAdd: ((error: Error) => void) | undefined;
    const firstAdd = new Promise<any>((_resolve, reject) => {
      rejectFirstAdd = reject;
    });
    const addNode = vi
      .fn()
      .mockReturnValueOnce(firstAdd)
      .mockResolvedValueOnce({
        nodeId: 3n,
        segmentId,
      });
    const deleteNode = vi.fn();
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      addNode,
      deleteNode,
      initialNodes: [parentNode],
      segmentId,
    });

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: segmentId,
      parentNodeId: parentNode.nodeId,
      positionInModelSpace: new Float32Array([7, 8, 9]),
    });
    await waitForMicrotasks();
    await expect(undoSpatialSkeletonCommand(layer as any)).resolves.toBe(true);
    await expect(redoSpatialSkeletonCommand(layer as any)).resolves.toBe(true);

    rejectFirstAdd!(
      new HttpError(
        "https://catmaid.example.test/1/node/create",
        409,
        "Conflict",
      ),
    );
    await waitForMicrotasks(16);

    expect(deleteNode).not.toHaveBeenCalled();
    expect(addNode).toHaveBeenCalledTimes(1);
    expect(spatialSkeletonEditSession.getCachedNode(3n)).toBeUndefined();
    expect(spatialSkeletonEditSession.commandHistory.canUndo.value).toBe(false);
    expect(spatialSkeletonEditSession.commandHistory.canRedo.value).toBe(false);
  });

  it("redoing a chain of unsent Adds keeps each new node attached to the one added before it", async () => {
    suppressStatusMessages();

    const segmentId = 23n;
    const rootNode: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([1, 2, 3]),
    };
    let resolveBlockingAdd: ((value: any) => void) | undefined;
    const blockingAdd = new Promise<any>((resolve) => {
      resolveBlockingAdd = resolve;
    });
    const addNode = vi
      .fn()
      .mockReturnValueOnce(blockingAdd)
      .mockResolvedValueOnce({
        nodeId: 3n,
        segmentId,
      })
      .mockResolvedValueOnce({
        nodeId: 4n,
        segmentId,
      });
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      addNode,
      initialNodes: [rootNode],
      segmentId,
    });

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: segmentId,
      parentNodeId: rootNode.nodeId,
      positionInModelSpace: new Float32Array([4, 5, 6]),
    });
    await waitForMicrotasks();
    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: segmentId,
      parentNodeId: rootNode.nodeId,
      positionInModelSpace: new Float32Array([7, 8, 9]),
    });
    const firstParentPreview = spatialSkeletonEditSession
      .getCachedSegmentNodes(segmentId)
      ?.find((node) => node.position[0] === 7);
    expect(firstParentPreview).toBeDefined();
    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: segmentId,
      parentNodeId: firstParentPreview!.nodeId,
      positionInModelSpace: new Float32Array([10, 11, 12]),
    });

    await expect(undoSpatialSkeletonCommand(layer as any)).resolves.toBe(true);
    await expect(undoSpatialSkeletonCommand(layer as any)).resolves.toBe(true);
    const redoParent = redoSpatialSkeletonCommand(layer as any);
    await expect(redoParent).resolves.toBe(true);
    const redoChild = redoSpatialSkeletonCommand(layer as any);
    await expect(redoChild).resolves.toBe(true);

    const redoneParentPreview = spatialSkeletonEditSession
      .getCachedSegmentNodes(segmentId)
      ?.find((node) => node.position[0] === 7);
    const redoneChildPreview = spatialSkeletonEditSession
      .getCachedSegmentNodes(segmentId)
      ?.find((node) => node.position[0] === 10);
    expect(redoneParentPreview).toBeDefined();
    expect(redoneParentPreview?.nodeId).not.toBe(firstParentPreview?.nodeId);
    expect(redoneChildPreview).toMatchObject({
      parentNodeId: redoneParentPreview?.nodeId,
    });
    expect(addNode).toHaveBeenCalledTimes(1);

    resolveBlockingAdd!({
      nodeId: 2n,
      segmentId,
    });
    await redoChild.settled;

    expect(addNode).toHaveBeenCalledTimes(3);
    expect(spatialSkeletonEditSession.getCachedNode(3n)).toMatchObject({
      parentNodeId: rootNode.nodeId,
    });
    expect(spatialSkeletonEditSession.getCachedNode(4n)).toMatchObject({
      parentNodeId: 3n,
    });
  });

  it.each([
    {
      kind: "new node",
      initialNodes: [
        { nodeId: 1n, segmentId: 23n, position: new Float32Array([4, 5, 6]) },
      ],
      makeServer: (heldSave: Promise<unknown>) => ({
        addNode: vi.fn(() => heldSave),
        deleteNode: vi.fn().mockResolvedValue({}),
      }),
      edit: (layer: unknown) =>
        executeSpatialSkeletonAddNode(layer as any, {
          skeletonId: 23n,
          parentNodeId: 1n,
          positionInModelSpace: new Float32Array([7, 8, 9]),
        }),
      savedMethod: "addNode",
      savedResult: { nodeId: 2n, segmentId: 23n },
      expectRestored: (state: SpatialSkeletonEditSession) => {
        expect(
          state.getCachedSegmentNodes(23n)?.map(({ nodeId }) => nodeId),
        ).toEqual([1n]);
      },
      inverseCall: ["deleteNode", 2n],
      expectUndoSaved: (state: SpatialSkeletonEditSession) => {
        expect(state.getCachedNode(2n)).toBeUndefined();
      },
    },
    {
      kind: "move",
      initialNodes: [
        { nodeId: 1n, segmentId: 23n, position: new Float32Array([4, 5, 6]) },
      ],
      makeServer: (heldSave: Promise<unknown>) => ({
        moveNode: vi.fn().mockReturnValueOnce(heldSave).mockResolvedValue({}),
      }),
      edit: (layer: unknown, state: SpatialSkeletonEditSession) =>
        executeSpatialSkeletonMoveNode(layer as any, {
          node: state.getCachedNode(1n)!,
          nextPositionInModelSpace: new Float32Array([10, 11, 12]),
        }),
      savedMethod: "moveNode",
      savedResult: {},
      expectRestored: (state: SpatialSkeletonEditSession) => {
        expect(Array.from(state.getCachedNode(1n)!.position)).toEqual([
          4, 5, 6,
        ]);
      },
      inverseCall: ["moveNode", 1n, 4, 5, 6],
      expectUndoSaved: (state: SpatialSkeletonEditSession) => {
        expect(Array.from(state.getCachedNode(1n)!.position)).toEqual([
          4, 5, 6,
        ]);
      },
    },
    {
      kind: "split",
      initialNodes: [
        { nodeId: 1n, segmentId: 23n, position: new Float32Array([1, 2, 3]) },
        {
          nodeId: 2n,
          segmentId: 23n,
          parentNodeId: 1n,
          position: new Float32Array([4, 5, 6]),
        },
      ],
      makeServer: (heldSave: Promise<unknown>) => ({
        splitSkeleton: vi.fn(() => heldSave),
        mergeSkeletons: vi.fn().mockResolvedValue({
          resultSegmentId: 23n,
          deletedSegmentId: 31n,
          directionAdjusted: false,
        }),
      }),
      edit: (layer: unknown, state: SpatialSkeletonEditSession) =>
        executeSpatialSkeletonSplit(layer as any, state.getCachedNode(2n)!),
      savedMethod: "splitSkeleton",
      savedResult: { existingSegmentId: 23n, newSegmentId: 31n },
      expectRestored: (state: SpatialSkeletonEditSession) => {
        expect(state.getCachedNode(2n)).toMatchObject({
          segmentId: 23n,
          parentNodeId: 1n,
        });
      },
      inverseCall: ["mergeSkeletons", 1n, 2n],
      expectUndoSaved: (state: SpatialSkeletonEditSession) => {
        expect(state.getCachedNode(2n)).toMatchObject({
          segmentId: 23n,
          parentNodeId: 1n,
        });
      },
    },
    {
      kind: "merge",
      initialNodes: [
        {
          nodeId: 101n,
          segmentId: 11n,
          position: new Float32Array([1, 2, 3]),
        },
        {
          nodeId: 201n,
          segmentId: 17n,
          position: new Float32Array([4, 5, 6]),
        },
      ],
      makeServer: (heldSave: Promise<unknown>) => ({
        mergeSkeletons: vi.fn(() => heldSave),
        splitSkeleton: vi.fn().mockResolvedValue({
          existingSegmentId: 11n,
          newSegmentId: 19n,
        }),
      }),
      edit: (layer: unknown, state: SpatialSkeletonEditSession) =>
        executeSpatialSkeletonMerge(
          layer as any,
          state.getCachedNode(101n)!,
          state.getCachedNode(201n)!,
        ),
      savedMethod: "mergeSkeletons",
      savedResult: {
        resultSegmentId: 11n,
        deletedSegmentId: 17n,
        directionAdjusted: false,
      },
      expectRestored: (state: SpatialSkeletonEditSession) => {
        const restoredPreview = state.getCachedNode(201n)!;
        expect(restoredPreview.parentNodeId).toBeUndefined();
        expect(restoredPreview.segmentId).not.toBe(11n);
        expect(restoredPreview.segmentId).not.toBe(17n);
      },
      inverseCall: ["splitSkeleton", 201n],
      expectUndoSaved: (state: SpatialSkeletonEditSession) => {
        expect(state.getCachedNode(201n)).toMatchObject({
          segmentId: 19n,
          parentNodeId: undefined,
        });
      },
    },
  ])(
    "Undo of a $kind that is still saving sends its inverse after the save",
    async ({
      initialNodes,
      makeServer,
      edit,
      savedMethod,
      savedResult,
      expectRestored,
      inverseCall: [inverseMethod, ...inverseArguments],
      expectUndoSaved,
    }) => {
      suppressStatusMessages();
      const showTemporaryMessage = vi.mocked(
        StatusMessage.showTemporaryMessage,
      );
      const heldSave = Promise.withResolvers<unknown>();
      const {
        client,
        layer,
        spatialSkeletonEditSession: state,
      } = makeAddNodeTestLayer({
        ...makeServer(heldSave.promise),
        initialNodes,
        segmentId: initialNodes[0].segmentId,
        segmentIds: [
          ...new Set(initialNodes.map(({ segmentId }) => segmentId)),
        ],
      });
      const inverseRequest = (client as any)[inverseMethod as string];

      const execution = edit(layer, state);
      await execution;
      await vi.waitFor(() =>
        expect((client as any)[savedMethod]).toHaveBeenCalledTimes(1),
      );
      const undo = undoSpatialSkeletonCommand(layer as any);
      await undo;

      expectRestored(state);
      expect(inverseRequest).not.toHaveBeenCalledWith(...inverseArguments);

      heldSave.resolve(savedResult);
      await expect(execution.settled).resolves.toMatchObject({
        outcome: "committed",
      });
      await expect(undo.settled).resolves.toMatchObject({
        outcome: "committed",
      });

      expect(inverseRequest).toHaveBeenLastCalledWith(...inverseArguments);
      expectUndoSaved(state);
      expect(showTemporaryMessage).not.toHaveBeenCalled();
      expect(state.commandHistory.canUndo.value).toBe(false);
    },
  );

  it("after a source reset, a new edit previews at once but is not sent while an earlier Add is still saving, and a page reload is required if that Add saves", async () => {
    suppressStatusMessages();

    const segmentId = 23n;
    const parentNode: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([4, 5, 6]),
    };
    let resolveFirstAdd:
      | ((value: { nodeId: bigint; segmentId: bigint }) => void)
      | undefined;
    const firstAddPromise = new Promise<any>((resolve) => {
      resolveFirstAdd = resolve;
    });
    const addNode = vi
      .fn()
      .mockReturnValueOnce(firstAddPromise)
      .mockResolvedValueOnce({
        nodeId: 3n,
        segmentId,
      });
    const deleteNode = vi.fn();
    const { layer, skeletonLayer, spatialSkeletonEditSession } =
      makeAddNodeTestLayer({
        addNode,
        deleteNode,
        initialNodes: [parentNode],
        segmentId,
      });

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: segmentId,
      parentNodeId: parentNode.nodeId,
      positionInModelSpace: new Float32Array([7, 8, 9]),
    });
    await waitForMicrotasks();

    expect(addNode).toHaveBeenCalledTimes(1);
    const retiredTempNode = spatialSkeletonEditSession
      .getCachedSegmentNodes(segmentId)!
      .find((node) => node.nodeId >= 2n ** 63n);
    expect(retiredTempNode).toBeDefined();
    const retiredTempNodeId = retiredTempNode!.nodeId;

    const oldQueue = (spatialSkeletonEditSession as any).editQueue;
    expect(spatialSkeletonEditSession.clearRuntimeState()).toBe(true);
    expect(spatialSkeletonEditSession.hasUnconfirmedEdits()).toBe(false);
    const disposal = oldQueue.dispose();
    expect(
      spatialSkeletonEditSession.getCachedNode(retiredTempNodeId),
    ).toBeUndefined();
    seedCachedNodesForTest(spatialSkeletonEditSession, [parentNode]);
    const replacementCommands = makeCatmaidEditCommands(
      makeCatmaidClient({ addNode, deleteNode }),
    );
    Object.assign(skeletonLayer.editableSource, {
      addNodesCommand: replacementCommands.addNodesCommand,
      deleteNodesCommand: replacementCommands.deleteNodesCommand,
      moveNodesCommand: replacementCommands.moveNodesCommand,
      rerootCommand: replacementCommands.rerootCommand,
      editNodeDescriptionCommand:
        replacementCommands.editNodeDescriptionCommand,
      editNodeTrueEndCommand: replacementCommands.editNodeTrueEndCommand,
      editNodeRadiusCommand: replacementCommands.editNodeRadiusCommand,
      editNodeConfidenceCommand: replacementCommands.editNodeConfidenceCommand,
      mergeSkeletonsCommand: replacementCommands.mergeSkeletonsCommand,
      splitSkeletonsCommand: replacementCommands.splitSkeletonsCommand,
    });

    const replacement = executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: segmentId,
      parentNodeId: parentNode.nodeId,
      positionInModelSpace: new Float32Array([10, 11, 12]),
    });
    await replacement;
    await waitForMicrotasks(5);

    const replacementTempNodeId = spatialSkeletonEditSession
      .getCachedSegmentNodes(segmentId)!
      .find((node) => node.nodeId >= 2n ** 63n)!.nodeId;

    // The replacement queue publishes its local preview immediately, but its
    // POST cannot pass the disposed queue's still-active source lane.
    expect(addNode).toHaveBeenCalledTimes(1);
    expect(
      spatialSkeletonEditSession.getCachedNode(replacementTempNodeId),
    ).toMatchObject({
      parentNodeId: parentNode.nodeId,
      position: new Float32Array([10, 11, 12]),
    });

    resolveFirstAdd!({
      nodeId: 2n,
      segmentId,
    });
    await disposal;
    await waitForMicrotasks(12);

    expect(deleteNode).not.toHaveBeenCalled();
    expect(addNode).toHaveBeenCalledTimes(1);
    expectReloadRequired(spatialSkeletonEditSession, "committed");
    expect(spatialSkeletonEditSession.getCachedNode(2n)).toBeUndefined();
  });

  it("after a source reset, new edits are sent in order once the server rejects an edit from before the reset", async () => {
    suppressStatusMessages();

    const firstSegmentId = 23n;
    const secondSegmentId = 29n;
    const firstParent: SkeletonNode = {
      nodeId: 1n,
      segmentId: firstSegmentId,
      position: new Float32Array([1, 2, 3]),
    };
    const secondParent: SkeletonNode = {
      nodeId: 10n,
      segmentId: secondSegmentId,
      position: new Float32Array([4, 5, 6]),
    };
    let rejectOldAdd!: (reason: unknown) => void;
    const oldAdd = new Promise<any>((_resolve, reject) => {
      rejectOldAdd = reject;
    });
    const addNode = vi
      .fn()
      .mockReturnValueOnce(oldAdd)
      .mockResolvedValueOnce({
        nodeId: 3n,
        segmentId: firstSegmentId,
      })
      .mockResolvedValueOnce({
        nodeId: 30n,
        segmentId: secondSegmentId,
      });
    const deleteNode = vi.fn();
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      addNode,
      deleteNode,
      initialNodes: [firstParent, secondParent],
      segmentId: firstSegmentId,
      segmentIds: [firstSegmentId, secondSegmentId],
    });

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: firstSegmentId,
      parentNodeId: firstParent.nodeId,
      positionInModelSpace: new Float32Array([7, 8, 9]),
    });
    await waitForMicrotasks();
    expect(addNode).toHaveBeenCalledTimes(1);

    spatialSkeletonEditSession.clearRuntimeState();
    seedCachedNodesForTest(spatialSkeletonEditSession, [
      firstParent,
      secondParent,
    ]);

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: firstSegmentId,
      parentNodeId: firstParent.nodeId,
      positionInModelSpace: new Float32Array([10, 11, 12]),
    });
    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: secondSegmentId,
      parentNodeId: secondParent.nodeId,
      positionInModelSpace: new Float32Array([13, 14, 15]),
    });
    await waitForMicrotasks(8);

    // Both replacement intents already own exact local previews, but neither
    // may cross the CATMAID transport boundary while the detached source-wide
    // plan lease remains active.
    expect(addNode).toHaveBeenCalledTimes(1);
    expect(
      spatialSkeletonEditSession
        .getCachedSegmentNodes(firstSegmentId)
        ?.some((node) => node.parentNodeId === firstParent.nodeId),
    ).toBe(true);
    expect(
      spatialSkeletonEditSession
        .getCachedSegmentNodes(secondSegmentId)
        ?.some((node) => node.parentNodeId === secondParent.nodeId),
    ).toBe(true);

    rejectOldAdd(
      new HttpError(
        "https://catmaid.example.test/1/node/create",
        409,
        "Conflict",
      ),
    );
    await waitForMicrotasks(40);

    expect(deleteNode).not.toHaveBeenCalled();
    expect(addNode).toHaveBeenCalledTimes(3);
    expect(addNode.mock.calls[1]).toEqual([10, 11, 12, firstParent.nodeId]);
    expect(addNode.mock.calls[2]).toEqual([13, 14, 15, secondParent.nodeId]);
    expect(spatialSkeletonEditSession.getCachedNode(3n)).toMatchObject({
      segmentId: firstSegmentId,
      parentNodeId: firstParent.nodeId,
    });
    expect(spatialSkeletonEditSession.getCachedNode(30n)).toMatchObject({
      segmentId: secondSegmentId,
      parentNodeId: secondParent.nodeId,
    });
  });

  it("after a source reset, new edits are never sent and a page reload is required if the answer to an edit from before the reset is lost", async () => {
    suppressStatusMessages();
    const showErrorMessage = vi.mocked(StatusMessage.showErrorMessage);

    const segmentId = 23n;
    const node: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([1, 2, 3]),
    };
    let rejectOldMove!: (reason: unknown) => void;
    const oldMove = new Promise<never>((_resolve, reject) => {
      rejectOldMove = reject;
    });
    const moveNode = vi
      .fn()
      .mockReturnValueOnce(oldMove)
      .mockResolvedValueOnce({});
    const getSkeleton = vi.fn(async () => [
      { ...node, position: new Float32Array(node.position) },
    ]);
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      moveNode,
      getSkeleton,
      initialNodes: [node],
      segmentId,
    });

    await executeSpatialSkeletonMoveNode(layer as any, {
      node,
      nextPositionInModelSpace: new Float32Array([4, 5, 6]),
    });
    await waitForMicrotasks();
    spatialSkeletonEditSession.clearRuntimeState();
    seedCachedNodesForTest(spatialSkeletonEditSession, [node]);
    await executeSpatialSkeletonMoveNode(layer as any, {
      node,
      nextPositionInModelSpace: new Float32Array([7, 8, 9]),
    });
    await waitForMicrotasks(5);

    rejectOldMove(
      new HttpError(
        "https://catmaid.example.test/1/node/update",
        0,
        "Network or CORS error",
      ),
    );
    await waitForMicrotasks(20);

    expect(moveNode).toHaveBeenCalledTimes(1);
    expect(showErrorMessage).not.toHaveBeenCalled();
    expectReloadRequired(spatialSkeletonEditSession, "indeterminate");
    expect(getSkeleton).not.toHaveBeenCalled();
    spatialSkeletonEditSession.dispose();
  });

  it.each([
    {
      name: "a move",
      initialNodes: [
        { nodeId: 1n, segmentId: 23n, position: new Float32Array([1, 2, 3]) },
      ],
      makeServer: (lostRequest: Promise<never>) => ({
        moveNode: vi.fn(() => lostRequest),
      }),
      run: async (layer: unknown, state: SpatialSkeletonEditSession) => {
        await executeSpatialSkeletonMoveNode(layer as any, {
          node: state.getCachedNode(1n)!,
          nextPositionInModelSpace: new Float32Array([4, 5, 6]),
        });
      },
      lostEdit: { kind: "moveNode", intent: "execute" },
      expectRestored: (state: SpatialSkeletonEditSession) => {
        expect(Array.from(state.getCachedNode(1n)!.position)).toEqual([
          1, 2, 3,
        ]);
      },
    },
    {
      name: "a new skeleton's first node",
      initialNodes: [],
      makeServer: (lostRequest: Promise<never>) => ({
        addNode: vi.fn(() => lostRequest),
      }),
      run: async (layer: unknown) => {
        await executeSpatialSkeletonAddNode(layer as any, {
          skeletonId: 0n,
          parentNodeId: undefined,
          positionInModelSpace: new Float32Array([1, 2, 3]),
        });
      },
      lostEdit: { kind: "addNode", intent: "execute" },
    },
    {
      name: "a split",
      initialNodes: [
        { nodeId: 1n, segmentId: 23n, position: new Float32Array([1, 2, 3]) },
        {
          nodeId: 2n,
          segmentId: 23n,
          parentNodeId: 1n,
          position: new Float32Array([4, 5, 6]),
        },
      ],
      makeServer: (lostRequest: Promise<never>) => ({
        splitSkeleton: vi.fn(() => lostRequest),
      }),
      run: async (layer: unknown, state: SpatialSkeletonEditSession) => {
        await executeSpatialSkeletonSplit(
          layer as any,
          state.getCachedNode(2n)!,
        );
      },
      lostEdit: { kind: "splitSkeleton", intent: "execute" },
    },
    {
      name: "the Undo of a saved move",
      initialNodes: [
        { nodeId: 1n, segmentId: 23n, position: new Float32Array([4, 5, 6]) },
      ],
      makeServer: (lostRequest: Promise<never>) => ({
        moveNode: vi
          .fn()
          .mockResolvedValueOnce({})
          .mockReturnValueOnce(lostRequest),
      }),
      run: async (layer: unknown, state: SpatialSkeletonEditSession) => {
        await executeSpatialSkeletonMoveNode(layer as any, {
          node: state.getCachedNode(1n)!,
          nextPositionInModelSpace: new Float32Array([10, 11, 12]),
        });
        await waitForMicrotasks(8);
        await undoSpatialSkeletonCommand(layer as any);
      },
      lostEdit: { kind: "moveNode", intent: "undo" },
    },
  ])(
    "requires a page reload and sends nothing more when the server's answer to $name is lost",
    async ({ initialNodes, makeServer, run, lostEdit, expectRestored }) => {
      suppressStatusMessages();
      const showErrorMessage = vi.mocked(StatusMessage.showErrorMessage);
      const lostRequest = Promise.withResolvers<never>();
      const getSkeleton = vi.fn();
      const {
        client,
        layer,
        spatialSkeletonEditSession: state,
      } = makeAddNodeTestLayer({
        ...makeServer(lostRequest.promise),
        getSkeleton,
        initialNodes,
        segmentId: 23n,
      });

      await run(layer, state);
      await waitForMicrotasks(8);
      const sentBeforeLoss = countSentRequests(client);
      lostRequest.reject(
        new HttpError(
          "https://catmaid.example.test/1/node/update",
          0,
          "Network or CORS error",
        ),
      );
      await waitForMicrotasks(20);

      expectReloadRequired(state, "indeterminate");
      expect(showErrorMessage).not.toHaveBeenCalled();
      expect(getSkeleton).not.toHaveBeenCalled();
      expect(state.getEditQueueRows()).toContainEqual(
        expect.objectContaining({
          ...lostEdit,
          lifecycle: expect.objectContaining({ authority: "indeterminate" }),
        }),
      );
      expectRestored?.(state);
      expect(() =>
        executeSpatialSkeletonAddNode(layer as any, {
          skeletonId: 0n,
          parentNodeId: undefined,
          positionInModelSpace: new Float32Array([7, 8, 9]),
        }),
      ).toThrow(SpatialSkeletonReloadRequiredError);
      expect(countSentRequests(client)).toBe(sentBeforeLoss);
      state.dispose();
    },
  );

  it("warns after 30 seconds that the server has not answered, but keeps the edit and its preview", async () => {
    vi.useFakeTimers();
    let detachAuthorityNotifications: (() => void) | undefined;
    try {
      suppressStatusMessages();
      const showErrorMessage = vi.mocked(StatusMessage.showErrorMessage);

      const segmentId = 23n;
      const parentNode: SkeletonNode = {
        nodeId: 1n,
        segmentId,
        position: new Float32Array([4, 5, 6]),
      };
      let resolveAdd:
        | ((value: { nodeId: bigint; segmentId: bigint }) => void)
        | undefined;
      const addPromise = new Promise<any>((resolve) => {
        resolveAdd = resolve;
      });
      const addNode = vi.fn(() => addPromise);
      const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
        addNode,
        initialNodes: [parentNode],
        segmentId,
      });
      detachAuthorityNotifications = attachAuthorityNotifications(layer);

      await executeSpatialSkeletonAddNode(layer as any, {
        skeletonId: segmentId,
        parentNodeId: parentNode.nodeId,
        positionInModelSpace: new Float32Array([7, 8, 9]),
      });
      await waitForMicrotasks();

      const requestOptions = (
        addNode.mock.calls[0] as unknown[] | undefined
      )?.[6] as { signal?: AbortSignal } | undefined;
      expect(requestOptions?.signal).toBeUndefined();
      expect(spatialSkeletonEditSession.hasUnconfirmedEdits()).toBe(true);

      vi.advanceTimersByTime(30_000);

      expect(showErrorMessage).toHaveBeenCalledWith(
        "CATMAID has not confirmed the optimistic skeleton edit yet. The server edit request lane is stalled, but you may continue previewing independent edits while the request remains in order.",
      );
      expect(spatialSkeletonEditSession.hasUnconfirmedEdits()).toBe(true);
      expect(
        spatialSkeletonEditSession.getCachedSegmentNodes(segmentId),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ nodeId: 2n ** 63n + 1n }),
        ]),
      );

      resolveAdd!({
        nodeId: 2n,
        segmentId,
      });
      await waitForMicrotasks(5);
    } finally {
      detachAuthorityNotifications?.();
      vi.useRealTimers();
    }
  });

  it("removes a chain of three added nodes when the server rejects the first Add", async () => {
    suppressStatusMessages();
    const showErrorMessage = vi.mocked(StatusMessage.showErrorMessage);

    const segmentId = 23n;
    const parentNode: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([4, 5, 6]),
    };
    let rejectFirstAdd: ((error: Error) => void) | undefined;
    const firstAddPromise = new Promise<any>((_resolve, reject) => {
      rejectFirstAdd = reject;
    });
    const addNode = vi.fn(() => firstAddPromise);
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      addNode,
      initialNodes: [parentNode],
      segmentId,
    });

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: segmentId,
      parentNodeId: parentNode.nodeId,
      positionInModelSpace: new Float32Array([7, 8, 9]),
    });
    await waitForMicrotasks();

    const previewParent = spatialSkeletonEditSession
      .getCachedSegmentNodes(segmentId)!
      .find((node) => node.nodeId >= 2n ** 63n);
    expect(previewParent).toBeDefined();

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: segmentId,
      parentNodeId: previewParent!.nodeId,
      positionInModelSpace: new Float32Array([10, 11, 12]),
    });
    await waitForMicrotasks();

    const previewChild = spatialSkeletonEditSession
      .getCachedSegmentNodes(segmentId)!
      .find((node) => node.parentNodeId === previewParent!.nodeId);
    expect(previewChild).toBeDefined();

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: segmentId,
      parentNodeId: previewChild!.nodeId,
      positionInModelSpace: new Float32Array([13, 14, 15]),
    });
    await waitForMicrotasks();

    expect(addNode).toHaveBeenCalledTimes(1);
    expect(
      spatialSkeletonEditSession
        .getCachedSegmentNodes(segmentId)!
        .filter((node) => node.nodeId >= 2n ** 63n),
    ).toHaveLength(3);

    rejectFirstAdd!(new Error("server rejected"));
    await waitForMicrotasks(5);

    expect(showErrorMessage).not.toHaveBeenCalled();
    expectReloadRequired(spatialSkeletonEditSession, "indeterminate");
    expect(addNode).toHaveBeenCalledTimes(1);
    expect(
      spatialSkeletonEditSession
        .getCachedSegmentNodes(segmentId)!
        .some((node) => node.nodeId >= 2n ** 63n),
    ).toBe(false);
  });

  it.each([
    {
      dependent: "move",
      prerequisite: "add",
      initialNodes: [
        { nodeId: 1n, segmentId: 23n, position: new Float32Array([4, 5, 6]) },
      ],
      makeServer: (rejectedRequest: Promise<never>) => ({
        addNode: vi.fn(() => rejectedRequest),
      }),
      runPrerequisite: async (
        layer: unknown,
        state: SpatialSkeletonEditSession,
      ) => {
        await executeSpatialSkeletonAddNode(layer as any, {
          skeletonId: 23n,
          parentNodeId: 1n,
          positionInModelSpace: new Float32Array([7, 8, 9]),
        });
        return state
          .getCachedSegmentNodes(23n)!
          .find((node) => node.nodeId >= 2n ** 63n)!;
      },
      runDependent: (layer: unknown, node: SkeletonNode) =>
        executeSpatialSkeletonMoveNode(layer as any, {
          node,
          nextPositionInModelSpace: new Float32Array([10, 11, 12]),
        }),
      expectRolledBack: (state: SpatialSkeletonEditSession) => {
        expect(
          state.getCachedSegmentNodes(23n)!.map(({ nodeId }) => nodeId),
        ).toEqual([1n]);
      },
    },
    {
      dependent: "delete",
      prerequisite: "add",
      initialNodes: [
        { nodeId: 1n, segmentId: 23n, position: new Float32Array([4, 5, 6]) },
      ],
      makeServer: (rejectedRequest: Promise<never>) => ({
        addNode: vi.fn(() => rejectedRequest),
      }),
      runPrerequisite: async (
        layer: unknown,
        state: SpatialSkeletonEditSession,
      ) => {
        await executeSpatialSkeletonAddNode(layer as any, {
          skeletonId: 23n,
          parentNodeId: 1n,
          positionInModelSpace: new Float32Array([7, 8, 9]),
        });
        return state
          .getCachedSegmentNodes(23n)!
          .find((node) => node.nodeId >= 2n ** 63n)!;
      },
      runDependent: (layer: unknown, node: SkeletonNode) =>
        executeSpatialSkeletonDeleteNode(layer as any, node),
      expectRolledBack: (state: SpatialSkeletonEditSession) => {
        expect(
          state.getCachedSegmentNodes(23n)!.map(({ nodeId }) => nodeId),
        ).toEqual([1n]);
      },
    },
    {
      dependent: "move",
      prerequisite: "split",
      initialNodes: [
        { nodeId: 1n, segmentId: 23n, position: new Float32Array([1, 2, 3]) },
        {
          nodeId: 2n,
          segmentId: 23n,
          parentNodeId: 1n,
          position: new Float32Array([4, 5, 6]),
        },
      ],
      makeServer: (rejectedRequest: Promise<never>) => ({
        splitSkeleton: vi.fn(() => rejectedRequest),
      }),
      runPrerequisite: async (
        layer: unknown,
        state: SpatialSkeletonEditSession,
      ) => {
        await executeSpatialSkeletonSplit(
          layer as any,
          state.getCachedNode(2n)!,
        );
        return state.getCachedNode(2n)!;
      },
      runDependent: (layer: unknown, node: SkeletonNode) =>
        executeSpatialSkeletonMoveNode(layer as any, {
          node,
          nextPositionInModelSpace: new Float32Array([40, 50, 60]),
        }),
      expectRolledBack: (state: SpatialSkeletonEditSession) => {
        expect(state.getCachedNode(2n)).toMatchObject({
          segmentId: 23n,
          parentNodeId: 1n,
        });
        expect(Array.from(state.getCachedNode(2n)!.position)).toEqual([
          4, 5, 6,
        ]);
      },
    },
  ])(
    "removes an unsent $dependent that depends on an unsaved $prerequisite when the server rejects that edit",
    async ({
      initialNodes,
      makeServer,
      runPrerequisite,
      runDependent,
      expectRolledBack,
    }) => {
      suppressStatusMessages();
      const rejectedRequest = Promise.withResolvers<never>();
      const {
        client,
        layer,
        spatialSkeletonEditSession: state,
      } = makeAddNodeTestLayer({
        ...makeServer(rejectedRequest.promise),
        initialNodes,
        segmentId: 23n,
      });

      const prerequisiteNode = await runPrerequisite(layer, state);
      await waitForMicrotasks();
      await runDependent(layer, prerequisiteNode);
      await waitForMicrotasks();
      expect(countSentRequests(client)).toBe(1);

      rejectedRequest.reject(new Error("server rejected"));
      await waitForMicrotasks(10);

      expect(countSentRequests(client)).toBe(1);
      expectRolledBack(state);
    },
  );

  it.each(["ends", "  \n\t", ""])(
    "shows no description when the server stores %j as empty, and Undo and Redo restore it",
    async (input) => {
      suppressStatusMessages();
      const node = {
        nodeId: 1n,
        segmentId: 23n,
        position: [1, 2, 3],
        description: "before",
      };
      const updateDescription = vi.fn(async (_id, description: string) => ({
        description: description === "before" ? description : undefined,
      }));
      const { layer, spatialSkeletonEditSession: state } = makeAddNodeTestLayer(
        {
          initialNodes: [node],
          segmentId: 23n,
          updateDescription,
        },
      );
      await executeSpatialSkeletonNodeDescriptionUpdate(layer as any, {
        node,
        nextDescription: input,
      }).settled;
      expect(state.getCachedNode(1n)!.description).toBeUndefined();
      await undoSpatialSkeletonCommand(layer as any).settled;
      expect(state.getCachedNode(1n)!.description).toBe("before");
      await redoSpatialSkeletonCommand(layer as any).settled;
      expect(state.getCachedNode(1n)!.description).toBeUndefined();
      expect(updateDescription.mock.calls.map((call) => call[1])).toEqual([
        input,
        "before",
        "",
      ]);
    },
  );

  it("a saved description stays undoable when a later move is rejected and the edits after it are canceled", async () => {
    suppressStatusMessages();
    const segmentId = 23n;
    const node: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([1, 2, 3]),
      description: "unreviewed",
    };
    const updateDescription = vi.fn(async (_nodeId, description: string) => ({
      description,
    }));
    let rejectMove!: (reason: unknown) => void;
    const moveNode = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<never>((_resolve, reject) => {
            rejectMove = reject;
          }),
      )
      .mockResolvedValue({});
    const addNode = vi.fn();
    const { layer, spatialSkeletonEditSession: state } = makeAddNodeTestLayer({
      updateDescription,
      moveNode,
      addNode,
      initialNodes: [node],
      segmentId,
    });
    const description = executeSpatialSkeletonNodeDescriptionUpdate(
      layer as any,
      {
        node,
        nextDescription: "checked",
      },
    );
    await description.settled;
    const move = executeSpatialSkeletonMoveNode(layer as any, {
      node: state.getCachedNode(1n)!,
      nextPositionInModelSpace: new Float32Array([4, 5, 6]),
    });
    await move;
    const child = executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: segmentId,
      parentNodeId: 1n,
      positionInModelSpace: new Float32Array([7, 8, 9]),
    });
    await child;
    expect(state.getCachedSegmentNodes(segmentId)).toHaveLength(2);
    await waitForMicrotasks();
    rejectMove(
      new HttpError(
        "https://catmaid.example.test/1/node/update",
        409,
        "Conflict",
      ),
    );
    await Promise.all([move.settled, child.settled]);
    expect(state.getCachedSegmentNodes(segmentId)).toHaveLength(1);
    expect(Array.from(state.getCachedNode(1n)!.position)).toEqual([1, 2, 3]);
    expect(state.getCachedNode(1n)!.description).toBe("checked");
    expect(addNode).not.toHaveBeenCalled();
    expect(
      state.getEditQueueRecentActivity().map(({ status }) => status),
    ).toEqual(["not-saved", "not-saved", "saved"]);
    expect(state.hasUnconfirmedEdits()).toBe(false);
    expect(state.commandHistory.canUndo.value).toBe(true);
    expect(state.commandHistory.canRedo.value).toBe(false);

    await undoSpatialSkeletonCommand(layer as any).settled;
    expect(state.getCachedNode(1n)!.description).toBe("unreviewed");
    expect(updateDescription).toHaveBeenLastCalledWith(1n, "unreviewed", {
      isTrueEnd: false,
    });
    await executeSpatialSkeletonMoveNode(layer as any, {
      node: state.getCachedNode(1n)!,
      nextPositionInModelSpace: new Float32Array([10, 11, 12]),
    }).settled;
    expect(Array.from(state.getCachedNode(1n)!.position)).toEqual([10, 11, 12]);
    expect(moveNode).toHaveBeenCalledTimes(2);
  });

  it("recent activity lists a rejected edit and every later edit it canceled", async () => {
    suppressStatusMessages();
    const showErrorMessage = vi.mocked(StatusMessage.showErrorMessage);
    const segmentId = 23n;
    const node: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([1, 2, 3]),
    };
    let rejectFirstMove!: (reason: unknown) => void;
    const moveNode = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectFirstMove = reject;
        }),
    );
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      moveNode,
      initialNodes: [node],
      segmentId,
    });
    const detachAuthorityNotifications = attachAuthorityNotifications(layer);

    await executeSpatialSkeletonMoveNode(layer as any, {
      node,
      nextPositionInModelSpace: new Float32Array([4, 5, 6]),
    });
    const previewedNode = spatialSkeletonEditSession.getCachedNode(
      node.nodeId,
    )!;
    await executeSpatialSkeletonMoveNode(layer as any, {
      node: previewedNode,
      nextPositionInModelSpace: new Float32Array([7, 8, 9]),
    });
    await waitForMicrotasks();

    rejectFirstMove(
      new HttpError(
        "https://catmaid.example.test/1/node/update",
        409,
        "Conflict",
      ),
    );
    await waitForMicrotasks(20);

    expect(moveNode).toHaveBeenCalledTimes(1);
    expect(spatialSkeletonEditSession.getEditQueueRecentActivity()).toEqual([
      expect.objectContaining({
        commandLabel: "Move node",
        status: "not-saved",
        reason: "Canceled because an earlier edit was not saved.",
        authorityReason: "not-started",
      }),
      expect.objectContaining({
        commandLabel: "Move node",
        status: "not-saved",
        reason: "Request failed with HTTP 409 (Conflict).",
        canceledLaterIntentCount: 1,
      }),
    ]);
    expect(showErrorMessage).toHaveBeenCalledWith(
      "CATMAID rejected node movement. The optimistic preview was removed. Request failed with HTTP 409 (Conflict). 1 later queued edit was also canceled.",
    );
    expect(spatialSkeletonEditSession.hasUnconfirmedEdits()).toBe(false);
    expect(spatialSkeletonEditSession.commandHistory.canUndo.value).toBe(false);
    expect(spatialSkeletonEditSession.commandHistory.canRedo.value).toBe(false);
    detachAuthorityNotifications();
  });

  it("restores the node and shows the provider's instructions when a queued move is rejected", async () => {
    suppressStatusMessages();
    const segmentId = 23n;
    const node: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([1, 2, 3]),
    };
    let rejectMove!: (error: unknown) => void;
    const moveNode = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectMove = reject;
        }),
    );
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      moveNode,
      initialNodes: [node],
      segmentId,
    });
    const detach = attachAuthorityNotifications(layer);
    const error = new HttpError(
      "https://catmaid.example.test/1/node/update",
      409,
      "Conflict",
    );
    const instructions =
      "This skeleton is linked to a task. Relink the task before editing.";
    error.message += ` ${instructions}`;
    try {
      const execution = executeSpatialSkeletonMoveNode(layer as any, {
        node,
        nextPositionInModelSpace: new Float32Array([4, 5, 6]),
      });
      await execution;
      await waitForMicrotasks();
      expect(
        Array.from(spatialSkeletonEditSession.getCachedNode(1n)!.position),
      ).toEqual([4, 5, 6]);
      rejectMove(error);
      await execution.settled;
      await waitForMicrotasks(10);
      expect(
        Array.from(spatialSkeletonEditSession.getCachedNode(1n)!.position),
      ).toEqual([1, 2, 3]);
      expect(spatialSkeletonEditSession.commandHistory.canUndo.value).toBe(
        false,
      );
      expect(spatialSkeletonEditSession.hasUnconfirmedEdits()).toBe(false);
      expect(StatusMessage.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining(instructions),
      );
    } finally {
      detach();
    }
  });

  it("a dragged node keeps its drag position when its saved ID arrives and when its queued move is rejected", async () => {
    suppressStatusMessages();

    const segmentId = 23n;
    const realNodeId = 20n;
    const parentNode: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([4, 5, 6]),
    };
    let resolveAdd: ((result: any) => void) | undefined;
    const addNode = vi.fn(
      () =>
        new Promise<any>((resolve) => {
          resolveAdd = resolve;
        }),
    );
    let rejectMove: ((error: Error) => void) | undefined;
    const moveNode = vi.fn(
      () =>
        new Promise<any>((_resolve, reject) => {
          rejectMove = reject;
        }),
    );
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      addNode,
      moveNode,
      initialNodes: [parentNode],
      segmentId,
    });

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: segmentId,
      parentNodeId: parentNode.nodeId,
      positionInModelSpace: new Float32Array([7, 8, 9]),
    });
    const previewNode = spatialSkeletonEditSession
      .getCachedSegmentNodes(segmentId)!
      .find((node) => node.nodeId >= 2n ** 63n)!;
    spatialSkeletonEditSession.setPendingNodePosition(
      previewNode.nodeId,
      [8, 8, 8],
    );

    await executeSpatialSkeletonMoveNode(layer as any, {
      node: previewNode,
      nextPositionInModelSpace: new Float32Array([10, 11, 12]),
    });
    expect(
      Array.from(
        spatialSkeletonEditSession.getCachedNode(previewNode.nodeId)!.position,
      ),
    ).toEqual([10, 11, 12]);
    expect(
      Array.from(
        spatialSkeletonEditSession.getPendingNodePosition(previewNode.nodeId)!,
      ),
    ).toEqual([8, 8, 8]);
    expect(moveNode).not.toHaveBeenCalled();

    resolveAdd?.({
      nodeId: realNodeId,
      segmentId,
    });
    await waitForMicrotasks(12);

    expect(
      spatialSkeletonEditSession.getPendingNodePosition(previewNode.nodeId),
    ).toBeUndefined();
    expect(
      Array.from(
        spatialSkeletonEditSession.getPendingNodePosition(realNodeId)!,
      ),
    ).toEqual([8, 8, 8]);
    expect(
      Array.from(
        spatialSkeletonEditSession.getCachedNode(realNodeId)!.position,
      ),
    ).toEqual([10, 11, 12]);
    expect(moveNode).toHaveBeenCalledWith(realNodeId, 10, 11, 12);

    rejectMove?.(
      new HttpError(
        "https://catmaid.example.test/1/node/update",
        409,
        "Conflict",
      ),
    );
    await waitForMicrotasks(12);
    expect(
      Array.from(
        spatialSkeletonEditSession.getPendingNodePosition(realNodeId)!,
      ),
    ).toEqual([8, 8, 8]);
    expect(
      Array.from(
        spatialSkeletonEditSession.getCachedNode(realNodeId)!.position,
      ),
    ).toEqual([7, 8, 9]);
    expect(spatialSkeletonEditSession.clearPendingNodePositions()).toBe(true);
    expect(
      spatialSkeletonEditSession.getPendingNodePosition(realNodeId),
    ).toBeUndefined();
  });

  it.each([
    {
      kind: "add",
      edit: (layer: unknown) =>
        executeSpatialSkeletonAddNode(layer as any, {
          skeletonId: 23n,
          parentNodeId: 1n,
          positionInModelSpace: new Float32Array([7, 8, 9]),
        }),
      expectSaved: (state: SpatialSkeletonEditSession) => {
        expect(state.getCachedNode(20n)).toMatchObject({
          segmentId: 23n,
          parentNodeId: 1n,
        });
      },
      expectUndoShown: (state: SpatialSkeletonEditSession) => {
        expect(state.getCachedNode(20n)).toBeUndefined();
      },
      inverseCall: ["deleteNode", 20n],
      expectUndoSaved: (state: SpatialSkeletonEditSession) => {
        expect(state.getCachedNode(20n)).toBeUndefined();
      },
    },
    {
      kind: "move",
      edit: (layer: unknown, state: SpatialSkeletonEditSession) =>
        executeSpatialSkeletonMoveNode(layer as any, {
          node: state.getCachedNode(2n)!,
          nextPositionInModelSpace: new Float32Array([10, 11, 12]),
        }),
      expectSaved: (state: SpatialSkeletonEditSession) => {
        expect(Array.from(state.getCachedNode(2n)!.position)).toEqual([
          10, 11, 12,
        ]);
      },
      expectUndoShown: (state: SpatialSkeletonEditSession) => {
        expect(Array.from(state.getCachedNode(2n)!.position)).toEqual([
          4, 5, 6,
        ]);
      },
      inverseCall: ["moveNode", 2n, 4, 5, 6],
      expectUndoSaved: (state: SpatialSkeletonEditSession) => {
        expect(Array.from(state.getCachedNode(2n)!.position)).toEqual([
          4, 5, 6,
        ]);
      },
    },
    {
      kind: "delete",
      edit: (layer: unknown, state: SpatialSkeletonEditSession) =>
        executeSpatialSkeletonDeleteNode(
          layer as any,
          state.getCachedNode(2n)!,
        ),
      expectSaved: (state: SpatialSkeletonEditSession) => {
        expect(state.getCachedNode(2n)).toBeUndefined();
      },
      expectUndoShown: (state: SpatialSkeletonEditSession) => {
        expect(state.spatialSkeletonDisplay.value.provisionalNodeIds).toEqual([
          2n ** 63n + 2n,
        ]);
        expect(state.getCachedNode(2n ** 63n + 2n)?.parentNodeId).toBe(1n);
      },
      inverseCall: ["addNode", 4, 5, 6, 1n],
      expectUndoSaved: (state: SpatialSkeletonEditSession) => {
        expect(state.getCachedNode(20n)).toMatchObject({
          segmentId: 23n,
          parentNodeId: 1n,
        });
      },
    },
  ])(
    "records a saved $kind in undo history, and Undo sends its inverse",
    async ({
      edit,
      expectSaved,
      expectUndoShown,
      inverseCall: [inverseMethod, ...inverseArguments],
      expectUndoSaved,
    }) => {
      suppressStatusMessages();
      const showTemporaryMessage = vi.mocked(
        StatusMessage.showTemporaryMessage,
      );
      const {
        client,
        layer,
        spatialSkeletonEditSession: state,
      } = makeAddNodeTestLayer({
        addNode: vi.fn().mockResolvedValue({ nodeId: 20n, segmentId: 23n }),
        deleteNode: vi.fn().mockResolvedValue({}),
        moveNode: vi.fn().mockResolvedValue({}),
        initialNodes: [
          { nodeId: 1n, segmentId: 23n, position: new Float32Array([1, 2, 3]) },
          {
            nodeId: 2n,
            segmentId: 23n,
            parentNodeId: 1n,
            position: new Float32Array([4, 5, 6]),
          },
        ],
        segmentId: 23n,
      });

      await edit(layer, state);
      await waitForMicrotasks(5);

      expectSaved(state);
      expect(state.getEditQueueRows()).toEqual([
        expect.objectContaining({
          lifecycle: expect.objectContaining({
            authority: "committed",
            reconciliation: "complete",
            history: "advanced",
          }),
        }),
      ]);
      expect(state.commandHistory.canUndo.value).toBe(true);
      expect(showTemporaryMessage).not.toHaveBeenCalled();

      const undo = undoSpatialSkeletonCommand(layer as any);
      await undo;
      expectUndoShown(state);
      await undo.settled;

      expect((client as any)[inverseMethod as string]).toHaveBeenLastCalledWith(
        ...inverseArguments,
      );
      expectUndoSaved(state);
    },
  );

  it("a new skeleton's first node appears at once and takes its saved node and skeleton IDs", async () => {
    suppressStatusMessages();
    const showTemporaryMessage = vi.mocked(StatusMessage.showTemporaryMessage);

    const segmentId = 23n;
    let resolveAdd: ((value: any) => void) | undefined;
    const addNode = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveAdd = resolve;
      }),
    );
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      addNode,
      initialNodes: [],
      segmentId,
    });

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: 0n,
      parentNodeId: undefined,
      positionInModelSpace: new Float32Array([7, 8, 9]),
    });
    await waitForMicrotasks();

    const pendingEntry = spatialSkeletonEditSession.getEditQueueRows()[0];
    expect(pendingEntry).toMatchObject({
      kind: "addNode",
    });
    const previewRoot = spatialSkeletonEditSession.getCachedNode(
      2n ** 63n + 1n,
    )!;
    expect(previewRoot).toMatchObject({
      parentNodeId: undefined,
    });
    expect(previewRoot.segmentId).toBeGreaterThan(0);

    resolveAdd!({
      nodeId: 2n,
      segmentId,
    });
    await waitForMicrotasks(20);

    expect(addNode).toHaveBeenCalledTimes(1);
    expect((addNode.mock.calls[0] as unknown[])[4]).toBeUndefined();
    expect(spatialSkeletonEditSession.getEditQueueRows()).toEqual([
      expect.objectContaining({
        kind: "addNode",
        lifecycle: expect.objectContaining({ authority: "committed" }),
      }),
    ]);
    expect(spatialSkeletonEditSession.commandHistory.canUndo.value).toBe(true);
    expect(spatialSkeletonEditSession.getCachedNode(2n)).toMatchObject({
      nodeId: 2n,
      segmentId,
      parentNodeId: undefined,
    });
    expect(showTemporaryMessage).not.toHaveBeenCalled();
  });

  it("a new skeleton keeps the visibility and selection the user gave it while it was saving", async () => {
    suppressStatusMessages();

    const realSegmentId = 23n;
    const realNodeId = 2n;
    let resolveAdd: ((value: any) => void) | undefined;
    const addNode = vi.fn(
      () =>
        new Promise<any>((resolve) => {
          resolveAdd = resolve;
        }),
    );
    const { layer, spatialSkeletonEditSession, group, selection } =
      makeAddNodeTestLayer({
        addNode,
        initialNodes: [],
        segmentId: realSegmentId,
        segmentIds: [],
      });

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: 0n,
      parentNodeId: undefined,
      positionInModelSpace: new Float32Array([7, 8, 9]),
    });
    const previewRoot = spatialSkeletonEditSession.getCachedNode(
      2n ** 63n + 1n,
    )!;
    const tempSegment = previewRoot.segmentId;
    const realSegment = realSegmentId;

    // Simulate changes made while CATMAID is still creating the skeleton: the
    // user hides the preview but keeps temporary and selected membership.
    group.visibleSegments.delete(tempSegment);
    group.temporaryVisibleSegments.add(tempSegment);
    group.selectedSegments.add(tempSegment);

    resolveAdd?.({
      nodeId: realNodeId,
      segmentId: realSegmentId,
    });
    await waitForMicrotasks(20);

    expect(group.visibleSegments.has(tempSegment)).toBe(false);
    expect(group.temporaryVisibleSegments.has(tempSegment)).toBe(false);
    expect(group.selectedSegments.has(tempSegment)).toBe(false);
    expect(group.visibleSegments.has(realSegment)).toBe(false);
    expect(group.temporaryVisibleSegments.has(realSegment)).toBe(true);
    expect(group.selectedSegments.has(realSegment)).toBe(true);
    expect(selection.selected.value).toMatchObject({
      nodeId: realNodeId,
      segmentId: realSegmentId,
    });
  });

  it("when the server rejects a child Add after its new skeleton has saved, the child and the split that depends on it are removed", async () => {
    suppressStatusMessages();
    const showErrorMessage = vi.mocked(StatusMessage.showErrorMessage);
    const realSegmentId = 23n;
    const realRootNodeId = 101n;
    let resolveRootAdd: ((value: any) => void) | undefined;
    let rejectChildAdd: ((error: Error) => void) | undefined;
    const addNode = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<any>((resolve) => {
            resolveRootAdd = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<any>((_resolve, reject) => {
            rejectChildAdd = reject;
          }),
      );
    const splitSkeleton = vi.fn();
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      addNode,
      splitSkeleton,
      initialNodes: [],
      segmentId: realSegmentId,
    });

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: 0n,
      parentNodeId: undefined,
      positionInModelSpace: new Float32Array([1, 2, 3]),
    });
    const previewRoot = spatialSkeletonEditSession.getCachedNode(
      2n ** 63n + 1n,
    )!;
    const tempRootNodeId = previewRoot.nodeId;
    const tempRootSegmentId = previewRoot.segmentId;

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: tempRootSegmentId,
      parentNodeId: tempRootNodeId,
      positionInModelSpace: new Float32Array([4, 5, 6]),
    });
    const tempChild = spatialSkeletonEditSession
      .getCachedSegmentNodes(tempRootSegmentId)!
      .find((node) => node.nodeId !== tempRootNodeId)!;

    await executeSpatialSkeletonSplit(layer as any, tempChild);
    const tempSplitSegmentId = spatialSkeletonEditSession.getCachedNode(
      tempChild.nodeId,
    )!.segmentId;

    expect(addNode).toHaveBeenCalledTimes(1);
    expect(splitSkeleton).not.toHaveBeenCalled();
    expect(
      spatialSkeletonEditSession.getCachedNode(tempChild.nodeId),
    ).toMatchObject({
      segmentId: tempSplitSegmentId,
      parentNodeId: undefined,
    });

    resolveRootAdd?.({
      nodeId: realRootNodeId,
      segmentId: realSegmentId,
    });
    await waitForMicrotasks(30);

    // Root reconciliation must update both the live dependent entries and
    // the split's historical snapshot before the child POST is allowed out.
    expect(addNode).toHaveBeenCalledTimes(2);
    expect(splitSkeleton).not.toHaveBeenCalled();
    expect(
      spatialSkeletonEditSession.getCachedNode(realRootNodeId),
    ).toMatchObject({
      segmentId: realSegmentId,
      parentNodeId: undefined,
    });
    expect(
      spatialSkeletonEditSession.getCachedSegmentNodes(tempRootSegmentId),
    ).toBeUndefined();

    rejectChildAdd?.(new Error("child add rejected"));
    await waitForMicrotasks(40);

    expect(splitSkeleton).not.toHaveBeenCalled();
    expect(spatialSkeletonEditSession.getEditQueueRows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "addNode",
          lifecycle: expect.objectContaining({
            authority: "indeterminate",
            reconciliation: "blocked",
            history: "staged",
          }),
        }),
      ]),
    );
    expect(
      spatialSkeletonEditSession
        .getCachedSegmentNodes(realSegmentId)
        ?.map((node) => node.nodeId),
    ).toEqual([realRootNodeId]);
    expect(
      spatialSkeletonEditSession.getCachedSegmentNodes(tempRootSegmentId),
    ).toBeUndefined();
    expect(
      spatialSkeletonEditSession.getCachedSegmentNodes(tempSplitSegmentId),
    ).toBeUndefined();
    expect(showErrorMessage).not.toHaveBeenCalled();
    expectReloadRequired(spatialSkeletonEditSession, "indeterminate");
    expect(
      showErrorMessage.mock.calls.some(([message]) =>
        /rollback.*failed|failed.*rollback|trusted.*handle/i.test(message),
      ),
    ).toBe(false);
  });

  it.each([
    ["new root", false],
    ["new root", true],
    ["split", false],
    ["split", true],
  ] as const)(
    "a pending Merge still joins the whole skeleton when the %s it depends on saves (server kept the other skeleton: %s)",
    async (kind, directionAdjusted) => {
      suppressStatusMessages();
      const nodes: SkeletonNode[] = [
        { nodeId: 101n, segmentId: 11n, position: new Float32Array([1, 2, 3]) },
        {
          nodeId: 102n,
          segmentId: 11n,
          parentNodeId: 101n,
          position: new Float32Array([4, 5, 6]),
        },
        { nodeId: 201n, segmentId: 17n, position: new Float32Array([7, 8, 9]) },
      ];
      const inputResult =
        kind === "new root"
          ? { nodeId: 301n, segmentId: 23n }
          : { existingSegmentId: 11n, newSegmentId: 23n };
      let resolveInput!: (value: typeof inputResult) => void;
      const saveInput = vi.fn(
        () =>
          new Promise((resolve) => {
            resolveInput = resolve;
          }),
      );
      let resolveMerge!: (value: {
        resultSegmentId: bigint;
        deletedSegmentId: bigint;
        directionAdjusted: boolean;
      }) => void;
      const mergeSkeletons = vi.fn(
        () =>
          new Promise((resolve) => {
            resolveMerge = resolve;
          }),
      );
      const moveNode = vi.fn().mockResolvedValue(undefined);
      const {
        layer,
        spatialSkeletonEditSession: state,
        group,
        selection,
      } = makeAddNodeTestLayer({
        initialNodes: nodes,
        segmentId: 11n,
        segmentIds: [11n, 17n],
        addNode: saveInput,
        splitSkeleton: saveInput,
        mergeSkeletons,
        moveNode,
      });
      const input =
        kind === "new root"
          ? executeSpatialSkeletonAddNode(layer as any, {
              skeletonId: 0n,
              positionInModelSpace: new Float32Array([10, 11, 12]),
            })
          : executeSpatialSkeletonSplit(layer as any, nodes[1]);
      await input;
      const inputNode = state.getCachedNode(
        kind === "new root" ? 2n ** 63n + 1n : 102n,
      )!;
      const merge = executeSpatialSkeletonMerge(
        layer as any,
        inputNode,
        nodes[2],
      );
      await merge;
      const previewId = state.getCachedNode(201n)!.segmentId;
      const expectCompletePreview = (nodeId: bigint) => {
        expect(previewId).not.toBe(inputNode.segmentId);
        expect(cachedTopologyForTest(state, [previewId])).toEqual(
          [
            [nodeId, previewId, null],
            [201n, previewId, nodeId],
          ].sort((a, b) => bigintCompare(a[0]!, b[0]!)),
        );
        expect(
          state.spatialSkeletonDisplay.value.numericAliases,
        ).toContainEqual(
          expect.objectContaining({
            segmentId: previewId,
            authoritative: false,
          }),
        );
        expect(new Set(group.visibleSegments)).toEqual(
          new Set([11n, previewId]),
        );
        expect(selection.selected.value?.segmentId).toBe(previewId);
      };
      expectCompletePreview(inputNode.nodeId);
      expect(mergeSkeletons).not.toHaveBeenCalled();

      resolveInput(inputResult);
      await expect(input.settled).resolves.toMatchObject({
        outcome: "committed",
      });
      await vi.waitFor(() => expect(mergeSkeletons).toHaveBeenCalledTimes(1));
      const savedNodeId = kind === "new root" ? 301n : 102n;
      expect(mergeSkeletons).toHaveBeenCalledWith(savedNodeId, 201n);
      expectCompletePreview(savedNodeId);

      const position = new Float32Array([15, 16, 17]);
      const move = executeSpatialSkeletonMoveNode(layer as any, {
        node: state.getCachedNode(savedNodeId)!,
        nextPositionInModelSpace: position,
      });
      await move;
      expect(moveNode).not.toHaveBeenCalled();
      const resultSegmentId = directionAdjusted ? 17n : 23n;
      resolveMerge({
        resultSegmentId,
        deletedSegmentId: directionAdjusted ? 23n : 17n,
        directionAdjusted,
      });
      await expect(merge.settled).resolves.toMatchObject({
        outcome: "committed",
      });
      await expect(move.settled).resolves.toMatchObject({
        outcome: "committed",
      });
      expect(state.getCachedNode(savedNodeId)).toMatchObject({
        segmentId: resultSegmentId,
        parentNodeId: directionAdjusted ? 201n : undefined,
        position,
      });
      expect(state.getCachedNode(201n)).toMatchObject({
        segmentId: resultSegmentId,
        parentNodeId: directionAdjusted ? undefined : savedNodeId,
      });
      expect(state.getCachedSegmentNodes(previewId)).toBeUndefined();
      expect(new Set(group.visibleSegments)).toEqual(
        new Set([11n, resultSegmentId]),
      );
      expect(state.getReloadRequired()).toBeUndefined();
    },
  );

  it("a rejected Merge onto a newly saved skeleton restores both skeletons and their roots", async () => {
    suppressStatusMessages();
    const showErrorMessage = vi.mocked(StatusMessage.showErrorMessage);
    const existingSegmentId = 17n;
    const realRootSegmentId = 23n;
    const realRootNodeId = 101n;
    const existingRoot: SkeletonNode = {
      nodeId: 201n,
      segmentId: existingSegmentId,
      position: new Float32Array([7, 8, 9]),
    };
    let resolveRootAdd: ((value: any) => void) | undefined;
    const addNode = vi.fn(
      () =>
        new Promise<any>((resolve) => {
          resolveRootAdd = resolve;
        }),
    );
    let rejectMerge: ((error: Error) => void) | undefined;
    const mergeSkeletons = vi.fn(
      () =>
        new Promise<any>((_resolve, reject) => {
          rejectMerge = reject;
        }),
    );
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      addNode,
      mergeSkeletons,
      initialNodes: [existingRoot],
      segmentId: existingSegmentId,
      segmentIds: [existingSegmentId, realRootSegmentId],
    });

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: 0n,
      parentNodeId: undefined,
      positionInModelSpace: new Float32Array([1, 2, 3]),
    });
    const tempRoot = spatialSkeletonEditSession.getCachedNode(2n ** 63n + 1n)!;
    const tempRootNodeId = tempRoot.nodeId;
    const tempRootSegmentId = tempRoot.segmentId;

    // The existing skeleton is the preview winner and the pending root's
    // temporary segment is the losing side.
    await executeSpatialSkeletonMerge(layer as any, existingRoot, tempRoot);
    const mergedPreviewId = spatialSkeletonEditSession.getCachedNode(
      existingRoot.nodeId,
    )!.segmentId;
    expect(mergedPreviewId).not.toBe(existingSegmentId);
    expect(mergeSkeletons).not.toHaveBeenCalled();
    expect(
      spatialSkeletonEditSession.getCachedNode(tempRootNodeId),
    ).toMatchObject({
      segmentId: mergedPreviewId,
      parentNodeId: existingRoot.nodeId,
    });

    resolveRootAdd?.({
      nodeId: realRootNodeId,
      segmentId: realRootSegmentId,
    });
    await waitForMicrotasks(30);

    expect(mergeSkeletons).toHaveBeenCalledTimes(1);
    expect(
      spatialSkeletonEditSession.getCachedNode(realRootNodeId),
    ).toMatchObject({
      segmentId: mergedPreviewId,
      parentNodeId: existingRoot.nodeId,
    });
    expect(
      spatialSkeletonEditSession.getCachedSegmentNodes(tempRootSegmentId),
    ).toBeUndefined();

    rejectMerge?.(new Error("merge rejected"));
    await waitForMicrotasks(40);

    expect(spatialSkeletonEditSession.getEditQueueRows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "addNode",
          lifecycle: expect.objectContaining({ authority: "committed" }),
        }),
        expect.objectContaining({
          kind: "mergeSkeletons",
          lifecycle: expect.objectContaining({
            authority: "indeterminate",
            reconciliation: "blocked",
            history: "staged",
          }),
        }),
      ]),
    );
    expect(
      spatialSkeletonEditSession
        .getCachedSegmentNodes(existingSegmentId)
        ?.map((node) => node.nodeId),
    ).toEqual([existingRoot.nodeId]);
    expect(
      spatialSkeletonEditSession.getCachedNode(realRootNodeId),
    ).toMatchObject({
      nodeId: realRootNodeId,
      segmentId: realRootSegmentId,
      parentNodeId: undefined,
    });
    expect(
      spatialSkeletonEditSession
        .getCachedSegmentNodes(realRootSegmentId)
        ?.map((node) => node.nodeId),
    ).toEqual([realRootNodeId]);
    expect(showErrorMessage).not.toHaveBeenCalled();
    expectReloadRequired(spatialSkeletonEditSession, "indeterminate");
    expect(
      showErrorMessage.mock.calls.some(([message]) =>
        /rollback.*failed|failed.*rollback|trusted.*handle/i.test(message),
      ),
    ).toBe(false);
  });

  it("requires a page reload when an Add saves but its result cannot be shown", async () => {
    suppressStatusMessages();
    const showErrorMessage = vi.mocked(StatusMessage.showErrorMessage);
    const segmentId = 23n;
    const parentNode: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([1, 2, 3]),
    };
    let resolveAdd!: (value: any) => void;
    const addNode = vi.fn(
      () =>
        new Promise<any>((resolve) => {
          resolveAdd = resolve;
        }),
    );
    const getSkeleton = vi.fn();
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      addNode,
      getSkeleton,
      initialNodes: [parentNode],
      segmentId,
    });

    const execution = executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: segmentId,
      parentNodeId: parentNode.nodeId,
      positionInModelSpace: new Float32Array([4, 5, 6]),
    });
    await execution;
    await vi.waitFor(() => expect(addNode).toHaveBeenCalledTimes(1));
    const tempNodeId = spatialSkeletonEditSession
      .getCachedSegmentNodes(segmentId)!
      .find((node) => node.nodeId >= 2n ** 63n)!.nodeId;
    replaceCachedSegmentForTest(
      spatialSkeletonEditSession,
      segmentId,
      cloneNodes(
        spatialSkeletonEditSession.getCachedSegmentNodes(segmentId),
      ).map((node) =>
        node.nodeId === tempNodeId
          ? { ...node, position: new Float32Array([40, 50, 60]) }
          : node,
      ),
    );
    resolveAdd({
      nodeId: 2n,
      segmentId,
    });
    await waitForMicrotasks(20);

    expect(getSkeleton).not.toHaveBeenCalled();
    expect(spatialSkeletonEditSession.getEditQueueRows()).toEqual([
      expect.objectContaining({
        kind: "addNode",
        lifecycle: expect.objectContaining({
          authority: "committed",
          reconciliation: "blocked",
          history: "staged",
        }),
      }),
    ]);
    expect(showErrorMessage).not.toHaveBeenCalled();
    expect(spatialSkeletonEditSession.getReloadRequired()).toEqual(
      expect.objectContaining({
        reason: "committed-local-publication-failed",
        authority: "committed",
      }),
    );
    expect(() =>
      executeSpatialSkeletonAddNode(layer as any, {
        skeletonId: segmentId,
        parentNodeId: parentNode.nodeId,
        positionInModelSpace: new Float32Array([7, 8, 9]),
      }),
    ).toThrow(SpatialSkeletonReloadRequiredError);
    let settled = false;
    void execution.settled.then(() => (settled = true));
    await waitForMicrotasks();
    expect(settled).toBe(false);
  });

  it("a rejected split leaves the skeleton as the earlier edits left it", async () => {
    suppressStatusMessages();

    const segmentId = 23n;
    const insertedNodeId = 4n;
    const rootNode: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([1, 2, 3]),
    };
    const deletedNode: SkeletonNode = {
      nodeId: 3n,
      segmentId,
      parentNodeId: rootNode.nodeId,
      position: new Float32Array([4, 5, 6]),
    };
    const childNode: SkeletonNode = {
      nodeId: 2n,
      segmentId,
      parentNodeId: deletedNode.nodeId,
      position: new Float32Array([7, 8, 9]),
    };
    let resolveInsert: ((value: any) => void) | undefined;
    const insertNode = vi.fn(
      () =>
        new Promise<any>((resolve) => {
          resolveInsert = resolve;
        }),
    );
    let rejectSplit: ((error: Error) => void) | undefined;
    const splitSkeleton = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectSplit = reject;
        }),
    );
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      insertNode,
      deleteNode: vi.fn().mockResolvedValue(undefined),
      splitSkeleton,
      initialNodes: [rootNode, deletedNode, childNode],
      segmentId,
    });

    await executeSpatialSkeletonDeleteNode(layer as any, deletedNode);
    await waitForMicrotasks(20);
    await undoSpatialSkeletonCommand(layer as any);
    const tempInsertedNodeId = spatialSkeletonEditSession
      .getCachedSegmentNodes(segmentId)!
      .find(
        ({ nodeId }) =>
          nodeId !== rootNode.nodeId && nodeId !== childNode.nodeId,
      )!.nodeId;
    await executeSpatialSkeletonSplit(
      layer as any,
      spatialSkeletonEditSession.getCachedNode(childNode.nodeId)!,
    );

    expect(splitSkeleton).not.toHaveBeenCalled();
    expect(
      spatialSkeletonEditSession.getCachedNode(childNode.nodeId),
    ).toMatchObject({
      parentNodeId: undefined,
    });
    resolveInsert?.({
      nodeId: insertedNodeId,
      segmentId,
    });
    await waitForMicrotasks(20);

    expect(splitSkeleton).toHaveBeenCalledTimes(1);

    rejectSplit?.(new Error("split rejected"));
    await waitForMicrotasks(20);

    expect(
      spatialSkeletonEditSession.getCachedNode(tempInsertedNodeId),
    ).toBeUndefined();
    expect(
      spatialSkeletonEditSession.getCachedNode(insertedNodeId),
    ).toMatchObject({
      segmentId,
      parentNodeId: rootNode.nodeId,
    });
    expect(
      spatialSkeletonEditSession.getCachedNode(childNode.nodeId),
    ).toMatchObject({
      segmentId,
      parentNodeId: insertedNodeId,
    });
  });

  it("Undo and Redo restore every node attribute edit: description, true end, radius and confidence", async () => {
    suppressStatusMessages();

    const segmentId = 23n;
    const node: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      parentNodeId: 10n,
      position: new Float32Array([1, 2, 3]),
      description: "before",
      attributes: { radius: [4], confidence: [50] },
    };
    const rootNode: SkeletonNode = {
      nodeId: 10n,
      segmentId,
      position: new Float32Array([0, 0, 0]),
    };
    const updateDescription = vi.fn(async (_nodeId, description: string) => ({
      description,
    }));
    const toggleTrueEnd = vi.fn(async () => ({}));
    const updateRadius = vi.fn(async () => ({}));
    const updateConfidence = vi.fn(async () => ({}));
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      updateDescription,
      toggleTrueEnd,
      updateRadius,
      updateConfidence,
      initialNodes: [rootNode, node],
      segmentId,
    });

    await executeSpatialSkeletonNodeDescriptionUpdate(layer as any, {
      node: spatialSkeletonEditSession.getCachedNode(node.nodeId)!,
      nextDescription: "after",
    });
    await waitForMicrotasks(6);
    const descriptionUndo = undoSpatialSkeletonCommand(layer as any);
    await descriptionUndo;
    expect(
      spatialSkeletonEditSession.getCachedNode(node.nodeId)?.description,
    ).toBe("before");
    await descriptionUndo.settled;
    await waitForMicrotasks(6);
    const descriptionRedo = redoSpatialSkeletonCommand(layer as any);
    await descriptionRedo;
    expect(
      spatialSkeletonEditSession.getCachedNode(node.nodeId)?.description,
    ).toBe("after");
    await descriptionRedo.settled;
    await waitForMicrotasks(6);

    await executeSpatialSkeletonNodeTrueEndUpdate(layer as any, {
      node: spatialSkeletonEditSession.getCachedNode(node.nodeId)!,
      nextIsTrueEnd: true,
    });
    await waitForMicrotasks(6);
    const undoExecution = undoSpatialSkeletonCommand(layer as any);
    await undoExecution;
    await waitForMicrotasks(6);
    await redoSpatialSkeletonCommand(layer as any);
    await waitForMicrotasks(6);

    await executeSpatialSkeletonNodeRadiusUpdate(layer as any, {
      node: spatialSkeletonEditSession.getCachedNode(node.nodeId)!,
      nextRadius: 8,
    });
    await waitForMicrotasks(6);
    await undoSpatialSkeletonCommand(layer as any);
    await waitForMicrotasks(6);
    await redoSpatialSkeletonCommand(layer as any);
    await waitForMicrotasks(6);

    await executeSpatialSkeletonNodeConfidenceUpdate(layer as any, {
      node: spatialSkeletonEditSession.getCachedNode(node.nodeId)!,
      nextConfidence: 75,
    });
    await waitForMicrotasks(6);
    await undoSpatialSkeletonCommand(layer as any);
    await waitForMicrotasks(6);
    await redoSpatialSkeletonCommand(layer as any);
    await waitForMicrotasks(6);

    expect(updateDescription).toHaveBeenCalledTimes(3);
    expect(toggleTrueEnd).toHaveBeenCalledTimes(3);
    expect(updateRadius).toHaveBeenCalledTimes(3);
    expect(updateConfidence).toHaveBeenCalledTimes(3);
    expect(spatialSkeletonEditSession.getCachedNode(node.nodeId)).toMatchObject(
      {
        description: "after",
        attributes: { true_end: [1], radius: [8], confidence: [75] },
      },
    );
  });

  it.each(["reroot", "merge"] as const)(
    "restores a newly created root's default confidence after %s Undo",
    async (operation) => {
      suppressStatusMessages();
      const updateConfidence = vi.fn(async () => undefined);
      const { layer, spatialSkeletonEditSession: state } = makeAddNodeTestLayer(
        {
          initialNodes: [],
          segmentId: 23n,
          addNode: vi
            .fn()
            .mockResolvedValueOnce({ nodeId: 1n, segmentId: 23n })
            .mockResolvedValueOnce({ nodeId: 2n, segmentId: 23n })
            .mockResolvedValueOnce({ nodeId: 3n, segmentId: 24n }),
          rerootSkeleton: vi.fn(async () => undefined),
          mergeSkeletons: vi.fn(async () => ({
            resultSegmentId: 24n,
            deletedSegmentId: 23n,
          })),
          splitSkeleton: vi.fn(async () => ({
            existingSegmentId: 24n,
            newSegmentId: 25n,
          })),
          updateConfidence,
        },
      );
      await executeSpatialSkeletonAddNode(layer as any, {
        skeletonId: 0n,
        parentNodeId: undefined,
        positionInModelSpace: [1, 2, 3],
      }).settled;
      await executeSpatialSkeletonAddNode(layer as any, {
        skeletonId: 23n,
        parentNodeId: 1n,
        positionInModelSpace: [4, 5, 6],
      }).settled;
      for (const id of [1n, 2n]) {
        expect(state.getCachedNode(id)).toMatchObject({
          attributes: { radius: [0], confidence: [0] },
        });
      }
      if (operation === "reroot") {
        await executeSpatialSkeletonReroot(
          layer as any,
          state.getCachedNode(2n)!,
        ).settled;
      } else {
        await executeSpatialSkeletonAddNode(layer as any, {
          skeletonId: 0n,
          parentNodeId: undefined,
          positionInModelSpace: [7, 8, 9],
        }).settled;
        await executeSpatialSkeletonMerge(
          layer as any,
          state.getCachedNode(3n)!,
          state.getCachedNode(2n)!,
        ).settled;
      }
      await undoSpatialSkeletonCommand(layer as any).settled;
      expect(updateConfidence).toHaveBeenCalledTimes(1);
      expect(updateConfidence).toHaveBeenCalledWith(1n, 0);
      expect(state.getCachedNode(1n)).toMatchObject({
        parentNodeId: undefined,
        attributes: { confidence: [0] },
      });
      expect(state.getCachedNode(2n)).toMatchObject({
        parentNodeId: 1n,
        attributes: { confidence: [0] },
      });
      expect(state.getCachedNode(1n)!.segmentId).toBe(
        operation === "reroot" ? 23n : 25n,
      );
      expect(state.getReloadRequired()).toBeUndefined();
    },
  );

  it("Undo and Redo of a reroot show the old and the new root at once", async () => {
    suppressStatusMessages();

    const segmentId = 23n;
    const rootNode: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([1, 2, 3]),
    };
    const middleNode: SkeletonNode = {
      nodeId: 2n,
      segmentId,
      parentNodeId: rootNode.nodeId,
      position: new Float32Array([4, 5, 6]),
    };
    const leafNode: SkeletonNode = {
      nodeId: 3n,
      segmentId,
      parentNodeId: middleNode.nodeId,
      position: new Float32Array([7, 8, 9]),
    };
    const rerootSkeleton = vi.fn(async () => ({}));
    const getSkeleton = vi.fn(async () => []);
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      rerootSkeleton,
      getSkeleton,
      initialNodes: [rootNode, middleNode, leafNode],
      segmentId,
    });

    await executeSpatialSkeletonReroot(layer as any, leafNode);
    await waitForMicrotasks(10);
    expect(
      spatialSkeletonEditSession.getCachedNode(leafNode.nodeId),
    ).toMatchObject({
      parentNodeId: undefined,
    });

    await expect(undoSpatialSkeletonCommand(layer as any)).resolves.toBe(true);
    await waitForMicrotasks(10);
    expect(
      spatialSkeletonEditSession.getCachedNode(rootNode.nodeId),
    ).toMatchObject({
      parentNodeId: undefined,
    });

    await expect(redoSpatialSkeletonCommand(layer as any)).resolves.toBe(true);
    await waitForMicrotasks(10);

    expect(rerootSkeleton).toHaveBeenCalledTimes(3);
    expect(rerootSkeleton).toHaveBeenNthCalledWith(1, leafNode.nodeId);
    expect(rerootSkeleton).toHaveBeenNthCalledWith(2, rootNode.nodeId);
    expect(rerootSkeleton).toHaveBeenNthCalledWith(3, leafNode.nodeId);
    expect(getSkeleton).not.toHaveBeenCalled();
    expect(
      spatialSkeletonEditSession.getCachedNode(leafNode.nodeId),
    ).toMatchObject({
      parentNodeId: undefined,
    });
    spatialSkeletonEditSession.clearRuntimeState();
  });

  it("restores every parent link across branched reroot undo and redo", async () => {
    suppressStatusMessages();
    const nodes = makeRootRestorationNodesForTest().filter(
      (node) => node.segmentId === 17n,
    );
    const rerootSkeleton = vi.fn().mockResolvedValue({});
    const getSkeleton = vi.fn();
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      initialNodes: nodes,
      segmentId: 17n,
      rerootSkeleton,
      getSkeleton,
    });
    const originalTopology = [
      [201n, 17n, null],
      [202n, 17n, 201n],
      [203n, 17n, 202n],
      [204n, 17n, 202n],
      [205n, 17n, 203n],
    ];
    const rerootedTopology = [
      [201n, 17n, 202n],
      [202n, 17n, 203n],
      [203n, 17n, null],
      [204n, 17n, 202n],
      [205n, 17n, 203n],
    ];

    const reroot = executeSpatialSkeletonReroot(layer as any, nodes[2]!);
    await reroot;
    expect(cachedTopologyForTest(spatialSkeletonEditSession, [17n])).toEqual(
      rerootedTopology,
    );
    await expect(reroot.settled).resolves.toMatchObject({
      outcome: "committed",
    });

    const undo = undoSpatialSkeletonCommand(layer as any);
    await expect(undo).resolves.toBe(true);
    expect(cachedTopologyForTest(spatialSkeletonEditSession, [17n])).toEqual(
      originalTopology,
    );
    await expect(undo.settled).resolves.toMatchObject({ outcome: "committed" });

    const redo = redoSpatialSkeletonCommand(layer as any);
    await expect(redo).resolves.toBe(true);
    expect(cachedTopologyForTest(spatialSkeletonEditSession, [17n])).toEqual(
      rerootedTopology,
    );
    await expect(redo.settled).resolves.toMatchObject({ outcome: "committed" });
    expect(cachedTopologyForTest(spatialSkeletonEditSession, [17n])).toEqual(
      rerootedTopology,
    );
    expect(rerootSkeleton.mock.calls).toEqual([[203n], [201n], [203n]]);
    expect(getSkeleton).not.toHaveBeenCalled();
  });

  it("restores both split components through undo and redo with a fresh skeleton ID", async () => {
    suppressStatusMessages();
    const nodes = makeRootRestorationNodesForTest().filter(
      (node) => node.segmentId === 17n,
    );
    let resolveSplit!: (result: {
      existingSegmentId: bigint;
      newSegmentId: bigint;
    }) => void;
    const splitSkeleton = vi.fn(
      () =>
        new Promise<any>((resolve) => {
          resolveSplit = resolve;
        }),
    );
    const mergeSkeletons = vi.fn().mockResolvedValue({
      resultSegmentId: 17n,
      deletedSegmentId: 31n,
      directionAdjusted: false,
    });
    const getSkeleton = vi.fn();
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      initialNodes: nodes,
      segmentId: 17n,
      splitSkeleton,
      mergeSkeletons,
      getSkeleton,
    });
    const expectSplitTopology = (splitSegmentId: bigint) => {
      expect(
        cachedTopologyForTest(spatialSkeletonEditSession, [
          17n,
          splitSegmentId,
        ]),
      ).toEqual([
        [201n, 17n, null],
        [202n, splitSegmentId, null],
        [203n, splitSegmentId, 202n],
        [204n, splitSegmentId, 202n],
        [205n, splitSegmentId, 203n],
      ]);
    };
    const expectOriginalTopology = () => {
      expect(cachedTopologyForTest(spatialSkeletonEditSession, [17n])).toEqual([
        [201n, 17n, null],
        [202n, 17n, 201n],
        [203n, 17n, 202n],
        [204n, 17n, 202n],
        [205n, 17n, 203n],
      ]);
    };

    const split = executeSpatialSkeletonSplit(layer as any, nodes[1]!);
    await split;
    const firstPreviewId =
      spatialSkeletonEditSession.getCachedNode(202n)!.segmentId;
    expect(firstPreviewId).not.toBe(17n);
    expectSplitTopology(firstPreviewId);
    resolveSplit({ existingSegmentId: 17n, newSegmentId: 31n });
    await expect(split.settled).resolves.toMatchObject({
      outcome: "committed",
    });
    expectSplitTopology(31n);
    expect(
      spatialSkeletonEditSession.getCachedSegmentNodes(firstPreviewId),
    ).toBeUndefined();

    const undo = undoSpatialSkeletonCommand(layer as any);
    await expect(undo).resolves.toBe(true);
    expectOriginalTopology();
    await expect(undo.settled).resolves.toMatchObject({ outcome: "committed" });
    expectOriginalTopology();
    expect(
      spatialSkeletonEditSession.getCachedSegmentNodes(31n),
    ).toBeUndefined();

    const redo = redoSpatialSkeletonCommand(layer as any);
    await expect(redo).resolves.toBe(true);
    const redoPreviewId =
      spatialSkeletonEditSession.getCachedNode(202n)!.segmentId;
    expect(redoPreviewId).not.toBe(17n);
    expectSplitTopology(redoPreviewId);
    resolveSplit({ existingSegmentId: 17n, newSegmentId: 37n });
    await expect(redo.settled).resolves.toMatchObject({ outcome: "committed" });
    expectSplitTopology(37n);
    expect(
      spatialSkeletonEditSession.getCachedSegmentNodes(31n),
    ).toBeUndefined();
    expect(
      spatialSkeletonEditSession.getCachedSegmentNodes(redoPreviewId),
    ).toBeUndefined();
    expect(splitSkeleton.mock.calls).toEqual([[202n], [202n]]);
    expect(mergeSkeletons.mock.calls).toEqual([[201n, 202n]]);
    expect(getSkeleton).not.toHaveBeenCalled();
  });

  it("restores the original root and parent path after repeated non-root merge undo", async () => {
    suppressStatusMessages();
    const nodes = makeRootRestorationNodesForTest();
    const mergeSkeletons = vi
      .fn()
      .mockResolvedValueOnce({
        resultSegmentId: 11n,
        deletedSegmentId: 17n,
        directionAdjusted: false,
      })
      .mockResolvedValueOnce({
        resultSegmentId: 11n,
        deletedSegmentId: 19n,
        directionAdjusted: false,
      });
    const splitSkeleton = vi
      .fn()
      .mockResolvedValueOnce({ existingSegmentId: 11n, newSegmentId: 19n })
      .mockResolvedValueOnce({ existingSegmentId: 11n, newSegmentId: 23n });
    const rerootSkeleton = vi.fn().mockResolvedValue({});
    const getSkeleton = vi.fn();
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      initialNodes: nodes,
      segmentId: 11n,
      segmentIds: [11n, 17n],
      mergeSkeletons,
      splitSkeleton,
      rerootSkeleton,
      getSkeleton,
    });
    const expectRestoredTopology = (restoredSegmentId: bigint) => {
      expect(
        cachedTopologyForTest(spatialSkeletonEditSession, [
          11n,
          restoredSegmentId,
        ]),
      ).toEqual([
        [101n, 11n, null],
        [102n, 11n, 101n],
        [201n, restoredSegmentId, null],
        [202n, restoredSegmentId, 201n],
        [203n, restoredSegmentId, 202n],
        [204n, restoredSegmentId, 202n],
        [205n, restoredSegmentId, 203n],
      ]);
    };
    const mergedTopology = [
      [101n, 11n, null],
      [102n, 11n, 101n],
      [201n, 11n, 202n],
      [202n, 11n, 203n],
      [203n, 11n, 102n],
      [204n, 11n, 202n],
      [205n, 11n, 203n],
    ];

    for (const [cycle, restoredSegmentId] of [19n, 23n].entries()) {
      const merge =
        cycle === 0
          ? executeSpatialSkeletonMerge(layer as any, nodes[1]!, nodes[4]!)
          : redoSpatialSkeletonCommand(layer as any);
      await merge;
      const mergedPreviewId =
        spatialSkeletonEditSession.getCachedNode(101n)!.segmentId;
      expect(
        cachedTopologyForTest(spatialSkeletonEditSession, [mergedPreviewId]),
      ).toEqual(
        mergedTopology.map(([nodeId, , parentId]) => [
          nodeId,
          mergedPreviewId,
          parentId,
        ]),
      );
      await expect(merge.settled).resolves.toMatchObject({
        outcome: "committed",
      });
      expect(cachedTopologyForTest(spatialSkeletonEditSession, [11n])).toEqual(
        mergedTopology,
      );

      const undo = undoSpatialSkeletonCommand(layer as any);
      await expect(undo).resolves.toBe(true);
      const restoredPreviewId =
        spatialSkeletonEditSession.getCachedNode(201n)!.segmentId;
      expect(restoredPreviewId).not.toBe(11n);
      expectRestoredTopology(restoredPreviewId);
      await expect(undo.settled).resolves.toMatchObject({
        outcome: "committed",
      });
      expectRestoredTopology(restoredSegmentId);
      expect(spatialSkeletonEditSession.commandHistory.canRedo.value).toBe(
        true,
      );
    }

    expect(
      spatialSkeletonEditSession.getCachedSegmentNodes(17n),
    ).toBeUndefined();
    expect(
      spatialSkeletonEditSession.getCachedSegmentNodes(19n),
    ).toBeUndefined();
    expect(mergeSkeletons.mock.calls).toEqual([
      [102n, 203n],
      [102n, 203n],
    ]);
    expect(splitSkeleton.mock.calls).toEqual([[203n], [203n]]);
    expect(rerootSkeleton.mock.calls).toEqual([[201n], [201n]]);
    expect(getSkeleton).not.toHaveBeenCalled();
  });

  it("Undo of a merge, and every edit after it, waits to be sent until the original root is restored", async () => {
    suppressStatusMessages();
    const nodes = makeRootRestorationNodesForTest();
    const requestOrder: string[] = [];
    const mergeSkeletons = vi.fn(async () => {
      requestOrder.push("merge");
      return {
        resultSegmentId: 11n,
        deletedSegmentId: 17n,
        directionAdjusted: false,
      };
    });
    let resolveSplit!: (result: {
      existingSegmentId: bigint;
      newSegmentId: bigint;
    }) => void;
    const splitSkeleton = vi.fn(() => {
      requestOrder.push("split");
      return new Promise<any>((resolve) => {
        resolveSplit = resolve;
      });
    });
    let resolveReroot!: (result: object) => void;
    const rerootSkeleton = vi.fn(() => {
      requestOrder.push("reroot");
      return new Promise<object>((resolve) => {
        resolveReroot = resolve;
      });
    });
    const moveNode = vi.fn(async () => {
      requestOrder.push("move");
      return {};
    });
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      initialNodes: nodes,
      segmentId: 11n,
      segmentIds: [11n, 17n],
      mergeSkeletons,
      splitSkeleton,
      rerootSkeleton,
      moveNode,
    });
    const merge = executeSpatialSkeletonMerge(
      layer as any,
      nodes[1]!,
      nodes[4]!,
    );
    await merge;
    await merge.settled;

    const undo = undoSpatialSkeletonCommand(layer as any);
    const undoSettled = vi.fn();
    void undo.settled.then(undoSettled);
    await expect(undo).resolves.toBe(true);
    const move = executeSpatialSkeletonMoveNode(layer as any, {
      node: spatialSkeletonEditSession.getCachedNode(201n)!,
      nextPositionInModelSpace: new Float32Array([40, 50, 60]),
    });
    await move;
    expect(
      Array.from(spatialSkeletonEditSession.getCachedNode(201n)!.position),
    ).toEqual([40, 50, 60]);
    expect(moveNode).not.toHaveBeenCalled();
    expect(rerootSkeleton).not.toHaveBeenCalled();
    expect(undoSettled).not.toHaveBeenCalled();

    resolveSplit({ existingSegmentId: 11n, newSegmentId: 19n });
    await vi.waitFor(() => expect(rerootSkeleton).toHaveBeenCalledWith(201n));
    await waitForMicrotasks(10);
    // The split has committed, but the server still has B2 as root. Neither
    // Undo's settled promise nor a later write may pass this reroot barrier.
    expect(requestOrder).toEqual(["merge", "split", "reroot"]);
    expect(undoSettled).not.toHaveBeenCalled();
    expect(moveNode).not.toHaveBeenCalled();

    resolveReroot({});
    await expect(undo.settled).resolves.toMatchObject({ outcome: "committed" });
    await expect(move.settled).resolves.toMatchObject({ outcome: "committed" });
    expect(undoSettled).toHaveBeenCalledTimes(1);
    expect(requestOrder).toEqual(["merge", "split", "reroot", "move"]);
    expect(moveNode).toHaveBeenCalledTimes(1);
    expect(
      cachedTopologyForTest(spatialSkeletonEditSession, [11n, 19n]),
    ).toEqual([
      [101n, 11n, null],
      [102n, 11n, 101n],
      [201n, 19n, null],
      [202n, 19n, 201n],
      [203n, 19n, 202n],
      [204n, 19n, 202n],
      [205n, 19n, 203n],
    ]);
    expect(
      Array.from(spatialSkeletonEditSession.getCachedNode(201n)!.position),
    ).toEqual([40, 50, 60]);
  });

  it("the edit queue keeps showing a saved Add until the Adds that depend on it are saved", async () => {
    suppressStatusMessages();

    const segmentId = 23n;
    const parentNode: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([4, 5, 6]),
    };
    let resolveParentAdd:
      | ((value: { nodeId: bigint; segmentId: bigint }) => void)
      | undefined;
    let resolveChildAdd:
      | ((value: { nodeId: bigint; segmentId: bigint }) => void)
      | undefined;
    const parentAddPromise = new Promise<any>((resolve) => {
      resolveParentAdd = resolve;
    });
    const childAddPromise = new Promise<any>((resolve) => {
      resolveChildAdd = resolve;
    });
    const addNode = vi
      .fn()
      .mockReturnValueOnce(parentAddPromise)
      .mockReturnValueOnce(childAddPromise);
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      addNode,
      initialNodes: [parentNode],
      segmentId,
    });

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: segmentId,
      parentNodeId: parentNode.nodeId,
      positionInModelSpace: new Float32Array([7, 8, 9]),
    });
    await waitForMicrotasks();

    const previewParent = spatialSkeletonEditSession
      .getCachedSegmentNodes(segmentId)!
      .find((node) => node.nodeId >= 2n ** 63n);
    expect(previewParent).toBeDefined();

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: segmentId,
      parentNodeId: previewParent!.nodeId,
      positionInModelSpace: new Float32Array([10, 11, 12]),
    });
    await waitForMicrotasks();

    resolveParentAdd!({
      nodeId: 2n,
      segmentId,
    });
    await waitForMicrotasks(10);

    expect(addNode).toHaveBeenCalledTimes(2);
    expect(spatialSkeletonEditSession.getEditQueueRows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "addNode",
          lifecycle: expect.objectContaining({
            authority: "committed",
            reconciliation: "complete",
          }),
        }),
        expect.objectContaining({
          kind: "addNode",
          lifecycle: expect.objectContaining({ authority: "running" }),
        }),
      ]),
    );

    resolveChildAdd!({
      nodeId: 3n,
      segmentId,
    });
    await waitForMicrotasks(5);

    expect(
      spatialSkeletonEditSession
        .getEditQueueRows()
        .filter((entry) => entry.lifecycle.authority === "committed"),
    ).toHaveLength(2);
  });

  it("restores a rejected sole-root deletion without reloading", async () => {
    suppressStatusMessages();
    const node: SkeletonNode = {
      nodeId: 725n,
      segmentId: 87n,
      position: new Float32Array([4, 5, 6]),
    };
    let rejectDelete!: (error: unknown) => void;
    const deleteNode = vi.fn(
      () =>
        new Promise<never>((_, reject) => {
          rejectDelete = reject;
        }),
    );
    const { layer, spatialSkeletonEditSession, selection } =
      makeAddNodeTestLayer({
        deleteNode,
        initialNodes: [node],
        segmentId: node.segmentId,
      });
    selection.select(node.nodeId, true, node);
    const execution = executeSpatialSkeletonDeleteNode(layer as any, node);
    await execution;
    await waitForMicrotasks();
    expect(
      spatialSkeletonEditSession.getCachedNode(node.nodeId),
    ).toBeUndefined();
    expect(selection.selected.value).toBeUndefined();
    rejectDelete(
      new HttpError(
        "https://catmaid.example.test/1/treenode/delete",
        409,
        "Conflict",
      ),
    );
    expect(await execution.settled).toMatchObject({
      outcome: "unchanged",
      reason: "rejected",
    });
    expect(spatialSkeletonEditSession.getCachedNode(node.nodeId)).toMatchObject(
      node,
    );
    expect(
      spatialSkeletonEditSession.spatialSkeletonDisplay.value.removedSegmentIds,
    ).not.toContain(node.segmentId);
    expect(selection.selected.value).toMatchObject({
      nodeId: node.nodeId,
      segmentId: node.segmentId,
    });
    expect(spatialSkeletonEditSession.getReloadRequired()).toBeUndefined();
    expect(spatialSkeletonEditSession.commandHistory.canUndo.value).toBe(false);
  });

  it("a rejected delete restores the node under its parent's saved ID", async () => {
    suppressStatusMessages();

    const segmentId = 23n;
    const rootNode: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([4, 5, 6]),
    };
    let resolveParentAdd:
      | ((value: { nodeId: bigint; segmentId: bigint }) => void)
      | undefined;
    let resolveChildAdd:
      | ((value: { nodeId: bigint; segmentId: bigint }) => void)
      | undefined;
    const parentAddPromise = new Promise<any>((resolve) => {
      resolveParentAdd = resolve;
    });
    const childAddPromise = new Promise<any>((resolve) => {
      resolveChildAdd = resolve;
    });
    const addNode = vi
      .fn()
      .mockReturnValueOnce(parentAddPromise)
      .mockReturnValueOnce(childAddPromise);
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      addNode,
      initialNodes: [rootNode],
      segmentId,
    });

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: segmentId,
      parentNodeId: rootNode.nodeId,
      positionInModelSpace: new Float32Array([7, 8, 9]),
    });
    await waitForMicrotasks();

    const previewParent = spatialSkeletonEditSession
      .getCachedSegmentNodes(segmentId)!
      .find((node) => node.nodeId >= 2n ** 63n);
    expect(previewParent).toBeDefined();

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: segmentId,
      parentNodeId: previewParent!.nodeId,
      positionInModelSpace: new Float32Array([10, 11, 12]),
    });
    await waitForMicrotasks();

    const previewChild = spatialSkeletonEditSession
      .getCachedSegmentNodes(segmentId)!
      .find((node) => node.parentNodeId === previewParent!.nodeId);
    expect(previewChild).toBeDefined();

    await executeSpatialSkeletonDeleteNode(layer as any, previewChild!);
    await waitForMicrotasks();

    resolveParentAdd!({
      nodeId: 2n,
      segmentId,
    });
    await waitForMicrotasks(5);

    await undoSpatialSkeletonCommand(layer as any);

    expect(
      spatialSkeletonEditSession.getCachedNode(previewChild!.nodeId),
    ).toMatchObject({
      nodeId: previewChild!.nodeId,
      parentNodeId: 2n,
    });

    resolveChildAdd!({
      nodeId: 3n,
      segmentId,
    });
    await waitForMicrotasks(5);
  });

  it.each([
    {
      name: "Undo of a move",
      runEdits: async (layer: unknown, state: SpatialSkeletonEditSession) => {
        await executeSpatialSkeletonMoveNode(layer as any, {
          node: state.getCachedNode(2n)!,
          nextPositionInModelSpace: new Float32Array([10, 11, 12]),
        }).settled;
      },
      evictedSegmentId: 23n,
      historyStep: undoSpatialSkeletonCommand,
      expectShown: (state: SpatialSkeletonEditSession) => {
        expect(Array.from(state.getCachedNode(2n)!.position)).toEqual([
          4, 5, 6,
        ]);
      },
      serverCall: ["moveNode", 2n, 4, 5, 6],
      expectedHistory: { canUndo: false, canRedo: true },
    },
    {
      name: "Redo of a move",
      runEdits: async (layer: unknown, state: SpatialSkeletonEditSession) => {
        await executeSpatialSkeletonMoveNode(layer as any, {
          node: state.getCachedNode(2n)!,
          nextPositionInModelSpace: new Float32Array([10, 11, 12]),
        }).settled;
        await undoSpatialSkeletonCommand(layer as any).settled;
      },
      evictedSegmentId: 23n,
      historyStep: redoSpatialSkeletonCommand,
      expectShown: (state: SpatialSkeletonEditSession) => {
        expect(Array.from(state.getCachedNode(2n)!.position)).toEqual([
          10, 11, 12,
        ]);
      },
      serverCall: ["moveNode", 2n, 10, 11, 12],
      expectedHistory: { canUndo: true, canRedo: false },
    },
    {
      name: "Undo of a split",
      runEdits: async (layer: unknown, state: SpatialSkeletonEditSession) => {
        await executeSpatialSkeletonSplit(
          layer as any,
          state.getCachedNode(2n)!,
        ).settled;
      },
      evictedSegmentId: 31n,
      historyStep: undoSpatialSkeletonCommand,
      expectShown: (state: SpatialSkeletonEditSession) => {
        expect(state.getCachedNode(2n)).toMatchObject({
          segmentId: 23n,
          parentNodeId: 1n,
        });
      },
      serverCall: ["mergeSkeletons", 1n, 2n],
      expectedHistory: { canUndo: false, canRedo: true },
    },
  ])(
    "$name works without downloading again a skeleton that has left the cache",
    async ({
      runEdits,
      evictedSegmentId,
      historyStep,
      expectShown,
      serverCall: [serverMethod, ...serverArguments],
      expectedHistory,
    }) => {
      suppressStatusMessages();
      const getSkeleton = vi.fn();
      const {
        client,
        layer,
        spatialSkeletonEditSession: state,
      } = makeAddNodeTestLayer({
        getSkeleton,
        moveNode: vi.fn().mockResolvedValue({}),
        splitSkeleton: vi.fn().mockResolvedValue({
          existingSegmentId: 23n,
          newSegmentId: 31n,
        }),
        mergeSkeletons: vi.fn().mockResolvedValue({
          resultSegmentId: 23n,
          deletedSegmentId: 31n,
        }),
        initialNodes: [
          { nodeId: 1n, segmentId: 23n, position: new Float32Array([1, 2, 3]) },
          {
            nodeId: 2n,
            segmentId: 23n,
            parentNodeId: 1n,
            position: new Float32Array([4, 5, 6]),
          },
        ],
        segmentId: 23n,
      });
      await runEdits(layer, state);
      replaceCachedSegmentForTest(state, evictedSegmentId, undefined);

      const execution = historyStep(layer as any);
      await expect(execution).resolves.toBe(true);
      expectShown(state);
      await expect(execution.settled).resolves.toMatchObject({
        outcome: "committed",
      });

      expect((client as any)[serverMethod as string]).toHaveBeenLastCalledWith(
        ...serverArguments,
      );
      expect(getSkeleton).not.toHaveBeenCalled();
      expect(state.commandHistory.canUndo.value).toBe(expectedHistory.canUndo);
      expect(state.commandHistory.canRedo.value).toBe(expectedHistory.canRedo);
    },
  );

  it("accepts more than 64 edits in a row once earlier ones are saved, and lists only the latest 64", async () => {
    suppressStatusMessages();
    const segmentId = 23n;
    const node: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([0, 0, 0]),
    };
    const moveNode = vi.fn().mockResolvedValue({});
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      moveNode,
      initialNodes: [node],
      segmentId,
    });

    for (let index = 1; index <= 70; ++index) {
      await executeSpatialSkeletonMoveNode(layer as any, {
        node: spatialSkeletonEditSession.getCachedNode(node.nodeId)!,
        nextPositionInModelSpace: new Float32Array([index, index, index]),
      });
      await waitForMicrotasks(5);
    }

    expect(moveNode).toHaveBeenCalledTimes(70);
    const retained = spatialSkeletonEditSession.getEditQueueRows();
    expect(retained).toHaveLength(64);
    expect(
      retained.every(
        (entry) =>
          entry.lifecycle.authority === "committed" &&
          entry.lifecycle.reconciliation === "complete",
      ),
    ).toBe(true);
    expect(spatialSkeletonEditSession.hasUnconfirmedEdits()).toBe(false);
    expect(
      Array.from(
        spatialSkeletonEditSession.getCachedNode(node.nodeId)!.position,
      ),
    ).toEqual([70, 70, 70]);
  });

  it("previews up to 64 unsaved edits, refuses the 65th with a message, and sends the rest once the first saves", async () => {
    suppressStatusMessages();
    const segmentId = 23n;
    const nodes = Array.from(
      { length: 65 },
      (_, index) =>
        ({
          nodeId: BigInt(index + 1),
          segmentId,
          parentNodeId: index === 0 ? undefined : BigInt(index),
          position: new Float32Array([index, 0, 0]),
        }) satisfies SkeletonNode,
    );
    let resolveFirstMove: (() => void) | undefined;
    const heldMove = new Promise<void>((resolve) => {
      resolveFirstMove = resolve;
    });
    const moveNode = vi
      .fn()
      .mockReturnValueOnce(heldMove)
      .mockResolvedValue(undefined);
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      moveNode,
      initialNodes: nodes,
      segmentId,
    });

    const executions = [];
    for (let index = 0; index < 64; ++index) {
      const nextPosition = new Float32Array([index, index + 10, index + 20]);
      const execution = executeSpatialSkeletonMoveNode(layer as any, {
        node: spatialSkeletonEditSession.getCachedNode(nodes[index].nodeId)!,
        nextPositionInModelSpace: nextPosition,
      });
      executions.push(execution);
      await execution.acceptedByQueue;
      await execution;
      expect(
        Array.from(
          spatialSkeletonEditSession.getCachedNode(nodes[index].nodeId)!
            .position,
        ),
      ).toEqual(Array.from(nextPosition));
    }

    expect(moveNode).toHaveBeenCalledTimes(1);
    expect(spatialSkeletonEditSession.getEditQueueRows()).toHaveLength(64);

    const overflow = executeSpatialSkeletonMoveNode(layer as any, {
      node: spatialSkeletonEditSession.getCachedNode(nodes[64].nodeId)!,
      nextPositionInModelSpace: new Float32Array([64, 74, 84]),
    });
    await expect(overflow).rejects.toThrow(
      "Optimistic edit queue has reached its 64-edit safety limit. Wait for the skeleton source to confirm some edits.",
    );
    expect(moveNode).toHaveBeenCalledTimes(1);
    expect(spatialSkeletonEditSession.getEditQueueRows()).toHaveLength(64);

    resolveFirstMove?.();
    await Promise.all(executions.map((execution) => execution.settled));

    // Settlement itself triggers the generation latch; no extra user event
    // is needed to submit the remaining ordered intents.
    expect(moveNode).toHaveBeenCalledTimes(64);
    expect(spatialSkeletonEditSession.hasUnconfirmedEdits()).toBe(false);
    expect(
      spatialSkeletonEditSession
        .getEditQueueRows()
        .every((entry) => entry.lifecycle.authority === "committed"),
    ).toBe(true);
  });

  it("shows a node's latest move when an earlier move of it saves", async () => {
    suppressStatusMessages();

    const segmentId = 23n;
    const node: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([4, 5, 6]),
    };
    let resolveFirstMove: (() => void) | undefined;
    let resolveSecondMove: (() => void) | undefined;
    const firstMovePromise = new Promise<void>((resolve) => {
      resolveFirstMove = resolve;
    });
    const secondMovePromise = new Promise<void>((resolve) => {
      resolveSecondMove = resolve;
    });
    const moveNode = vi
      .fn()
      .mockReturnValueOnce(firstMovePromise)
      .mockReturnValueOnce(secondMovePromise);
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      moveNode,
      initialNodes: [node],
      segmentId,
    });

    await executeSpatialSkeletonMoveNode(layer as any, {
      node,
      nextPositionInModelSpace: new Float32Array([10, 11, 12]),
    });
    await waitForMicrotasks();
    expect(
      Array.from(
        spatialSkeletonEditSession.getCachedNode(node.nodeId)!.position,
      ),
    ).toEqual([10, 11, 12]);

    await executeSpatialSkeletonMoveNode(layer as any, {
      node: spatialSkeletonEditSession.getCachedNode(node.nodeId)!,
      nextPositionInModelSpace: new Float32Array([20, 21, 22]),
    });
    await waitForMicrotasks();
    expect(moveNode).toHaveBeenCalledTimes(1);
    expect(
      Array.from(
        spatialSkeletonEditSession.getCachedNode(node.nodeId)!.position,
      ),
    ).toEqual([20, 21, 22]);

    resolveFirstMove!();
    await waitForMicrotasks(20);

    expect(moveNode).toHaveBeenCalledTimes(2);
    expect(
      Array.from(
        spatialSkeletonEditSession.getCachedNode(node.nodeId)!.position,
      ),
    ).toEqual([20, 21, 22]);

    resolveSecondMove!();
    await waitForMicrotasks(20);

    expect(
      Array.from(
        spatialSkeletonEditSession.getCachedNode(node.nodeId)!.position,
      ),
    ).toEqual([20, 21, 22]);
  });

  it("a split appears at once and takes the new skeleton ID the server returns", async () => {
    suppressStatusMessages();
    const segmentId = 23n;
    const newSegmentId = 31n;
    const rootNode: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([1, 2, 3]),
    };
    const splitNode: SkeletonNode = {
      nodeId: 2n,
      segmentId,
      parentNodeId: rootNode.nodeId,
      position: new Float32Array([4, 5, 6]),
    };
    const childNode: SkeletonNode = {
      nodeId: 3n,
      segmentId,
      parentNodeId: splitNode.nodeId,
      position: new Float32Array([7, 8, 9]),
    };
    let resolveSplit:
      | ((result: { existingSegmentId: bigint; newSegmentId: bigint }) => void)
      | undefined;
    const splitSkeleton = vi.fn(
      () =>
        new Promise<{
          existingSegmentId: bigint;
          newSegmentId: bigint;
        }>((resolve) => {
          resolveSplit = resolve;
        }),
    );
    const getSkeleton = vi.fn(async (requestedSegmentId: bigint) => {
      if (requestedSegmentId === segmentId) return [rootNode];
      if (requestedSegmentId === newSegmentId) {
        return [
          {
            ...splitNode,
            segmentId: newSegmentId,
            parentNodeId: undefined,
          },
          {
            ...childNode,
            segmentId: newSegmentId,
          },
        ];
      }
      return [];
    });
    const { layer, overlaySegments, spatialSkeletonEditSession } =
      makeAddNodeTestLayer({
        initialNodes: [rootNode, splitNode, childNode],
        segmentId,
        splitSkeleton,
        getSkeleton,
      });

    const execution = executeSpatialSkeletonSplit(layer as any, splitNode);
    // Every structural action first exposes its admitted preparation state;
    // the exact warm topology publishes after the presentation turn.
    expect(execution.acceptedByQueue).toBeInstanceOf(Promise);
    await execution.acceptedByQueue;
    await waitForDisplayTurn();
    await execution;
    const previewSplitNode = spatialSkeletonEditSession.getCachedNode(
      splitNode.nodeId,
    )!;
    const tempSegmentId = previewSplitNode.segmentId;
    expect(tempSegmentId).not.toBe(segmentId);
    expect(previewSplitNode.parentNodeId).toBeUndefined();
    expect(
      spatialSkeletonEditSession
        .getCachedSegmentNodes(tempSegmentId)
        ?.map((node) => node.nodeId),
    ).toEqual([splitNode.nodeId, childNode.nodeId]);
    expect(
      spatialSkeletonEditSession.spatialSkeletonDisplay.value.numericAliases,
    ).toContainEqual(
      expect.objectContaining({
        segmentId: tempSegmentId,
        authoritative: false,
      }),
    );
    expect(splitSkeleton).toHaveBeenCalledWith(splitNode.nodeId);

    resolveSplit?.({ existingSegmentId: segmentId, newSegmentId });
    await waitForMicrotasks(12);

    expect(
      spatialSkeletonEditSession.getCachedSegmentNodes(tempSegmentId),
    ).toBe(undefined);
    expect(
      spatialSkeletonEditSession.getCachedNode(splitNode.nodeId),
    ).toMatchObject({
      segmentId: newSegmentId,
      parentNodeId: undefined,
    });
    expect(
      spatialSkeletonEditSession.spatialSkeletonDisplay.value.numericAliases,
    ).toContainEqual(
      expect.objectContaining({
        segmentId: newSegmentId,
        authoritative: true,
      }),
    );
    expect(
      spatialSkeletonEditSession.spatialSkeletonDisplay.value.numericAliases,
    ).not.toContainEqual(
      expect.objectContaining({
        segmentId: tempSegmentId,
        authoritative: false,
      }),
    );
    expect(overlaySegments.remap).toHaveBeenCalledWith(
      new Map([[tempSegmentId, newSegmentId]]),
    );
    expect(getSkeleton).not.toHaveBeenCalled();
    expect(spatialSkeletonEditSession.commandHistory.canUndo.value).toBe(true);
  });

  it("a merge stays visible when the server keeps the other skeleton", async () => {
    suppressStatusMessages();
    const firstSegmentId = 11n;
    const secondSegmentId = 17n;
    const firstRoot: SkeletonNode = {
      nodeId: 101n,
      segmentId: firstSegmentId,
      position: new Float32Array([1, 2, 3]),
    };
    const firstNode: SkeletonNode = {
      nodeId: 102n,
      segmentId: firstSegmentId,
      parentNodeId: firstRoot.nodeId,
      position: new Float32Array([4, 5, 6]),
    };
    const secondRoot: SkeletonNode = {
      nodeId: 201n,
      segmentId: secondSegmentId,
      position: new Float32Array([7, 8, 9]),
    };
    const secondNode: SkeletonNode = {
      nodeId: 202n,
      segmentId: secondSegmentId,
      parentNodeId: secondRoot.nodeId,
      position: new Float32Array([10, 11, 12]),
    };
    let resolveMerge:
      | ((result: {
          resultSegmentId: bigint;
          deletedSegmentId: bigint;
          directionAdjusted: boolean;
        }) => void)
      | undefined;
    const mergeSkeletons = vi.fn(
      () =>
        new Promise<{
          resultSegmentId: bigint;
          deletedSegmentId: bigint;
          directionAdjusted: boolean;
        }>((resolve) => {
          resolveMerge = resolve;
        }),
    );
    const getSkeleton = vi.fn(async () => []);
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      initialNodes: [firstRoot, firstNode, secondRoot, secondNode],
      segmentId: firstSegmentId,
      segmentIds: [firstSegmentId, secondSegmentId],
      mergeSkeletons,
      getSkeleton,
    });

    const execution = executeSpatialSkeletonMerge(
      layer as any,
      firstNode,
      secondNode,
    );
    await execution;

    expect(
      spatialSkeletonEditSession.getCachedSegmentNodes(secondSegmentId),
    ).toBe(undefined);
    const mergedPreviewId = spatialSkeletonEditSession.getCachedNode(
      firstNode.nodeId,
    )!.segmentId;
    expect(mergedPreviewId).not.toBe(firstSegmentId);
    expect(
      spatialSkeletonEditSession.getCachedNode(secondNode.nodeId),
    ).toMatchObject({
      segmentId: mergedPreviewId,
      parentNodeId: firstNode.nodeId,
    });
    expect(mergeSkeletons).toHaveBeenCalledWith(
      firstNode.nodeId,
      secondNode.nodeId,
    );

    const publishedReconciliationFrames: Array<{
      first: bigint[] | undefined;
      second: bigint[] | undefined;
    }> = [];
    const unsubscribeDisplay =
      spatialSkeletonEditSession.spatialSkeletonDisplay.changed.add(() => {
        publishedReconciliationFrames.push({
          first: spatialSkeletonEditSession
            .getCachedSegmentNodes(firstSegmentId)
            ?.map((node) => node.nodeId),
          second: spatialSkeletonEditSession
            .getCachedSegmentNodes(secondSegmentId)
            ?.map((node) => node.nodeId)
            .sort(bigintCompare),
        });
      });

    resolveMerge?.({
      resultSegmentId: secondSegmentId,
      deletedSegmentId: firstSegmentId,
      directionAdjusted: true,
    });
    await waitForMicrotasks(8);

    expect(getSkeleton).not.toHaveBeenCalled();
    expect(
      spatialSkeletonEditSession
        .getCachedSegmentNodes(secondSegmentId)
        ?.map((node) => node.nodeId)
        .sort(bigintCompare),
    ).toEqual([
      firstRoot.nodeId,
      firstNode.nodeId,
      secondRoot.nodeId,
      secondNode.nodeId,
    ]);
    expect(
      spatialSkeletonEditSession.getCachedSegmentNodes(firstSegmentId),
    ).toBeUndefined();
    expect(publishedReconciliationFrames).toEqual([
      {
        first: undefined,
        second: [
          firstRoot.nodeId,
          firstNode.nodeId,
          secondRoot.nodeId,
          secondNode.nodeId,
        ],
      },
    ]);

    expect(
      spatialSkeletonEditSession.getCachedNode(firstNode.nodeId),
    ).toMatchObject({
      segmentId: secondSegmentId,
      parentNodeId: secondNode.nodeId,
    });
    expect(
      spatialSkeletonEditSession.getCachedSegmentNodes(firstSegmentId),
    ).toBeUndefined();
    expect(spatialSkeletonEditSession.commandHistory.canUndo.value).toBe(true);
    unsubscribeDisplay();
  });

  it("a merge with a hidden skeleton keeps that skeleton's download until the merge is previewed", async () => {
    suppressStatusMessages();
    const firstSegmentId = 11n;
    const secondSegmentId = 17n;
    const firstNode: SkeletonNode = {
      nodeId: 101n,
      segmentId: firstSegmentId,
      position: new Float32Array([1, 2, 3]),
    };
    const secondNode: SkeletonNode = {
      nodeId: 201n,
      segmentId: secondSegmentId,
      position: new Float32Array([4, 5, 6]),
    };
    let secondFetchSignal: AbortSignal | undefined;
    let resolveSecondFetch: ((nodes: SkeletonNode[]) => void) | undefined;
    let secondFetchResolved = false;
    const mergedServerSecondNode: SkeletonNode = {
      ...secondNode,
      segmentId: firstSegmentId,
      parentNodeId: firstNode.nodeId,
    };
    const getSkeleton = vi.fn(
      (requestedSegmentId: bigint, options?: { signal?: AbortSignal }) => {
        if (requestedSegmentId !== secondSegmentId) {
          return Promise.resolve(
            requestedSegmentId === firstSegmentId
              ? [firstNode, mergedServerSecondNode]
              : [],
          );
        }
        if (secondFetchResolved) return Promise.resolve([]);
        secondFetchSignal = options?.signal;
        return new Promise<SkeletonNode[]>((resolve, reject) => {
          resolveSecondFetch = resolve;
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      },
    );
    const mergeSkeletons = vi.fn().mockResolvedValue({
      resultSegmentId: firstSegmentId,
      deletedSegmentId: secondSegmentId,
      directionAdjusted: false,
    });
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      initialNodes: [firstNode],
      segmentId: firstSegmentId,
      mergeSkeletons,
      getSkeleton,
    });

    const execution = executeSpatialSkeletonMerge(
      layer as any,
      firstNode,
      secondNode,
    );
    await waitForMicrotasks(4);

    expect(getSkeleton).toHaveBeenCalledWith(
      secondSegmentId,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(getSkeleton).not.toHaveBeenCalledWith(
      firstSegmentId,
      expect.anything(),
    );
    await execution.acceptedByQueue;
    expect(spatialSkeletonEditSession.getEditQueueRows()).toMatchObject([
      {
        intent: "execute",
        operationId: 1,
        lifecycle: { preview: "preparing", authority: "queued" },
      },
    ]);
    expect(spatialSkeletonEditSession.commandHistory.canUndo.value).toBe(true);
    expect(mergeSkeletons).not.toHaveBeenCalled();
    expect(
      spatialSkeletonEditSession.evictInactiveSegmentNodes([firstSegmentId]),
    ).toBe(false);
    expect(secondFetchSignal?.aborted).toBe(false);

    secondFetchResolved = true;
    resolveSecondFetch?.([secondNode]);
    await execution;
    await waitForMicrotasks(12);

    expect(
      spatialSkeletonEditSession
        .getCachedSegmentNodes(firstSegmentId)
        ?.map((node) => node.nodeId),
    ).toEqual([firstNode.nodeId, secondNode.nodeId]);
    expect(mergeSkeletons).toHaveBeenCalledWith(
      firstNode.nodeId,
      secondNode.nodeId,
    );
  });

  it("a merge waiting for a download uses the node's new skeleton when the server kept the other skeleton in an earlier merge", async () => {
    suppressStatusMessages();
    const nodes = makeRootRestorationNodesForTest();
    nodes[2] = { ...nodes[2], attributes: { confidence: [25] } };
    const target = {
      nodeId: 301n,
      segmentId: 23n,
      position: new Float32Array([301, 302, 303]),
    };
    let resolveFirst!: (result: {
      resultSegmentId: bigint;
      deletedSegmentId: bigint;
      directionAdjusted: boolean;
    }) => void;
    let resolveRead!: (nodes: SkeletonNode[]) => void;
    const mergeSkeletons = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        resultSegmentId: 17n,
        deletedSegmentId: 23n,
        directionAdjusted: false,
      });
    const getSkeleton = vi.fn(
      () =>
        new Promise<SkeletonNode[]>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const splitSkeleton = vi
      .fn()
      .mockResolvedValue({ existingSegmentId: 17n, newSegmentId: 29n });
    const rerootSkeleton = vi.fn().mockResolvedValue(undefined);
    const updateConfidence = vi.fn().mockResolvedValue(undefined);
    const { layer, spatialSkeletonEditSession: state } = makeAddNodeTestLayer({
      initialNodes: nodes,
      segmentId: 11n,
      segmentIds: [11n, 17n],
      mergeSkeletons,
      getSkeleton,
      splitSkeleton,
      rerootSkeleton,
      updateConfidence,
    });
    const first = executeSpatialSkeletonMerge(layer as any, nodes[1], nodes[4]);
    await first;
    const waiting = executeSpatialSkeletonMerge(
      layer as any,
      state.getCachedNode(102n)!,
      target,
    );
    await waiting.acceptedByQueue;
    await waitForMicrotasks(12);
    expect(getSkeleton).toHaveBeenCalledOnce();
    resolveFirst({
      resultSegmentId: 17n,
      deletedSegmentId: 11n,
      directionAdjusted: true,
    });
    await first.settled;
    expect(state.getCachedNode(102n)?.segmentId).toBe(17n);
    resolveRead([target]);
    await waiting;
    await expect(waiting.settled).resolves.toMatchObject({
      outcome: "committed",
    });
    expect(getSkeleton).toHaveBeenCalledOnce();
    expect(mergeSkeletons).toHaveBeenLastCalledWith(102n, 301n);
    expect(cachedTopologyForTest(state, [17n])).toEqual([
      [101n, 17n, 102n],
      [102n, 17n, 203n],
      [201n, 17n, null],
      [202n, 17n, 201n],
      [203n, 17n, 202n],
      [204n, 17n, 202n],
      [205n, 17n, 203n],
      [301n, 17n, 102n],
    ]);
    await undoSpatialSkeletonCommand(layer as any).settled;
    expect(state.getCachedNode(201n)).toMatchObject({
      segmentId: 17n,
      attributes: { confidence: [25] },
    });
    expect(state.getCachedNode(301n)).toMatchObject({
      segmentId: 29n,
      parentNodeId: undefined,
    });
    expect(state.getReloadRequired()).toBeUndefined();
  });

  it("Redo of a merge undone while its skeleton was still downloading saves it once", async () => {
    suppressStatusMessages();
    const first = {
      nodeId: 101n,
      segmentId: 11n,
      position: new Float32Array([1, 2, 3]),
    };
    const target = {
      nodeId: 201n,
      segmentId: 17n,
      position: new Float32Array([4, 5, 6]),
    };
    let resolveOldRead!: (nodes: SkeletonNode[]) => void;
    const getSkeleton = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<SkeletonNode[]>((resolve) => {
            resolveOldRead = resolve;
          }),
      )
      .mockResolvedValue([target]);
    const mergeSkeletons = vi.fn().mockResolvedValue({
      resultSegmentId: 11n,
      deletedSegmentId: 17n,
      directionAdjusted: false,
    });
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      initialNodes: [first],
      segmentId: 11n,
      getSkeleton,
      mergeSkeletons,
    });
    const original = executeSpatialSkeletonMerge(layer as any, first, target);
    await original.acceptedByQueue;
    await waitForMicrotasks(12);
    const undo = undoSpatialSkeletonCommand(layer as any);
    await Promise.all([original, undo]);
    expect(mergeSkeletons).not.toHaveBeenCalled();
    expect(spatialSkeletonEditSession.commandHistory.canRedo.value).toBe(true);
    const redo = redoSpatialSkeletonCommand(layer as any);
    await redo;
    await redo.settled;
    expect(mergeSkeletons).toHaveBeenCalledWith(101n, 201n);
    expect(spatialSkeletonEditSession.getCachedNode(201n)).toMatchObject({
      segmentId: 11n,
      parentNodeId: 101n,
    });
    resolveOldRead([target]);
    await waitForMicrotasks(12);
    expect(spatialSkeletonEditSession.getCachedNode(201n)?.segmentId).toBe(11n);
    expect(mergeSkeletons).toHaveBeenCalledOnce();
  });

  it("Redo of a merge undone before its preview appeared saves it once", async () => {
    suppressStatusMessages();
    const first = {
      nodeId: 101n,
      segmentId: 11n,
      position: new Float32Array([1, 2, 3]),
    };
    const target = {
      nodeId: 201n,
      segmentId: 17n,
      position: new Float32Array([4, 5, 6]),
    };
    let releasePreview!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releasePreview = resolve;
    });
    const prepare = SpatialSkeletonEditPreview.prototype.prepareExact;
    const previewPort: {
      prepareExact: (
        ...args: Parameters<typeof prepare>
      ) => ReturnType<typeof prepare> | Promise<ReturnType<typeof prepare>>;
    } = SpatialSkeletonEditPreview.prototype;
    const prepareSpy = vi
      .spyOn(previewPort, "prepareExact")
      .mockImplementationOnce(async function (
        this: SpatialSkeletonEditPreview,
        ...args
      ) {
        const prepared = prepare.apply(this, args);
        await barrier;
        return prepared;
      });
    const mergeSkeletons = vi.fn().mockResolvedValue({
      resultSegmentId: 11n,
      deletedSegmentId: 17n,
      directionAdjusted: false,
    });
    const { layer, spatialSkeletonEditSession: state } = makeAddNodeTestLayer({
      initialNodes: [first, target],
      segmentId: 11n,
      segmentIds: [11n, 17n],
      mergeSkeletons,
    });
    try {
      const original = executeSpatialSkeletonMerge(layer as any, first, target);
      await original.acceptedByQueue;
      await waitForMicrotasks(12);
      expect(prepareSpy).toHaveBeenCalledOnce();
      expect(mergeSkeletons).not.toHaveBeenCalled();
      await undoSpatialSkeletonCommand(layer as any);
      await original;
      const redo = redoSpatialSkeletonCommand(layer as any);
      await redo;
      await expect(redo.settled).resolves.toMatchObject({
        outcome: "committed",
      });
      expect(state.getCachedNode(201n)).toMatchObject({
        segmentId: 11n,
        parentNodeId: 101n,
      });
      releasePreview();
      await waitForMicrotasks(12);
      expect(mergeSkeletons).toHaveBeenCalledOnce();
      expect(state.getCachedNode(201n)?.segmentId).toBe(11n);
      expect(state.getReloadRequired()).toBeUndefined();
    } finally {
      releasePreview();
      prepareSpy.mockRestore();
    }
  });

  it.each([
    {
      kind: "merge",
      edit: (layer: unknown) =>
        executeSpatialSkeletonMerge(
          layer as any,
          { nodeId: 101n, segmentId: 11n },
          { nodeId: 201n, segmentId: 17n },
        ),
      message: "Inspect skeleton 11 before skeleton merging",
    },
    {
      kind: "move",
      edit: (layer: unknown) =>
        executeSpatialSkeletonMoveNode(layer as any, {
          node: {
            nodeId: 101n,
            segmentId: 23n,
            position: new Float32Array([1, 2, 3]),
          },
          nextPositionInModelSpace: new Float32Array([7, 8, 9]),
        }),
      message: "Inspect skeleton 23 before node movement",
    },
  ])(
    "refuses a $kind on a skeleton that has not been inspected, without downloading or queuing it",
    async ({ edit, message }) => {
      suppressStatusMessages();
      const getSkeleton = vi.fn();
      const {
        client,
        layer,
        spatialSkeletonEditSession: state,
      } = makeAddNodeTestLayer({
        initialNodes: [],
        segmentId: 11n,
        getSkeleton,
      });
      const execution = edit(layer);
      await expect(execution.acceptedByQueue).rejects.toThrow(message);
      await expect(execution).rejects.toThrow(message);

      expect(getSkeleton).not.toHaveBeenCalled();
      expect(countSentRequests(client)).toBe(0);
      expect(state.getEditQueueRows()).toEqual([]);
    },
  );

  it("a dragged node stays where the user holds it while an earlier move and a merge save", async () => {
    suppressStatusMessages();
    const firstSegmentId = 11n;
    const secondSegmentId = 17n;
    const firstNode: SkeletonNode = {
      nodeId: 101n,
      segmentId: firstSegmentId,
      position: new Float32Array([1, 2, 3]),
    };
    const secondNode: SkeletonNode = {
      nodeId: 201n,
      segmentId: secondSegmentId,
      position: new Float32Array([4, 5, 6]),
    };
    let resolveMerge:
      | ((result: {
          resultSegmentId: bigint;
          deletedSegmentId: bigint;
          directionAdjusted: boolean;
        }) => void)
      | undefined;
    const mergeSkeletons = vi.fn(
      () =>
        new Promise<{
          resultSegmentId: bigint;
          deletedSegmentId: bigint;
          directionAdjusted: boolean;
        }>((resolve) => {
          resolveMerge = resolve;
        }),
    );
    const moveNode = vi.fn(() => new Promise(() => {}));
    const getSkeleton = vi.fn(
      (_segmentId: bigint, options?: { signal?: AbortSignal }) =>
        new Promise<SkeletonNode[]>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        }),
    );
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      initialNodes: [firstNode, secondNode],
      segmentId: firstSegmentId,
      segmentIds: [firstSegmentId, secondSegmentId],
      getSkeleton,
      mergeSkeletons,
      moveNode,
    });

    await executeSpatialSkeletonMerge(layer as any, firstNode, secondNode);
    const nextPosition = new Float32Array([10, 20, 30]);
    await executeSpatialSkeletonMoveNode(layer as any, {
      node: spatialSkeletonEditSession.getCachedNode(firstNode.nodeId)!,
      nextPositionInModelSpace: nextPosition,
    });
    expect(moveNode).not.toHaveBeenCalled();

    const interactionPosition = new Float32Array([40, 50, 60]);
    spatialSkeletonEditSession.setPendingNodePosition(
      firstNode.nodeId,
      interactionPosition,
    );
    // Removing the previewed complete snapshot forces confirmation through
    // rollback/rebase/replay, while the interaction override stays visible.
    replaceCachedSegmentForTest(
      spatialSkeletonEditSession,
      firstSegmentId,
      undefined,
    );
    resolveMerge?.({
      resultSegmentId: firstSegmentId,
      deletedSegmentId: secondSegmentId,
      directionAdjusted: false,
    });
    await waitForMicrotasks(16);

    expect(moveNode).toHaveBeenCalledTimes(1);
    expect(
      Array.from(
        spatialSkeletonEditSession.getPendingNodePosition(firstNode.nodeId)!,
      ),
    ).toEqual(Array.from(interactionPosition));
    const updatedInteractionPosition = new Float32Array([70, 80, 90]);
    spatialSkeletonEditSession.setPendingNodePosition(
      firstNode.nodeId,
      updatedInteractionPosition,
    );
    expect(
      Array.from(
        spatialSkeletonEditSession.getPendingNodePosition(firstNode.nodeId)!,
      ),
    ).toEqual(Array.from(updatedInteractionPosition));

    spatialSkeletonEditSession.clearPendingNodePositions();
    expect(
      spatialSkeletonEditSession.getPendingNodePosition(firstNode.nodeId),
    ).toBeUndefined();
    expect(
      Array.from(
        spatialSkeletonEditSession.getCachedNode(firstNode.nodeId)!.position,
      ),
    ).toEqual(Array.from(nextPosition));
    spatialSkeletonEditSession.clearRuntimeState();
  });

  it("does not download the skeleton again after a merge saves", async () => {
    vi.useFakeTimers();
    try {
      suppressStatusMessages();
      const showErrorMessage = vi.mocked(StatusMessage.showErrorMessage);
      const firstSegmentId = 11n;
      const secondSegmentId = 17n;
      const firstNode: SkeletonNode = {
        nodeId: 101n,
        segmentId: firstSegmentId,
        position: new Float32Array([1, 2, 3]),
      };
      const secondNode: SkeletonNode = {
        nodeId: 201n,
        segmentId: secondSegmentId,
        position: new Float32Array([4, 5, 6]),
      };
      const getSkeleton = vi
        .fn()
        .mockRejectedValue(new Error("unexpected topology read"));
      const mergeSkeletons = vi.fn().mockResolvedValue({
        resultSegmentId: firstSegmentId,
        deletedSegmentId: secondSegmentId,
        directionAdjusted: false,
      });
      const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
        initialNodes: [firstNode, secondNode],
        segmentId: firstSegmentId,
        segmentIds: [firstSegmentId, secondSegmentId],
        mergeSkeletons,
        getSkeleton,
      });

      await afterDisplayTurnWithFakeTimers(
        executeSpatialSkeletonMerge(layer as any, firstNode, secondNode),
      );
      await waitForMicrotasks(20);

      expect(getSkeleton).not.toHaveBeenCalled();
      expect(showErrorMessage).not.toHaveBeenCalled();

      vi.advanceTimersByTime(30_000);
      await waitForMicrotasks(20);
      expect(getSkeleton).not.toHaveBeenCalled();

      spatialSkeletonEditSession.clearRuntimeState();
    } finally {
      vi.useRealTimers();
    }
  });

  it("undoing two merges quickly restores two separate skeletons while the first Undo is still saving", async () => {
    suppressStatusMessages();
    const resultSegmentId = 11n;
    const firstDeletedSegmentId = 17n;
    const secondDeletedSegmentId = 23n;
    const firstRestoredSegmentId = 19n;
    const secondRestoredSegmentId = 29n;
    const firstRoot: SkeletonNode = {
      nodeId: 101n,
      segmentId: resultSegmentId,
      position: new Float32Array([1, 2, 3]),
    };
    const secondRoot: SkeletonNode = {
      nodeId: 201n,
      segmentId: firstDeletedSegmentId,
      position: new Float32Array([4, 5, 6]),
    };
    const thirdRoot: SkeletonNode = {
      nodeId: 301n,
      segmentId: secondDeletedSegmentId,
      position: new Float32Array([7, 8, 9]),
    };
    const mergeSkeletons = vi
      .fn()
      .mockResolvedValueOnce({
        resultSegmentId,
        deletedSegmentId: firstDeletedSegmentId,
        directionAdjusted: false,
      })
      .mockResolvedValueOnce({
        resultSegmentId,
        deletedSegmentId: secondDeletedSegmentId,
        directionAdjusted: false,
      });
    const splitResolvers: Array<
      (result: { existingSegmentId: bigint; newSegmentId: bigint }) => void
    > = [];
    const splitSkeleton = vi.fn(
      (_nodeId: bigint) =>
        new Promise<{ existingSegmentId: bigint; newSegmentId: bigint }>(
          (resolve) => splitResolvers.push(resolve),
        ),
    );
    const getSkeleton = vi.fn(async (segmentId: bigint) => {
      if (segmentId === resultSegmentId) {
        const nodes = [cloneNode(firstRoot)];
        if (splitSkeleton.mock.calls.length < 2) {
          nodes.push({
            ...cloneNode(secondRoot),
            segmentId: resultSegmentId,
            parentNodeId: firstRoot.nodeId,
          });
        }
        if (
          mergeSkeletons.mock.calls.length >= 2 &&
          splitSkeleton.mock.calls.length === 0
        ) {
          nodes.push({
            ...cloneNode(thirdRoot),
            segmentId: resultSegmentId,
            parentNodeId: firstRoot.nodeId,
          });
        }
        return nodes;
      }
      if (segmentId === firstRestoredSegmentId) {
        return [
          { ...cloneNode(secondRoot), segmentId: firstRestoredSegmentId },
        ];
      }
      if (segmentId === secondRestoredSegmentId) {
        return [
          { ...cloneNode(thirdRoot), segmentId: secondRestoredSegmentId },
        ];
      }
      return [];
    });
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      initialNodes: [firstRoot, secondRoot, thirdRoot],
      segmentId: resultSegmentId,
      segmentIds: [
        resultSegmentId,
        firstDeletedSegmentId,
        secondDeletedSegmentId,
      ],
      mergeSkeletons,
      splitSkeleton,
      getSkeleton,
    });

    const firstMerge = executeSpatialSkeletonMerge(
      layer as any,
      firstRoot,
      secondRoot,
    );
    await firstMerge;
    await firstMerge.settled;
    const secondMerge = executeSpatialSkeletonMerge(
      layer as any,
      spatialSkeletonEditSession.getCachedNode(firstRoot.nodeId)!,
      thirdRoot,
    );
    await secondMerge;
    await secondMerge.settled;

    const undoThird = undoSpatialSkeletonCommand(layer as any);
    const undoSecond = undoSpatialSkeletonCommand(layer as any);
    await expect(undoThird.acceptedByQueue).resolves.toBeUndefined();
    await expect(undoSecond.acceptedByQueue).resolves.toBeUndefined();
    await expect(undoThird).resolves.toBe(true);
    await expect(undoSecond).resolves.toBe(true);
    await waitForMicrotasks(8);

    const undoEntries = spatialSkeletonEditSession
      .getEditQueueRows()
      .filter(
        (entry) => entry.kind === "mergeSkeletons" && entry.intent === "undo",
      );
    expect(undoEntries).toHaveLength(2);
    const thirdUndoSegmentId = spatialSkeletonEditSession.getCachedNode(
      thirdRoot.nodeId,
    )!.segmentId;
    const secondUndoSegmentId = spatialSkeletonEditSession.getCachedNode(
      secondRoot.nodeId,
    )!.segmentId;
    expect(thirdUndoSegmentId).not.toBe(secondUndoSegmentId);
    expect(
      spatialSkeletonEditSession.getCachedNode(thirdRoot.nodeId),
    ).toMatchObject({
      parentNodeId: undefined,
      segmentId: thirdUndoSegmentId,
    });
    expect(
      spatialSkeletonEditSession.getCachedNode(secondRoot.nodeId),
    ).toMatchObject({
      parentNodeId: undefined,
      segmentId: secondUndoSegmentId,
    });
    expect(splitSkeleton).toHaveBeenCalledTimes(1);

    splitResolvers[0]!({
      existingSegmentId: resultSegmentId,
      newSegmentId: secondRestoredSegmentId,
    });
    await waitForMicrotasks(12);
    expect(splitSkeleton).toHaveBeenCalledTimes(2);
    splitResolvers[1]!({
      existingSegmentId: resultSegmentId,
      newSegmentId: firstRestoredSegmentId,
    });
    await waitForMicrotasks(16);

    expect(splitSkeleton.mock.calls.map(([nodeId]) => nodeId)).toEqual([
      thirdRoot.nodeId,
      secondRoot.nodeId,
    ]);
    const provisionalSegmentIds = new Set([
      thirdUndoSegmentId,
      secondUndoSegmentId,
    ]);
    expect(
      getSkeleton.mock.calls.some(([segmentId]) =>
        provisionalSegmentIds.has(segmentId),
      ),
    ).toBe(false);
    expect(
      getSkeleton.mock.calls.some(
        ([segmentId]) =>
          segmentId === firstDeletedSegmentId ||
          segmentId === secondDeletedSegmentId,
      ),
    ).toBe(false);
    expect(
      spatialSkeletonEditSession.getCachedNode(secondRoot.nodeId)?.segmentId,
    ).toBe(firstRestoredSegmentId);
    expect(
      spatialSkeletonEditSession.getCachedNode(thirdRoot.nodeId)?.segmentId,
    ).toBe(secondRestoredSegmentId);
    const identities = spatialSkeletonEditSession.getEditingIdentityService();
    expect(
      identities.resolveSegment(
        identities.getOrCreateSegmentHandle(firstDeletedSegmentId),
      ),
    ).toBe(firstRestoredSegmentId);
    expect(
      identities.resolveSegment(
        identities.getOrCreateSegmentHandle(secondDeletedSegmentId),
      ),
    ).toBe(secondRestoredSegmentId);
    expect(spatialSkeletonEditSession.commandHistory.canUndo.value).toBe(false);
  });

  it.each([false, true])(
    "Undo of a merge restores the right skeleton when the server kept the other one (Redo already queued: %s)",
    async (queueRedo) => {
      suppressStatusMessages();
      const nodes = makeRootRestorationNodesForTest();
      let resolveMerge!: (result: {
        resultSegmentId: bigint;
        deletedSegmentId: bigint;
        directionAdjusted: boolean;
      }) => void;
      const mergeSkeletons = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveMerge = resolve;
            }),
        )
        .mockResolvedValue({
          resultSegmentId: 17n,
          deletedSegmentId: 23n,
          directionAdjusted: false,
        });
      const splitSkeleton = vi
        .fn()
        .mockResolvedValueOnce({ existingSegmentId: 17n, newSegmentId: 23n })
        .mockResolvedValueOnce({ existingSegmentId: 17n, newSegmentId: 29n });
      const rerootSkeleton = vi.fn(async () => undefined);
      const { layer, spatialSkeletonEditSession: state } = makeAddNodeTestLayer(
        {
          initialNodes: nodes,
          segmentId: 11n,
          segmentIds: [11n, 17n],
          mergeSkeletons,
          splitSkeleton,
          rerootSkeleton,
        },
      );
      const merge = executeSpatialSkeletonMerge(
        layer as any,
        nodes[1],
        nodes[4],
      );
      await merge;
      const undo = undoSpatialSkeletonCommand(layer as any);
      await undo;
      expect(splitSkeleton).not.toHaveBeenCalled();
      const queuedRedo = queueRedo
        ? redoSpatialSkeletonCommand(layer as any)
        : undefined;
      if (queuedRedo !== undefined) await queuedRedo;

      resolveMerge({
        resultSegmentId: 17n,
        deletedSegmentId: 11n,
        directionAdjusted: true,
      });
      await expect(merge.settled).resolves.toMatchObject({
        outcome: "committed",
      });
      await expect(undo.settled).resolves.toMatchObject({
        outcome: "committed",
      });
      expect(state.getReloadRequired()).toBeUndefined();
      expect(splitSkeleton).toHaveBeenCalledWith(102n);
      expect(rerootSkeleton).toHaveBeenCalledWith(101n);
      if (!queueRedo) {
        expect(cachedTopologyForTest(state, [17n, 23n])).toEqual([
          [101n, 23n, null],
          [102n, 23n, 101n],
          [201n, 17n, null],
          [202n, 17n, 201n],
          [203n, 17n, 202n],
          [204n, 17n, 202n],
          [205n, 17n, 203n],
        ]);
      }
      const redo = queuedRedo ?? redoSpatialSkeletonCommand(layer as any);
      await redo;
      await expect(redo.settled).resolves.toMatchObject({
        outcome: "committed",
      });
      expect(state.getCachedNode(102n)?.parentNodeId).toBe(203n);
      const undoAgain = undoSpatialSkeletonCommand(layer as any);
      await undoAgain;
      await expect(undoAgain.settled).resolves.toMatchObject({
        outcome: "committed",
      });
      expect(splitSkeleton.mock.calls).toEqual([[102n], [102n]]);
      expect(state.getCachedNode(101n)).toMatchObject({
        segmentId: 29n,
        parentNodeId: undefined,
      });
      expect(state.getCachedNode(201n)).toMatchObject({
        segmentId: 17n,
        parentNodeId: undefined,
      });
      expect(state.getReloadRequired()).toBeUndefined();
    },
  );

  it.each([0, 100])(
    "Undo of a reroot that follows a merge in which the server kept the other skeleton restores the root and its confidence %i",
    async (confidence) => {
      suppressStatusMessages();
      const nodes = makeRootRestorationNodesForTest();
      nodes[0] = { ...nodes[0], attributes: { confidence: [60] } };
      nodes[2] = { ...nodes[2], attributes: { confidence: [confidence] } };
      let resolveMerge!: (result: {
        resultSegmentId: bigint;
        deletedSegmentId: bigint;
        directionAdjusted: boolean;
      }) => void;
      const mergeSkeletons = vi.fn(
        () =>
          new Promise((resolve) => {
            resolveMerge = resolve;
          }),
      );
      const rerootSkeleton = vi.fn(async () => undefined);
      const updateConfidence = vi.fn(async () => undefined);
      const { layer, spatialSkeletonEditSession: state } = makeAddNodeTestLayer(
        {
          initialNodes: nodes,
          segmentId: 11n,
          segmentIds: [11n, 17n],
          mergeSkeletons,
          rerootSkeleton,
          updateConfidence,
        },
      );
      const merge = executeSpatialSkeletonMerge(
        layer as any,
        nodes[1],
        nodes[4],
      );
      await merge;
      const reroot = executeSpatialSkeletonReroot(
        layer as any,
        state.getCachedNode(102n)!,
      );
      await reroot;
      resolveMerge({
        resultSegmentId: 17n,
        deletedSegmentId: 11n,
        directionAdjusted: true,
      });
      await expect(merge.settled).resolves.toMatchObject({
        outcome: "committed",
      });
      await expect(reroot.settled).resolves.toMatchObject({
        outcome: "committed",
      });

      for (let cycle = 0; cycle < 2; ++cycle) {
        const undo = undoSpatialSkeletonCommand(layer as any);
        await undo;
        await expect(undo.settled).resolves.toMatchObject({
          outcome: "committed",
        });
        expect(state.getCachedNode(201n)).toMatchObject({
          parentNodeId: undefined,
          attributes: { confidence: [confidence] },
        });
        expect(state.getCachedNode(102n)?.parentNodeId).toBe(203n);
        if (cycle === 0) {
          const redo = redoSpatialSkeletonCommand(layer as any);
          await redo;
          await expect(redo.settled).resolves.toMatchObject({
            outcome: "committed",
          });
        }
      }
      expect(rerootSkeleton.mock.calls).toEqual([
        [102n],
        [201n],
        [102n],
        [201n],
      ]);
      expect(updateConfidence.mock.calls).toEqual(
        confidence === 100
          ? []
          : [
              [201n, confidence],
              [201n, confidence],
            ],
      );
      expect(state.getReloadRequired()).toBeUndefined();
    },
  );

  it.each(["delete", "split", "confidence"] as const)(
    "Undo and Redo of a %s queued behind a merge in which the server kept the other skeleton act on the right nodes",
    async (kind) => {
      suppressStatusMessages();
      const nodes = makeRootRestorationNodesForTest();
      nodes[3] = { ...nodes[3], attributes: { confidence: [25] } };
      nodes[4] = { ...nodes[4], attributes: { confidence: [75] } };
      let resolveMerge!: (result: {
        resultSegmentId: bigint;
        deletedSegmentId: bigint;
        directionAdjusted: boolean;
      }) => void;
      const mergeSkeletons = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveMerge = resolve;
            }),
        )
        .mockResolvedValueOnce({
          resultSegmentId: 17n,
          deletedSegmentId: 23n,
          directionAdjusted: false,
        })
        .mockResolvedValueOnce({
          resultSegmentId: 17n,
          deletedSegmentId: 29n,
          directionAdjusted: false,
        });
      const deleteNode = vi.fn().mockResolvedValue(undefined);
      const insertNode = vi
        .fn()
        .mockResolvedValueOnce({ nodeId: 302n, segmentId: 17n })
        .mockResolvedValueOnce({ nodeId: 402n, segmentId: 17n });
      const splitSkeleton = vi
        .fn()
        .mockResolvedValueOnce({ existingSegmentId: 17n, newSegmentId: 23n })
        .mockResolvedValueOnce({ existingSegmentId: 17n, newSegmentId: 29n });
      const updateConfidence = vi.fn().mockResolvedValue(undefined);
      const { layer, spatialSkeletonEditSession: state } = makeAddNodeTestLayer(
        {
          initialNodes: nodes,
          segmentId: 11n,
          segmentIds: [11n, 17n],
          mergeSkeletons,
          deleteNode,
          insertNode,
          splitSkeleton,
          updateConfidence,
        },
      );
      const merge = executeSpatialSkeletonMerge(
        layer as any,
        nodes[1],
        nodes[4],
      );
      await merge;
      const target = state.getCachedNode(202n)!;
      expect(target).toMatchObject({
        parentNodeId: 203n,
        attributes: { confidence: [75] },
      });
      const edit =
        kind === "delete"
          ? executeSpatialSkeletonDeleteNode(layer as any, target)
          : kind === "split"
            ? executeSpatialSkeletonSplit(layer as any, target)
            : executeSpatialSkeletonNodeConfidenceUpdate(layer as any, {
                node: target,
                nextConfidence: 50,
              });
      await edit;
      expect(deleteNode).not.toHaveBeenCalled();
      expect(splitSkeleton).not.toHaveBeenCalled();
      expect(updateConfidence).not.toHaveBeenCalled();
      resolveMerge({
        resultSegmentId: 17n,
        deletedSegmentId: 11n,
        directionAdjusted: true,
      });
      await expect(merge.settled).resolves.toMatchObject({
        outcome: "committed",
      });
      await expect(edit.settled).resolves.toMatchObject({
        outcome: "committed",
      });

      for (let cycle = 0; cycle < 2; ++cycle) {
        const undo = undoSpatialSkeletonCommand(layer as any);
        await undo;
        await expect(undo.settled).resolves.toMatchObject({
          outcome: "committed",
        });
        const restoredId =
          kind === "delete" ? 302n + BigInt(cycle) * 100n : 202n;
        expect(cachedTopologyForTest(state, [17n])).toEqual([
          [101n, 17n, 102n],
          [102n, 17n, 203n],
          [201n, 17n, null],
          ...(kind === "delete" ? [] : [[202n, 17n, 201n]]),
          [203n, 17n, restoredId],
          [204n, 17n, restoredId],
          [205n, 17n, 203n],
          ...(kind === "delete" ? [[restoredId, 17n, 201n]] : []),
        ]);
        expect(
          getSkeletonNodeConfidence(state.getCachedNode(restoredId)!),
        ).toBe(25);
        if (kind === "delete") {
          expect(insertNode).toHaveBeenNthCalledWith(
            cycle + 1,
            202,
            203,
            204,
            201n,
            [203n, 204n],
          );
          expect(updateConfidence).toHaveBeenNthCalledWith(
            cycle + 1,
            restoredId,
            25,
          );
        } else if (kind === "split") {
          expect(mergeSkeletons).toHaveBeenNthCalledWith(cycle + 2, 201n, 202n);
        } else {
          expect(updateConfidence).toHaveBeenNthCalledWith(
            cycle * 2 + 2,
            202n,
            25,
          );
        }
        if (cycle === 0) {
          const redo = redoSpatialSkeletonCommand(layer as any);
          await redo;
          await expect(redo.settled).resolves.toMatchObject({
            outcome: "committed",
          });
          if (kind === "delete") {
            expect(deleteNode.mock.calls).toEqual([[202n], [302n]]);
          } else if (kind === "split") {
            expect(splitSkeleton.mock.calls).toEqual([[202n], [202n]]);
          } else {
            expect(updateConfidence).toHaveBeenLastCalledWith(202n, 50);
          }
        }
      }
      expect(state.getReloadRequired()).toBeUndefined();
    },
  );

  it.each([false, true])(
    "Undo of two chained merges restores each root and its confidence (server kept the other skeleton in the second: %s)",
    async (secondDirectionAdjusted) => {
      suppressStatusMessages();
      const nodes = makeRootRestorationNodesForTest();
      nodes[0] = { ...nodes[0], attributes: { confidence: [60] } };
      nodes[2] = { ...nodes[2], attributes: { confidence: [25] } };
      nodes.push({
        nodeId: 301n,
        segmentId: 23n,
        position: new Float32Array([301, 302, 303]),
      });
      let resolveFirst!: (result: {
        resultSegmentId: bigint;
        deletedSegmentId: bigint;
        directionAdjusted: boolean;
      }) => void;
      const mergeSkeletons = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockResolvedValueOnce({
          resultSegmentId: 23n,
          deletedSegmentId: 17n,
          directionAdjusted: secondDirectionAdjusted,
        })
        .mockResolvedValueOnce({
          resultSegmentId: 23n,
          deletedSegmentId: 29n,
          directionAdjusted: false,
        });
      const splitSkeleton = vi
        .fn()
        .mockResolvedValueOnce({ existingSegmentId: 23n, newSegmentId: 29n })
        .mockResolvedValueOnce({ existingSegmentId: 23n, newSegmentId: 31n });
      const rerootSkeleton = vi.fn().mockResolvedValue(undefined);
      const updateConfidence = vi.fn().mockResolvedValue(undefined);
      const { layer, spatialSkeletonEditSession: state } = makeAddNodeTestLayer(
        {
          initialNodes: nodes,
          segmentId: 11n,
          segmentIds: [11n, 17n, 23n],
          mergeSkeletons,
          splitSkeleton,
          rerootSkeleton,
          updateConfidence,
        },
      );
      const first = executeSpatialSkeletonMerge(
        layer as any,
        nodes[1],
        nodes[4],
      );
      await first;
      const second = executeSpatialSkeletonMerge(
        layer as any,
        state.getCachedNode(secondDirectionAdjusted ? 102n : 301n)!,
        state.getCachedNode(secondDirectionAdjusted ? 301n : 102n)!,
      );
      await second;
      expect(mergeSkeletons).toHaveBeenCalledTimes(1);
      resolveFirst({
        resultSegmentId: 17n,
        deletedSegmentId: 11n,
        directionAdjusted: true,
      });
      await waitForMicrotasks(16);
      expect(state.getReloadRequired()).toBeUndefined();
      await expect(first.settled).resolves.toMatchObject({
        outcome: "committed",
      });
      await expect(second.settled).resolves.toMatchObject({
        outcome: "committed",
      });

      for (let cycle = 0; cycle < 2; ++cycle) {
        const undo = undoSpatialSkeletonCommand(layer as any);
        await undo;
        await expect(undo.settled).resolves.toMatchObject({
          outcome: "committed",
        });
        const restoredSegmentId = cycle === 0 ? 29n : 31n;
        expect(cachedTopologyForTest(state, [restoredSegmentId, 23n])).toEqual([
          [101n, restoredSegmentId, 102n],
          [102n, restoredSegmentId, 203n],
          [201n, restoredSegmentId, null],
          [202n, restoredSegmentId, 201n],
          [203n, restoredSegmentId, 202n],
          [204n, restoredSegmentId, 202n],
          [205n, restoredSegmentId, 203n],
          [301n, 23n, null],
        ]);
        expect(getSkeletonNodeConfidence(state.getCachedNode(201n)!)).toBe(25);
        expect(rerootSkeleton).toHaveBeenNthCalledWith(cycle + 1, 201n);
        expect(updateConfidence).toHaveBeenNthCalledWith(cycle + 1, 201n, 25);
        if (cycle === 0) {
          const redo = redoSpatialSkeletonCommand(layer as any);
          await redo;
          await expect(redo.settled).resolves.toMatchObject({
            outcome: "committed",
          });
          expect(mergeSkeletons).toHaveBeenLastCalledWith(301n, 102n);
        }
      }
      expect(state.getReloadRequired()).toBeUndefined();
    },
  );

  it("Undo of a merge in which the server kept the other skeleton brings back the skeleton the user merged away", async () => {
    suppressStatusMessages();
    const firstSegmentId = 11n;
    const winningSegmentId = 17n;
    const restoredSegmentId = 19n;
    const firstRoot: SkeletonNode = {
      nodeId: 101n,
      segmentId: firstSegmentId,
      position: new Float32Array([1, 2, 3]),
    };
    const secondRoot: SkeletonNode = {
      nodeId: 201n,
      segmentId: winningSegmentId,
      position: new Float32Array([4, 5, 6]),
    };
    const mergeSkeletons = vi.fn().mockResolvedValue({
      resultSegmentId: winningSegmentId,
      deletedSegmentId: firstSegmentId,
      directionAdjusted: true,
    });
    let resolveSplit:
      | ((result: { existingSegmentId: bigint; newSegmentId: bigint }) => void)
      | undefined;
    const splitSkeleton = vi.fn(
      () =>
        new Promise<{ existingSegmentId: bigint; newSegmentId: bigint }>(
          (resolve) => {
            resolveSplit = resolve;
          },
        ),
    );
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      initialNodes: [firstRoot, secondRoot],
      segmentId: firstSegmentId,
      segmentIds: [firstSegmentId, winningSegmentId],
      mergeSkeletons,
      splitSkeleton,
    });

    const merge = executeSpatialSkeletonMerge(
      layer as any,
      firstRoot,
      secondRoot,
    );
    await merge;
    await vi.waitFor(() => expect(mergeSkeletons).toHaveBeenCalledTimes(1));
    await expect(merge.settled).resolves.toMatchObject({
      outcome: "committed",
    });
    const identities = spatialSkeletonEditSession.getEditingIdentityService();
    expect(
      identities.resolveSegment(
        identities.getOrCreateSegmentHandle(firstSegmentId),
      ),
    ).toBe(winningSegmentId);
    expect(spatialSkeletonEditSession.commandHistory.canUndo.value).toBe(true);
    const undo = undoSpatialSkeletonCommand(layer as any);
    await expect(undo.acceptedByQueue).resolves.toBeUndefined();
    await expect(undo).resolves.toBe(true);

    const undoEntry = spatialSkeletonEditSession
      .getEditQueueRows()
      .find(
        (entry) => entry.kind === "mergeSkeletons" && entry.intent === "undo",
      );
    expect(undoEntry).toBeDefined();
    const restoredPreviewSegmentId = spatialSkeletonEditSession.getCachedNode(
      firstRoot.nodeId,
    )!.segmentId;
    expect(restoredPreviewSegmentId).not.toBe(winningSegmentId);
    expect(
      spatialSkeletonEditSession.getCachedNode(firstRoot.nodeId),
    ).toMatchObject({
      parentNodeId: undefined,
      segmentId: restoredPreviewSegmentId,
    });
    resolveSplit?.({
      existingSegmentId: winningSegmentId,
      newSegmentId: restoredSegmentId,
    });
    await waitForMicrotasks(16);
    expect(splitSkeleton).toHaveBeenCalledWith(firstRoot.nodeId);
    expect(
      spatialSkeletonEditSession.getCachedNode(firstRoot.nodeId),
    ).toMatchObject({
      segmentId: restoredSegmentId,
    });
  });

  it.each([
    new HttpError(
      "https://catmaid.example.test/1/skeleton/reroot",
      409,
      "Conflict",
    ),
    new Error("Reroot response lost"),
  ])("requires reload when merge undo's reroot fails: %s", async (error) => {
    suppressStatusMessages();

    const firstSegmentId = 11n;
    const secondSegmentId = 17n;
    const restoredSegmentId = 19n;
    const firstRoot: SkeletonNode = {
      nodeId: 101n,
      segmentId: firstSegmentId,
      position: new Float32Array([1, 2, 3]),
    };
    const secondRoot: SkeletonNode = {
      nodeId: 201n,
      segmentId: secondSegmentId,
      position: new Float32Array([4, 5, 6]),
    };
    const secondAttach: SkeletonNode = {
      nodeId: 202n,
      segmentId: secondSegmentId,
      parentNodeId: secondRoot.nodeId,
      position: new Float32Array([7, 8, 9]),
    };
    const mergeSkeletons = vi.fn().mockResolvedValue({
      resultSegmentId: firstSegmentId,
      deletedSegmentId: secondSegmentId,
      directionAdjusted: false,
    });
    let resolveSplit: (() => void) | undefined;
    const splitPromise = new Promise<any>((resolve) => {
      resolveSplit = () => {
        resolve({
          existingSegmentId: firstSegmentId,
          newSegmentId: restoredSegmentId,
        });
      };
    });
    const splitSkeleton = vi.fn(() => splitPromise);
    const rerootSkeleton = vi.fn().mockRejectedValue(error);
    const moveNode = vi.fn().mockResolvedValue({});
    const getSkeleton = vi.fn();
    const { layer, spatialSkeletonEditSession } = makeAddNodeTestLayer({
      initialNodes: [firstRoot, secondRoot, secondAttach],
      segmentId: firstSegmentId,
      segmentIds: [firstSegmentId, secondSegmentId],
      mergeSkeletons,
      splitSkeleton,
      rerootSkeleton,
      moveNode,
      getSkeleton,
    });
    const merge = executeSpatialSkeletonMerge(
      layer as any,
      firstRoot,
      secondAttach,
    );
    await merge;
    await merge.settled;
    const undo = undoSpatialSkeletonCommand(layer as any);
    await expect(undo.acceptedByQueue).resolves.toBeUndefined();
    const move = executeSpatialSkeletonMoveNode(layer as any, {
      node: spatialSkeletonEditSession.getCachedNode(secondRoot.nodeId)!,
      nextPositionInModelSpace: new Float32Array([40, 50, 60]),
    });
    await move;
    expect(
      Array.from(
        spatialSkeletonEditSession.getCachedNode(secondRoot.nodeId)!.position,
      ),
    ).toEqual([40, 50, 60]);
    expect(moveNode).not.toHaveBeenCalled();

    const undoSettled = vi.fn();
    void undo.settled.then(undoSettled);
    resolveSplit?.();
    await expect(undo).resolves.toBe(true);
    await waitForMicrotasks(60);

    expect(splitSkeleton).toHaveBeenCalledWith(secondAttach.nodeId);
    expect(rerootSkeleton).toHaveBeenCalledWith(secondRoot.nodeId);
    expectReloadRequired(spatialSkeletonEditSession, "committed");
    expect(undoSettled).not.toHaveBeenCalled();
    await expect(move.settled).resolves.toMatchObject({
      outcome: "unchanged",
      reason: "not-started",
    });
    expect(getSkeleton).not.toHaveBeenCalled();
    expect(moveNode).not.toHaveBeenCalled();
    expect(spatialSkeletonEditSession.commandHistory.canUndo.value).toBe(false);
    expect(spatialSkeletonEditSession.commandHistory.canRedo.value).toBe(false);
  });
});

describe("skeleton edit failure messages", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each([
    [
      "an error with a cause",
      new Error("edit failed", { cause: new Error("provider unavailable") }),
      "Failed to delete node: edit failed: provider unavailable",
    ],
    [
      "a value that cannot be converted to a string",
      Object.create(null),
      "Failed to delete node: Unknown error",
    ],
  ] as const)("shows %s as a temporary message", (_name, error, message) => {
    suppressStatusMessages();
    showSpatialSkeletonActionError(SpatialSkeletonActions.deleteNodes, error);
    expect(StatusMessage.showTemporaryMessage).toHaveBeenCalledWith(message);
    expect(StatusMessage.showErrorMessage).not.toHaveBeenCalled();
  });

  it("tells the user to refresh the page after an outdated-state conflict", () => {
    suppressStatusMessages();
    showSpatialSkeletonActionError(
      SpatialSkeletonActions.deleteNodes,
      new SpatialSkeletonEditConflictError(),
    );
    expect(StatusMessage.showErrorMessage).toHaveBeenCalledWith(
      "Failed to delete node due to outdated state. Refresh the page to sync.",
    );
  });
});

describe("skeleton reroot command", () => {
  it("rerooting the root node is refused and says it is already root", () => {
    const executeEdit = vi.fn();
    const layer = {
      spatialSkeletonEditSession: { executeEdit },
      getSpatiallyIndexedSkeletonLayer: () => undefined,
    };
    expect(() =>
      executeSpatialSkeletonReroot(layer as any, {
        nodeId: 17n,
        segmentId: 23n,
        position: new Float32Array([1, 2, 3]),
      }),
    ).toThrow("Node 17 is already root.");
    expect(executeEdit).not.toHaveBeenCalled();
  });
});

describe("skeletons an edit reads", () => {
  it("queues an edit at once and downloads its other skeletons only when its turn comes", async () => {
    const { layer, getSkeleton } = makeQueueInputLayer([11n]);
    const submit = vi.fn(() => makeEditExecution(Promise.resolve()));
    prepareAndSubmitSpatialSkeletonEdit(
      layer,
      makeQueueInputCommand([{ segmentId: 11n }], [{ segmentId: 21n }]),
      submit,
    );
    expect(submit).toHaveBeenCalledOnce();
    expect(getSkeleton).not.toHaveBeenCalled();
  });

  it("reads a skeleton once when one edit names it twice", async () => {
    const { layer } = makeQueueInputLayer([11n, 21n]);
    const policy = createSpatialSkeletonQueueInputPreparation(
      layer,
      makeQueueInputCommand(
        [{ segmentId: 11n }, { segmentId: 11n, nodeId: 12n }],
        [{ segmentId: 21n }],
      ),
    );
    const releaseAdmission = policy.validate("execute");
    const prepared = await policy.acquire(
      new AbortController().signal,
      "execute",
    );
    expect(prepared.input.segments.map(({ segmentId }) => segmentId)).toEqual([
      11n,
      21n,
    ]);
    prepared.release();
    releaseAdmission();
  });

  it("an edit that needs no existing skeleton, such as a new skeleton's first node, starts without a download", async () => {
    const { layer, getSkeleton } = makeQueueInputLayer();
    const policy = createSpatialSkeletonQueueInputPreparation(
      layer,
      makeQueueInputCommand([]),
    );
    const release = policy.validate("execute");
    const prepared = await policy.acquire(
      new AbortController().signal,
      "execute",
    );
    expect(prepared.input).toEqual({ segments: [] });
    expect(getSkeleton).not.toHaveBeenCalled();
    prepared.release();
    release();
  });

  it("an edit uses the skeleton as it is when its turn comes, not as it was when the edit was queued", async () => {
    const { layer, state } = makeQueueInputLayer([11n]);
    const policy = createSpatialSkeletonQueueInputPreparation(
      layer,
      makeQueueInputCommand([{ segmentId: 11n }]),
    );
    const release = policy.validate("execute");
    state.replaceCachedSegmentSnapshots([[11n, []]]);
    const prepared = await policy.acquire(
      new AbortController().signal,
      "execute",
    );
    expect(prepared.input.segments[0].cacheRevision).toBe(2);
    prepared.assertCurrent();
    prepared.release();
    release();
    state.evictInactiveSegmentNodes([]);
    expect(state.getCachedSegmentNodes(11n)).toBeUndefined();
  });

  it("an edit follows its node into the skeleton that an earlier queued merge moved it to", async () => {
    const { layer, state } = makeQueueInputLayer([11n, 21n]);
    const policy = createSpatialSkeletonQueueInputPreparation(
      layer,
      makeQueueInputCommand([{ segmentId: 11n, nodeId: 12n }]),
    );
    const release = policy.validate("execute");
    expect(policy.getProtectedSegmentIds()).toEqual([11n]);
    state.replaceCachedSegmentSnapshots([
      [11n, []],
      [
        21n,
        [
          { nodeId: 12n, segmentId: 21n, position: new Float32Array(3) },
          { nodeId: 22n, segmentId: 21n, position: new Float32Array(3) },
        ],
      ],
    ]);
    expect(policy.getProtectedSegmentIds()).toEqual([21n]);
    const prepared = await policy.acquire(
      new AbortController().signal,
      "execute",
    );
    expect(prepared.input.segments[0].segmentId).toBe(21n);
    prepared.release();
    release();
  });

  it.each([
    {
      name: "a required skeleton is replaced",
      changeInputs: (
        state: SpatialSkeletonEditSession,
        _retarget: (segmentId: bigint) => void,
      ) => state.replaceCachedSegmentSnapshots([[11n, []]]),
      reason: "snapshot-changed",
    },
    {
      name: "the edit's target changes",
      changeInputs: (
        _state: SpatialSkeletonEditSession,
        retarget: (segmentId: bigint) => void,
      ) => retarget(31n),
      reason: "requirements-changed",
    },
  ])(
    "abandons an edit whose inputs change while one of its skeletons downloads ($name)",
    async ({ changeInputs, reason }) => {
      const { layer, state, getSkeleton } = makeQueueInputLayer([11n]);
      const read = Promise.withResolvers<void>();
      getSkeleton.mockImplementationOnce(async () => {
        await read.promise;
        return [];
      });
      let target = 21n;
      const command = {
        ...makeQueueInputCommand([]),
        getQueueInputRequirements: () => ({
          required: [{ segmentId: 11n }],
          loadable: [{ segmentId: target }],
        }),
      };
      const acquiring = createSpatialSkeletonQueueInputPreparation(
        layer,
        command,
      ).acquire(new AbortController().signal, "execute");
      changeInputs(state, (segmentId) => {
        target = segmentId;
      });
      read.resolve();
      await expect(acquiring).rejects.toMatchObject({ reason });
      state.evictInactiveSegmentNodes([]);
      expect(state.getCachedSegmentNodes(11n)).toBeUndefined();
    },
  );

  it("canceling an edit during a download frees its skeletons at once and ignores the late download", async () => {
    const { layer, state, getSkeleton } = makeQueueInputLayer([11n]);
    const read = Promise.withResolvers<void>();
    let downloadSignal: AbortSignal | undefined;
    getSkeleton.mockImplementationOnce(async (_segmentId, { signal }) => {
      downloadSignal = signal;
      await read.promise;
      return [];
    });
    const controller = new AbortController();
    const acquiring = createSpatialSkeletonQueueInputPreparation(
      layer,
      makeQueueInputCommand([{ segmentId: 11n }], [{ segmentId: 21n }]),
    ).acquire(controller.signal, "execute");
    await waitForMicrotasks();
    expect(downloadSignal?.aborted).toBe(false);
    const reason = new DOMException("Canceled", "AbortError");
    controller.abort(reason);
    await expect(acquiring).rejects.toBe(reason);
    expect(downloadSignal?.aborted).toBe(true);
    state.evictInactiveSegmentNodes([]);
    expect(state.getCachedSegmentNodes(11n)).toBeUndefined();
    read.resolve();
    await waitForMicrotasks();
    expect(state.getCachedSegmentNodes(21n)).toBeUndefined();
  });

  it("downloads an edit's other skeletons in the order the edit lists them", async () => {
    const { layer, getSkeleton } = makeQueueInputLayer([11n]);
    const command = {
      ...makeQueueInputCommand(
        [{ segmentId: 11n }],
        [{ segmentId: 31n }, { segmentId: 21n }],
      ),
      action: SpatialSkeletonActions.editNodeRadius,
    };
    const prepared = await createSpatialSkeletonQueueInputPreparation(
      layer,
      command,
    ).acquire(new AbortController().signal, "execute");
    expect(getSkeleton.mock.calls.map((call) => call[0])).toEqual([31n, 21n]);
    expect(prepared.input.segments.map(({ segmentId }) => segmentId)).toEqual([
      11n,
      31n,
      21n,
    ]);
    prepared.release();
  });

  it("frees an edit's skeletons when a download fails", async () => {
    const { layer, state, getSkeleton } = makeQueueInputLayer([11n]);
    const error = new Error("Unavailable");
    getSkeleton.mockRejectedValueOnce(error);
    await expect(
      createSpatialSkeletonQueueInputPreparation(
        layer,
        makeQueueInputCommand([{ segmentId: 11n }], [{ segmentId: 21n }]),
      ).acquire(new AbortController().signal, "execute"),
    ).rejects.toBe(error);
    state.evictInactiveSegmentNodes([]);
    expect(state.getCachedSegmentNodes(11n)).toBeUndefined();
  });

  it("refuses an edit once a page reload is required, including when the requirement arises during its download", async () => {
    const { layer, state, getSkeleton } = makeQueueInputLayer([11n]);
    const read = Promise.withResolvers<void>();
    getSkeleton.mockImplementationOnce(async () => {
      await read.promise;
      return [];
    });
    const policy = createSpatialSkeletonQueueInputPreparation(
      layer,
      makeQueueInputCommand([{ segmentId: 11n }], [{ segmentId: 21n }]),
    );
    const acquiring = policy.acquire(new AbortController().signal, "execute");
    state.latchReloadRequired({
      reason: "authority-indeterminate",
      authority: "indeterminate",
      intentId: 1,
    });
    read.resolve();
    await expect(acquiring).rejects.toBeInstanceOf(
      SpatialSkeletonReloadRequiredError,
    );
    expect(() => policy.validate("execute")).toThrow(
      SpatialSkeletonReloadRequiredError,
    );
  });

  it("Redo downloads again a skeleton that left the cache before the edit first ran", async () => {
    const { layer, state, getSkeleton } = makeQueueInputLayer([11n]);
    const policy = createSpatialSkeletonQueueInputPreparation(
      layer,
      makeQueueInputCommand([{ segmentId: 11n }], [{ segmentId: 21n }]),
    );
    policy.validate("execute")();
    state.evictInactiveSegmentNodes([]);
    const release = policy.validate("redo");
    const prepared = await policy.acquire(new AbortController().signal, "redo");
    expect(getSkeleton.mock.calls.map((call) => call[0])).toEqual([11n, 21n]);
    expect(prepared.input.segments.map(({ segmentId }) => segmentId)).toEqual([
      11n,
      21n,
    ]);
    prepared.release();
    release();
  });
});
