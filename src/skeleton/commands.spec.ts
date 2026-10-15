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

import { CatmaidSpatialSkeletonEditCommands } from "#src/datasource/catmaid/spatial_skeleton_commands.js";
import type { SkeletonNode } from "#src/skeleton/api.js";
import { SpatialSkeletonCommandHistory } from "#src/skeleton/command_history.js";
import {
  SpatialSkeletonActions,
  SpatialSkeletonHistoryActions,
} from "#src/skeleton/command_protocol.js";
import {
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
  redoSpatialSkeletonCommand,
  showSpatialSkeletonActionError,
  undoSpatialSkeletonCommand,
} from "#src/skeleton/commands.js";
import {
  SpatialSkeletonEditConflictError,
  SpatialSkeletonEditRecoveryError,
} from "#src/skeleton/edit_errors.js";
import {
  getSkeletonNodeConfidence,
  getSkeletonNodeRadius,
} from "#src/skeleton/node_attributes.js";
import {
  findSpatiallyIndexedSkeletonNode,
  getSpatiallyIndexedSkeletonDirectChildren,
  getSpatiallyIndexedSkeletonNodeParent,
} from "#src/skeleton/node_traversal.js";
import { resetGlobalSpatialSkeletonMutationAuthorityLeaseCoordinatorForTesting } from "#src/skeleton/optimistic_edit/authority_lease_coordinator.js";
import { SpatialSkeletonOptimisticReloadRequiredError } from "#src/skeleton/optimistic_edit/fatal.js";
import {
  committedSpatialSkeletonOptimisticEditSettlement,
  type SpatialSkeletonOptimisticEditSettlement,
} from "#src/skeleton/optimistic_edit/lifecycle.js";
import { SpatialSkeletonOptimisticProjectionRuntime } from "#src/skeleton/optimistic_edit/projection_runtime.js";
import { SpatialSkeletonState } from "#src/skeleton/spatial_skeleton_manager.js";
import { StatusMessage } from "#src/status.js";
import { SpatialSkeletonOptimisticAuthorityNotificationController } from "#src/ui/skeleton_optimistic_edit_queue_tab.js";
import { bigintCompare } from "#src/util/bigint.js";
import { HttpError } from "#src/util/http_request.js";

function makeWholeSkeletonReads(
  getSkeleton: (
    skeletonId: bigint,
    options: { signal: AbortSignal },
  ) => unknown,
) {
  return {
    getSkeletonManifest: async () => ({ fragmentKeys: ["skeleton"] }),
    getSkeletonFragment: async (
      skeletonId: bigint,
      _fragmentKey: string,
      signal: AbortSignal,
    ) => ({ nodes: await getSkeleton(skeletonId, { signal }) }),
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
  state: SpatialSkeletonState,
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
  state: SpatialSkeletonState,
  segmentId: bigint,
  nodes: readonly SkeletonNode[] | undefined,
) {
  state.replaceCachedSegmentSnapshots([[segmentId, nodes]], {
    notify: false,
  });
}

function seedCachedNodesForTest(
  state: SpatialSkeletonState,
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
    optimisticEditing: commands.optimisticEditing,
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
  const controller =
    new SpatialSkeletonOptimisticAuthorityNotificationController(layer);
  const subscription =
    layer.spatialSkeletonState.optimisticEditQueueVersion.changed.add(() =>
      controller.update(),
    );
  return () => {
    if (typeof subscription === "function") subscription();
    else subscription.dispose();
    controller.dispose();
  };
}

function expectReloadRequired(
  state: SpatialSkeletonState,
  authority: "committed" | "indeterminate",
) {
  expect(state.getOptimisticEditFatalState()).toEqual(
    expect.objectContaining({
      authority,
      reason:
        authority === "committed"
          ? "committed-local-publication-failed"
          : "authority-indeterminate",
    }),
  );
}

function makeDisplayState(visibleSegmentIds: readonly bigint[]) {
  return {
    segmentSelectionState: {
      baseValue: undefined as bigint | undefined,
    },
    segmentationGroupState: {
      value: {
        visibleSegments: new Set(visibleSegmentIds),
        selectedSegments: new Set<bigint>(),
        segmentEquivalences: {},
        temporaryVisibleSegments: new Set<bigint>(),
        temporarySegmentEquivalences: {},
        useTemporaryVisibleSegments: { value: false },
        useTemporarySegmentEquivalences: { value: false },
      },
    },
    segmentStatedColors: {
      value: {
        delete: vi.fn(),
      },
    },
  };
}

function makePinnedManager() {
  return {
    root: {
      selectionState: {
        pin: {
          value: true,
        },
      },
    },
  };
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
    assertOptimisticEditingAllowed: vi.fn(),
    getOptimisticEditingIdentityService: vi.fn(() => ({})),
    tryAcquireInputReference: vi.fn(makeRetainedInput),
    acquireInputReference: vi.fn(makeRetainedInput),
  };
}

function makeResolvedOptimisticExecution(value = true) {
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

function makeOptimisticAddNodeTestLayer(options: {
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
  const spatialSkeletonState = new SpatialSkeletonState();
  const initialNodesBySegment = new Map<bigint, SkeletonNode[]>();
  for (const node of options.initialNodes) {
    const segmentNodes = initialNodesBySegment.get(node.segmentId) ?? [];
    segmentNodes.push(node);
    initialNodesBySegment.set(node.segmentId, segmentNodes);
  }
  spatialSkeletonState.replaceCachedSegmentSnapshots(
    [...initialNodesBySegment],
    { notify: false },
  );
  const getSkeleton =
    options.getSkeleton ??
    vi.fn(async (requestedSegmentId: bigint) =>
      (
        spatialSkeletonState.getCachedSegmentNodes(requestedSegmentId) ??
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
    optimisticEditing: commands.optimisticEditing,
    ...makeWholeSkeletonReads(getSkeleton),
  };
  const invalidateWholeSourceCache = vi.fn();
  const chunkSource = { invalidateCache: invalidateWholeSourceCache };
  const skeletonLayer = {
    fragmentSource: skeletonSource,
    editableSource: skeletonSource,
    getNode: vi.fn((nodeId: bigint) =>
      spatialSkeletonState.getCachedNode(nodeId),
    ),
    retainOverlaySegment: vi.fn(),
    remapOverlaySegments: vi.fn(),
    getUniqueChunkSources: () => new Set([chunkSource]),
  };
  const selectedSpatialSkeletonNodeInfo = {
    value: undefined as
      | {
          nodeId: bigint;
          segmentId?: bigint;
          position?: ArrayLike<number>;
        }
      | undefined,
  };
  const layer = {
    displayState: makeDisplayState(options.segmentIds ?? [options.segmentId]),
    manager: makePinnedManager(),
    selectedSpatialSkeletonNodeInfo,
    spatialSkeletonState,
    getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
    getCachedSpatialSkeletonSegmentNodesForEdit: (requestedSegmentId: bigint) =>
      spatialSkeletonState.getCachedSegmentNodes(requestedSegmentId) ?? [],
    async getSpatialSkeletonDeleteOperationContext(node: SkeletonNode) {
      const segmentNodes =
        spatialSkeletonState.getCachedSegmentNodes(node.segmentId) ?? [];
      const currentNode = findSpatiallyIndexedSkeletonNode(
        segmentNodes,
        node.nodeId,
      );
      if (currentNode === undefined) {
        throw new Error(`Unable to resolve cached node ${node.nodeId}.`);
      }
      const childNodes = getSpatiallyIndexedSkeletonDirectChildren(
        segmentNodes,
        currentNode.nodeId,
      );
      return {
        node: currentNode,
        parentNode: getSpatiallyIndexedSkeletonNodeParent(
          segmentNodes,
          currentNode,
        ),
        childNodes,
      };
    },
    selectSegment: vi.fn(),
    selectAndMoveToSpatialSkeletonNode: vi.fn(),
    selectSpatialSkeletonNode: vi.fn(
      (
        nodeId: bigint,
        _pin: boolean,
        nodeInfo?: { segmentId?: bigint; position?: ArrayLike<number> },
      ) => {
        selectedSpatialSkeletonNodeInfo.value = {
          nodeId,
          segmentId: nodeInfo?.segmentId,
          position: nodeInfo?.position,
        };
      },
    ),
    clearSpatialSkeletonNodeSelection: vi.fn(() => {
      selectedSpatialSkeletonNodeInfo.value = undefined;
    }),
    moveViewToSpatialSkeletonNodePosition: vi.fn(),
  };
  Object.assign(layer, {
    applySpatialSkeletonProjectionUiHints: (hints: {
      nodeIdRemappings: ReadonlyMap<bigint, bigint>;
      segmentIdRemappings: ReadonlyMap<bigint, bigint>;
      segmentVisibility: readonly {
        segmentId: bigint;
        visible: boolean;
      }[];
      retainSegmentIds: readonly bigint[];
      selectedNode?:
        | { kind: "clear" }
        | {
            kind: "select" | "refresh-if-selected";
            nodeId: bigint;
            segmentId?: bigint;
            position?: ArrayLike<number>;
          };
    }) => {
      spatialSkeletonState.remapPendingNodePositions(hints.nodeIdRemappings);
      const group = layer.displayState.segmentationGroupState.value;
      for (const set of [
        group.visibleSegments,
        group.temporaryVisibleSegments,
        group.selectedSegments,
      ]) {
        for (const [from, to] of hints.segmentIdRemappings) {
          if (!set.delete(from)) continue;
          set.add(to);
        }
      }
      const selected = layer.selectedSpatialSkeletonNodeInfo.value;
      if (selected !== undefined) {
        layer.selectSpatialSkeletonNode(
          hints.nodeIdRemappings.get(selected.nodeId) ?? selected.nodeId,
          true,
          {
            ...selected,
            segmentId:
              selected.segmentId === undefined
                ? undefined
                : (hints.segmentIdRemappings.get(selected.segmentId) ??
                  selected.segmentId),
          },
        );
      }
      if (hints.selectedNode?.kind === "clear") {
        layer.clearSpatialSkeletonNodeSelection();
      } else if (
        hints.selectedNode !== undefined &&
        (hints.selectedNode.kind === "select" ||
          layer.selectedSpatialSkeletonNodeInfo.value?.nodeId ===
            hints.selectedNode.nodeId)
      ) {
        const cached = spatialSkeletonState.getCachedNode(
          hints.selectedNode.nodeId,
        );
        layer.selectSpatialSkeletonNode(hints.selectedNode.nodeId, true, {
          segmentId: hints.selectedNode.segmentId ?? cached?.segmentId,
          position: hints.selectedNode.position ?? cached?.position,
        });
      }
      if (hints.segmentIdRemappings.size !== 0) {
        skeletonLayer.remapOverlaySegments(new Map(hints.segmentIdRemappings));
      }
      for (const segmentId of hints.retainSegmentIds) {
        skeletonLayer.retainOverlaySegment(segmentId);
      }
    },
  });
  return {
    client,
    layer,
    skeletonLayer,
    spatialSkeletonState,
    invalidateWholeSourceCache,
  };
}

async function waitForMicrotasks(count = 3) {
  for (let i = 0; i < count; ++i) {
    await Promise.resolve();
  }
}

async function waitForPresentationTurn() {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

async function afterPresentationTurnWithFakeTimers<T>(execution: Promise<T>) {
  vi.advanceTimersToNextFrame();
  await vi.advanceTimersByTimeAsync(0);
  return execution;
}

describe("spatial_skeleton_commands", () => {
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
    resetGlobalSpatialSkeletonMutationAuthorityLeaseCoordinatorForTesting();
    vi.restoreAllMocks();
  });

  it("routes opaque source-created descriptors through the mandatory state engine", async () => {
    const command = {
      action: SpatialSkeletonActions.moveNodes,
      label: "Backend-owned move",
      payload: Object.freeze({ backend: "opaque" }),
      getQueueInputRequirements: vi.fn(() => ({ required: [] })),
    };
    const createCommand = vi.fn(() => command);
    const executeOptimisticEdit = vi.fn(() =>
      makeResolvedOptimisticExecution(),
    );
    const ensureOptimisticEditingEngine = vi.fn(() => ({}));
    const layer = {
      spatialSkeletonState: {
        ...makeAvailableInputReferences(),
        commandHistory: new SpatialSkeletonCommandHistory(),
        ensureOptimisticEditingEngine,
        executeOptimisticEdit,
      },
      getSpatiallyIndexedSkeletonLayer: () => ({
        editableSource: {
          ...makeEditableSkeletonSource({
            moveNodesCommand: {
              action: SpatialSkeletonActions.moveNodes,
              createCommand,
            },
          }),
        },
      }),
    };
    const node: SkeletonNode = {
      nodeId: 17n,
      segmentId: 23n,
      position: new Float32Array([1, 2, 3]),
    };
    const nextPositionInModelSpace = new Float32Array([7, 8, 9]);

    await executeSpatialSkeletonMoveNode(layer as any, {
      node,
      nextPositionInModelSpace,
    });

    expect(createCommand).toHaveBeenCalledWith({
      node,
      nextPositionInModelSpace,
    });
    expect(ensureOptimisticEditingEngine).toHaveBeenCalledTimes(1);
    expect(executeOptimisticEdit).toHaveBeenCalledWith(command, {
      getProtectedSegmentIds: expect.any(Function),
      validate: expect.any(Function),
      acquire: expect.any(Function),
    });
    expect(command).not.toHaveProperty("execute");
    expect(command).not.toHaveProperty("undo");
    expect(command).not.toHaveProperty("redo");
  });

  it("rejects an unavailable requested command factory", () => {
    const layer = {
      spatialSkeletonState: {
        ...makeAvailableInputReferences(),
        commandHistory: new SpatialSkeletonCommandHistory(),
      },
      getSpatiallyIndexedSkeletonLayer: () => ({
        editableSource: {
          ...makeEditableSkeletonSource(),
          editNodeDescriptionCommand: {
            action: SpatialSkeletonActions.editNodeDescription,
          },
        },
      }),
    };

    expect(() =>
      executeSpatialSkeletonNodeDescriptionUpdate(layer as any, {
        node: {
          nodeId: 17n,
          segmentId: 23n,
          position: new Float32Array([1, 2, 3]),
        },
        nextDescription: "next",
      }),
    ).toThrow(
      "The active skeleton source does not support node description editing.",
    );
  });

  it("reports unsupported commands clearly", () => {
    const layer = {
      spatialSkeletonState: {
        ...makeAvailableInputReferences(),
        commandHistory: new SpatialSkeletonCommandHistory(),
      },
      getSpatiallyIndexedSkeletonLayer: () => ({
        editableSource: {
          ...makeEditableSkeletonSource({
            editNodeDescriptionCommand: undefined,
          }),
        },
      }),
    };
    const node: SkeletonNode = {
      nodeId: 17n,
      segmentId: 23n,
      position: new Float32Array([1, 2, 3]),
    };

    expect(() =>
      executeSpatialSkeletonNodeDescriptionUpdate(layer as any, {
        node,
        nextDescription: "next",
      }),
    ).toThrow(
      "The active skeleton source does not support node description editing.",
    );
  });

  it.each(["read-only", "missing"])(
    "blocks dispatch for a %s source",
    (kind) => {
      const source = makeEditableSkeletonSource();
      const createCommand = vi.spyOn(source.moveNodesCommand, "createCommand");
      const ensureOptimisticEditingEngine = vi.fn();
      const layer = {
        spatialSkeletonState: {
          ...makeAvailableInputReferences(),
          ensureOptimisticEditingEngine,
        },
        getSpatiallyIndexedSkeletonLayer: () =>
          kind === "missing" ? undefined : { fragmentSource: source },
      };

      expect(() => executeSpatialSkeletonMoveNode(layer as any, {})).toThrow(
        "The active skeleton source does not support node movement.",
      );
      expect(createCommand).not.toHaveBeenCalled();
      expect(ensureOptimisticEditingEngine).not.toHaveBeenCalled();
    },
  );

  it("keeps the pending message through acceptance and preserves final settlement", async () => {
    let finishPreview!: () => void;
    let finishSave!: (result: SpatialSkeletonOptimisticEditSettlement) => void;
    const submitted = Object.assign(
      new Promise<void>((resolve) => {
        finishPreview = resolve;
      }),
      {
        acceptedByQueue: Promise.resolve(),
        settled: new Promise<SpatialSkeletonOptimisticEditSettlement>(
          (resolve) => {
            finishSave = resolve;
          },
        ),
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
      spatialSkeletonState: {
        ...makeAvailableInputReferences(),
        ensureOptimisticEditingEngine: vi.fn(),
        executeOptimisticEdit: () => submitted,
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

    const result = committedSpatialSkeletonOptimisticEditSettlement();
    finishSave(result);
    await expect(execution.settled).resolves.toEqual(result);
  });

  it("routes public wrappers through shared execution metadata", async () => {
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
    const executeOptimisticEdit = vi.fn(() =>
      makeResolvedOptimisticExecution(),
    );
    const layer = {
      spatialSkeletonState: {
        ...makeAvailableInputReferences(),
        commandHistory: new SpatialSkeletonCommandHistory(),
        ensureOptimisticEditingEngine: vi.fn(() => ({})),
        executeOptimisticEdit,
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
        execute: () => executeSpatialSkeletonReroot(layer as any, node),
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
      expect(executeOptimisticEdit).toHaveBeenCalledTimes(1);
      executeOptimisticEdit.mockClear();
      if (testCase.pendingMessage === undefined) {
        expect(showMessage).not.toHaveBeenCalled();
      } else {
        expect(showMessage).toHaveBeenCalledWith(testCase.pendingMessage);
        expect(dispose).toHaveBeenCalledTimes(1);
      }
    }
  });

  it("exposes CATMAID command factories for supported edit actions", () => {
    const commandSource = makeCatmaidEditCommands();

    expect(commandSource.moveNodesCommand.action).toBe(
      SpatialSkeletonActions.moveNodes,
    );
    expect(commandSource.editNodeRadiusCommand.action).toBe(
      SpatialSkeletonActions.editNodeRadius,
    );
    expect(commandSource.editNodeConfidenceCommand.action).toBe(
      SpatialSkeletonActions.editNodeConfidence,
    );
    expect((commandSource as any).inspectCommand).toBeUndefined();
  });

  it("previews insertion and reconciles fresh IDs through Undo and Redo", async () => {
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
    const { layer, spatialSkeletonState: state } =
      makeOptimisticAddNodeTestLayer({
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
    expect(
      state.spatialSkeletonPresentation.value.provisionalNodeIds,
    ).toContain(preview.nodeId);
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

  it("rejects an insertion if the admitted child is no longer attached to its parent", async () => {
    suppressStatusMessages();
    const insertNode = vi.fn();
    const { layer, spatialSkeletonState: state } =
      makeOptimisticAddNodeTestLayer({
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

  it("captures insertion children immutably and rejects malformed insertion payloads", () => {
    const commands = makeCatmaidEditCommands();
    const childNodeIds = [2n];
    const command = commands.insertNodesCommand.createCommand({
      skeletonId: 23n,
      parentNodeId: 1n,
      childNodeIds,
      positionInModelSpace: [1, 2, 3],
    });
    childNodeIds.push(3n);
    expect((command as any).payload.options.childNodeIds).toEqual([2n]);
    for (const children of [[], [2n, 2n], [NaN]]) {
      expect(() =>
        commands.insertNodesCommand.createCommand({
          skeletonId: 23n,
          parentNodeId: 1n,
          childNodeIds: children,
          positionInModelSpace: [1, 2, 3],
        }),
      ).toThrow(/invalid payload/);
    }
  });

  it("creates CATMAID commands from valid opaque payloads", () => {
    const commandSource = makeCatmaidEditCommands();
    const node: SkeletonNode = {
      nodeId: 17n,
      segmentId: 23n,
      position: new Float32Array([1, 2, 3]),
    };

    const command = commandSource.moveNodesCommand.createCommand({
      node,
      nextPositionInModelSpace: new Float32Array([7, 8, 9]),
    });

    expect(command?.label).toBe("Move node");
    expect((command as any)?.payload).toMatchObject({ kind: "move-node" });
    expect(command?.getQueueInputRequirements).toBeTypeOf("function");
    expect(command).not.toHaveProperty("execute");
    expect(command).not.toHaveProperty("executeOptimistically");
  });

  it("reports invalid CATMAID command payloads clearly", () => {
    const commandSource = makeCatmaidEditCommands();

    expect(() =>
      commandSource.moveNodesCommand.createCommand({
        node: {},
        nextPositionInModelSpace: new Float32Array([7, 8, 9]),
      }),
    ).toThrow("CATMAID move-node command received an invalid payload.");
  });

  it("defers malformed coordinate contents beyond command construction", () => {
    const commandSource = makeCatmaidEditCommands();
    const node: SkeletonNode = {
      nodeId: 17n,
      segmentId: 23n,
      position: new Float32Array([1, 2, 3]),
    };

    expect(() =>
      commandSource.moveNodesCommand.createCommand({
        node,
        nextPositionInModelSpace: {} as Float32Array,
      }),
    ).not.toThrow();
  });

  it("removes a pending optimistic add-node preview without sending it", async () => {
    suppressStatusMessages();
    const showTemporaryMessage = vi.mocked(StatusMessage.showTemporaryMessage);

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
    const addNode = vi.fn(() => firstAddPromise);
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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
    await waitForMicrotasks();

    expect(addNode).toHaveBeenCalledTimes(1);
    expect(
      spatialSkeletonState
        .getCachedSegmentNodes(segmentId)!
        .filter((node) => node.nodeId >= 2n ** 63n),
    ).toHaveLength(2);
    expect(
      spatialSkeletonState.spatialSkeletonPresentation.value.provisionalNodeIds,
    ).toEqual([2n ** 63n + 1n, 2n ** 63n + 2n]);

    await undoSpatialSkeletonCommand(layer as any);

    expect(showTemporaryMessage).not.toHaveBeenCalled();
    expect(addNode).toHaveBeenCalledTimes(1);
    expect(
      spatialSkeletonState
        .getCachedSegmentNodes(segmentId)!
        .filter((node) => node.nodeId >= 2n ** 63n),
    ).toHaveLength(1);
    expect(
      spatialSkeletonState.spatialSkeletonPresentation.value.provisionalNodeIds,
    ).toEqual([2n ** 63n + 1n]);
    expect(spatialSkeletonState.getOptimisticEditQueueRecentActivity()).toEqual(
      [
        expect.objectContaining({
          commandLabel: "Add node",
          intent: "undo",
          status: "reverted",
        }),
        expect.objectContaining({
          commandLabel: "Add node",
          intent: "execute",
          status: "reverted",
        }),
      ],
    );

    resolveFirstAdd!({
      nodeId: 2n,
      segmentId,
    });
    await waitForMicrotasks(20);
    expect(
      spatialSkeletonState.spatialSkeletonPresentation.value.provisionalNodeIds,
    ).toEqual([]);
  });

  it("reapplies a coalesced pending add when it is redone", async () => {
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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
    expect(spatialSkeletonState.commandHistory.canRedo.value).toBe(true);
    expect(addNode).toHaveBeenCalledTimes(1);

    await expect(redoSpatialSkeletonCommand(layer as any)).resolves.toBe(true);
    expect(spatialSkeletonState.commandHistory.canRedo.value).toBe(false);
    expect(
      spatialSkeletonState
        .getOptimisticEditQueueSnapshot()
        .some((entry) => entry.kind === "addNode" && entry.intent === "redo"),
    ).toBe(true);
    expect(addNode).toHaveBeenCalledTimes(1);

    resolveBlockingAdd!({
      nodeId: 2n,
      segmentId,
    });
    await waitForMicrotasks(40);

    expect(addNode).toHaveBeenCalledTimes(2);
    expect(spatialSkeletonState.getCachedNode(3n)).toMatchObject({
      parentNodeId: parentNode.nodeId,
      position: new Float32Array([10, 11, 12]),
    });
  });

  it("submits an optimistic add from its inspected parent after cache invalidation", async () => {
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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
    replaceCachedSegmentForTest(spatialSkeletonState, segmentId, undefined);

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

  it("removes a rejected in-flight add and its queued Undo from history", async () => {
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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
    expect(spatialSkeletonState.commandHistory.canUndo.value).toBe(false);
    expect(spatialSkeletonState.commandHistory.canRedo.value).toBe(false);
    await expect(redoSpatialSkeletonCommand(layer as any)).resolves.toBe(false);
    expect(addNode).toHaveBeenCalledTimes(1);
    expect(spatialSkeletonState.getCachedNode(3n)).toBeUndefined();
  });

  it.each(["split", "delete"] as const)(
    "saves %s with Undo and Redo already previewed",
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
      const { layer, spatialSkeletonState: state } =
        makeOptimisticAddNodeTestLayer({
          initialNodes: nodes,
          segmentId: 11n,
          splitSkeleton,
          deleteNode,
          mergeSkeletons,
          addNode,
        });
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
      expect(state.getOptimisticEditFatalState()).toBeUndefined();
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
        state
          .getOptimisticEditQueueRecentActivity()
          .map(({ status }) => status),
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
      const { layer, spatialSkeletonState: state } =
        makeOptimisticAddNodeTestLayer({
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
      // This fixture applies remaps but leaves visibility hints to the caller.
      const visible =
        layer.displayState.segmentationGroupState.value.visibleSegments;
      visible.add(preview.segmentId);

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
      expect(visible.has(preview.segmentId)).toBe(true);
      expect(layer.selectedSpatialSkeletonNodeInfo.value).toMatchObject({
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
      expect(state.getOptimisticEditFatalState()).toBeUndefined();
      expect(
        state.spatialSkeletonPresentation.value.provisionalNodeIds,
      ).toEqual([]);
      expect(
        state
          .getOptimisticEditQueueRecentActivity()
          .map(({ status }) => status),
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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
    expect(spatialSkeletonState.getCachedNode(3n)).toBeUndefined();
    expect(spatialSkeletonState.commandHistory.canUndo.value).toBe(false);
    expect(spatialSkeletonState.commandHistory.canRedo.value).toBe(false);
  });

  it("preserves temporary parent identity across coalesced add-chain redo", async () => {
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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
    const firstParentPreview = spatialSkeletonState
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

    const redoneParentPreview = spatialSkeletonState
      .getCachedSegmentNodes(segmentId)
      ?.find((node) => node.position[0] === 7);
    const redoneChildPreview = spatialSkeletonState
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
    expect(spatialSkeletonState.getCachedNode(3n)).toMatchObject({
      parentNodeId: rootNode.nodeId,
    });
    expect(spatialSkeletonState.getCachedNode(4n)).toMatchObject({
      parentNodeId: 3n,
    });
  });

  it("runs an explicit add-node undo after its in-flight execute commits", async () => {
    suppressStatusMessages();
    const showTemporaryMessage = vi.mocked(StatusMessage.showTemporaryMessage);

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
    const deleteNode = vi.fn().mockResolvedValue({});
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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
    const requestOptions = (
      addNode.mock.calls[0] as unknown[] | undefined
    )?.[6] as { signal?: AbortSignal } | undefined;
    expect(requestOptions?.signal).toBeUndefined();

    await undoSpatialSkeletonCommand(layer as any);
    expect(requestOptions?.signal).toBeUndefined();
    expect(
      spatialSkeletonState
        .getCachedSegmentNodes(segmentId)!
        .some((node) => node.nodeId >= 2n ** 63n),
    ).toBe(false);

    resolveAdd!({
      nodeId: 2n,
      segmentId,
    });
    await waitForMicrotasks(10);

    expect(deleteNode).toHaveBeenCalledWith(2n);
    expect(showTemporaryMessage).not.toHaveBeenCalled();
    expect(spatialSkeletonState.commandHistory.canUndo.value).toBe(false);
  });

  it("requires reload without an inverse POST when a disposed add later commits", async () => {
    suppressStatusMessages();
    const showErrorMessage = vi.mocked(StatusMessage.showErrorMessage);

    const segmentId = 23n;
    const parentNode: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([4, 5, 6]),
    };
    let resolveAdd!: (value: { nodeId: bigint; segmentId: bigint }) => void;
    const addPromise = new Promise<any>((resolve) => {
      resolveAdd = resolve;
    });
    const addNode = vi.fn(() => addPromise);
    const deleteNode = vi.fn();
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
      addNode,
      deleteNode,
      initialNodes: [parentNode],
      segmentId,
    });

    const forwardExecution = executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: segmentId,
      parentNodeId: parentNode.nodeId,
      positionInModelSpace: new Float32Array([7, 8, 9]),
    });
    await forwardExecution;
    await waitForMicrotasks();
    const queue = (spatialSkeletonState as any).optimisticEditQueue;
    expect(spatialSkeletonState.clearRuntimeState()).toBe(true);
    const disposal = queue.dispose();

    resolveAdd({
      nodeId: 2n,
      segmentId,
    });
    await disposal;
    await waitForMicrotasks(10);

    expect(deleteNode).not.toHaveBeenCalled();
    expect(showErrorMessage).not.toHaveBeenCalled();
    expectReloadRequired(spatialSkeletonState, "committed");
    expect(spatialSkeletonState.canUndoOptimisticEdit()).toBe(false);

    expect(() =>
      executeSpatialSkeletonAddNode(layer as any, {
        skeletonId: segmentId,
        parentNodeId: parentNode.nodeId,
        positionInModelSpace: new Float32Array([10, 11, 12]),
      }),
    ).toThrow(SpatialSkeletonOptimisticReloadRequiredError);
    expect(addNode).toHaveBeenCalledTimes(1);

    let forwardSettled = false;
    void forwardExecution.settled.then(() => (forwardSettled = true));
    await waitForMicrotasks();
    expect(forwardSettled).toBe(false);
  });

  it("keeps replacement previews immediate but fences their POST after a disposed add commits", async () => {
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
    const { layer, skeletonLayer, spatialSkeletonState } =
      makeOptimisticAddNodeTestLayer({
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
    const retiredTempNode = spatialSkeletonState
      .getCachedSegmentNodes(segmentId)!
      .find((node) => node.nodeId >= 2n ** 63n);
    expect(retiredTempNode).toBeDefined();
    const retiredTempNodeId = retiredTempNode!.nodeId;

    const oldQueue = (spatialSkeletonState as any).optimisticEditQueue;
    expect(spatialSkeletonState.clearRuntimeState()).toBe(true);
    const disposal = oldQueue.dispose();
    expect(
      spatialSkeletonState.getCachedNode(retiredTempNodeId),
    ).toBeUndefined();
    seedCachedNodesForTest(spatialSkeletonState, [parentNode]);
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

    const replacementTempNodeId = spatialSkeletonState
      .getCachedSegmentNodes(segmentId)!
      .find((node) => node.nodeId >= 2n ** 63n)!.nodeId;

    // The replacement queue publishes its local preview immediately, but its
    // POST cannot pass the disposed queue's still-active source lane.
    expect(addNode).toHaveBeenCalledTimes(1);
    expect(
      spatialSkeletonState.getCachedNode(replacementTempNodeId),
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
    expectReloadRequired(spatialSkeletonState, "committed");
    expect(spatialSkeletonState.getCachedNode(2n)).toBeUndefined();
  });

  it("runs replacement writes FIFO after a disposed request is definitively rejected", async () => {
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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

    spatialSkeletonState.clearRuntimeState();
    seedCachedNodesForTest(spatialSkeletonState, [firstParent, secondParent]);

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
    // workflow lease remains active.
    expect(addNode).toHaveBeenCalledTimes(1);
    expect(
      spatialSkeletonState
        .getCachedSegmentNodes(firstSegmentId)
        ?.some((node) => node.parentNodeId === firstParent.nodeId),
    ).toBe(true);
    expect(
      spatialSkeletonState
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
    expect(spatialSkeletonState.getCachedNode(3n)).toMatchObject({
      segmentId: firstSegmentId,
      parentNodeId: firstParent.nodeId,
    });
    expect(spatialSkeletonState.getCachedNode(30n)).toMatchObject({
      segmentId: secondSegmentId,
      parentNodeId: secondParent.nodeId,
    });
  });

  it("releases a disposed source lane after an explicit CATMAID rejection", async () => {
    suppressStatusMessages();

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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
      moveNode,
      initialNodes: [node],
      segmentId,
    });

    await executeSpatialSkeletonMoveNode(layer as any, {
      node,
      nextPositionInModelSpace: new Float32Array([4, 5, 6]),
    });
    await waitForMicrotasks();
    expect(moveNode).toHaveBeenCalledTimes(1);

    spatialSkeletonState.clearRuntimeState();
    seedCachedNodesForTest(spatialSkeletonState, [node]);
    await executeSpatialSkeletonMoveNode(layer as any, {
      node,
      nextPositionInModelSpace: new Float32Array([7, 8, 9]),
    });
    await waitForMicrotasks(5);
    expect(moveNode).toHaveBeenCalledTimes(1);

    rejectOldMove(
      new HttpError(
        "https://catmaid.example.test/1/node/update",
        409,
        "Conflict",
      ),
    );
    await waitForMicrotasks(20);

    // The explicit response proves non-commit, so the replacement POST may
    // drain immediately without an inverse mutation.
    expect(moveNode).toHaveBeenCalledTimes(2);
    expect(moveNode.mock.calls[1]).toEqual([node.nodeId, 7, 8, 9]);
  });

  it("retains a disposed source lane after an ambiguous transport failure", async () => {
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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
    spatialSkeletonState.clearRuntimeState();
    seedCachedNodesForTest(spatialSkeletonState, [node]);
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
    expectReloadRequired(spatialSkeletonState, "indeterminate");
    expect(getSkeleton).not.toHaveBeenCalled();
    spatialSkeletonState.dispose();
  });

  it("retains a visible global mutation fence after an ambiguous move failure", async () => {
    suppressStatusMessages();
    const showErrorMessage = vi.mocked(StatusMessage.showErrorMessage);

    const segmentId = 23n;
    const node: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([1, 2, 3]),
    };
    let rejectFirstMove!: (reason: unknown) => void;
    const firstMove = new Promise<never>((_resolve, reject) => {
      rejectFirstMove = reject;
    });
    const moveNode = vi
      .fn()
      .mockReturnValueOnce(firstMove)
      .mockResolvedValueOnce({});
    const getSkeleton = vi.fn(async () => [
      { ...node, position: new Float32Array(node.position) },
    ]);
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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

    expect(moveNode).toHaveBeenCalledTimes(1);
    expect(
      Array.from(spatialSkeletonState.getCachedNode(node.nodeId)!.position),
    ).toEqual([4, 5, 6]);

    rejectFirstMove(
      new HttpError(
        "https://catmaid.example.test/1/node/update",
        0,
        "Network or CORS error",
      ),
    );
    await waitForMicrotasks(20);

    expect(
      Array.from(spatialSkeletonState.getCachedNode(node.nodeId)!.position),
    ).toEqual(Array.from(node.position));
    expect(showErrorMessage).not.toHaveBeenCalled();
    expect(spatialSkeletonState.getOptimisticEditFatalState()).toEqual(
      expect.objectContaining({
        reason: "authority-indeterminate",
        authority: "indeterminate",
      }),
    );
    expect(spatialSkeletonState.getOptimisticEditQueueSnapshot()).toEqual([
      expect.objectContaining({
        kind: "moveNode",
        lifecycle: expect.objectContaining({
          authority: "indeterminate",
          reconciliation: "blocked",
          history: "staged",
        }),
      }),
    ]);

    expect(() =>
      executeSpatialSkeletonMoveNode(layer as any, {
        node: spatialSkeletonState.getCachedNode(node.nodeId)!,
        nextPositionInModelSpace: new Float32Array([7, 8, 9]),
      }),
    ).toThrow(SpatialSkeletonOptimisticReloadRequiredError);

    // Fatal admission is rejected before a second speculative frame or POST.
    expect(
      Array.from(spatialSkeletonState.getCachedNode(node.nodeId)!.position),
    ).toEqual(Array.from(node.position));
    expect(moveNode).toHaveBeenCalledTimes(1);
    expect(spatialSkeletonState.getOptimisticEditQueueSnapshot()).toEqual([
      expect.objectContaining({
        kind: "moveNode",
        lifecycle: expect.objectContaining({ authority: "indeterminate" }),
      }),
    ]);
    expect(spatialSkeletonState.hasUnconfirmedOptimisticEdits()).toBe(true);

    expect(getSkeleton).not.toHaveBeenCalled();
    expect(moveNode).toHaveBeenCalledTimes(1);
    expect(
      Array.from(spatialSkeletonState.getCachedNode(node.nodeId)!.position),
    ).toEqual(Array.from(node.position));
    expect(
      spatialSkeletonState
        .getOptimisticEditQueueSnapshot()
        .some((entry) => entry.lifecycle.authority === "indeterminate"),
    ).toBe(true);

    spatialSkeletonState.dispose();
  });

  it("requires a page reload when an outcome-unknown root add has no authoritative skeleton id", async () => {
    suppressStatusMessages();
    const showErrorMessage = vi.mocked(StatusMessage.showErrorMessage);
    let rejectAdd!: (reason: unknown) => void;
    const addNode = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectAdd = reject;
        }),
    );
    const getSkeleton = vi.fn();
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
      addNode,
      getSkeleton,
      initialNodes: [],
      segmentId: 23n,
    });

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: 0n,
      parentNodeId: undefined,
      positionInModelSpace: new Float32Array([1, 2, 3]),
    });
    await waitForMicrotasks();
    rejectAdd(
      new HttpError(
        "https://catmaid.example.test/1/treenode/create",
        0,
        "Network or CORS error",
      ),
    );
    await waitForMicrotasks(20);

    expect(showErrorMessage).not.toHaveBeenCalled();
    expect(spatialSkeletonState.getOptimisticEditFatalState()).toEqual(
      expect.objectContaining({
        reason: "authority-indeterminate",
        authority: "indeterminate",
      }),
    );
    expect(getSkeleton).not.toHaveBeenCalled();
    expect(spatialSkeletonState.getOptimisticEditQueueSnapshot()).toEqual([
      expect.objectContaining({
        kind: "addNode",
        lifecycle: expect.objectContaining({ authority: "indeterminate" }),
      }),
    ]);

    spatialSkeletonState.dispose();
  });

  it("requires a page reload when an outcome-unknown split has no new skeleton id", async () => {
    suppressStatusMessages();
    const showErrorMessage = vi.mocked(StatusMessage.showErrorMessage);
    const segmentId = 23n;
    const root: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      parentNodeId: undefined,
      position: new Float32Array([1, 2, 3]),
    };
    const child: SkeletonNode = {
      nodeId: 2n,
      segmentId,
      parentNodeId: root.nodeId,
      position: new Float32Array([4, 5, 6]),
    };
    let rejectSplit!: (reason: unknown) => void;
    const splitSkeleton = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectSplit = reject;
        }),
    );
    const getSkeleton = vi.fn();
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
      splitSkeleton,
      getSkeleton,
      initialNodes: [root, child],
      segmentId,
    });

    await executeSpatialSkeletonSplit(layer as any, child);
    await waitForMicrotasks();
    rejectSplit(
      new HttpError(
        "https://catmaid.example.test/1/skeleton/split",
        0,
        "Network or CORS error",
      ),
    );
    await waitForMicrotasks(20);

    expect(showErrorMessage).not.toHaveBeenCalled();
    expectReloadRequired(spatialSkeletonState, "indeterminate");
    expect(getSkeleton).not.toHaveBeenCalled();
    expect(spatialSkeletonState.getOptimisticEditQueueSnapshot()).toEqual([
      expect.objectContaining({
        kind: "splitSkeleton",
        lifecycle: expect.objectContaining({ authority: "indeterminate" }),
      }),
    ]);

    spatialSkeletonState.dispose();
  });

  it("does not adopt or reverse a late commit after changing history source", async () => {
    suppressStatusMessages();

    const segmentId = 23n;
    const parentNode: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([4, 5, 6]),
    };
    let resolveAdd: ((value: any) => void) | undefined;
    const addNode = vi.fn(
      () =>
        new Promise<any>((resolve) => {
          resolveAdd = resolve;
        }),
    );
    const deleteNode = vi.fn().mockResolvedValue({});
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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
    expect(spatialSkeletonState.hasUnconfirmedOptimisticEdits()).toBe(true);

    const oldQueue = (spatialSkeletonState as any).optimisticEditQueue;
    expect(spatialSkeletonState.updateCommandHistorySource({})).toBe(true);
    const disposal = oldQueue.dispose();
    expect(spatialSkeletonState.hasUnconfirmedOptimisticEdits()).toBe(false);
    expect(
      spatialSkeletonState
        .getCachedSegmentNodes(segmentId)
        ?.some((node) => node.nodeId >= 2n ** 63n),
    ).toBe(false);

    resolveAdd!({
      nodeId: 2n,
      segmentId,
    });
    await disposal;

    expect(deleteNode).not.toHaveBeenCalled();
    expect(spatialSkeletonState.getCachedNode(2n)).toBeUndefined();
    expectReloadRequired(spatialSkeletonState, "committed");
  });

  it("warns without aborting or rolling back when an in-flight optimistic edit takes too long", async () => {
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
      const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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
      expect(spatialSkeletonState.hasUnconfirmedOptimisticEdits()).toBe(true);

      vi.advanceTimersByTime(30_000);

      expect(showErrorMessage).toHaveBeenCalledWith(
        "CATMAID has not confirmed the optimistic skeleton edit yet. The server mutation lane is stalled, but you may continue previewing independent edits while the request remains in order.",
      );
      expect(spatialSkeletonState.hasUnconfirmedOptimisticEdits()).toBe(true);
      expect(spatialSkeletonState.getCachedSegmentNodes(segmentId)).toEqual(
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

  it("rolls back a 3-level optimistic add chain when the root add is rejected", async () => {
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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

    const optimisticParent = spatialSkeletonState
      .getCachedSegmentNodes(segmentId)!
      .find((node) => node.nodeId >= 2n ** 63n);
    expect(optimisticParent).toBeDefined();

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: segmentId,
      parentNodeId: optimisticParent!.nodeId,
      positionInModelSpace: new Float32Array([10, 11, 12]),
    });
    await waitForMicrotasks();

    const optimisticChild = spatialSkeletonState
      .getCachedSegmentNodes(segmentId)!
      .find((node) => node.parentNodeId === optimisticParent!.nodeId);
    expect(optimisticChild).toBeDefined();

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: segmentId,
      parentNodeId: optimisticChild!.nodeId,
      positionInModelSpace: new Float32Array([13, 14, 15]),
    });
    await waitForMicrotasks();

    expect(addNode).toHaveBeenCalledTimes(1);
    expect(
      spatialSkeletonState
        .getCachedSegmentNodes(segmentId)!
        .filter((node) => node.nodeId >= 2n ** 63n),
    ).toHaveLength(3);

    rejectFirstAdd!(new Error("server rejected"));
    await waitForMicrotasks(5);

    expect(showErrorMessage).not.toHaveBeenCalled();
    expectReloadRequired(spatialSkeletonState, "indeterminate");
    expect(addNode).toHaveBeenCalledTimes(1);
    expect(
      spatialSkeletonState
        .getCachedSegmentNodes(segmentId)!
        .some((node) => node.nodeId >= 2n ** 63n),
    ).toBe(false);
  });

  it("rolls back a move queued against a pending optimistic add when the add is rejected", async () => {
    suppressStatusMessages();

    const segmentId = 23n;
    const parentNode: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([4, 5, 6]),
    };
    let rejectAdd: ((error: Error) => void) | undefined;
    const addPromise = new Promise<any>((_resolve, reject) => {
      rejectAdd = reject;
    });
    const addNode = vi.fn(() => addPromise);
    const moveNode = vi.fn();
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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
    await waitForMicrotasks();

    const optimisticNode = spatialSkeletonState
      .getCachedSegmentNodes(segmentId)!
      .find((node) => node.nodeId >= 2n ** 63n);
    expect(optimisticNode).toBeDefined();

    await executeSpatialSkeletonMoveNode(layer as any, {
      node: optimisticNode!,
      nextPositionInModelSpace: new Float32Array([10, 11, 12]),
    });
    await waitForMicrotasks();

    expect(moveNode).not.toHaveBeenCalled();
    expect(
      Array.from(
        spatialSkeletonState.getCachedNode(optimisticNode!.nodeId)!.position,
      ),
    ).toEqual([10, 11, 12]);

    rejectAdd!(new Error("server rejected"));
    await waitForMicrotasks(5);

    expect(moveNode).not.toHaveBeenCalled();
    expect(
      spatialSkeletonState
        .getCachedSegmentNodes(segmentId)!
        .some((node) => node.nodeId >= 2n ** 63n),
    ).toBe(false);
  });

  it.each(["ends", "  \n\t", ""])(
    "adopts an empty normalized description after saving %j",
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
      const { layer, spatialSkeletonState: state } =
        makeOptimisticAddNodeTestLayer({
          initialNodes: [node],
          segmentId: 23n,
          updateDescription,
        });
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

  it("keeps a saved description undoable after rejecting a move and canceling its child", async () => {
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
    const { layer, spatialSkeletonState: state } =
      makeOptimisticAddNodeTestLayer({
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
      state.getOptimisticEditQueueRecentActivity().map(({ status }) => status),
    ).toEqual(["not-saved", "not-saved", "saved"]);
    expect(state.hasUnconfirmedOptimisticEdits()).toBe(false);
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

  it("retains a definitive rejection and its canceled suffix in recent activity", async () => {
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
      moveNode,
      initialNodes: [node],
      segmentId,
    });
    const detachAuthorityNotifications = attachAuthorityNotifications(layer);

    await executeSpatialSkeletonMoveNode(layer as any, {
      node,
      nextPositionInModelSpace: new Float32Array([4, 5, 6]),
    });
    const projectedNode = spatialSkeletonState.getCachedNode(node.nodeId)!;
    await executeSpatialSkeletonMoveNode(layer as any, {
      node: projectedNode,
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
    expect(spatialSkeletonState.getOptimisticEditQueueRecentActivity()).toEqual(
      [
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
      ],
    );
    expect(showErrorMessage).toHaveBeenCalledWith(
      "CATMAID rejected node movement. The optimistic preview was removed. Request failed with HTTP 409 (Conflict). 1 later queued edit was also canceled.",
    );
    expect(spatialSkeletonState.hasUnconfirmedOptimisticEdits()).toBe(false);
    expect(spatialSkeletonState.commandHistory.canUndo.value).toBe(false);
    expect(spatialSkeletonState.commandHistory.canRedo.value).toBe(false);
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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
        Array.from(spatialSkeletonState.getCachedNode(1n)!.position),
      ).toEqual([4, 5, 6]);
      rejectMove(error);
      await execution.settled;
      await waitForMicrotasks(10);
      expect(
        Array.from(spatialSkeletonState.getCachedNode(1n)!.position),
      ).toEqual([1, 2, 3]);
      expect(spatialSkeletonState.commandHistory.canUndo.value).toBe(false);
      expect(spatialSkeletonState.hasUnconfirmedOptimisticEdits()).toBe(false);
      expect(StatusMessage.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining(instructions),
      );
    } finally {
      detach();
    }
  });

  it("keeps interaction overlays separate while remapping an optimistic move", async () => {
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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
    const optimisticNode = spatialSkeletonState
      .getCachedSegmentNodes(segmentId)!
      .find((node) => node.nodeId >= 2n ** 63n)!;
    spatialSkeletonState.setPendingNodePosition(
      optimisticNode.nodeId,
      [8, 8, 8],
    );

    await executeSpatialSkeletonMoveNode(layer as any, {
      node: optimisticNode,
      nextPositionInModelSpace: new Float32Array([10, 11, 12]),
    });
    expect(
      Array.from(
        spatialSkeletonState.getCachedNode(optimisticNode.nodeId)!.position,
      ),
    ).toEqual([10, 11, 12]);
    expect(
      Array.from(
        spatialSkeletonState.getPendingNodePosition(optimisticNode.nodeId)!,
      ),
    ).toEqual([8, 8, 8]);
    expect(moveNode).not.toHaveBeenCalled();

    resolveAdd?.({
      nodeId: realNodeId,
      segmentId,
    });
    await waitForMicrotasks(12);

    expect(
      spatialSkeletonState.getPendingNodePosition(optimisticNode.nodeId),
    ).toBeUndefined();
    expect(
      Array.from(spatialSkeletonState.getPendingNodePosition(realNodeId)!),
    ).toEqual([8, 8, 8]);
    expect(
      Array.from(spatialSkeletonState.getCachedNode(realNodeId)!.position),
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
      Array.from(spatialSkeletonState.getPendingNodePosition(realNodeId)!),
    ).toEqual([8, 8, 8]);
    expect(
      Array.from(spatialSkeletonState.getCachedNode(realNodeId)!.position),
    ).toEqual([7, 8, 9]);
    expect(spatialSkeletonState.clearPendingNodePositions()).toBe(true);
    expect(
      spatialSkeletonState.getPendingNodePosition(realNodeId),
    ).toBeUndefined();
  });

  it("rolls back a delete queued against a pending optimistic add when the add is rejected", async () => {
    suppressStatusMessages();

    const segmentId = 23n;
    const parentNode: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([4, 5, 6]),
    };
    let rejectAdd: ((error: Error) => void) | undefined;
    const addPromise = new Promise<any>((_resolve, reject) => {
      rejectAdd = reject;
    });
    const addNode = vi.fn(() => addPromise);
    const deleteNode = vi.fn();
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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

    const optimisticNode = spatialSkeletonState
      .getCachedSegmentNodes(segmentId)!
      .find((node) => node.nodeId >= 2n ** 63n);
    expect(optimisticNode).toBeDefined();

    await executeSpatialSkeletonDeleteNode(layer as any, optimisticNode!);
    await waitForMicrotasks();

    expect(deleteNode).not.toHaveBeenCalled();
    expect(
      spatialSkeletonState.getCachedNode(optimisticNode!.nodeId),
    ).toBeUndefined();

    rejectAdd!(new Error("server rejected"));
    await waitForMicrotasks(5);

    expect(deleteNode).not.toHaveBeenCalled();
    expect(
      spatialSkeletonState
        .getCachedSegmentNodes(segmentId)!
        .some((node) => node.nodeId >= 2n ** 63n),
    ).toBe(false);
  });

  it("records a confirmed optimistic add-node in undo history", async () => {
    suppressStatusMessages();
    const showTemporaryMessage = vi.mocked(StatusMessage.showTemporaryMessage);

    const segmentId = 23n;
    const parentNode: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([4, 5, 6]),
    };
    const addNode = vi.fn().mockResolvedValue({
      nodeId: 2n,
      segmentId,
    });
    const deleteNode = vi.fn().mockResolvedValue({});
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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
    await waitForMicrotasks(5);

    expect(spatialSkeletonState.getOptimisticEditQueueSnapshot()).toEqual([
      expect.objectContaining({
        kind: "addNode",
        lifecycle: expect.objectContaining({
          authority: "committed",
          reconciliation: "complete",
          history: "advanced",
        }),
      }),
    ]);
    expect(spatialSkeletonState.getCachedNode(2n)).toMatchObject({
      nodeId: 2n,
      segmentId,
      parentNodeId: parentNode.nodeId,
    });
    expect(spatialSkeletonState.commandHistory.canUndo.value).toBe(true);
    expect(showTemporaryMessage).not.toHaveBeenCalled();

    await undoSpatialSkeletonCommand(layer as any);
    await waitForMicrotasks();

    expect(deleteNode).toHaveBeenCalledWith(2n);
    expect(spatialSkeletonState.getCachedNode(2n)).toBeUndefined();
  });

  it("previews and reconciles root add-node when optimistic edits are enabled", async () => {
    suppressStatusMessages();
    const showTemporaryMessage = vi.mocked(StatusMessage.showTemporaryMessage);

    const segmentId = 23n;
    let resolveAdd: ((value: any) => void) | undefined;
    const addNode = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveAdd = resolve;
      }),
    );
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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

    const pendingEntry =
      spatialSkeletonState.getOptimisticEditQueueSnapshot()[0];
    expect(pendingEntry).toMatchObject({
      kind: "addNode",
    });
    const previewRoot = spatialSkeletonState.getCachedNode(2n ** 63n + 1n)!;
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
    expect(spatialSkeletonState.getOptimisticEditQueueSnapshot()).toEqual([
      expect.objectContaining({
        kind: "addNode",
        lifecycle: expect.objectContaining({ authority: "committed" }),
      }),
    ]);
    expect(spatialSkeletonState.commandHistory.canUndo.value).toBe(true);
    expect(spatialSkeletonState.getCachedNode(2n)).toMatchObject({
      nodeId: 2n,
      segmentId,
      parentNodeId: undefined,
    });
    expect(showTemporaryMessage).not.toHaveBeenCalled();
  });

  it("preserves current root display membership when its temporary id commits", async () => {
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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
    const previewRoot = spatialSkeletonState.getCachedNode(2n ** 63n + 1n)!;
    const tempSegment = previewRoot.segmentId;
    const realSegment = realSegmentId;
    const groupState = layer.displayState.segmentationGroupState.value;

    // Simulate changes made while CATMAID is still creating the skeleton: the
    // user hides the preview but keeps temporary and selected membership.
    groupState.visibleSegments.delete(tempSegment);
    groupState.temporaryVisibleSegments.add(tempSegment);
    groupState.selectedSegments.add(tempSegment);

    resolveAdd?.({
      nodeId: realNodeId,
      segmentId: realSegmentId,
    });
    await waitForMicrotasks(20);

    expect(groupState.visibleSegments.has(tempSegment)).toBe(false);
    expect(groupState.temporaryVisibleSegments.has(tempSegment)).toBe(false);
    expect(groupState.selectedSegments.has(tempSegment)).toBe(false);
    expect(groupState.visibleSegments.has(realSegment)).toBe(false);
    expect(groupState.temporaryVisibleSegments.has(realSegment)).toBe(true);
    expect(groupState.selectedSegments.has(realSegment)).toBe(true);
    expect(layer.selectedSpatialSkeletonNodeInfo.value).toMatchObject({
      nodeId: realNodeId,
      segmentId: realSegmentId,
    });
  });

  it("rolls back a child add and split after its root temp segment is reconciled", async () => {
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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
    const previewRoot = spatialSkeletonState.getCachedNode(2n ** 63n + 1n)!;
    const tempRootNodeId = previewRoot.nodeId;
    const tempRootSegmentId = previewRoot.segmentId;

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: tempRootSegmentId,
      parentNodeId: tempRootNodeId,
      positionInModelSpace: new Float32Array([4, 5, 6]),
    });
    const tempChild = spatialSkeletonState
      .getCachedSegmentNodes(tempRootSegmentId)!
      .find((node) => node.nodeId !== tempRootNodeId)!;

    await executeSpatialSkeletonSplit(layer as any, tempChild);
    const tempSplitSegmentId = spatialSkeletonState.getCachedNode(
      tempChild.nodeId,
    )!.segmentId;

    expect(addNode).toHaveBeenCalledTimes(1);
    expect(splitSkeleton).not.toHaveBeenCalled();
    expect(spatialSkeletonState.getCachedNode(tempChild.nodeId)).toMatchObject({
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
    expect(spatialSkeletonState.getCachedNode(realRootNodeId)).toMatchObject({
      segmentId: realSegmentId,
      parentNodeId: undefined,
    });
    expect(
      spatialSkeletonState.getCachedSegmentNodes(tempRootSegmentId),
    ).toBeUndefined();

    rejectChildAdd?.(new Error("child add rejected"));
    await waitForMicrotasks(40);

    expect(splitSkeleton).not.toHaveBeenCalled();
    expect(spatialSkeletonState.getOptimisticEditQueueSnapshot()).toEqual(
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
      spatialSkeletonState
        .getCachedSegmentNodes(realSegmentId)
        ?.map((node) => node.nodeId),
    ).toEqual([realRootNodeId]);
    expect(
      spatialSkeletonState.getCachedSegmentNodes(tempRootSegmentId),
    ).toBeUndefined();
    expect(
      spatialSkeletonState.getCachedSegmentNodes(tempSplitSegmentId),
    ).toBeUndefined();
    expect(showErrorMessage).not.toHaveBeenCalled();
    expectReloadRequired(spatialSkeletonState, "indeterminate");
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
    "keeps a pending Merge complete when its %s input saves (reversed: %s)",
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
      const { layer, spatialSkeletonState: state } =
        makeOptimisticAddNodeTestLayer({
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
      const group = layer.displayState.segmentationGroupState.value;
      const expectCompletePreview = (nodeId: bigint) => {
        expect(previewId).not.toBe(inputNode.segmentId);
        expect(cachedTopologyForTest(state, [previewId])).toEqual(
          [
            [nodeId, previewId, null],
            [201n, previewId, nodeId],
          ].sort((a, b) => bigintCompare(a[0]!, b[0]!)),
        );
        expect(
          state.spatialSkeletonPresentation.value.numericAliases,
        ).toContainEqual(
          expect.objectContaining({
            segmentId: previewId,
            authoritative: false,
          }),
        );
        expect(group.visibleSegments).toEqual(new Set([11n, previewId]));
        expect(layer.selectedSpatialSkeletonNodeInfo.value?.segmentId).toBe(
          previewId,
        );
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
      expect(group.visibleSegments).toEqual(new Set([11n, resultSegmentId]));
      expect(state.getOptimisticEditFatalState()).toBeUndefined();
    },
  );

  it("restores real root and existing skeleton when a remapped dependent merge is rejected", async () => {
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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
    const tempRoot = spatialSkeletonState.getCachedNode(2n ** 63n + 1n)!;
    const tempRootNodeId = tempRoot.nodeId;
    const tempRootSegmentId = tempRoot.segmentId;

    // The existing skeleton is the preview winner and the pending root's
    // temporary segment is the losing side.
    await executeSpatialSkeletonMerge(layer as any, existingRoot, tempRoot);
    const mergedPreviewId = spatialSkeletonState.getCachedNode(
      existingRoot.nodeId,
    )!.segmentId;
    expect(mergedPreviewId).not.toBe(existingSegmentId);
    expect(mergeSkeletons).not.toHaveBeenCalled();
    expect(spatialSkeletonState.getCachedNode(tempRootNodeId)).toMatchObject({
      segmentId: mergedPreviewId,
      parentNodeId: existingRoot.nodeId,
    });

    resolveRootAdd?.({
      nodeId: realRootNodeId,
      segmentId: realRootSegmentId,
    });
    await waitForMicrotasks(30);

    expect(mergeSkeletons).toHaveBeenCalledTimes(1);
    expect(spatialSkeletonState.getCachedNode(realRootNodeId)).toMatchObject({
      segmentId: mergedPreviewId,
      parentNodeId: existingRoot.nodeId,
    });
    expect(
      spatialSkeletonState.getCachedSegmentNodes(tempRootSegmentId),
    ).toBeUndefined();

    rejectMerge?.(new Error("merge rejected"));
    await waitForMicrotasks(40);

    expect(spatialSkeletonState.getOptimisticEditQueueSnapshot()).toEqual(
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
      spatialSkeletonState
        .getCachedSegmentNodes(existingSegmentId)
        ?.map((node) => node.nodeId),
    ).toEqual([existingRoot.nodeId]);
    expect(spatialSkeletonState.getCachedNode(realRootNodeId)).toMatchObject({
      nodeId: realRootNodeId,
      segmentId: realRootSegmentId,
      parentNodeId: undefined,
    });
    expect(
      spatialSkeletonState
        .getCachedSegmentNodes(realRootSegmentId)
        ?.map((node) => node.nodeId),
    ).toEqual([realRootNodeId]);
    expect(showErrorMessage).not.toHaveBeenCalled();
    expectReloadRequired(spatialSkeletonState, "indeterminate");
    expect(
      showErrorMessage.mock.calls.some(([message]) =>
        /rollback.*failed|failed.*rollback|trusted.*handle/i.test(message),
      ),
    ).toBe(false);
  });

  it("requires reload after a committed add cannot publish locally", async () => {
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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
    const tempNodeId = spatialSkeletonState
      .getCachedSegmentNodes(segmentId)!
      .find((node) => node.nodeId >= 2n ** 63n)!.nodeId;
    replaceCachedSegmentForTest(
      spatialSkeletonState,
      segmentId,
      cloneNodes(spatialSkeletonState.getCachedSegmentNodes(segmentId)).map(
        (node) =>
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
    expect(spatialSkeletonState.getOptimisticEditQueueSnapshot()).toEqual([
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
    expect(spatialSkeletonState.getOptimisticEditFatalState()).toEqual(
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
    ).toThrow(SpatialSkeletonOptimisticReloadRequiredError);
    let settled = false;
    void execution.settled.then(() => (settled = true));
    await waitForMicrotasks();
    expect(settled).toBe(false);
  });

  it("retains the source lane without deleting a late committed root add", async () => {
    suppressStatusMessages();

    let resolveFirstAdd!: (value: {
      nodeId: bigint;
      segmentId: bigint;
    }) => void;
    const firstAdd = new Promise<{
      nodeId: bigint;
      segmentId: bigint;
    }>((resolve) => {
      resolveFirstAdd = resolve;
    });
    const addNode = vi
      .fn()
      .mockReturnValueOnce(firstAdd)
      .mockResolvedValueOnce({
        nodeId: 3n,
        segmentId: 29n,
      });
    const deleteNode = vi.fn();
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
      addNode,
      deleteNode,
      initialNodes: [],
      segmentId: 23n,
      segmentIds: [23n, 29n],
    });

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: 0n,
      parentNodeId: undefined,
      positionInModelSpace: new Float32Array([1, 2, 3]),
    });
    await waitForMicrotasks();
    expect(addNode).toHaveBeenCalledTimes(1);

    const oldQueue = (spatialSkeletonState as any).optimisticEditQueue;
    spatialSkeletonState.clearRuntimeState();
    const disposal = oldQueue.dispose();
    const replacement = executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: 0n,
      parentNodeId: undefined,
      positionInModelSpace: new Float32Array([4, 5, 6]),
    });
    await replacement;
    await waitForMicrotasks(6);

    expect(addNode).toHaveBeenCalledTimes(1);
    const replacementTempNode =
      spatialSkeletonState.spatialSkeletonPresentation.value.provisionalNodeIds
        .map((nodeId) => spatialSkeletonState.getCachedNode(nodeId))
        .find((node) => node !== undefined);
    expect(replacementTempNode).toMatchObject({
      position: new Float32Array([4, 5, 6]),
    });

    resolveFirstAdd({
      nodeId: 2n,
      segmentId: 23n,
    });
    await disposal;
    await waitForMicrotasks(10);

    expect(deleteNode).not.toHaveBeenCalled();
    expect(addNode).toHaveBeenCalledTimes(1);
    expectReloadRequired(spatialSkeletonState, "committed");
    expect(spatialSkeletonState.getCachedNode(2n)).toBeUndefined();
  });

  it("retains restored topology when a later split is rejected", async () => {
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
      insertNode,
      deleteNode: vi.fn().mockResolvedValue(undefined),
      splitSkeleton,
      initialNodes: [rootNode, deletedNode, childNode],
      segmentId,
    });

    await executeSpatialSkeletonDeleteNode(layer as any, deletedNode);
    await waitForMicrotasks(20);
    await undoSpatialSkeletonCommand(layer as any);
    const tempInsertedNodeId = spatialSkeletonState
      .getCachedSegmentNodes(segmentId)!
      .find(
        ({ nodeId }) =>
          nodeId !== rootNode.nodeId && nodeId !== childNode.nodeId,
      )!.nodeId;
    await executeSpatialSkeletonSplit(
      layer as any,
      spatialSkeletonState.getCachedNode(childNode.nodeId)!,
    );

    expect(splitSkeleton).not.toHaveBeenCalled();
    expect(spatialSkeletonState.getCachedNode(childNode.nodeId)).toMatchObject({
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
      spatialSkeletonState.getCachedNode(tempInsertedNodeId),
    ).toBeUndefined();
    expect(spatialSkeletonState.getCachedNode(insertedNodeId)).toMatchObject({
      segmentId,
      parentNodeId: rootNode.nodeId,
    });
    expect(spatialSkeletonState.getCachedNode(childNode.nodeId)).toMatchObject({
      segmentId,
      parentNodeId: insertedNodeId,
    });
  });

  it("queues optimistic undo and redo for every node attribute edit", async () => {
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
      updateDescription,
      toggleTrueEnd,
      updateRadius,
      updateConfidence,
      initialNodes: [rootNode, node],
      segmentId,
    });

    await executeSpatialSkeletonNodeDescriptionUpdate(layer as any, {
      node: spatialSkeletonState.getCachedNode(node.nodeId)!,
      nextDescription: "after",
    });
    await waitForMicrotasks(6);
    const descriptionUndo = undoSpatialSkeletonCommand(layer as any);
    await descriptionUndo;
    expect(spatialSkeletonState.getCachedNode(node.nodeId)?.description).toBe(
      "before",
    );
    await descriptionUndo.settled;
    await waitForMicrotasks(6);
    const descriptionRedo = redoSpatialSkeletonCommand(layer as any);
    await descriptionRedo;
    expect(spatialSkeletonState.getCachedNode(node.nodeId)?.description).toBe(
      "after",
    );
    await descriptionRedo.settled;
    await waitForMicrotasks(6);

    await executeSpatialSkeletonNodeTrueEndUpdate(layer as any, {
      node: spatialSkeletonState.getCachedNode(node.nodeId)!,
      nextIsTrueEnd: true,
    });
    await waitForMicrotasks(6);
    const undoExecution = undoSpatialSkeletonCommand(layer as any);
    await undoExecution;
    await waitForMicrotasks(6);
    await redoSpatialSkeletonCommand(layer as any);
    await waitForMicrotasks(6);

    await executeSpatialSkeletonNodeRadiusUpdate(layer as any, {
      node: spatialSkeletonState.getCachedNode(node.nodeId)!,
      nextRadius: 8,
    });
    await waitForMicrotasks(6);
    await undoSpatialSkeletonCommand(layer as any);
    await waitForMicrotasks(6);
    await redoSpatialSkeletonCommand(layer as any);
    await waitForMicrotasks(6);

    await executeSpatialSkeletonNodeConfidenceUpdate(layer as any, {
      node: spatialSkeletonState.getCachedNode(node.nodeId)!,
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
    expect(spatialSkeletonState.getCachedNode(node.nodeId)).toMatchObject({
      description: "after",
      attributes: { true_end: [1], radius: [8], confidence: [75] },
    });
  });

  it.each(["reroot", "merge"] as const)(
    "restores a newly created root's default confidence after %s Undo",
    async (operation) => {
      suppressStatusMessages();
      const updateConfidence = vi.fn(async () => undefined);
      const { layer, spatialSkeletonState: state } =
        makeOptimisticAddNodeTestLayer({
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
        });
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
      expect(state.getOptimisticEditFatalState()).toBeUndefined();
    },
  );

  it("previews optimistic reroot undo and redo from complete snapshots", async () => {
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
      rerootSkeleton,
      getSkeleton,
      initialNodes: [rootNode, middleNode, leafNode],
      segmentId,
    });

    await executeSpatialSkeletonReroot(layer as any, leafNode);
    await waitForMicrotasks(10);
    expect(spatialSkeletonState.getCachedNode(leafNode.nodeId)).toMatchObject({
      parentNodeId: undefined,
    });

    await expect(undoSpatialSkeletonCommand(layer as any)).resolves.toBe(true);
    await waitForMicrotasks(10);
    expect(spatialSkeletonState.getCachedNode(rootNode.nodeId)).toMatchObject({
      parentNodeId: undefined,
    });

    await expect(redoSpatialSkeletonCommand(layer as any)).resolves.toBe(true);
    await waitForMicrotasks(10);

    expect(rerootSkeleton).toHaveBeenCalledTimes(3);
    expect(rerootSkeleton).toHaveBeenNthCalledWith(1, leafNode.nodeId);
    expect(rerootSkeleton).toHaveBeenNthCalledWith(2, rootNode.nodeId);
    expect(rerootSkeleton).toHaveBeenNthCalledWith(3, leafNode.nodeId);
    expect(getSkeleton).not.toHaveBeenCalled();
    expect(spatialSkeletonState.getCachedNode(leafNode.nodeId)).toMatchObject({
      parentNodeId: undefined,
    });
    spatialSkeletonState.clearRuntimeState();
  });

  it("restores every parent link across branched reroot undo and redo", async () => {
    suppressStatusMessages();
    const nodes = makeRootRestorationNodesForTest().filter(
      (node) => node.segmentId === 17n,
    );
    const rerootSkeleton = vi.fn().mockResolvedValue({});
    const getSkeleton = vi.fn();
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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
    expect(cachedTopologyForTest(spatialSkeletonState, [17n])).toEqual(
      rerootedTopology,
    );
    await expect(reroot.settled).resolves.toMatchObject({
      outcome: "committed",
    });

    const undo = undoSpatialSkeletonCommand(layer as any);
    await expect(undo).resolves.toBe(true);
    expect(cachedTopologyForTest(spatialSkeletonState, [17n])).toEqual(
      originalTopology,
    );
    await expect(undo.settled).resolves.toMatchObject({ outcome: "committed" });

    const redo = redoSpatialSkeletonCommand(layer as any);
    await expect(redo).resolves.toBe(true);
    expect(cachedTopologyForTest(spatialSkeletonState, [17n])).toEqual(
      rerootedTopology,
    );
    await expect(redo.settled).resolves.toMatchObject({ outcome: "committed" });
    expect(cachedTopologyForTest(spatialSkeletonState, [17n])).toEqual(
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
      initialNodes: nodes,
      segmentId: 17n,
      splitSkeleton,
      mergeSkeletons,
      getSkeleton,
    });
    const expectSplitTopology = (splitSegmentId: bigint) => {
      expect(
        cachedTopologyForTest(spatialSkeletonState, [17n, splitSegmentId]),
      ).toEqual([
        [201n, 17n, null],
        [202n, splitSegmentId, null],
        [203n, splitSegmentId, 202n],
        [204n, splitSegmentId, 202n],
        [205n, splitSegmentId, 203n],
      ]);
    };
    const expectOriginalTopology = () => {
      expect(cachedTopologyForTest(spatialSkeletonState, [17n])).toEqual([
        [201n, 17n, null],
        [202n, 17n, 201n],
        [203n, 17n, 202n],
        [204n, 17n, 202n],
        [205n, 17n, 203n],
      ]);
    };

    const split = executeSpatialSkeletonSplit(layer as any, nodes[1]!);
    await split;
    const firstPreviewId = spatialSkeletonState.getCachedNode(202n)!.segmentId;
    expect(firstPreviewId).not.toBe(17n);
    expectSplitTopology(firstPreviewId);
    resolveSplit({ existingSegmentId: 17n, newSegmentId: 31n });
    await expect(split.settled).resolves.toMatchObject({
      outcome: "committed",
    });
    expectSplitTopology(31n);
    expect(
      spatialSkeletonState.getCachedSegmentNodes(firstPreviewId),
    ).toBeUndefined();

    const undo = undoSpatialSkeletonCommand(layer as any);
    await expect(undo).resolves.toBe(true);
    expectOriginalTopology();
    await expect(undo.settled).resolves.toMatchObject({ outcome: "committed" });
    expectOriginalTopology();
    expect(spatialSkeletonState.getCachedSegmentNodes(31n)).toBeUndefined();

    const redo = redoSpatialSkeletonCommand(layer as any);
    await expect(redo).resolves.toBe(true);
    const redoPreviewId = spatialSkeletonState.getCachedNode(202n)!.segmentId;
    expect(redoPreviewId).not.toBe(17n);
    expectSplitTopology(redoPreviewId);
    resolveSplit({ existingSegmentId: 17n, newSegmentId: 37n });
    await expect(redo.settled).resolves.toMatchObject({ outcome: "committed" });
    expectSplitTopology(37n);
    expect(spatialSkeletonState.getCachedSegmentNodes(31n)).toBeUndefined();
    expect(
      spatialSkeletonState.getCachedSegmentNodes(redoPreviewId),
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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
        cachedTopologyForTest(spatialSkeletonState, [11n, restoredSegmentId]),
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
        spatialSkeletonState.getCachedNode(101n)!.segmentId;
      expect(
        cachedTopologyForTest(spatialSkeletonState, [mergedPreviewId]),
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
      expect(cachedTopologyForTest(spatialSkeletonState, [11n])).toEqual(
        mergedTopology,
      );

      const undo = undoSpatialSkeletonCommand(layer as any);
      await expect(undo).resolves.toBe(true);
      const restoredPreviewId =
        spatialSkeletonState.getCachedNode(201n)!.segmentId;
      expect(restoredPreviewId).not.toBe(11n);
      expectRestoredTopology(restoredPreviewId);
      await expect(undo.settled).resolves.toMatchObject({
        outcome: "committed",
      });
      expectRestoredTopology(restoredSegmentId);
      expect(spatialSkeletonState.commandHistory.canRedo.value).toBe(true);
    }

    expect(spatialSkeletonState.getCachedSegmentNodes(17n)).toBeUndefined();
    expect(spatialSkeletonState.getCachedSegmentNodes(19n)).toBeUndefined();
    expect(mergeSkeletons.mock.calls).toEqual([
      [102n, 203n],
      [102n, 203n],
    ]);
    expect(splitSkeleton.mock.calls).toEqual([[203n], [203n]]);
    expect(rerootSkeleton.mock.calls).toEqual([[201n], [201n]]);
    expect(getSkeleton).not.toHaveBeenCalled();
  });

  it("keeps merge undo and subsequent writes pending until the original root is restored", async () => {
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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
      node: spatialSkeletonState.getCachedNode(201n)!,
      nextPositionInModelSpace: new Float32Array([40, 50, 60]),
    });
    await move;
    expect(
      Array.from(spatialSkeletonState.getCachedNode(201n)!.position),
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
    expect(cachedTopologyForTest(spatialSkeletonState, [11n, 19n])).toEqual([
      [101n, 11n, null],
      [102n, 11n, 101n],
      [201n, 19n, null],
      [202n, 19n, 201n],
      [203n, 19n, 202n],
      [204n, 19n, 202n],
      [205n, 19n, 203n],
    ]);
    expect(
      Array.from(spatialSkeletonState.getCachedNode(201n)!.position),
    ).toEqual([40, 50, 60]);
  });

  it("retains a bounded settled queue row with its undo recipe", async () => {
    suppressStatusMessages();

    const segmentId = 23n;
    const parentNode: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([4, 5, 6]),
    };
    const addNode = vi.fn().mockResolvedValue({
      nodeId: 2n,
      segmentId,
    });
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
      addNode,
      initialNodes: [parentNode],
      segmentId,
    });

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: segmentId,
      parentNodeId: parentNode.nodeId,
      positionInModelSpace: new Float32Array([7, 8, 9]),
    });
    await waitForMicrotasks(5);

    expect(spatialSkeletonState.getOptimisticEditQueueSnapshot()).toEqual([
      expect.objectContaining({
        kind: "addNode",
        lifecycle: expect.objectContaining({
          authority: "committed",
          reconciliation: "complete",
          history: "advanced",
        }),
      }),
    ]);
    expect(spatialSkeletonState.commandHistory.canUndo.value).toBe(true);

    expect(spatialSkeletonState.getOptimisticEditQueueSnapshot()).toHaveLength(
      1,
    );
    expect(spatialSkeletonState.commandHistory.canUndo.value).toBe(true);
  });

  it("retains committed optimistic dependencies until their pending dependents settle", async () => {
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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

    const optimisticParent = spatialSkeletonState
      .getCachedSegmentNodes(segmentId)!
      .find((node) => node.nodeId >= 2n ** 63n);
    expect(optimisticParent).toBeDefined();

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: segmentId,
      parentNodeId: optimisticParent!.nodeId,
      positionInModelSpace: new Float32Array([10, 11, 12]),
    });
    await waitForMicrotasks();

    resolveParentAdd!({
      nodeId: 2n,
      segmentId,
    });
    await waitForMicrotasks(10);

    expect(addNode).toHaveBeenCalledTimes(2);
    expect(spatialSkeletonState.getOptimisticEditQueueSnapshot()).toEqual(
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
      spatialSkeletonState
        .getOptimisticEditQueueSnapshot()
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
      deleteNode,
      initialNodes: [node],
      segmentId: node.segmentId,
    });
    layer.selectSpatialSkeletonNode(node.nodeId, true, node);
    const execution = executeSpatialSkeletonDeleteNode(layer as any, node);
    await execution;
    await waitForMicrotasks();
    expect(spatialSkeletonState.getCachedNode(node.nodeId)).toBeUndefined();
    expect(layer.selectedSpatialSkeletonNodeInfo.value).toBeUndefined();
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
    expect(spatialSkeletonState.getCachedNode(node.nodeId)).toMatchObject(node);
    expect(
      spatialSkeletonState.spatialSkeletonPresentation.value.removedSegmentIds,
    ).not.toContain(node.segmentId);
    expect(layer.selectedSpatialSkeletonNodeInfo.value).toMatchObject({
      nodeId: node.nodeId,
      segmentId: node.segmentId,
    });
    expect(spatialSkeletonState.getOptimisticEditFatalState()).toBeUndefined();
    expect(spatialSkeletonState.commandHistory.canUndo.value).toBe(false);
  });

  it("restores a pending delete rollback with a remapped real parent id", async () => {
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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

    const optimisticParent = spatialSkeletonState
      .getCachedSegmentNodes(segmentId)!
      .find((node) => node.nodeId >= 2n ** 63n);
    expect(optimisticParent).toBeDefined();

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: segmentId,
      parentNodeId: optimisticParent!.nodeId,
      positionInModelSpace: new Float32Array([10, 11, 12]),
    });
    await waitForMicrotasks();

    const optimisticChild = spatialSkeletonState
      .getCachedSegmentNodes(segmentId)!
      .find((node) => node.parentNodeId === optimisticParent!.nodeId);
    expect(optimisticChild).toBeDefined();

    await executeSpatialSkeletonDeleteNode(layer as any, optimisticChild!);
    await waitForMicrotasks();

    resolveParentAdd!({
      nodeId: 2n,
      segmentId,
    });
    await waitForMicrotasks(5);

    await undoSpatialSkeletonCommand(layer as any);

    expect(
      spatialSkeletonState.getCachedNode(optimisticChild!.nodeId),
    ).toMatchObject({
      nodeId: optimisticChild!.nodeId,
      parentNodeId: 2n,
    });

    resolveChildAdd!({
      nodeId: 3n,
      segmentId,
    });
    await waitForMicrotasks(5);
  });

  it("removes a pending optimistic move-node preview without sending it", async () => {
    suppressStatusMessages();

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
    const moveNode = vi.fn();
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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
    await waitForMicrotasks();
    await executeSpatialSkeletonMoveNode(layer as any, {
      node: parentNode,
      nextPositionInModelSpace: new Float32Array([10, 11, 12]),
    });
    await waitForMicrotasks();

    expect(moveNode).not.toHaveBeenCalled();
    expect(
      Array.from(
        spatialSkeletonState.getCachedNode(parentNode.nodeId)!.position,
      ),
    ).toEqual([10, 11, 12]);

    const moveUndo = undoSpatialSkeletonCommand(layer as any);

    expect(moveNode).not.toHaveBeenCalled();
    expect(
      Array.from(
        spatialSkeletonState.getCachedNode(parentNode.nodeId)!.position,
      ),
    ).toEqual([4, 5, 6]);
    await moveUndo;

    resolveAdd!({
      nodeId: 2n,
      segmentId,
    });
    await waitForMicrotasks(5);
  });

  it("runs an explicit move-node undo after its in-flight execute commits", async () => {
    suppressStatusMessages();
    const showTemporaryMessage = vi.mocked(StatusMessage.showTemporaryMessage);

    const segmentId = 23n;
    const node: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([4, 5, 6]),
    };
    let resolveMove: (() => void) | undefined;
    const movePromise = new Promise<void>((resolve) => {
      resolveMove = resolve;
    });
    const moveNode = vi
      .fn()
      .mockReturnValueOnce(movePromise)
      .mockResolvedValueOnce({});
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
      moveNode,
      initialNodes: [node],
      segmentId,
    });

    const forwardExecution = executeSpatialSkeletonMoveNode(layer as any, {
      node,
      nextPositionInModelSpace: new Float32Array([10, 11, 12]),
    });
    await forwardExecution;
    await waitForMicrotasks();

    expect(moveNode).toHaveBeenCalledWith(node.nodeId, 10, 11, 12);
    expect(
      Array.from(spatialSkeletonState.getCachedNode(node.nodeId)!.position),
    ).toEqual([10, 11, 12]);

    const undoExecution = undoSpatialSkeletonCommand(layer as any);
    await undoExecution;

    expect(moveNode).toHaveBeenCalledTimes(1);
    expect(
      Array.from(spatialSkeletonState.getCachedNode(node.nodeId)!.position),
    ).toEqual([4, 5, 6]);

    resolveMove!();
    await expect(forwardExecution.settled).resolves.toMatchObject({
      outcome: "committed",
    });
    await expect(undoExecution.settled).resolves.toMatchObject({
      outcome: "committed",
    });

    expect(moveNode).toHaveBeenCalledTimes(2);
    expect(moveNode).toHaveBeenLastCalledWith(node.nodeId, 4, 5, 6);
    expect(showTemporaryMessage).not.toHaveBeenCalled();
    expect(spatialSkeletonState.commandHistory.canUndo.value).toBe(false);
  });

  it("fences later writes while an explicit move undo is ambiguous", async () => {
    suppressStatusMessages();

    const segmentId = 23n;
    const node: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([4, 5, 6]),
    };
    let resolveOriginalMove!: () => void;
    const originalMove = new Promise<void>((resolve) => {
      resolveOriginalMove = resolve;
    });
    let rejectUndo!: (error: Error) => void;
    const undoRequest = new Promise<any>((_resolve, reject) => {
      rejectUndo = reject;
    });
    const moveNode = vi
      .fn()
      .mockReturnValueOnce(originalMove)
      .mockReturnValueOnce(undoRequest)
      .mockResolvedValueOnce({});
    const getSkeleton = vi.fn(
      () => new Promise<readonly SkeletonNode[]>(() => {}),
    );
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
      moveNode,
      getSkeleton,
      initialNodes: [node],
      segmentId,
    });

    await executeSpatialSkeletonMoveNode(layer as any, {
      node,
      nextPositionInModelSpace: new Float32Array([10, 11, 12]),
    });
    await waitForMicrotasks();
    await expect(undoSpatialSkeletonCommand(layer as any)).resolves.toBe(true);

    resolveOriginalMove();
    await waitForMicrotasks(8);
    expect(moveNode).toHaveBeenCalledTimes(2);

    rejectUndo(
      new HttpError(
        "https://catmaid.example.test/1/node/update",
        0,
        "Network or CORS error",
      ),
    );
    await waitForMicrotasks(20);
    expect(spatialSkeletonState.getOptimisticEditQueueSnapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "moveNode",
          lifecycle: expect.objectContaining({
            authority: "committed",
            reconciliation: "complete",
          }),
        }),
        expect.objectContaining({
          kind: "moveNode",
          intent: "undo",
          lifecycle: expect.objectContaining({
            authority: "indeterminate",
            reconciliation: "blocked",
          }),
        }),
      ]),
    );
    expectReloadRequired(spatialSkeletonState, "indeterminate");

    expect(() =>
      executeSpatialSkeletonMoveNode(layer as any, {
        node,
        nextPositionInModelSpace: new Float32Array([20, 21, 22]),
      }),
    ).toThrow(SpatialSkeletonOptimisticReloadRequiredError);

    expect(moveNode).toHaveBeenCalledTimes(2);
    expect(spatialSkeletonState.getOptimisticEditQueueSnapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "moveNode",
          intent: "undo",
          lifecycle: expect.objectContaining({ authority: "indeterminate" }),
        }),
      ]),
    );
    spatialSkeletonState.dispose();
  });

  it("records a confirmed optimistic move-node in undo history", async () => {
    suppressStatusMessages();
    const showTemporaryMessage = vi.mocked(StatusMessage.showTemporaryMessage);

    const segmentId = 23n;
    const node: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([4, 5, 6]),
    };
    const moveNode = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const { layer, spatialSkeletonState, invalidateWholeSourceCache } =
      makeOptimisticAddNodeTestLayer({
        moveNode,
        initialNodes: [node],
        segmentId,
      });

    await executeSpatialSkeletonMoveNode(layer as any, {
      node,
      nextPositionInModelSpace: new Float32Array([10, 11, 12]),
    });
    await waitForMicrotasks(5);

    expect(spatialSkeletonState.commandHistory.canUndo.value).toBe(true);
    expect(
      Array.from(spatialSkeletonState.getCachedNode(node.nodeId)!.position),
    ).toEqual([10, 11, 12]);
    expect(showTemporaryMessage).not.toHaveBeenCalled();

    const undo = undoSpatialSkeletonCommand(layer as any);
    await undo;

    expect(
      Array.from(spatialSkeletonState.getCachedNode(node.nodeId)!.position),
    ).toEqual([4, 5, 6]);
    await undo.settled;
    expect(moveNode).toHaveBeenCalledTimes(2);
    expect(moveNode).toHaveBeenLastCalledWith(node.nodeId, 4, 5, 6);
    expect(invalidateWholeSourceCache).not.toHaveBeenCalled();
  });

  it("undoes directly from retained history after manager-cache eviction", async () => {
    suppressStatusMessages();
    const node: SkeletonNode = {
      nodeId: 1n,
      segmentId: 23n,
      position: new Float32Array([4, 5, 6]),
    };
    const getSkeleton = vi.fn();
    const moveNode = vi.fn().mockResolvedValue({});
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
      moveNode,
      getSkeleton,
      initialNodes: [node],
      segmentId: node.segmentId,
    });

    await executeSpatialSkeletonMoveNode(layer as any, {
      node,
      nextPositionInModelSpace: new Float32Array([10, 11, 12]),
    });
    await waitForMicrotasks(6);
    replaceCachedSegmentForTest(
      spatialSkeletonState,
      node.segmentId,
      undefined,
    );

    const undo = undoSpatialSkeletonCommand(layer as any);
    await expect(undo).resolves.toBe(true);
    expect(
      Array.from(spatialSkeletonState.getCachedNode(node.nodeId)!.position),
    ).toEqual([4, 5, 6]);
    await undo.settled;

    expect(moveNode).toHaveBeenCalledTimes(2);
    expect(getSkeleton).not.toHaveBeenCalled();
    expect(spatialSkeletonState.commandHistory.canUndo.value).toBe(false);
    expect(spatialSkeletonState.commandHistory.canRedo.value).toBe(true);
  });

  it("redoes directly from retained history after manager-cache eviction", async () => {
    suppressStatusMessages();
    const node: SkeletonNode = {
      nodeId: 1n,
      segmentId: 23n,
      position: new Float32Array([4, 5, 6]),
    };
    const getSkeleton = vi.fn();
    const moveNode = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
      moveNode,
      getSkeleton,
      initialNodes: [node],
      segmentId: node.segmentId,
    });

    await executeSpatialSkeletonMoveNode(layer as any, {
      node,
      nextPositionInModelSpace: new Float32Array([10, 11, 12]),
    });
    await waitForMicrotasks(6);
    const undo = undoSpatialSkeletonCommand(layer as any);
    await undo;
    await undo.settled;
    replaceCachedSegmentForTest(
      spatialSkeletonState,
      node.segmentId,
      undefined,
    );

    const redo = redoSpatialSkeletonCommand(layer as any);
    await expect(redo).resolves.toBe(true);
    expect(
      Array.from(spatialSkeletonState.getCachedNode(node.nodeId)!.position),
    ).toEqual([10, 11, 12]);
    await redo.settled;

    expect(moveNode).toHaveBeenCalledTimes(3);
    expect(getSkeleton).not.toHaveBeenCalled();
    expect(spatialSkeletonState.commandHistory.canUndo.value).toBe(true);
    expect(spatialSkeletonState.commandHistory.canRedo.value).toBe(false);
  });

  it("releases journal capacity after more than 64 sequential confirmations", async () => {
    suppressStatusMessages();
    const segmentId = 23n;
    const node: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([0, 0, 0]),
    };
    const moveNode = vi.fn().mockResolvedValue({});
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
      moveNode,
      initialNodes: [node],
      segmentId,
    });

    for (let index = 1; index <= 70; ++index) {
      await executeSpatialSkeletonMoveNode(layer as any, {
        node: spatialSkeletonState.getCachedNode(node.nodeId)!,
        nextPositionInModelSpace: new Float32Array([index, index, index]),
      });
      await waitForMicrotasks(5);
    }

    expect(moveNode).toHaveBeenCalledTimes(70);
    const retained = spatialSkeletonState.getOptimisticEditQueueSnapshot();
    expect(retained).toHaveLength(64);
    expect(
      retained.every(
        (entry) =>
          entry.lifecycle.authority === "committed" &&
          entry.lifecycle.reconciliation === "complete",
      ),
    ).toBe(true);
    expect(spatialSkeletonState.hasUnconfirmedOptimisticEdits()).toBe(false);
    expect(
      Array.from(spatialSkeletonState.getCachedNode(node.nodeId)!.position),
    ).toEqual([70, 70, 70]);
  });

  it("releases journal capacity after more than 64 pending execute-undo coalesces", async () => {
    suppressStatusMessages();
    const segmentId = 23n;
    const node: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([0, 0, 0]),
    };
    let resolveFirstMove: (() => void) | undefined;
    const moveNode = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFirstMove = resolve;
        }),
    );
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
      moveNode,
      initialNodes: [node],
      segmentId,
    });

    await executeSpatialSkeletonMoveNode(layer as any, {
      node,
      nextPositionInModelSpace: new Float32Array([1, 1, 1]),
    });
    await waitForMicrotasks();
    expect(moveNode).toHaveBeenCalledTimes(1);

    for (let index = 2; index <= 71; ++index) {
      await executeSpatialSkeletonMoveNode(layer as any, {
        node: spatialSkeletonState.getCachedNode(node.nodeId)!,
        nextPositionInModelSpace: new Float32Array([index, index, index]),
      });
      expect(await undoSpatialSkeletonCommand(layer as any)).toBe(true);
    }

    // Only the original request is unresolved.  Every later forward preview
    // was physically unsent and coalesced with its undo.
    expect(moveNode).toHaveBeenCalledTimes(1);
    expect(
      spatialSkeletonState
        .getOptimisticEditQueueSnapshot()
        .filter((entry) => entry.lifecycle.authority === "running"),
    ).toHaveLength(1);
    expect(
      Array.from(spatialSkeletonState.getCachedNode(node.nodeId)!.position),
    ).toEqual([1, 1, 1]);

    resolveFirstMove?.();
    await waitForMicrotasks(6);
    expect(spatialSkeletonState.hasUnconfirmedOptimisticEdits()).toBe(false);
  });

  it("keeps previewing to the 64-intent limit and resumes after a held POST", async () => {
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
      moveNode,
      initialNodes: nodes,
      segmentId,
    });

    const executions = [];
    for (let index = 0; index < 64; ++index) {
      const nextPosition = new Float32Array([index, index + 10, index + 20]);
      const execution = executeSpatialSkeletonMoveNode(layer as any, {
        node: spatialSkeletonState.getCachedNode(nodes[index].nodeId)!,
        nextPositionInModelSpace: nextPosition,
      });
      executions.push(execution);
      await execution.acceptedByQueue;
      await execution;
      expect(
        Array.from(
          spatialSkeletonState.getCachedNode(nodes[index].nodeId)!.position,
        ),
      ).toEqual(Array.from(nextPosition));
    }

    expect(moveNode).toHaveBeenCalledTimes(1);
    expect(spatialSkeletonState.getOptimisticEditQueueSnapshot()).toHaveLength(
      64,
    );

    const overflow = executeSpatialSkeletonMoveNode(layer as any, {
      node: spatialSkeletonState.getCachedNode(nodes[64].nodeId)!,
      nextPositionInModelSpace: new Float32Array([64, 74, 84]),
    });
    await expect(overflow).rejects.toThrow(
      "Optimistic edit queue has reached its 64-edit safety limit. Wait for the skeleton source to confirm some edits.",
    );
    expect(moveNode).toHaveBeenCalledTimes(1);
    expect(spatialSkeletonState.getOptimisticEditQueueSnapshot()).toHaveLength(
      64,
    );

    resolveFirstMove?.();
    await Promise.all(executions.map((execution) => execution.settled));

    // Settlement itself triggers the generation latch; no extra user event
    // is needed to submit the remaining ordered intents.
    expect(moveNode).toHaveBeenCalledTimes(64);
    expect(spatialSkeletonState.hasUnconfirmedOptimisticEdits()).toBe(false);
    expect(
      spatialSkeletonState
        .getOptimisticEditQueueSnapshot()
        .every((entry) => entry.lifecycle.authority === "committed"),
    ).toBe(true);
  });

  it("keeps the latest optimistic move preview when an older move commits", async () => {
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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
      Array.from(spatialSkeletonState.getCachedNode(node.nodeId)!.position),
    ).toEqual([10, 11, 12]);

    await executeSpatialSkeletonMoveNode(layer as any, {
      node: spatialSkeletonState.getCachedNode(node.nodeId)!,
      nextPositionInModelSpace: new Float32Array([20, 21, 22]),
    });
    await waitForMicrotasks();
    expect(moveNode).toHaveBeenCalledTimes(1);
    expect(
      Array.from(spatialSkeletonState.getCachedNode(node.nodeId)!.position),
    ).toEqual([20, 21, 22]);

    resolveFirstMove!();
    await waitForMicrotasks(20);

    expect(moveNode).toHaveBeenCalledTimes(2);
    expect(
      Array.from(spatialSkeletonState.getCachedNode(node.nodeId)!.position),
    ).toEqual([20, 21, 22]);

    resolveSecondMove!();
    await waitForMicrotasks(20);

    expect(
      Array.from(spatialSkeletonState.getCachedNode(node.nodeId)!.position),
    ).toEqual([20, 21, 22]);
  });

  it("removes a pending optimistic delete-node preview without sending it", async () => {
    suppressStatusMessages();

    const segmentId = 23n;
    const rootNode: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([1, 2, 3]),
    };
    const deletedNode: SkeletonNode = {
      nodeId: 2n,
      segmentId,
      parentNodeId: rootNode.nodeId,
      position: new Float32Array([4, 5, 6]),
    };
    const childNode: SkeletonNode = {
      nodeId: 3n,
      segmentId,
      parentNodeId: deletedNode.nodeId,
      position: new Float32Array([7, 8, 9]),
    };
    let resolveAdd:
      | ((value: { nodeId: bigint; segmentId: bigint }) => void)
      | undefined;
    const addPromise = new Promise<any>((resolve) => {
      resolveAdd = resolve;
    });
    const addNode = vi.fn(() => addPromise);
    const deleteNode = vi.fn();
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
      addNode,
      deleteNode,
      initialNodes: [rootNode, deletedNode, childNode],
      segmentId,
    });

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: segmentId,
      parentNodeId: rootNode.nodeId,
      positionInModelSpace: new Float32Array([10, 11, 12]),
    });
    await waitForMicrotasks();
    await executeSpatialSkeletonDeleteNode(layer as any, deletedNode);
    await waitForMicrotasks();

    expect(deleteNode).not.toHaveBeenCalled();
    expect(
      spatialSkeletonState.getCachedNode(deletedNode.nodeId),
    ).toBeUndefined();
    expect(
      spatialSkeletonState.getCachedNode(childNode.nodeId)?.parentNodeId,
    ).toBe(rootNode.nodeId);

    await undoSpatialSkeletonCommand(layer as any);

    expect(deleteNode).not.toHaveBeenCalled();
    expect(
      spatialSkeletonState.getCachedNode(deletedNode.nodeId),
    ).toMatchObject({
      nodeId: deletedNode.nodeId,
      parentNodeId: rootNode.nodeId,
    });
    expect(
      spatialSkeletonState.getCachedNode(childNode.nodeId)?.parentNodeId,
    ).toBe(deletedNode.nodeId);

    resolveAdd!({
      nodeId: 4n,
      segmentId,
    });
    await waitForMicrotasks(5);
  });

  it("records a confirmed optimistic delete-node in undo history", async () => {
    suppressStatusMessages();
    const showTemporaryMessage = vi.mocked(StatusMessage.showTemporaryMessage);

    const segmentId = 23n;
    const rootNode: SkeletonNode = {
      nodeId: 1n,
      segmentId,
      position: new Float32Array([1, 2, 3]),
    };
    const deletedNode: SkeletonNode = {
      nodeId: 2n,
      segmentId,
      parentNodeId: rootNode.nodeId,
      position: new Float32Array([4, 5, 6]),
    };
    const deleteNode = vi.fn().mockResolvedValue({});
    const addNode = vi.fn().mockResolvedValue({
      nodeId: 20n,
      segmentId,
    });
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
      addNode,
      deleteNode,
      initialNodes: [rootNode, deletedNode],
      segmentId,
    });

    await executeSpatialSkeletonDeleteNode(layer as any, deletedNode);
    await waitForMicrotasks(5);

    expect(
      spatialSkeletonState.getCachedNode(deletedNode.nodeId),
    ).toBeUndefined();
    expect(spatialSkeletonState.commandHistory.canUndo.value).toBe(true);
    expect(showTemporaryMessage).not.toHaveBeenCalled();

    const undo = undoSpatialSkeletonCommand(layer as any);
    await undo;

    expect(
      spatialSkeletonState
        .getCachedSegmentNodes(segmentId)
        ?.some((node) => node.nodeId >= 2n ** 63n),
    ).toBe(true);
    await undo.settled;
    expect(addNode).toHaveBeenCalledWith(4, 5, 6, rootNode.nodeId);
    expect(spatialSkeletonState.getCachedNode(20n)).toMatchObject({
      nodeId: 20n,
      parentNodeId: rootNode.nodeId,
    });
  });

  it("previews and reconciles an optimistic skeleton split with nocheck", async () => {
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
    const { layer, skeletonLayer, spatialSkeletonState } =
      makeOptimisticAddNodeTestLayer({
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
    await waitForPresentationTurn();
    await execution;
    const previewSplitNode = spatialSkeletonState.getCachedNode(
      splitNode.nodeId,
    )!;
    const tempSegmentId = previewSplitNode.segmentId;
    expect(tempSegmentId).not.toBe(segmentId);
    expect(previewSplitNode.parentNodeId).toBeUndefined();
    expect(
      spatialSkeletonState
        .getCachedSegmentNodes(tempSegmentId)
        ?.map((node) => node.nodeId),
    ).toEqual([splitNode.nodeId, childNode.nodeId]);
    expect(
      spatialSkeletonState.spatialSkeletonPresentation.value.numericAliases,
    ).toContainEqual(
      expect.objectContaining({
        segmentId: tempSegmentId,
        authoritative: false,
      }),
    );
    expect(splitSkeleton).toHaveBeenCalledWith(splitNode.nodeId);

    resolveSplit?.({ existingSegmentId: segmentId, newSegmentId });
    await waitForMicrotasks(12);

    expect(spatialSkeletonState.getCachedSegmentNodes(tempSegmentId)).toBe(
      undefined,
    );
    expect(spatialSkeletonState.getCachedNode(splitNode.nodeId)).toMatchObject({
      segmentId: newSegmentId,
      parentNodeId: undefined,
    });
    expect(
      spatialSkeletonState.spatialSkeletonPresentation.value.numericAliases,
    ).toContainEqual(
      expect.objectContaining({
        segmentId: newSegmentId,
        authoritative: true,
      }),
    );
    expect(
      spatialSkeletonState.spatialSkeletonPresentation.value.numericAliases,
    ).not.toContainEqual(
      expect.objectContaining({
        segmentId: tempSegmentId,
        authoritative: false,
      }),
    );
    expect(skeletonLayer.remapOverlaySegments).toHaveBeenCalledWith(
      new Map([[tempSegmentId, newSegmentId]]),
    );
    expect(getSkeleton).not.toHaveBeenCalled();
    expect(spatialSkeletonState.commandHistory.canUndo.value).toBe(true);
  });

  it("undoes a retained split without hydrating an evicted manager cache", async () => {
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
    const splitSideNodes = [
      {
        ...cloneNode(splitNode),
        segmentId: newSegmentId,
        parentNodeId: undefined,
      },
    ];
    const splitSkeleton = vi.fn().mockResolvedValue({
      existingSegmentId: segmentId,
      newSegmentId,
    });
    const mergeSkeletons = vi.fn().mockResolvedValue({
      resultSegmentId: segmentId,
      deletedSegmentId: newSegmentId,
    });
    const getSkeleton = vi.fn(async (requestedSegmentId: bigint) =>
      requestedSegmentId === segmentId ? [rootNode] : splitSideNodes,
    );
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
      initialNodes: [rootNode, splitNode],
      segmentId,
      splitSkeleton,
      mergeSkeletons,
      getSkeleton,
    });

    const split = executeSpatialSkeletonSplit(layer as any, splitNode);
    await expect(split.settled).resolves.toMatchObject({
      outcome: "committed",
    });
    replaceCachedSegmentForTest(spatialSkeletonState, newSegmentId, undefined);
    getSkeleton.mockClear();

    const undo = undoSpatialSkeletonCommand(layer as any);
    await expect(undo).resolves.toBe(true);
    expect(spatialSkeletonState.getCachedNode(splitNode.nodeId)).toMatchObject({
      segmentId,
      parentNodeId: rootNode.nodeId,
    });
    await expect(undo.settled).resolves.toEqual(
      expect.objectContaining({ outcome: "committed" }),
    );
    expect(mergeSkeletons).toHaveBeenCalledWith(
      rootNode.nodeId,
      splitNode.nodeId,
    );
    expect(getSkeleton).not.toHaveBeenCalled();
  });

  it("merges back an explicitly undone in-flight optimistic split", async () => {
    suppressStatusMessages();
    const segmentId = 23n;
    const splitSegmentId = 31n;
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
    const mergeSkeletons = vi.fn().mockResolvedValue({
      resultSegmentId: segmentId,
      deletedSegmentId: splitSegmentId,
      directionAdjusted: false,
    });
    const getSkeleton = vi.fn(async (requestedSegmentId: bigint) =>
      requestedSegmentId === segmentId ? [rootNode, splitNode] : [],
    );
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
      initialNodes: [rootNode, splitNode],
      segmentId,
      splitSkeleton,
      mergeSkeletons,
      getSkeleton,
    });

    await executeSpatialSkeletonSplit(layer as any, splitNode);
    const splitUndo = undoSpatialSkeletonCommand(layer as any);
    await waitForPresentationTurn();

    expect(spatialSkeletonState.getCachedNode(splitNode.nodeId)).toMatchObject({
      segmentId,
      parentNodeId: rootNode.nodeId,
    });
    await expect(splitUndo).resolves.toBe(true);

    resolveSplit?.({
      existingSegmentId: segmentId,
      newSegmentId: splitSegmentId,
    });
    await waitForMicrotasks(12);

    expect(mergeSkeletons).toHaveBeenCalledWith(
      rootNode.nodeId,
      splitNode.nodeId,
    );
    expect(spatialSkeletonState.commandHistory.canUndo.value).toBe(false);
  });

  it("retains the source lane without merging back a disposed split that commits", async () => {
    suppressStatusMessages();
    const segmentId = 23n;
    const splitSegmentId = 31n;
    const independentSegmentId = 41n;
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
    const independentRoot: SkeletonNode = {
      nodeId: 10n,
      segmentId: independentSegmentId,
      position: new Float32Array([7, 8, 9]),
    };
    let resolveSplit!: (result: {
      existingSegmentId: bigint;
      newSegmentId: bigint;
    }) => void;
    const splitSkeleton = vi.fn(
      () =>
        new Promise<{
          existingSegmentId: bigint;
          newSegmentId: bigint;
        }>((resolve) => {
          resolveSplit = resolve;
        }),
    );
    const mergeSkeletons = vi.fn();
    const addNode = vi.fn().mockResolvedValue({
      nodeId: 11n,
      segmentId: independentSegmentId,
    });
    const getSkeleton = vi.fn(async (requestedSegmentId: bigint) => {
      if (requestedSegmentId === segmentId) return [rootNode, splitNode];
      if (requestedSegmentId === independentSegmentId) {
        return [independentRoot];
      }
      return [];
    });
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
      initialNodes: [rootNode, splitNode, independentRoot],
      segmentId,
      segmentIds: [segmentId, splitSegmentId, independentSegmentId],
      splitSkeleton,
      mergeSkeletons,
      addNode,
      getSkeleton,
    });

    await executeSpatialSkeletonSplit(layer as any, splitNode);
    await waitForMicrotasks();
    expect(splitSkeleton).toHaveBeenCalledTimes(1);

    const oldQueue = (spatialSkeletonState as any).optimisticEditQueue;
    spatialSkeletonState.clearRuntimeState();
    const disposal = oldQueue.dispose();
    seedCachedNodesForTest(spatialSkeletonState, [
      rootNode,
      splitNode,
      independentRoot,
    ]);
    const replacement = executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: independentSegmentId,
      parentNodeId: independentRoot.nodeId,
      positionInModelSpace: new Float32Array([10, 11, 12]),
    });
    await replacement;
    await waitForMicrotasks(8);

    // The local add remains visible, but the disposed structural write has an
    // unknown allocated skeleton id, so no replacement POST may bypass it.
    expect(addNode).not.toHaveBeenCalled();
    expect(
      spatialSkeletonState
        .getCachedSegmentNodes(independentSegmentId)
        ?.some((node) => node.nodeId >= 2n ** 63n),
    ).toBe(true);

    resolveSplit({
      existingSegmentId: segmentId,
      newSegmentId: splitSegmentId,
    });
    await disposal;
    await waitForMicrotasks(20);

    expect(mergeSkeletons).not.toHaveBeenCalled();
    expect(getSkeleton).not.toHaveBeenCalled();
    expect(addNode).not.toHaveBeenCalled();
    expectReloadRequired(spatialSkeletonState, "committed");
    expect(spatialSkeletonState.getCachedNode(11n)).toBeUndefined();
  });

  it("keeps an optimistic merge visible while reconciling a reversed direction", async () => {
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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

    expect(spatialSkeletonState.getCachedSegmentNodes(secondSegmentId)).toBe(
      undefined,
    );
    const mergedPreviewId = spatialSkeletonState.getCachedNode(
      firstNode.nodeId,
    )!.segmentId;
    expect(mergedPreviewId).not.toBe(firstSegmentId);
    expect(spatialSkeletonState.getCachedNode(secondNode.nodeId)).toMatchObject(
      {
        segmentId: mergedPreviewId,
        parentNodeId: firstNode.nodeId,
      },
    );
    expect(mergeSkeletons).toHaveBeenCalledWith(
      firstNode.nodeId,
      secondNode.nodeId,
    );

    const publishedReconciliationFrames: Array<{
      first: bigint[] | undefined;
      second: bigint[] | undefined;
    }> = [];
    const unsubscribePresentation =
      spatialSkeletonState.spatialSkeletonPresentation.changed.add(() => {
        publishedReconciliationFrames.push({
          first: spatialSkeletonState
            .getCachedSegmentNodes(firstSegmentId)
            ?.map((node) => node.nodeId),
          second: spatialSkeletonState
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
      spatialSkeletonState
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
      spatialSkeletonState.getCachedSegmentNodes(firstSegmentId),
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

    expect(spatialSkeletonState.getCachedNode(firstNode.nodeId)).toMatchObject({
      segmentId: secondSegmentId,
      parentNodeId: secondNode.nodeId,
    });
    expect(
      spatialSkeletonState.getCachedSegmentNodes(firstSegmentId),
    ).toBeUndefined();
    expect(spatialSkeletonState.commandHistory.canUndo.value).toBe(true);
    unsubscribePresentation();
  });

  it("retains a hidden merge target fetch while resolving an optimistic preview", async () => {
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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
    expect(spatialSkeletonState.getOptimisticEditQueueSnapshot()).toMatchObject(
      [
        {
          intent: "execute",
          operationId: 1,
          lifecycle: { preview: "preparing", authority: "queued" },
        },
      ],
    );
    expect(spatialSkeletonState.commandHistory.canUndo.value).toBe(true);
    expect(mergeSkeletons).not.toHaveBeenCalled();
    expect(
      spatialSkeletonState.evictInactiveSegmentNodes([firstSegmentId]),
    ).toBe(false);
    expect(secondFetchSignal?.aborted).toBe(false);

    secondFetchResolved = true;
    resolveSecondFetch?.([secondNode]);
    await execution;
    await waitForMicrotasks(12);

    expect(
      spatialSkeletonState
        .getCachedSegmentNodes(firstSegmentId)
        ?.map((node) => node.nodeId),
    ).toEqual([firstNode.nodeId, secondNode.nodeId]);
    expect(mergeSkeletons).toHaveBeenCalledWith(
      firstNode.nodeId,
      secondNode.nodeId,
    );
  });

  it("orders a cold merge, a warm merge, and a property edit using the preceding projected ownership", async () => {
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
    const warm = {
      nodeId: 301n,
      segmentId: 23n,
      position: new Float32Array([7, 8, 9]),
    };
    let resolveRead!: (nodes: SkeletonNode[]) => void;
    const getSkeleton = vi.fn(
      () =>
        new Promise<SkeletonNode[]>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const mergeSkeletons = vi
      .fn()
      .mockResolvedValueOnce({
        resultSegmentId: 11n,
        deletedSegmentId: 17n,
        directionAdjusted: false,
      })
      .mockResolvedValueOnce({
        resultSegmentId: 11n,
        deletedSegmentId: 23n,
        directionAdjusted: false,
      });
    const updateRadius = vi.fn().mockResolvedValue(undefined);
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
      initialNodes: [first, warm],
      segmentId: 11n,
      getSkeleton,
      mergeSkeletons,
      updateRadius,
    });
    const coldMerge = executeSpatialSkeletonMerge(layer as any, first, target);
    const warmMerge = executeSpatialSkeletonMerge(layer as any, first, warm);
    const radius = executeSpatialSkeletonNodeRadiusUpdate(layer as any, {
      node: first,
      nextRadius: 50,
    });
    await Promise.all([
      coldMerge.acceptedByQueue,
      warmMerge.acceptedByQueue,
      radius.acceptedByQueue,
    ]);
    await waitForMicrotasks(12);
    expect(
      spatialSkeletonState
        .getOptimisticEditQueueSnapshot()
        .map(({ operationId }) => operationId),
    ).toEqual([1, 2, 3]);
    expect(spatialSkeletonState.getCachedNode(first.nodeId)?.segmentId).toBe(
      11n,
    );
    expect(mergeSkeletons).not.toHaveBeenCalled();
    expect(updateRadius).not.toHaveBeenCalled();
    expect(getSkeleton).toHaveBeenCalledOnce();
    resolveRead([target]);
    await Promise.all([coldMerge, warmMerge, radius]);
    await Promise.all([coldMerge.settled, warmMerge.settled, radius.settled]);
    expect(mergeSkeletons.mock.calls).toEqual([
      [101n, 201n],
      [101n, 301n],
    ]);
    expect(updateRadius).toHaveBeenCalledWith(101n, 50);
    expect(mergeSkeletons.mock.invocationCallOrder[1]).toBeLessThan(
      updateRadius.mock.invocationCallOrder[0],
    );
    expect(
      spatialSkeletonState
        .getCachedSegmentNodes(11n)
        ?.map(({ nodeId }) => nodeId)
        .sort(),
    ).toEqual([101n, 201n, 301n]);
    expect(
      getSkeletonNodeRadius(spatialSkeletonState.getCachedNode(101n)!),
    ).toBe(50);
  });

  it("reacquires a cold merge source when an earlier save reverses skeleton ownership", async () => {
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
    const { layer, spatialSkeletonState: state } =
      makeOptimisticAddNodeTestLayer({
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
    expect(state.getOptimisticEditFatalState()).toBeUndefined();
  });

  it("redos a cold merge canceled before recipe construction using retained complete inputs", async () => {
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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
    expect(spatialSkeletonState.commandHistory.canRedo.value).toBe(true);
    const redo = redoSpatialSkeletonCommand(layer as any);
    await redo;
    await redo.settled;
    expect(mergeSkeletons).toHaveBeenCalledWith(101n, 201n);
    expect(spatialSkeletonState.getCachedNode(201n)).toMatchObject({
      segmentId: 11n,
      parentNodeId: 101n,
    });
    resolveOldRead([target]);
    await waitForMicrotasks(12);
    expect(spatialSkeletonState.getCachedNode(201n)?.segmentId).toBe(11n);
    expect(mergeSkeletons).toHaveBeenCalledOnce();
  });

  it("redos a merge canceled after compilation but before exact-preview publication", async () => {
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
    const prepare =
      SpatialSkeletonOptimisticProjectionRuntime.prototype.prepareExact;
    const projectionPort: {
      prepareExact: (
        ...args: Parameters<typeof prepare>
      ) => ReturnType<typeof prepare> | Promise<ReturnType<typeof prepare>>;
    } = SpatialSkeletonOptimisticProjectionRuntime.prototype;
    const prepareSpy = vi
      .spyOn(projectionPort, "prepareExact")
      .mockImplementationOnce(async function (
        this: SpatialSkeletonOptimisticProjectionRuntime,
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
    const { layer, spatialSkeletonState: state } =
      makeOptimisticAddNodeTestLayer({
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
      expect(state.getOptimisticEditFatalState()).toBeUndefined();
    } finally {
      releasePreview();
      prepareSpy.mockRestore();
    }
  });

  it("rejects a cold merge source without loading either participant", async () => {
    suppressStatusMessages();
    const firstNode: SkeletonNode = {
      nodeId: 101n,
      segmentId: 11n,
      position: new Float32Array([1, 2, 3]),
    };
    const secondNode: SkeletonNode = {
      nodeId: 201n,
      segmentId: 17n,
      position: new Float32Array([4, 5, 6]),
    };
    const getSkeleton = vi.fn();
    const mergeSkeletons = vi.fn();
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
      initialNodes: [],
      segmentId: firstNode.segmentId,
      segmentIds: [firstNode.segmentId, secondNode.segmentId],
      getSkeleton,
      mergeSkeletons,
    });

    const execution = executeSpatialSkeletonMerge(
      layer as any,
      firstNode,
      secondNode,
    );
    await expect(execution.acceptedByQueue).rejects.toThrow(
      "Inspect skeleton 11 before skeleton merging",
    );
    await expect(execution).rejects.toThrow(
      "Inspect skeleton 11 before skeleton merging",
    );

    expect(getSkeleton).not.toHaveBeenCalled();
    expect(mergeSkeletons).not.toHaveBeenCalled();
    expect(spatialSkeletonState.getOptimisticEditQueueSnapshot()).toEqual([]);
    expect(spatialSkeletonState.commandHistory.canUndo.value).toBe(false);
  });

  it("rejects a node action when only its picked node is known", async () => {
    suppressStatusMessages();
    const node: SkeletonNode = {
      nodeId: 101n,
      segmentId: 23n,
      position: new Float32Array([1, 2, 3]),
    };
    const getSkeleton = vi.fn();
    const moveNode = vi.fn().mockResolvedValue({});
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
      initialNodes: [],
      segmentId: node.segmentId,
      getSkeleton,
      moveNode,
    });
    const execution = executeSpatialSkeletonMoveNode(layer as any, {
      node,
      nextPositionInModelSpace: new Float32Array([7, 8, 9]),
    });
    await expect(execution.acceptedByQueue).rejects.toThrow(
      "Inspect skeleton 23 before node movement",
    );
    await expect(execution).rejects.toThrow(
      "Inspect skeleton 23 before node movement",
    );

    expect(getSkeleton).not.toHaveBeenCalled();
    expect(moveNode).not.toHaveBeenCalled();
    expect(spatialSkeletonState.getOptimisticEditQueueSnapshot()).toEqual([]);
  });

  it("keeps an active drag above an older move during merge replay", async () => {
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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
      node: spatialSkeletonState.getCachedNode(firstNode.nodeId)!,
      nextPositionInModelSpace: nextPosition,
    });
    expect(moveNode).not.toHaveBeenCalled();

    const interactionPosition = new Float32Array([40, 50, 60]);
    spatialSkeletonState.setPendingNodePosition(
      firstNode.nodeId,
      interactionPosition,
    );
    // Removing the projected complete snapshot forces confirmation through
    // rollback/rebase/replay, while the interaction override stays visible.
    replaceCachedSegmentForTest(
      spatialSkeletonState,
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
        spatialSkeletonState.getPendingNodePosition(firstNode.nodeId)!,
      ),
    ).toEqual(Array.from(interactionPosition));
    const updatedInteractionPosition = new Float32Array([70, 80, 90]);
    spatialSkeletonState.setPendingNodePosition(
      firstNode.nodeId,
      updatedInteractionPosition,
    );
    expect(
      Array.from(
        spatialSkeletonState.getPendingNodePosition(firstNode.nodeId)!,
      ),
    ).toEqual(Array.from(updatedInteractionPosition));

    spatialSkeletonState.clearPendingNodePositions();
    expect(
      spatialSkeletonState.getPendingNodePosition(firstNode.nodeId),
    ).toBeUndefined();
    expect(
      Array.from(
        spatialSkeletonState.getCachedNode(firstNode.nodeId)!.position,
      ),
    ).toEqual(Array.from(nextPosition));
    spatialSkeletonState.clearRuntimeState();
  });

  it("does not verify topology after a committed optimistic merge", async () => {
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
      const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
        initialNodes: [firstNode, secondNode],
        segmentId: firstSegmentId,
        segmentIds: [firstSegmentId, secondSegmentId],
        mergeSkeletons,
        getSkeleton,
      });

      await afterPresentationTurnWithFakeTimers(
        executeSpatialSkeletonMerge(layer as any, firstNode, secondNode),
      );
      await waitForMicrotasks(20);

      expect(getSkeleton).not.toHaveBeenCalled();
      expect(showErrorMessage).not.toHaveBeenCalled();

      vi.advanceTimersByTime(30_000);
      await waitForMicrotasks(20);
      expect(getSkeleton).not.toHaveBeenCalled();

      spatialSkeletonState.clearRuntimeState();
    } finally {
      vi.useRealTimers();
    }
  });

  it("splits back an explicitly undone in-flight optimistic merge", async () => {
    suppressStatusMessages();
    const firstSegmentId = 11n;
    const secondSegmentId = 17n;
    const restoredSegmentId = 19n;
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
    const splitSkeleton = vi.fn().mockResolvedValue({
      existingSegmentId: firstSegmentId,
      newSegmentId: restoredSegmentId,
    });
    const getSkeleton = vi.fn(async (requestedSegmentId: bigint) => {
      if (requestedSegmentId === firstSegmentId) return [firstNode];
      if (requestedSegmentId === restoredSegmentId) {
        return [{ ...secondNode, segmentId: restoredSegmentId }];
      }
      return [];
    });
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
      initialNodes: [firstNode, secondNode],
      segmentId: firstSegmentId,
      segmentIds: [firstSegmentId, secondSegmentId],
      mergeSkeletons,
      splitSkeleton,
      getSkeleton,
    });

    const execution = executeSpatialSkeletonMerge(
      layer as any,
      firstNode,
      secondNode,
    );
    await execution;
    await vi.waitFor(() => expect(mergeSkeletons).toHaveBeenCalledTimes(1));
    const mergeUndo = undoSpatialSkeletonCommand(layer as any);
    await waitForPresentationTurn();

    const restoredPreview = spatialSkeletonState.getCachedNode(
      secondNode.nodeId,
    )!;
    expect(restoredPreview.parentNodeId).toBeUndefined();
    expect(restoredPreview.segmentId).not.toBe(firstSegmentId);
    expect(restoredPreview.segmentId).not.toBe(secondSegmentId);
    await expect(mergeUndo).resolves.toBe(true);

    resolveMerge?.({
      resultSegmentId: firstSegmentId,
      deletedSegmentId: secondSegmentId,
      directionAdjusted: false,
    });
    await vi.waitFor(() =>
      expect(splitSkeleton).toHaveBeenCalledWith(secondNode.nodeId),
    );
    await expect(execution.settled).resolves.toMatchObject({
      outcome: "committed",
    });
    await expect(mergeUndo.settled).resolves.toMatchObject({
      outcome: "committed",
    });
    expect(spatialSkeletonState.getCachedNode(secondNode.nodeId)).toMatchObject(
      {
        segmentId: restoredSegmentId,
        parentNodeId: undefined,
      },
    );
    expect(spatialSkeletonState.commandHistory.canUndo.value).toBe(false);
  });

  it("keeps rapid chained merge undos logically distinct while the first split is in flight", async () => {
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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
      spatialSkeletonState.getCachedNode(firstRoot.nodeId)!,
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

    const undoEntries = spatialSkeletonState
      .getOptimisticEditQueueSnapshot()
      .filter(
        (entry) => entry.kind === "mergeSkeletons" && entry.intent === "undo",
      );
    expect(undoEntries).toHaveLength(2);
    const thirdUndoSegmentId = spatialSkeletonState.getCachedNode(
      thirdRoot.nodeId,
    )!.segmentId;
    const secondUndoSegmentId = spatialSkeletonState.getCachedNode(
      secondRoot.nodeId,
    )!.segmentId;
    expect(thirdUndoSegmentId).not.toBe(secondUndoSegmentId);
    expect(spatialSkeletonState.getCachedNode(thirdRoot.nodeId)).toMatchObject({
      parentNodeId: undefined,
      segmentId: thirdUndoSegmentId,
    });
    expect(spatialSkeletonState.getCachedNode(secondRoot.nodeId)).toMatchObject(
      {
        parentNodeId: undefined,
        segmentId: secondUndoSegmentId,
      },
    );
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
      spatialSkeletonState.getCachedNode(secondRoot.nodeId)?.segmentId,
    ).toBe(firstRestoredSegmentId);
    expect(
      spatialSkeletonState.getCachedNode(thirdRoot.nodeId)?.segmentId,
    ).toBe(secondRestoredSegmentId);
    const identities =
      spatialSkeletonState.getOptimisticEditingIdentityService();
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
    expect(spatialSkeletonState.commandHistory.canUndo.value).toBe(false);
  });

  it.each([false, true])(
    "rebuilds Undo before a reversed Merge reply with Redo already queued: %s",
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
      const { layer, spatialSkeletonState: state } =
        makeOptimisticAddNodeTestLayer({
          initialNodes: nodes,
          segmentId: 11n,
          segmentIds: [11n, 17n],
          mergeSkeletons,
          splitSkeleton,
          rerootSkeleton,
        });
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
      expect(state.getOptimisticEditFatalState()).toBeUndefined();
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
      expect(state.getOptimisticEditFatalState()).toBeUndefined();
    },
  );

  it.each([0, 100])(
    "uses the corrected root and confidence %i when undoing Reroot after a reversed Merge",
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
      const { layer, spatialSkeletonState: state } =
        makeOptimisticAddNodeTestLayer({
          initialNodes: nodes,
          segmentId: 11n,
          segmentIds: [11n, 17n],
          mergeSkeletons,
          rerootSkeleton,
          updateConfidence,
        });
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
      expect(state.getOptimisticEditFatalState()).toBeUndefined();
    },
  );

  it.each(["delete", "split", "confidence"] as const)(
    "uses the corrected inverse through Undo/Redo of %s queued behind a reversed Merge",
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
      const { layer, spatialSkeletonState: state } =
        makeOptimisticAddNodeTestLayer({
          initialNodes: nodes,
          segmentId: 11n,
          segmentIds: [11n, 17n],
          mergeSkeletons,
          deleteNode,
          insertNode,
          splitSkeleton,
          updateConfidence,
        });
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
      expect(state.getOptimisticEditFatalState()).toBeUndefined();
    },
  );

  it.each([false, true])(
    "restores the corrected root and confidence when undoing a chained Merge (second direction adjusted: %s)",
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
      const { layer, spatialSkeletonState: state } =
        makeOptimisticAddNodeTestLayer({
          initialNodes: nodes,
          segmentId: 11n,
          segmentIds: [11n, 17n, 23n],
          mergeSkeletons,
          splitSkeleton,
          rerootSkeleton,
          updateConfidence,
        });
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
      expect(state.getOptimisticEditFatalState()).toBeUndefined();
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
      expect(state.getOptimisticEditFatalState()).toBeUndefined();
    },
  );

  it("undoes a reversed merge with the original losing logical segment", async () => {
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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
    const identities =
      spatialSkeletonState.getOptimisticEditingIdentityService();
    expect(
      identities.resolveSegment(
        identities.getOrCreateSegmentHandle(firstSegmentId),
      ),
    ).toBe(winningSegmentId);
    expect(spatialSkeletonState.commandHistory.canUndo.value).toBe(true);
    const undo = undoSpatialSkeletonCommand(layer as any);
    await expect(undo.acceptedByQueue).resolves.toBeUndefined();
    await expect(undo).resolves.toBe(true);

    const undoEntry = spatialSkeletonState
      .getOptimisticEditQueueSnapshot()
      .find(
        (entry) => entry.kind === "mergeSkeletons" && entry.intent === "undo",
      );
    expect(undoEntry).toBeDefined();
    const restoredPreviewSegmentId = spatialSkeletonState.getCachedNode(
      firstRoot.nodeId,
    )!.segmentId;
    expect(restoredPreviewSegmentId).not.toBe(winningSegmentId);
    expect(spatialSkeletonState.getCachedNode(firstRoot.nodeId)).toMatchObject({
      parentNodeId: undefined,
      segmentId: restoredPreviewSegmentId,
    });
    resolveSplit?.({
      existingSegmentId: winningSegmentId,
      newSegmentId: restoredSegmentId,
    });
    await waitForMicrotasks(16);
    expect(splitSkeleton).toHaveBeenCalledWith(firstRoot.nodeId);
    expect(spatialSkeletonState.getCachedNode(firstRoot.nodeId)).toMatchObject({
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
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
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
      node: spatialSkeletonState.getCachedNode(secondRoot.nodeId)!,
      nextPositionInModelSpace: new Float32Array([40, 50, 60]),
    });
    await move;
    expect(
      Array.from(
        spatialSkeletonState.getCachedNode(secondRoot.nodeId)!.position,
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
    expectReloadRequired(spatialSkeletonState, "committed");
    expect(undoSettled).not.toHaveBeenCalled();
    await expect(move.settled).resolves.toMatchObject({
      outcome: "unchanged",
      reason: "not-started",
    });
    expect(getSkeleton).not.toHaveBeenCalled();
    expect(moveNode).not.toHaveBeenCalled();
    expect(spatialSkeletonState.commandHistory.canUndo.value).toBe(false);
    expect(spatialSkeletonState.commandHistory.canRedo.value).toBe(false);
  });

  it("rolls back an optimistic move that depends on a rejected split", async () => {
    suppressStatusMessages();
    const segmentId = 23n;
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
    let rejectSplit: ((error: Error) => void) | undefined;
    const splitSkeleton = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectSplit = reject;
        }),
    );
    const moveNode = vi.fn();
    const { layer, spatialSkeletonState } = makeOptimisticAddNodeTestLayer({
      initialNodes: [rootNode, splitNode],
      segmentId,
      splitSkeleton,
      moveNode,
    });

    await executeSpatialSkeletonSplit(layer as any, splitNode);
    const splitPreview = spatialSkeletonState.getCachedNode(splitNode.nodeId)!;
    await executeSpatialSkeletonMoveNode(layer as any, {
      node: splitPreview,
      nextPositionInModelSpace: new Float32Array([40, 50, 60]),
    });
    expect(
      Array.from(
        spatialSkeletonState.getCachedNode(splitNode.nodeId)!.position,
      ),
    ).toEqual([40, 50, 60]);

    rejectSplit?.(new Error("split rejected"));
    await waitForMicrotasks(10);

    expect(moveNode).not.toHaveBeenCalled();
    expect(spatialSkeletonState.getCachedNode(splitNode.nodeId)).toMatchObject({
      segmentId,
      parentNodeId: rootNode.nodeId,
    });
    expect(
      Array.from(
        spatialSkeletonState.getCachedNode(splitNode.nodeId)?.position ?? [],
      ),
    ).toEqual(Array.from(splitNode.position));
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

  it.each([
    SpatialSkeletonActions.reroot,
    SpatialSkeletonHistoryActions.undo,
    SpatialSkeletonHistoryActions.redo,
  ] as const)("keeps recovery guidance persistent for %s", (operation) => {
    suppressStatusMessages();
    const error = new SpatialSkeletonEditRecoveryError(
      "The edit committed. Refresh the page to sync.",
      { cause: new Error("revision refresh failed") },
    );
    showSpatialSkeletonActionError(operation, error);
    expect(StatusMessage.showErrorMessage).toHaveBeenCalledWith(
      "The edit committed. Refresh the page to sync.: revision refresh failed",
    );
    expect(StatusMessage.showTemporaryMessage).not.toHaveBeenCalled();
  });

  it("keeps the refresh message for an outdated-state conflict", () => {
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
