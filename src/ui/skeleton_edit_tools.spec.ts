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

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SKELETON_ADD_NODE,
  SKELETON_CLEAR_SELECTION,
  SKELETON_ENTER_INSERT_MODE,
  SKELETON_ENTER_MERGE_MODE,
  SKELETON_ENTER_SPLIT_MODE,
  SKELETON_REROOT,
  SKELETON_TOGGLE_TRUE_END,
  SKELETON_FIND_PATH_SELECT_ENDPOINT,
} from "#src/skeleton/actions.js";
import type { SpatiallyIndexedSkeletonNode } from "#src/skeleton/api.js";
import { SpatialSkeletonCommandHistory } from "#src/skeleton/command_history.js";
import {
  SpatialSkeletonActions,
  type SpatialSkeletonAction,
} from "#src/skeleton/command_protocol.js";
import * as skeletonCommands from "#src/skeleton/commands.js";
import { createCompleteSkeletonSnapshot } from "#src/skeleton/complete_skeleton_snapshot.js";
import { SkeletonFindPathState } from "#src/skeleton/find_path.js";
import {
  SpatialSkeletonLogicalHandleMappings,
  spatialSkeletonLogicalNode,
} from "#src/skeleton/logical_identity.js";
import { buildSpatiallyIndexedSkeletonNavigationGraph } from "#src/skeleton/navigation_graph.js";
import { StatusMessage } from "#src/status.js";
import { WatchableValue } from "#src/trackable_value.js";
import { getDefaultSkeletonFindPathToolBindings } from "#src/ui/default_input_event_bindings.js";
import * as mouseDrag from "#src/util/mouse_drag.js";
import { NullarySignal } from "#src/util/signal.js";

if (!("WebGL2RenderingContext" in globalThis)) {
  Object.defineProperty(globalThis, "WebGL2RenderingContext", {
    value: new Proxy(class WebGL2RenderingContext {} as any, {
      get(target, property, receiver) {
        if (Reflect.has(target, property)) {
          return Reflect.get(target, property, receiver);
        }
        return 0;
      },
    }),
    configurable: true,
  });
}

const { setSpatialSkeletonModesToLinesAndPoints, SkeletonRenderMode } =
  await import("#src/skeleton/frontend.js");
const { SpatialSkeletonEditTool } = await import(
  "#src/ui/skeleton_edit_tools.js"
);
const {
  getSpatialSkeletonFindPathEndpointDescription,
  SpatialSkeletonFindPathTool,
} = await import("#src/ui/skeleton_edit_tools.js");

function makeVisibleSegmentsState(initialVisibleSegments: bigint[] = []) {
  return {
    visibleSegments: Object.assign(new Set<bigint>(initialVisibleSegments), {
      changed: makeChangedSignal(),
    }),
    selectedSegments: new Set<bigint>(),
    segmentEquivalences: {},
    temporaryVisibleSegments: new Set<bigint>(),
    temporarySegmentEquivalences: {},
    useTemporaryVisibleSegments: { value: false },
    useTemporarySegmentEquivalences: { value: false },
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
}

function completedEditExecution() {
  return Object.assign(Promise.resolve(), {
    acceptedByQueue: Promise.resolve(),
    settled: Promise.resolve({ outcome: "committed" as const }),
  });
}

function makeChangedSignal() {
  return {
    add: vi.fn((_listener: () => void) => () => {}),
    dispatch: vi.fn(),
  };
}

function makeMergeTargetPrefetch() {
  return { setTarget: vi.fn(), clear: vi.fn() };
}

function makeMergeHoverTool(options: {
  hoveredSegmentId: number;
  anchorSegmentId: number;
  pointerActive?: boolean;
  pending?: boolean;
}) {
  const {
    hoveredSegmentId,
    anchorSegmentId,
    pointerActive = true,
    pending = false,
  } = options;
  const anchorNodeId = 5;
  const skeletonLayer = {};
  const mergeTargetPrefetch = makeMergeTargetPrefetch();
  const mouseState = {
    active: pointerActive,
    pickedSpatialSkeleton: { segmentId: hoveredSegmentId },
    changed: new NullarySignal(),
  };
  const mergeAnchorNodeId: { value: number | undefined } = {
    value: anchorNodeId,
  };
  const tool = Object.assign(Object.create(SpatialSkeletonEditTool.prototype), {
    layer: {
      spatialSkeletonState: {
        mergeAnchorNodeId,
        getCachedNode: (nodeId: number) =>
          nodeId === anchorNodeId
            ? { nodeId, segmentId: anchorSegmentId }
            : undefined,
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      manager: { root: { layerSelectedValues: { mouseState } } },
    },
    // SkeletonEditMode.Merge is a non-exported const enum.
    currentMode: 1,
    pending,
    mergeTargetPrefetch,
  });
  const movePointerTo = (segmentId: number) => {
    mouseState.pickedSpatialSkeleton = { segmentId };
    mouseState.changed.dispatch();
  };
  const clearAnchor = () => {
    mergeAnchorNodeId.value = undefined;
    (tool as any).handleMergeAnchorChanged();
  };
  return {
    tool: tool as any,
    mergeTargetPrefetch,
    skeletonLayer,
    movePointerTo,
    clearAnchor,
  };
}

function makeModeWatchable(value = false) {
  return { value };
}

function makeCachedSegmentSnapshot(
  nodes: readonly SpatiallyIndexedSkeletonNode[],
) {
  return {
    handle: createCompleteSkeletonSnapshot(nodes),
    cacheRevision: 1,
  };
}

function makeSkeletonRenderingOptions() {
  return {
    skeletonRenderingOptions: {
      params2d: { mode: { value: SkeletonRenderMode.LINES } },
      params3d: { mode: { value: SkeletonRenderMode.LINES } },
    },
  };
}

function makeToolActivation() {
  const disposers: unknown[] = [];
  const actions = new Map<string, (event: any) => void>();
  const activation = {
    inputEventMapBinder: vi.fn(),
    bindInputEventMap(inputEventMap: unknown) {
      this.inputEventMapBinder(inputEventMap, this);
    },
    bindAction: vi.fn((action: string, handler: (event: any) => void) => {
      actions.set(action, handler);
    }),
    registerDisposer(disposer: unknown) {
      disposers.push(disposer);
      return disposer;
    },
    cancel: vi.fn(),
  };
  const dispose = () => {
    for (const disposer of disposers.reverse()) {
      if (typeof disposer === "function") {
        disposer();
      } else {
        (disposer as { dispose?: () => void }).dispose?.();
      }
    }
  };
  const readStatusElement = () =>
    disposers.find((disposer) => disposer instanceof StatusMessage)!.element;
  return { activation, actions, dispose, readStatusElement };
}

function makeEditToolHarness() {
  const layer = {
    displayState: {
      ...makeSkeletonRenderingOptions(),
      segmentationGroupState: { value: makeVisibleSegmentsState([11n]) },
    },
    spatialSkeletonEditMode: makeModeWatchable(),
    spatialSkeletonMergeMode: makeModeWatchable(),
    spatialSkeletonSplitMode: makeModeWatchable(),
    spatialSkeletonSuppressSelectedNodeHighlight: makeModeWatchable(),
    selectedSpatialSkeletonNodeInfo: {
      value: undefined,
      changed: makeChangedSignal(),
    },
    spatialSkeletonState: {
      mergeAnchorNodeId: { value: undefined, changed: makeChangedSignal() },
      getCachedNode: vi.fn(),
      commandHistory: new SpatialSkeletonCommandHistory(),
      clearPendingNodePositions: vi.fn(),
    },
    manager: {
      root: {
        layerSelectedValues: {
          mouseState: {
            pickedRenderLayer: undefined,
            pickedSpatialSkeleton: undefined,
            updateUnconditionally: vi.fn(() => true),
            active: true,
          },
        },
        selectionState: { value: undefined, changed: makeChangedSignal() },
        display: { panels: [] },
      },
    },
    getSpatiallyIndexedSkeletonLayer: () => ({ getNode: vi.fn() }),
    getSpatialSkeletonActionsDisabledReason: vi.fn(() => undefined),
    clearSpatialSkeletonMergeAnchor: vi.fn(),
    clearSpatialSkeletonNodeSelection: vi.fn(),
    layersChanged: makeChangedSignal(),
  };
  const { activation, actions, dispose, readStatusElement } =
    makeToolActivation();
  const tool = Object.assign(Object.create(SpatialSkeletonEditTool.prototype), {
    layer,
    mergeTargetPrefetch: makeMergeTargetPrefetch(),
  });
  SpatialSkeletonEditTool.prototype.activate.call(tool, activation as any);
  return { layer, actions, dispose, statusMessage: readStatusElement() };
}

function readFullText(element: HTMLElement) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const words: string[] = [];
  while (walker.nextNode()) {
    const text = walker.currentNode.textContent!.replace(/\s+/g, " ").trim();
    if (text !== "") words.push(text);
  }
  return words.join(" ");
}

function readStatusText(statusMessage: HTMLElement) {
  return statusMessage.querySelector(".neuroglancer-skeleton-tool-status-text")
    ?.textContent;
}

function readHints(statusMessage: HTMLElement) {
  return Array.from(
    statusMessage.querySelectorAll(".neuroglancer-annotation-entry-tool-chip"),
    (chip) => ({
      key: chip
        .querySelector(".neuroglancer-annotation-entry-tool-chip-key")
        ?.textContent?.replace(/\s+/g, " ")
        .trim(),
      label: chip.querySelector(
        ".neuroglancer-annotation-entry-tool-chip-label",
      )?.textContent,
    }),
  );
}

function makeFindPathActionEvent() {
  return {
    stopPropagation: vi.fn(),
    detail: {
      preventDefault: vi.fn(),
    },
  };
}

function makeFindPathNode(
  nodeId: number,
  segmentId = 11,
  parentNodeId?: number,
): SpatiallyIndexedSkeletonNode {
  return {
    nodeId,
    segmentId,
    parentNodeId,
    position: new Float32Array([nodeId, nodeId + 1, nodeId + 2]),
    isTrueEnd: false,
  };
}

function makeFindPathToolHarness(
  options: {
    cachedSegmentNodes?: readonly SpatiallyIndexedSkeletonNode[];
    disabledReason?: string;
    hasSource?: boolean;
    hasSecondSource?: boolean;
    readonly?: boolean;
    state?: SkeletonFindPathState;
    visibleSegmentIds?: bigint[];
  } = {},
) {
  const state = options.state ?? new SkeletonFindPathState();
  const mouseState: any = {
    pickedRenderLayer: undefined,
    pickedSpatialSkeleton: undefined,
    updateUnconditionally: vi.fn(() => true),
    active: true,
  };
  const cachedSegmentNodes = new Map<
    number,
    readonly SpatiallyIndexedSkeletonNode[]
  >();
  if (options.cachedSegmentNodes !== undefined) {
    cachedSegmentNodes.set(11, options.cachedSegmentNodes);
  }
  const getFullSegmentNodes = vi.fn();
  const nodeDataVersion = new WatchableValue(0);
  const visibleSegmentsState = makeVisibleSegmentsState(
    options.visibleSegmentIds ?? [11n, 12n],
  );
  const skeletonLayer =
    options.hasSource === false
      ? undefined
      : {
          source: { readonly: options.readonly ?? true },
          getNode: vi.fn(),
        };
  const secondSkeletonLayer =
    options.hasSecondSource === true
      ? {
          source: { readonly: options.readonly ?? true },
          getNode: vi.fn(),
        }
      : undefined;
  const context =
    skeletonLayer === undefined
      ? undefined
      : {
          skeletonLayer,
          state,
          annotationController: {
            annotationState: {
              source: [],
            },
          },
        };
  let activeSkeletonLayer = skeletonLayer;
  const getSpatialSkeletonActionsDisabledReason = vi.fn(
    () => options.disabledReason,
  );
  const layer = {
    displayState: {
      ...makeSkeletonRenderingOptions(),
      segmentationGroupState: { value: visibleSegmentsState },
    },
    annotationDisplayState: {
      hoverState: { value: undefined },
    },
    spatialSkeletonState: {
      getFullSegmentNodes,
      getCachedSegmentNodes: vi.fn((segmentId: number) =>
        cachedSegmentNodes.get(segmentId),
      ),
      nodeDataVersion,
    },
    manager: {
      root: {
        layerSelectedValues: { mouseState },
        display: { panels: [] },
      },
    },
    getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
    getSpatialSkeletonFindPathContext: (candidate?: unknown) =>
      candidate === undefined || context?.skeletonLayer === candidate
        ? context
        : undefined,
    getSpatialSkeletonActionsDisabledReason,
    layersChanged: makeChangedSignal(),
  };
  const { activation, actions, dispose, readStatusElement } =
    makeToolActivation();
  const tool = Object.assign(
    Object.create(SpatialSkeletonFindPathTool.prototype),
    {
      layer,
      getActiveSpatiallyIndexedSkeletonLayer: () => activeSkeletonLayer,
    },
  );

  SpatialSkeletonFindPathTool.prototype.activate.call(tool, activation as any);

  const pickNode = (
    node: SpatiallyIndexedSkeletonNode,
    candidateSkeletonLayer = skeletonLayer,
  ) => {
    activeSkeletonLayer = candidateSkeletonLayer;
    mouseState.pickedSpatialSkeleton = node;
    actions.get(SKELETON_FIND_PATH_SELECT_ENDPOINT)?.(
      makeFindPathActionEvent(),
    );
  };

  return {
    actions,
    activation,
    cachedSegmentNodes,
    context,
    dispose,
    getFullSegmentNodes,
    getSpatialSkeletonActionsDisabledReason,
    layer,
    mouseState,
    nodeDataVersion,
    pickNode,
    readStatusElement,
    skeletonLayer,
    secondSkeletonLayer,
    state,
    visibleSegmentsState,
  };
}

function makeCommandFactory(action: SpatialSkeletonAction) {
  return {
    action,
    createCommand: vi.fn((payload) => ({
      action,
      label: action,
      payload,
      getQueueInputRequirements: () => ({ required: [] }),
    })),
  };
}

function makeCommandSkeletonSource(overrides: Record<string, unknown> = {}) {
  return {
    readonly: false,
    optimisticEditing: { createDriver: vi.fn() },
    addNodesCommand: makeCommandFactory(SpatialSkeletonActions.addNodes),
    moveNodesCommand: makeCommandFactory(SpatialSkeletonActions.moveNodes),
    deleteNodesCommand: makeCommandFactory(SpatialSkeletonActions.deleteNodes),
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
    listSkeletons: vi.fn(),
    getSkeleton: vi.fn(),
    fetchNodes: vi.fn(),
    getSpatialIndexMetadata: vi.fn(),
    ...overrides,
  };
}

function makeDragHarness({ inspected = true } = {}) {
  suppressStatusMessages();
  const original: SpatiallyIndexedSkeletonNode = {
    nodeId: 2147483647,
    segmentId: 4294967293,
    position: new Float32Array([1, 2, 3]),
    isTrueEnd: false,
  };
  let currentNode = original;
  const handle = spatialSkeletonLogicalNode("dragged");
  const mappings = new SpatialSkeletonLogicalHandleMappings<number, number>();
  mappings.bindNodes([[handle, original.nodeId]]);
  const identities = {
    getOrCreateNodeHandle: () => handle,
    resolveNode: (node: typeof handle) => mappings.resolveNode(node),
  };
  const executeOptimistically = vi.fn(completedEditExecution);
  const releaseBrowseExclusion = vi.fn();
  const source = makeCommandSkeletonSource();
  const skeletonLayer = {
    source,
    getNode: (id: number) =>
      id === currentNode.nodeId ? currentNode : undefined,
    beginTemporaryBrowseExclusion: vi.fn(() => releaseBrowseExclusion),
  };
  const state = {
    commandHistory: new SpatialSkeletonCommandHistory(),
    assertOptimisticEditingAllowed: vi.fn(),
    ensureOptimisticEditingEngine: vi.fn(() => ({})),
    getOptimisticEditingIdentityService: () => identities,
    executeOptimisticEdit: executeOptimistically,
    getCachedNode: (id: number) =>
      inspected && id === currentNode.nodeId ? currentNode : undefined,
    getCachedSegmentSnapshotHandle: () =>
      inspected ? makeCachedSegmentSnapshot([currentNode]) : undefined,
    mergeAnchorNodeId: { value: undefined, changed: makeChangedSignal() },
    clearPendingNodePositions: vi.fn(),
    setPendingNodePosition: vi.fn(() => true),
  };
  const mouseState = {
    position: original.position,
    changed: makeChangedSignal(),
  };
  const layer = {
    spatialSkeletonState: state,
    displayState: {
      ...makeSkeletonRenderingOptions(),
      segmentationGroupState: {
        value: makeVisibleSegmentsState([BigInt(original.segmentId)]),
      },
    },
    spatialSkeletonEditMode: makeModeWatchable(),
    spatialSkeletonMergeMode: makeModeWatchable(),
    spatialSkeletonSplitMode: makeModeWatchable(),
    spatialSkeletonSuppressSelectedNodeHighlight: makeModeWatchable(),
    selectedSpatialSkeletonNodeInfo: {
      value: undefined,
      changed: makeChangedSignal(),
    },
    layersChanged: makeChangedSignal(),
    manager: {
      root: {
        layerSelectedValues: { mouseState },
        selectionState: { value: undefined, changed: makeChangedSignal() },
        display: { panels: [] },
      },
    },
    getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
    getSpatialSkeletonActionsDisabledReason: () => undefined,
    selectSpatialSkeletonNode: vi.fn(),
  };
  const tool = Object.assign(Object.create(SpatialSkeletonEditTool.prototype), {
    layer,
    mergeTargetPrefetch: makeMergeTargetPrefetch(),
    dragModelSpacePosition: new Float32Array(3),
    dragGlobalAnchorPosition: new Float32Array(3),
    dragGlobalPosition: new Float32Array(3),
    getActiveSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
    getPickedSpatialSkeletonNode: () => original,
    pinSegmentByNumber: vi.fn(),
    setStatus: vi.fn(),
    clearStatus: vi.fn(),
    renderStatus: vi.fn(),
    globalToSkeletonCoordinates: (position: Float32Array) => position,
  });
  const startDrag = vi
    .spyOn(mouseDrag, "startRelativeMouseDrag")
    .mockImplementation(() => {});
  const event = new MouseEvent("mousedown");
  const panel = {
    element: { dataset: {} },
    translateDataPointByViewportPixels: (
      result: Float32Array,
      anchor: Float32Array,
      dx: number,
      dy: number,
    ) => result.set([anchor[0] + dx, anchor[1] + dy, anchor[2]]),
  };
  const start = () => {
    tool.handleDefaultMousedown(event, panel);
    const [, move, finish] = startDrag.mock.calls.at(-1)!;
    return { move, finish: finish! };
  };
  return {
    tool,
    state,
    layer,
    source,
    skeletonLayer,
    mouseState,
    panel,
    event,
    start,
    original,
    mappings,
    handle,
    executeOptimistically,
    releaseBrowseExclusion,
    setCurrentNode: (node: SpatiallyIndexedSkeletonNode) => {
      currentNode = node;
    },
  };
}

describe("spatial_skeleton_edit_tool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("switches 2d and 3d skeleton rendering to lines and points", () => {
    const layer = {
      displayState: {
        skeletonRenderingOptions: {
          params2d: { mode: { value: SkeletonRenderMode.LINES } },
          params3d: { mode: { value: SkeletonRenderMode.LINES } },
        },
      },
    } as any;

    setSpatialSkeletonModesToLinesAndPoints(layer);

    expect(
      layer.displayState.skeletonRenderingOptions.params3d.mode.value,
    ).toBe(SkeletonRenderMode.LINES_AND_POINTS);
    expect(
      layer.displayState.skeletonRenderingOptions.params2d.mode.value,
    ).toBe(SkeletonRenderMode.LINES_AND_POINTS);
  });

  it("clears the merge anchor when the clear-selection action runs with an active merge anchor", () => {
    suppressStatusMessages();
    const bindClearSelectionAction = (SpatialSkeletonEditTool.prototype as any)
      .bindClearSelectionAction as (this: any, activation: any) => void;
    const clearSpatialSkeletonNodeSelection = vi.fn();
    const clearSpatialSkeletonMergeAnchor = vi.fn();
    const unpin = vi.fn();
    let clearSelectionHandler: ((event: any) => void) | undefined;
    const activation = {
      bindAction: vi.fn((action: string, handler: (event: any) => void) => {
        if (action === SKELETON_CLEAR_SELECTION) {
          clearSelectionHandler = handler;
        }
      }),
    };
    const tool = {
      layer: {
        selectedSpatialSkeletonNodeInfo: { value: undefined },
        spatialSkeletonState: {
          mergeAnchorNodeId: { value: 101 },
        },
        clearSpatialSkeletonNodeSelection,
        clearSpatialSkeletonMergeAnchor,
        manager: {
          root: {
            selectionState: {
              value: undefined,
              unpin,
            },
          },
        },
      },
    };

    bindClearSelectionAction.call(tool, activation);

    expect(clearSelectionHandler).toBeDefined();
    clearSelectionHandler?.({
      stopPropagation: vi.fn(),
      detail: {
        button: 2,
        ctrlKey: true,
        shiftKey: true,
        preventDefault: vi.fn(),
      },
    });

    expect(clearSpatialSkeletonNodeSelection).toHaveBeenCalledWith(
      "force-unpin",
    );
    expect(clearSpatialSkeletonMergeAnchor).toHaveBeenCalledTimes(1);
    expect(unpin).not.toHaveBeenCalled();
  });

  it("shows shortcut hints in place of the generic bindings line", () => {
    suppressStatusMessages();
    const harness = makeEditToolHarness();
    try {
      expect(readFullText(harness.statusMessage)).toBe(
        "Skeleton editing No selection" +
          " click Select drag Move" +
          " hold + m Merge hold + i Insert hold + s Split" +
          " hold + n New skeleton hold + d Delete" +
          " middle click / ctrl click Rotate/pan",
      );
    } finally {
      harness.dispose();
    }
  });

  it("shows the bound merge key in the Merge hint", () => {
    suppressStatusMessages();
    const harness = makeEditToolHarness();
    try {
      expect(readHints(harness.statusMessage)).toContainEqual({
        key: "hold + m",
        label: "Merge",
      });
    } finally {
      harness.dispose();
    }
  });

  it("ends merge mode when the key named in its release hint is released", () => {
    suppressStatusMessages();
    const harness = makeEditToolHarness();
    try {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyM" }));
      harness.actions.get(SKELETON_ENTER_MERGE_MODE)?.({});
      expect(readHints(harness.statusMessage)).toContainEqual({
        key: "release + m",
        label: "Exit merge",
      });

      window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyM" }));

      expect(harness.layer.spatialSkeletonMergeMode.value).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  it("updates the status and the hints when merge mode starts", () => {
    suppressStatusMessages();
    const harness = makeEditToolHarness();
    try {
      expect(readStatusText(harness.statusMessage)).toBe("No selection");

      harness.actions.get(SKELETON_ENTER_MERGE_MODE)?.({});

      expect(readStatusText(harness.statusMessage)).toBe(
        "Merge · click a node to merge from",
      );
      expect(readHints(harness.statusMessage)).toEqual([
        { key: "click", label: "Select" },
        { key: "middle click / ctrl click", label: "Rotate/pan" },
      ]);
    } finally {
      harness.dispose();
    }
  });

  it("uses inspected ownership when a merge source pick has a retired skeleton ID", () => {
    suppressStatusMessages();
    const hoveredNode = {
      nodeId: 101,
      segmentId: 11,
      position: new Float32Array([1, 2, 3]),
    };
    const mergeAnchorNodeId = {
      value: undefined as number | undefined,
      changed: makeChangedSignal(),
    };
    const selectSpatialSkeletonNode = vi.fn();
    const setSpatialSkeletonMergeAnchor = vi.fn((nodeId: number) => {
      mergeAnchorNodeId.value = nodeId;
      return true;
    });
    const clearSpatialSkeletonMergeAnchor = vi.fn(() => {
      mergeAnchorNodeId.value = undefined;
      return true;
    });
    const getFullSegmentNodes = vi.fn(async () => []);
    const inspectedSnapshot = makeCachedSegmentSnapshot([hoveredNode]);
    const skeletonLayer = {
      getNode: vi.fn((nodeId: number) =>
        nodeId === hoveredNode.nodeId ? hoveredNode : undefined,
      ),
    };
    const mouseState = {
      pickedRenderLayer: undefined,
      pickedSpatialSkeleton: {
        nodeId: hoveredNode.nodeId,
        segmentId: 6368542,
        position: hoveredNode.position,
      },
      updateUnconditionally: vi.fn(() => true),
      active: true,
      changed: makeChangedSignal(),
    };
    const layer = {
      displayState: {
        ...makeSkeletonRenderingOptions(),
        segmentationGroupState: {
          value: makeVisibleSegmentsState([11n]),
        },
      },
      spatialSkeletonEditMode: makeModeWatchable(),
      spatialSkeletonMergeMode: makeModeWatchable(),
      spatialSkeletonSplitMode: makeModeWatchable(),
      spatialSkeletonSuppressSelectedNodeHighlight: makeModeWatchable(),
      selectedSpatialSkeletonNodeInfo: {
        value: undefined,
        changed: makeChangedSignal(),
      },
      spatialSkeletonState: {
        mergeAnchorNodeId,
        getCachedNode: vi.fn(),
        getCachedSegmentNodes: vi.fn(),
        getCachedSegmentSnapshotHandle: vi.fn((segmentId: number) =>
          segmentId === hoveredNode.segmentId ? inspectedSnapshot : undefined,
        ),
        getFullSegmentNodes,
        commandHistory: new SpatialSkeletonCommandHistory(),
        clearPendingNodePositions: vi.fn(),
      },
      manager: {
        root: {
          layerSelectedValues: { mouseState },
          selectionState: { value: undefined, changed: makeChangedSignal() },
          display: { panels: [] },
        },
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      getSpatialSkeletonActionsDisabledReason: vi.fn(() => undefined),
      selectSegment: vi.fn(),
      selectSpatialSkeletonNode,
      setSpatialSkeletonMergeAnchor,
      clearSpatialSkeletonMergeAnchor,
      clearSpatialSkeletonNodeSelection: vi.fn(),
      layersChanged: makeChangedSignal(),
    };
    const { activation, actions, dispose } = makeToolActivation();
    const tool = Object.assign(
      Object.create(SpatialSkeletonEditTool.prototype),
      { layer, mergeTargetPrefetch: makeMergeTargetPrefetch() },
    );

    try {
      SpatialSkeletonEditTool.prototype.activate.call(tool, activation as any);

      // Fire the merge action (simulates pressing "m" while hovering node 101).
      actions.get(SKELETON_ENTER_MERGE_MODE)?.({});

      // Entering the mode does not silently consume the current hover.  The
      // first click is what records the merge anchor.
      expect(selectSpatialSkeletonNode).not.toHaveBeenCalled();
      expect(setSpatialSkeletonMergeAnchor).not.toHaveBeenCalled();
      (tool as any).handleMergeFirstPick();

      expect(selectSpatialSkeletonNode).toHaveBeenCalledWith(
        hoveredNode.nodeId,
        true,
        expect.objectContaining({ nodeId: hoveredNode.nodeId }),
      );
      expect(setSpatialSkeletonMergeAnchor).toHaveBeenCalledWith(
        hoveredNode.nodeId,
      );
      expect(getFullSegmentNodes).not.toHaveBeenCalled();
      expect(layer.spatialSkeletonMergeMode.value).toBe(true);
    } finally {
      dispose();
    }
  });

  it("enters split mode, then executes on the hovered node when picked", async () => {
    suppressStatusMessages();
    const hoveredNode = {
      nodeId: 77,
      segmentId: 11,
      parentNodeId: 76,
      position: new Float32Array([7, 8, 9]),
    };
    const splitExecute = vi.fn(completedEditExecution);
    const splitSkeletonsCommand = makeCommandFactory(
      SpatialSkeletonActions.splitSkeletons,
    );
    const inspectedSnapshot = makeCachedSegmentSnapshot([hoveredNode]);
    const skeletonLayer = {
      source: makeCommandSkeletonSource({ splitSkeletonsCommand }),
      getNode: vi.fn((nodeId: number) =>
        nodeId === hoveredNode.nodeId ? hoveredNode : undefined,
      ),
    };
    const mouseState = {
      pickedRenderLayer: undefined,
      pickedSpatialSkeleton: {
        nodeId: hoveredNode.nodeId,
        segmentId: hoveredNode.segmentId,
        position: hoveredNode.position,
      },
      updateUnconditionally: vi.fn(() => true),
      active: true,
      changed: makeChangedSignal(),
    };
    const selectSegment = vi.fn();
    const selectSpatialSkeletonNode = vi.fn();
    const layer = {
      displayState: {
        ...makeSkeletonRenderingOptions(),
        segmentationGroupState: {
          value: makeVisibleSegmentsState([11n]),
        },
      },
      spatialSkeletonEditMode: makeModeWatchable(),
      spatialSkeletonMergeMode: makeModeWatchable(),
      spatialSkeletonSplitMode: makeModeWatchable(),
      spatialSkeletonSuppressSelectedNodeHighlight: makeModeWatchable(),
      selectedSpatialSkeletonNodeInfo: {
        value: undefined,
        changed: makeChangedSignal(),
      },
      spatialSkeletonState: {
        commandHistory: new SpatialSkeletonCommandHistory(),
        assertOptimisticEditingAllowed: vi.fn(),
        ensureOptimisticEditingEngine: vi.fn(() => ({})),
        getOptimisticEditingIdentityService: vi.fn(() => ({})),
        executeOptimisticEdit: splitExecute,
        getCachedNode: vi.fn(),
        getCachedSegmentSnapshotHandle: vi.fn((segmentId: number) =>
          segmentId === hoveredNode.segmentId ? inspectedSnapshot : undefined,
        ),
        mergeAnchorNodeId: { value: undefined, changed: makeChangedSignal() },
        clearPendingNodePositions: vi.fn(),
      },
      manager: {
        root: {
          layerSelectedValues: { mouseState },
          selectionState: { value: undefined, changed: makeChangedSignal() },
          display: { panels: [] },
        },
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      getSpatialSkeletonActionsDisabledReason: vi.fn(() => undefined),
      selectSegment,
      selectSpatialSkeletonNode,
      clearSpatialSkeletonNodeSelection: vi.fn(),
      layersChanged: makeChangedSignal(),
    };
    const { activation, actions, dispose } = makeToolActivation();
    const tool = Object.assign(
      Object.create(SpatialSkeletonEditTool.prototype),
      { layer, mergeTargetPrefetch: makeMergeTargetPrefetch() },
    );

    try {
      SpatialSkeletonEditTool.prototype.activate.call(tool, activation as any);

      // Fire the split action (simulates pressing "s" while hovering node 77).
      actions.get(SKELETON_ENTER_SPLIT_MODE)?.({});

      expect(selectSegment).not.toHaveBeenCalled();
      expect(selectSpatialSkeletonNode).not.toHaveBeenCalled();
      (tool as any).handleSplitPick();

      expect(selectSegment).toHaveBeenCalledWith(11n, true);
      expect(selectSpatialSkeletonNode).toHaveBeenCalledWith(
        hoveredNode.nodeId,
        true,
        expect.objectContaining({ nodeId: hoveredNode.nodeId }),
      );
      expect(splitSkeletonsCommand.createCommand).toHaveBeenCalledWith({
        nodeId: hoveredNode.nodeId,
        segmentId: hoveredNode.segmentId,
        parentNodeId: hoveredNode.parentNodeId,
        position: Array.from(hoveredNode.position),
      });
      await vi.waitFor(() => expect(splitExecute).toHaveBeenCalledTimes(1));
    } finally {
      dispose();
    }
  });

  it("releases the split mode lock on admission before exact preview hydration", async () => {
    suppressStatusMessages();
    let resolveAdmission!: () => void;
    let resolveExactPreview!: () => void;
    const acceptedByQueue = new Promise<void>((resolve) => {
      resolveAdmission = resolve;
    });
    const exactPreview = new Promise<void>((resolve) => {
      resolveExactPreview = resolve;
    }) as Promise<void> & {
      acceptedByQueue: Promise<void>;
      settled: Promise<{
        outcome: "committed";
      }>;
    };
    exactPreview.acceptedByQueue = acceptedByQueue;
    exactPreview.settled = Promise.resolve({ outcome: "committed" });
    const executeOptimistically = vi.fn(() => exactPreview);
    const splitSkeletonsCommand = {
      action: SpatialSkeletonActions.splitSkeletons,
      createCommand: vi.fn((payload) => ({
        action: SpatialSkeletonActions.splitSkeletons,
        label: "Split skeleton",
        payload,
        getQueueInputRequirements: () => ({ required: [] }),
      })),
    };
    const skeletonLayer = {
      source: makeCommandSkeletonSource({ splitSkeletonsCommand }),
    };
    const clearSpatialSkeletonNodeSelection = vi.fn();
    const layer = {
      displayState: {
        segmentationGroupState: {
          value: makeVisibleSegmentsState([11n]),
        },
      },
      spatialSkeletonSuppressSelectedNodeHighlight: makeModeWatchable(),
      spatialSkeletonState: {
        commandHistory: new SpatialSkeletonCommandHistory(),
        assertOptimisticEditingAllowed: vi.fn(),
        ensureOptimisticEditingEngine: vi.fn(() => ({})),
        getOptimisticEditingIdentityService: vi.fn(() => ({})),
        executeOptimisticEdit: executeOptimistically,
      },
      manager: {
        root: {
          selectionState: { pin: { value: true } },
        },
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      selectSegment: vi.fn(),
      selectSpatialSkeletonNode: vi.fn(),
      clearSpatialSkeletonNodeSelection,
    };
    const tool = Object.assign(
      Object.create(SpatialSkeletonEditTool.prototype),
      { layer, pending: false, mergeTargetPrefetch: makeMergeTargetPrefetch() },
    );

    (tool as any).executeSplitOnNode({
      nodeId: 77,
      segmentId: 11,
      position: new Float32Array([7, 8, 9]),
    });

    expect(executeOptimistically).toHaveBeenCalledTimes(1);
    expect((tool as any).pending).toBe(true);
    expect(clearSpatialSkeletonNodeSelection).not.toHaveBeenCalled();

    resolveAdmission();
    await acceptedByQueue;
    await Promise.resolve();

    expect((tool as any).pending).toBe(false);
    expect(clearSpatialSkeletonNodeSelection).toHaveBeenCalledWith(
      "force-unpin",
    );

    // The exact-preview promise is intentionally still outstanding here: its
    // hydration/confirmation lifecycle must not keep the interaction locked.
    resolveExactPreview();
    await exactPreview;
  });

  it("prefetches the skeleton hovered after picking a merge anchor", () => {
    const { tool, mergeTargetPrefetch, skeletonLayer, movePointerTo } =
      makeMergeHoverTool({ hoveredSegmentId: 11, anchorSegmentId: 11 });

    tool.handleMergeAnchorChanged();
    movePointerTo(22);

    expect(mergeTargetPrefetch.setTarget).toHaveBeenCalledExactlyOnceWith(
      skeletonLayer,
      22,
    );
  });

  it("does not prefetch the merge anchor's own skeleton", () => {
    const { tool, mergeTargetPrefetch } = makeMergeHoverTool({
      hoveredSegmentId: 11,
      anchorSegmentId: 11,
    });

    tool.handleMergeAnchorChanged();

    expect(mergeTargetPrefetch.setTarget).not.toHaveBeenCalled();
  });

  it("keeps the merge target prefetch while the pointer is outside the view", () => {
    const { tool, mergeTargetPrefetch } = makeMergeHoverTool({
      hoveredSegmentId: 22,
      anchorSegmentId: 11,
      pointerActive: false,
    });

    tool.handleMergeAnchorChanged();

    expect(mergeTargetPrefetch.clear).not.toHaveBeenCalled();
    expect(mergeTargetPrefetch.setTarget).not.toHaveBeenCalled();
  });

  it("keeps the merge target while a merge is waiting for the queue", () => {
    const { tool, mergeTargetPrefetch, movePointerTo } = makeMergeHoverTool({
      hoveredSegmentId: 11,
      anchorSegmentId: 11,
      pending: true,
    });

    tool.handleMergeAnchorChanged();
    movePointerTo(22);

    expect(mergeTargetPrefetch.setTarget).not.toHaveBeenCalled();
    expect(mergeTargetPrefetch.clear).not.toHaveBeenCalled();
  });

  it("stops prefetching hovered skeletons once the merge anchor is cleared", () => {
    const { tool, mergeTargetPrefetch, movePointerTo, clearAnchor } =
      makeMergeHoverTool({ hoveredSegmentId: 22, anchorSegmentId: 11 });

    tool.handleMergeAnchorChanged();
    clearAnchor();
    movePointerTo(33);

    expect(mergeTargetPrefetch.clear).toHaveBeenCalledTimes(1);
    expect(mergeTargetPrefetch.setTarget).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      22,
    );
  });

  it("releases a pending interaction when action construction throws", () => {
    suppressStatusMessages();
    const tool = Object.assign(
      Object.create(SpatialSkeletonEditTool.prototype),
      {
        pending: false,
        interactionGeneration: 1,
        mergeTargetPrefetch: makeMergeTargetPrefetch(),
      },
    );
    const release = vi.fn();

    expect(() =>
      (tool as any).startPendingAction(
        SpatialSkeletonActions.splitSkeletons,
        () => {
          throw new Error("queue is full");
        },
        release,
      ),
    ).not.toThrow();

    expect((tool as any).pending).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
    expect(StatusMessage.showTemporaryMessage).toHaveBeenCalledWith(
      expect.stringContaining("queue is full"),
    );
  });

  it("ignores admission callbacks from an older interaction generation", async () => {
    suppressStatusMessages();
    let resolveAdmission!: () => void;
    const acceptedByQueue = new Promise<void>((resolve) => {
      resolveAdmission = resolve;
    });
    const execution = Promise.resolve() as Promise<void> & {
      acceptedByQueue: Promise<void>;
      settled: Promise<{ outcome: "committed" }>;
    };
    execution.acceptedByQueue = acceptedByQueue;
    execution.settled = Promise.resolve({ outcome: "committed" });
    const tool = Object.assign(
      Object.create(SpatialSkeletonEditTool.prototype),
      {
        pending: false,
        interactionGeneration: 1,
        mergeTargetPrefetch: makeMergeTargetPrefetch(),
      },
    );
    const release = vi.fn();

    (tool as any).startPendingAction(
      SpatialSkeletonActions.mergeSkeletons,
      () => execution,
      release,
    );
    expect((tool as any).pending).toBe(true);

    (tool as any).advanceInteractionGeneration();
    // Model a newly started interaction that must not be unlocked by the old
    // admission callback.
    (tool as any).pending = true;
    resolveAdmission();
    await acceptedByQueue;
    await Promise.resolve();

    expect(release).not.toHaveBeenCalled();
    expect((tool as any).pending).toBe(true);
  });

  // Activates the edit tool over a single visible skeleton whose nodes are
  // all resolvable, and exposes the in-mode pick handler so tests can drive
  // insert mode without a rendered panel.
  function makeInsertToolHarness(nodes: SpatiallyIndexedSkeletonNode[]) {
    suppressStatusMessages();
    const insertExecute = vi.fn(
      async (_layer: unknown, _options: object) => {},
    );
    vi.spyOn(
      skeletonCommands,
      "executeSpatialSkeletonInsertNode",
    ).mockImplementation((layer, options) => {
      const execution = insertExecute(layer, options);
      return Object.assign(execution, {
        acceptedByQueue: execution.then(() => {}),
        settled: execution.then(() => ({ outcome: "committed" as const })),
      });
    });
    const insertNodesCommand = makeCommandFactory(
      SpatialSkeletonActions.insertNodes,
    );
    const skeletonLayer = {
      source: makeCommandSkeletonSource({ insertNodesCommand }),
      getNode: vi.fn((nodeId: number) =>
        nodes.find((node) => node.nodeId === nodeId),
      ),
    };
    const mouseState = {
      pickedRenderLayer: undefined,
      pickedSpatialSkeleton: undefined as
        | SpatiallyIndexedSkeletonNode
        | undefined,
      updateUnconditionally: vi.fn(() => true),
      active: true,
      changed: makeChangedSignal(),
    };
    const selectSpatialSkeletonNode = vi.fn();
    const layer = {
      displayState: {
        ...makeSkeletonRenderingOptions(),
        segmentationGroupState: {
          value: makeVisibleSegmentsState([11n]),
        },
      },
      spatialSkeletonEditMode: makeModeWatchable(),
      spatialSkeletonMergeMode: makeModeWatchable(),
      spatialSkeletonSplitMode: makeModeWatchable(),
      spatialSkeletonSuppressSelectedNodeHighlight: makeModeWatchable(),
      selectedSpatialSkeletonNodeInfo: {
        value: undefined,
        changed: makeChangedSignal(),
      },
      spatialSkeletonState: {
        commandHistory: new SpatialSkeletonCommandHistory(),
        getCachedNode: vi.fn(),
        mergeAnchorNodeId: { value: undefined, changed: makeChangedSignal() },
        clearPendingNodePositions: vi.fn(),
      },
      manager: {
        root: {
          layerSelectedValues: { mouseState },
          selectionState: {
            value: undefined,
            changed: makeChangedSignal(),
            unpin: vi.fn(),
          },
          display: { panels: [] },
        },
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      getSpatialSkeletonActionsDisabledReason: vi.fn(() => undefined),
      selectSegment: vi.fn(),
      selectSpatialSkeletonNode,
      clearSpatialSkeletonNodeSelection: vi.fn(),
      layersChanged: makeChangedSignal(),
    };
    const { activation, actions, dispose } = makeToolActivation();
    const tool = Object.assign(
      Object.create(SpatialSkeletonEditTool.prototype),
      { layer, mergeTargetPrefetch: makeMergeTargetPrefetch() },
    );
    SpatialSkeletonEditTool.prototype.activate.call(tool, activation as any);
    const activate = () => {
      const nextActivation = makeToolActivation();
      SpatialSkeletonEditTool.prototype.activate.call(
        tool,
        nextActivation.activation as any,
      );
      return nextActivation;
    };
    const pickNode = async (node: SpatiallyIndexedSkeletonNode) => {
      mouseState.pickedSpatialSkeleton = node;
      tool.handleInsertPick();
      // Let the command execution promise chain settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return {
      actions,
      activate,
      dispose,
      insertExecute,
      insertNodesCommand,
      layer,
      pickNode,
      selectSpatialSkeletonNode,
      tool,
    };
  }

  it("enters insert mode without selecting a node", () => {
    const rootNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 1,
      segmentId: 11,
      position: new Float32Array([0, 0, 0]),
    };
    const harness = makeInsertToolHarness([rootNode]);
    try {
      harness.actions.get(SKELETON_ENTER_INSERT_MODE)?.({});

      expect(harness.layer.spatialSkeletonMergeMode.value).toBe(false);
      expect(
        harness.layer.spatialSkeletonSuppressSelectedNodeHighlight.value,
      ).toBe(true);
      expect(harness.selectSpatialSkeletonNode).not.toHaveBeenCalled();
      expect(harness.insertExecute).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it.each([
    ["parent then child", [1, 2]],
    ["child then parent", [2, 1]],
  ])(
    "inserts a node at the midpoint of the picked edge (%s)",
    async (_label, pickOrder) => {
      const parentNode: SpatiallyIndexedSkeletonNode = {
        nodeId: 1,
        segmentId: 11,
        position: new Float32Array([0, 0, 0]),
      };
      const childNode: SpatiallyIndexedSkeletonNode = {
        nodeId: 2,
        segmentId: 11,
        parentNodeId: 1,
        position: new Float32Array([2, 4, 6]),
      };
      const nodes = [parentNode, childNode];
      const harness = makeInsertToolHarness(nodes);
      try {
        harness.actions.get(SKELETON_ENTER_INSERT_MODE)?.({});
        for (const nodeId of pickOrder) {
          await harness.pickNode(nodes.find((node) => node.nodeId === nodeId)!);
        }

        expect(harness.selectSpatialSkeletonNode).toHaveBeenCalledTimes(1);
        expect(harness.selectSpatialSkeletonNode).toHaveBeenCalledWith(
          pickOrder[0],
          true,
          expect.objectContaining({ nodeId: pickOrder[0] }),
        );
        expect(harness.insertExecute).toHaveBeenCalledWith(harness.layer, {
          skeletonId: 11,
          parentNodeId: 1,
          childNodeIds: [2],
          positionInModelSpace: new Float32Array([1, 2, 3]),
        });
        // After the insert the mode is re-armed for the next pair.
        expect(harness.tool.insertAnchorNodeId).toBeUndefined();
      } finally {
        harness.dispose();
      }
    },
  );

  it("rejects a pick on a non-visible skeleton before resolving the node", async () => {
    const hiddenNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 9,
      segmentId: 12,
      position: new Float32Array([1, 1, 1]),
    };
    // Only skeleton 11 is visible and fully loaded; the hidden node is known
    // solely from the pick buffer.
    const harness = makeInsertToolHarness([]);
    const showTemporaryMessage = vi.spyOn(
      StatusMessage,
      "showTemporaryMessage",
    );
    try {
      harness.actions.get(SKELETON_ENTER_INSERT_MODE)?.({});
      await harness.pickNode(hiddenNode);

      expect(showTemporaryMessage).toHaveBeenCalledWith(
        expect.stringContaining("Make skeleton 12 visible"),
        3000,
      );
      expect(harness.tool.insertAnchorNodeId).toBeUndefined();
      expect(harness.selectSpatialSkeletonNode).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it("rejects insertion between nodes that are not directly connected and keeps the first pick", async () => {
    const rootNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 1,
      segmentId: 11,
      position: new Float32Array([0, 0, 0]),
    };
    const middleNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 2,
      segmentId: 11,
      parentNodeId: 1,
      position: new Float32Array([2, 2, 2]),
    };
    const leafNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 3,
      segmentId: 11,
      parentNodeId: 2,
      position: new Float32Array([4, 4, 4]),
    };
    const harness = makeInsertToolHarness([rootNode, middleNode, leafNode]);
    const showTemporaryMessage = vi.spyOn(
      StatusMessage,
      "showTemporaryMessage",
    );
    try {
      harness.actions.get(SKELETON_ENTER_INSERT_MODE)?.({});
      await harness.pickNode(rootNode);
      await harness.pickNode(leafNode);

      expect(harness.insertExecute).not.toHaveBeenCalled();
      expect(showTemporaryMessage).toHaveBeenCalledWith(
        expect.stringContaining("Node 3 is not connected to node 1"),
      );
      expect(harness.tool.insertAnchorNodeId).toBe(1);

      // A connected neighbour of the retained first pick completes the insert.
      await harness.pickNode(middleNode);
      expect(harness.insertExecute).toHaveBeenCalledWith(
        harness.layer,
        expect.objectContaining({ parentNodeId: 1, childNodeIds: [2] }),
      );
    } finally {
      harness.dispose();
    }
  });

  it("treats the next pick as a first pick after the selection is cleared", async () => {
    const parentNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 1,
      segmentId: 11,
      position: new Float32Array([0, 0, 0]),
    };
    const childNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 2,
      segmentId: 11,
      parentNodeId: 1,
      position: new Float32Array([2, 2, 2]),
    };
    const harness = makeInsertToolHarness([parentNode, childNode]);
    try {
      harness.actions.get(SKELETON_ENTER_INSERT_MODE)?.({});
      await harness.pickNode(parentNode);
      harness.actions.get(SKELETON_CLEAR_SELECTION)?.({
        stopPropagation: vi.fn(),
        detail: { preventDefault: vi.fn() },
      });
      await harness.pickNode(childNode);

      expect(harness.insertExecute).not.toHaveBeenCalled();
      expect(harness.selectSpatialSkeletonNode).toHaveBeenLastCalledWith(
        2,
        true,
        childNode,
      );
    } finally {
      harness.dispose();
    }
  });

  it("inserts at the midpoint of the current node positions when the first node moves between picks", async () => {
    const parentNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 1,
      segmentId: 11,
      position: new Float32Array([10, 10, 10]),
    };
    const childNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 2,
      segmentId: 11,
      parentNodeId: 1,
      position: new Float32Array([2, 4, 6]),
    };
    const nodes = [parentNode, childNode];
    const harness = makeInsertToolHarness(nodes);
    try {
      harness.actions.get(SKELETON_ENTER_INSERT_MODE)?.({});
      await harness.pickNode(parentNode);
      nodes[0] = { ...parentNode, position: new Float32Array([0, 0, 0]) };
      await harness.pickNode(childNode);

      expect(harness.insertExecute).toHaveBeenCalledWith(
        harness.layer,
        expect.objectContaining({
          positionInModelSpace: new Float32Array([1, 2, 3]),
        }),
      );
    } finally {
      harness.dispose();
    }
  });

  it("abandons the insert with a message when the first node no longer exists", async () => {
    const parentNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 1,
      segmentId: 11,
      position: new Float32Array([0, 0, 0]),
    };
    const childNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 2,
      segmentId: 11,
      parentNodeId: 1,
      position: new Float32Array([2, 2, 2]),
    };
    const nodes = [parentNode, childNode];
    const harness = makeInsertToolHarness(nodes);
    const showTemporaryMessage = vi.spyOn(
      StatusMessage,
      "showTemporaryMessage",
    );
    try {
      harness.actions.get(SKELETON_ENTER_INSERT_MODE)?.({});
      await harness.pickNode(parentNode);
      nodes.splice(0, 1);
      await harness.pickNode(childNode);

      expect(harness.insertExecute).not.toHaveBeenCalled();
      expect(showTemporaryMessage).toHaveBeenCalledWith(
        "Node 1 is no longer available. Pick the first node again.",
      );

      await harness.pickNode(childNode);
      expect(harness.insertExecute).not.toHaveBeenCalled();
      expect(harness.selectSpatialSkeletonNode).toHaveBeenLastCalledWith(
        2,
        true,
        childNode,
      );
    } finally {
      harness.dispose();
    }
  });

  it("keeps the selected-node highlight visible when an insert finishes after the tool deactivates", async () => {
    const parentNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 1,
      segmentId: 11,
      position: new Float32Array([0, 0, 0]),
    };
    const childNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 2,
      segmentId: 11,
      parentNodeId: 1,
      position: new Float32Array([2, 2, 2]),
    };
    const harness = makeInsertToolHarness([parentNode, childNode]);
    let finishInsert = () => {};
    harness.insertExecute.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishInsert = resolve;
        }),
    );
    harness.actions.get(SKELETON_ENTER_INSERT_MODE)?.({});
    await harness.pickNode(parentNode);
    await harness.pickNode(childNode);
    harness.dispose();
    finishInsert();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      harness.layer.spatialSkeletonSuppressSelectedNodeHighlight.value,
    ).toBe(false);
  });

  function makeSplitMergeToolHarness(nodes: SpatiallyIndexedSkeletonNode[]) {
    suppressStatusMessages();
    let admit = () => {};
    const heldExecution = () => {
      const acceptedByQueue = new Promise<void>((resolve) => {
        admit = resolve;
      });
      return Object.assign(
        acceptedByQueue.then(() => {}),
        {
          acceptedByQueue,
          settled: acceptedByQueue.then(() => ({
            outcome: "committed" as const,
          })),
        },
      );
    };
    const splitExecute = vi
      .spyOn(skeletonCommands, "executeSpatialSkeletonSplit")
      .mockImplementation(heldExecution);
    const mergeExecute = vi
      .spyOn(skeletonCommands, "executeSpatialSkeletonMerge")
      .mockImplementation(heldExecution);
    const findNode = (nodeId: number) =>
      nodes.find((node) => node.nodeId === nodeId);
    const skeletonLayer = {
      source: makeCommandSkeletonSource({
        splitSkeletonsCommand: makeCommandFactory(
          SpatialSkeletonActions.splitSkeletons,
        ),
        mergeSkeletonsCommand: makeCommandFactory(
          SpatialSkeletonActions.mergeSkeletons,
        ),
      }),
      getNode: vi.fn(findNode),
    };
    const mouseState = {
      pickedRenderLayer: undefined,
      pickedSpatialSkeleton: undefined as
        | SpatiallyIndexedSkeletonNode
        | undefined,
      updateUnconditionally: vi.fn(() => true),
      active: true,
      changed: makeChangedSignal(),
    };
    const mergeAnchorNodeId = {
      value: undefined as number | undefined,
      changed: makeChangedSignal(),
    };
    const segmentIds = [...new Set(nodes.map((node) => node.segmentId))];
    const layer = {
      displayState: {
        ...makeSkeletonRenderingOptions(),
        segmentationGroupState: {
          value: makeVisibleSegmentsState(segmentIds.map(BigInt)),
        },
      },
      spatialSkeletonEditMode: makeModeWatchable(),
      spatialSkeletonMergeMode: makeModeWatchable(),
      spatialSkeletonSplitMode: makeModeWatchable(),
      spatialSkeletonSuppressSelectedNodeHighlight: makeModeWatchable(),
      selectedSpatialSkeletonNodeInfo: {
        value: undefined,
        changed: makeChangedSignal(),
      },
      spatialSkeletonState: {
        commandHistory: new SpatialSkeletonCommandHistory(),
        getCachedNode: vi.fn(),
        getCachedSegmentSnapshotHandle: vi.fn((segmentId: number) =>
          makeCachedSegmentSnapshot(
            nodes.filter((node) => node.segmentId === segmentId),
          ),
        ),
        mergeAnchorNodeId,
        clearPendingNodePositions: vi.fn(),
      },
      manager: {
        root: {
          layerSelectedValues: { mouseState },
          selectionState: {
            value: undefined,
            changed: makeChangedSignal(),
            unpin: vi.fn(),
          },
          display: { panels: [] },
        },
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      getSpatialSkeletonActionsDisabledReason: vi.fn(() => undefined),
      selectSegment: vi.fn(),
      selectSpatialSkeletonNode: vi.fn(),
      setSpatialSkeletonMergeAnchor: vi.fn((nodeId: number) => {
        mergeAnchorNodeId.value = nodeId;
      }),
      clearSpatialSkeletonMergeAnchor: vi.fn(() => {
        mergeAnchorNodeId.value = undefined;
      }),
      clearSpatialSkeletonNodeSelection: vi.fn(),
      layersChanged: makeChangedSignal(),
    };
    const { activation, actions, dispose } = makeToolActivation();
    const tool = Object.assign(
      Object.create(SpatialSkeletonEditTool.prototype),
      { layer, mergeTargetPrefetch: makeMergeTargetPrefetch() },
    );
    SpatialSkeletonEditTool.prototype.activate.call(tool, activation as any);
    const pick = (nodeId: number, handlePick: () => void) => {
      mouseState.pickedSpatialSkeleton = findNode(nodeId);
      handlePick();
    };
    return {
      actions,
      admit: () => admit(),
      dispose,
      layer,
      mergeExecute,
      pickForMerge: (nodeId: number) =>
        pick(nodeId, () => tool.handleMergeSecondPick()),
      pickForSplit: (nodeId: number) =>
        pick(nodeId, () => tool.handleSplitPick()),
      splitExecute,
    };
  }

  it("keeps the selected-node highlight visible when a split finishes after the tool deactivates", async () => {
    const harness = makeSplitMergeToolHarness([
      { nodeId: 76, segmentId: 11, position: new Float32Array([6, 7, 8]) },
      {
        nodeId: 77,
        segmentId: 11,
        parentNodeId: 76,
        position: new Float32Array([7, 8, 9]),
      },
    ]);
    harness.actions.get(SKELETON_ENTER_SPLIT_MODE)?.({});
    harness.pickForSplit(77);
    harness.dispose();
    harness.admit();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.splitExecute).toHaveBeenCalled();
    expect(
      harness.layer.spatialSkeletonSuppressSelectedNodeHighlight.value,
    ).toBe(false);
  });

  it("keeps the selected-node highlight visible when a merge finishes after the tool deactivates", async () => {
    const harness = makeSplitMergeToolHarness([
      { nodeId: 101, segmentId: 11, position: new Float32Array([1, 2, 3]) },
      { nodeId: 202, segmentId: 17, position: new Float32Array([4, 5, 6]) },
    ]);
    harness.actions.get(SKELETON_ENTER_MERGE_MODE)?.({});
    harness.pickForMerge(101);
    harness.pickForMerge(202);
    harness.dispose();
    harness.admit();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.mergeExecute).toHaveBeenCalled();
    expect(
      harness.layer.spatialSkeletonSuppressSelectedNodeHighlight.value,
    ).toBe(false);
  });

  it("keeps the first pick of a new activation when an insert from an earlier activation finishes", async () => {
    const parentNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 1,
      segmentId: 11,
      position: new Float32Array([0, 0, 0]),
    };
    const childNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 2,
      segmentId: 11,
      parentNodeId: 1,
      position: new Float32Array([2, 2, 2]),
    };
    const harness = makeInsertToolHarness([parentNode, childNode]);
    let finishInsert = () => {};
    harness.insertExecute.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishInsert = resolve;
        }),
    );
    harness.actions.get(SKELETON_ENTER_INSERT_MODE)?.({});
    await harness.pickNode(parentNode);
    await harness.pickNode(childNode);
    harness.dispose();
    const reactivation = harness.activate();
    try {
      reactivation.actions.get(SKELETON_ENTER_INSERT_MODE)?.({});
      await harness.pickNode(parentNode);
      finishInsert();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(
        harness.layer.spatialSkeletonSuppressSelectedNodeHighlight.value,
      ).toBe(false);
      await harness.pickNode(childNode);
      expect(harness.insertExecute).toHaveBeenCalledTimes(2);
    } finally {
      reactivation.dispose();
    }
  });

  it("uses regular clicks for Find Path and preserves skeleton navigation chords", () => {
    const bindings = getDefaultSkeletonFindPathToolBindings();

    expect(bindings.get("at:mousedown0")?.action).toBe(
      SKELETON_FIND_PATH_SELECT_ENDPOINT,
    );
    expect(bindings.get("at:shift+mousedown0")?.action).toBe(
      SKELETON_FIND_PATH_SELECT_ENDPOINT,
    );
    expect(bindings.get("at:control+mousedown0")?.action).toBe(
      "rotate-via-mouse-drag",
    );
    expect(bindings.get("at:control+shift+mousedown0")?.action).toBe(
      "translate-via-mouse-drag",
    );
    expect(bindings.get("at:mousedown1")?.action).toBe("rotate-via-mouse-drag");
  });

  it("shows no generic bindings line in the Find Path status", () => {
    suppressStatusMessages();
    const harness = makeFindPathToolHarness();
    try {
      expect(readFullText(harness.readStatusElement())).toBe(
        "Find Path Clear Left-click the source node.",
      );
    } finally {
      harness.dispose();
    }
  });

  it("describes Find Path endpoints using their derived topology type", () => {
    const nodes = [
      makeFindPathNode(1),
      makeFindPathNode(2, 11, 1),
      makeFindPathNode(3, 11, 1),
      makeFindPathNode(4, 11, 2),
      makeFindPathNode(5, 11, 2),
    ];
    nodes[3].isTrueEnd = true;
    const graph = buildSpatiallyIndexedSkeletonNavigationGraph(nodes);

    expect(
      getSpatialSkeletonFindPathEndpointDescription(
        "Source",
        {
          nodeId: 1n,
          segmentId: 11n,
          position: new Float32Array(3),
        },
        graph,
      ),
    ).toBe("Source · Root");
    expect(
      getSpatialSkeletonFindPathEndpointDescription(
        "Target",
        {
          nodeId: 2n,
          segmentId: 11n,
          position: new Float32Array(3),
        },
        graph,
      ),
    ).toBe("Target · Branch point");
    expect(
      getSpatialSkeletonFindPathEndpointDescription(
        "Target",
        {
          nodeId: 3n,
          segmentId: 11n,
          position: new Float32Array(3),
        },
        graph,
      ),
    ).toBe("Target · Leaf");
    expect(
      getSpatialSkeletonFindPathEndpointDescription(
        "Target",
        {
          nodeId: 4n,
          segmentId: 11n,
          position: new Float32Array(3),
        },
        graph,
      ),
    ).toBe("Target · True end");
  });

  it("collects two exact Find Path nodes and rejects invalid or extra picks", () => {
    suppressStatusMessages();
    const harness = makeFindPathToolHarness();
    const source = makeFindPathNode(1);
    const target = makeFindPathNode(2);

    try {
      harness.pickNode(source);
      expect(harness.state.source).toEqual({
        nodeId: 1n,
        segmentId: 11n,
        position: source.position,
      });
      expect(harness.state.target).toBeUndefined();

      harness.pickNode(makeFindPathNode(1));
      expect(harness.state.target).toBeUndefined();
      expect(StatusMessage.showTemporaryMessage).toHaveBeenLastCalledWith(
        "Find Path endpoints must be distinct skeleton nodes.",
      );

      harness.pickNode(makeFindPathNode(2, 12));
      expect(harness.state.target).toBeUndefined();
      expect(StatusMessage.showTemporaryMessage).toHaveBeenLastCalledWith(
        "Find Path endpoints must belong to the same skeleton segment.",
      );

      harness.pickNode(target);
      expect(harness.state.target).toEqual({
        nodeId: 2n,
        segmentId: 11n,
        position: target.position,
      });

      harness.pickNode(makeFindPathNode(3));
      expect(harness.state.source?.nodeId).toBe(1n);
      expect(harness.state.target?.nodeId).toBe(2n);
      expect(StatusMessage.showTemporaryMessage).toHaveBeenLastCalledWith(
        "Clear Find Path or delete an endpoint before selecting another node.",
      );
    } finally {
      harness.dispose();
    }
  });

  it("rejects edge-only picks and permits a new endpoint after Clear", () => {
    suppressStatusMessages();
    const harness = makeFindPathToolHarness();

    try {
      harness.mouseState.pickedSpatialSkeleton = { segmentId: 11 };
      harness.actions.get(SKELETON_FIND_PATH_SELECT_ENDPOINT)?.(
        makeFindPathActionEvent(),
      );
      expect(harness.state.source).toBeUndefined();
      expect(StatusMessage.showTemporaryMessage).toHaveBeenLastCalledWith(
        "Find Path endpoints must be exact skeleton nodes, not edges.",
      );

      harness.pickNode(makeFindPathNode(1));
      harness.state.clear();
      harness.pickNode(makeFindPathNode(2));
      expect(harness.state.source?.nodeId).toBe(2n);
    } finally {
      harness.dispose();
    }
  });

  it("rejects picks from a non-owning spatial skeleton source", () => {
    suppressStatusMessages();
    const harness = makeFindPathToolHarness({ hasSecondSource: true });

    try {
      harness.pickNode(makeFindPathNode(1));
      harness.pickNode(makeFindPathNode(2), harness.secondSkeletonLayer);

      expect(harness.state.source?.nodeId).toBe(1n);
      expect(harness.state.target).toBeUndefined();
      expect(StatusMessage.showTemporaryMessage).toHaveBeenLastCalledWith(
        "Find Path is only available for the first active spatial skeleton datasource in this layer.",
      );

      harness.state.clear();
      harness.pickNode(makeFindPathNode(2), harness.secondSkeletonLayer);
      expect(harness.state.toJSON()).toBeUndefined();
      expect(StatusMessage.showTemporaryMessage).toHaveBeenLastCalledWith(
        "Find Path is only available for the first active spatial skeleton datasource in this layer.",
      );
    } finally {
      harness.dispose();
    }
  });

  it("automatically uses the cached skeleton and stores an endpoint-inclusive path", () => {
    suppressStatusMessages();
    const nodes = [
      makeFindPathNode(1),
      makeFindPathNode(2, 11, 1),
      makeFindPathNode(3, 11, 2),
    ];
    const harness = makeFindPathToolHarness({ cachedSegmentNodes: nodes });
    try {
      harness.pickNode(nodes[2]);
      harness.pickNode(nodes[0]);

      expect(harness.state.result?.map(({ nodeId }) => nodeId)).toEqual([
        3n,
        2n,
        1n,
      ]);
      expect(harness.getFullSegmentNodes).not.toHaveBeenCalled();
      expect(
        harness.layer.spatialSkeletonState.getCachedSegmentNodes,
      ).toHaveBeenCalledWith(11);
      expect(harness.state.result?.map(({ position }) => position)).toEqual([
        nodes[2].position,
        nodes[1].position,
        nodes[0].position,
      ]);
      expect(StatusMessage.showTemporaryMessage).toHaveBeenCalledWith(
        "Path found!",
        5000,
      );
    } finally {
      harness.dispose();
    }
  });

  it("reports missing endpoints and disconnected cached skeletons distinctly", () => {
    suppressStatusMessages();
    const cases = [
      {
        nodes: [makeFindPathNode(3)],
        expected:
          "Failed to find path: Source node 1 is missing from the loaded skeleton.",
      },
      {
        nodes: [makeFindPathNode(1)],
        expected:
          "Failed to find path: Target node 3 is missing from the loaded skeleton.",
      },
      {
        nodes: [makeFindPathNode(1), makeFindPathNode(3)],
        expected: "Failed to find path: No route exists between nodes 1 and 3.",
      },
    ] as const;

    for (const { nodes, expected } of cases) {
      const harness = makeFindPathToolHarness({ cachedSegmentNodes: nodes });
      try {
        harness.pickNode(makeFindPathNode(1));
        harness.pickNode(makeFindPathNode(3));

        expect(StatusMessage.showTemporaryMessage).toHaveBeenCalledWith(
          expected,
        );
        expect(harness.getFullSegmentNodes).not.toHaveBeenCalled();
        expect(harness.state.result).toBeUndefined();
      } finally {
        harness.dispose();
      }
    }
  });

  it("waits for cached node data without requesting it", () => {
    suppressStatusMessages();
    const harness = makeFindPathToolHarness();

    try {
      harness.pickNode(makeFindPathNode(1));
      harness.pickNode(makeFindPathNode(3));

      expect(harness.getFullSegmentNodes).not.toHaveBeenCalled();
      expect(harness.state.result).toBeUndefined();
      expect(StatusMessage.showTemporaryMessage).toHaveBeenCalledWith(
        "Full data for skeleton 11 is not cached. Make it visible and wait for loading.",
      );
    } finally {
      harness.dispose();
    }
  });

  it("rejects persisted endpoint IDs outside the spatial number boundary", () => {
    suppressStatusMessages();
    const state = new SkeletonFindPathState();
    const unsafeNodeId = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    state.setEndpoints(
      {
        nodeId: unsafeNodeId,
        segmentId: 11n,
        position: new Float32Array([1, 2, 3]),
      },
      {
        nodeId: unsafeNodeId + 1n,
        segmentId: 11n,
        position: new Float32Array([4, 5, 6]),
      },
    );
    const harness = makeFindPathToolHarness({ state });

    try {
      const status = harness
        .readStatusElement()
        .querySelector(".neuroglancer-skeleton-find-path-message");
      expect(status?.textContent).toBe(
        "The selected endpoint IDs are not supported by this spatial skeleton source.",
      );
      expect(harness.state.result).toBeUndefined();
      expect(harness.getFullSegmentNodes).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it("uses a cached skeleton even when it is not visible", () => {
    suppressStatusMessages();
    const nodes = [
      makeFindPathNode(1),
      makeFindPathNode(2, 11, 1),
      makeFindPathNode(3, 11, 2),
    ];
    const harness = makeFindPathToolHarness({
      cachedSegmentNodes: nodes,
      visibleSegmentIds: [],
    });

    try {
      harness.pickNode(nodes[0]);
      harness.pickNode(nodes[2]);

      expect(harness.state.result?.map(({ nodeId }) => nodeId)).toEqual([
        1n,
        2n,
        3n,
      ]);
      expect(harness.getFullSegmentNodes).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it("automatically retries when the full skeleton enters the cache", () => {
    suppressStatusMessages();
    const nodes = [
      makeFindPathNode(1),
      makeFindPathNode(2, 11, 1),
      makeFindPathNode(3, 11, 2),
    ];
    const harness = makeFindPathToolHarness();

    try {
      harness.pickNode(nodes[0]);
      harness.pickNode(nodes[2]);
      expect(harness.state.result).toBeUndefined();

      harness.cachedSegmentNodes.set(11, nodes);
      harness.nodeDataVersion.value++;

      expect(harness.state.result?.map(({ nodeId }) => nodeId)).toEqual([
        1n,
        2n,
        3n,
      ]);
      expect(harness.getFullSegmentNodes).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it("Clear resets a result computed from cached nodes", () => {
    suppressStatusMessages();
    const nodes = [
      makeFindPathNode(1),
      makeFindPathNode(2, 11, 1),
      makeFindPathNode(3, 11, 2),
    ];
    const harness = makeFindPathToolHarness({ cachedSegmentNodes: nodes });

    try {
      harness.pickNode(nodes[0]);
      harness.pickNode(nodes[2]);
      expect(harness.state.result).toBeDefined();

      const clearButton = harness
        .readStatusElement()
        .querySelector<HTMLElement>('[title="Clear Find Path"]');
      expect(clearButton).not.toBeNull();
      clearButton!.click();

      expect(harness.state.source).toBeUndefined();
      expect(harness.state.target).toBeUndefined();
      expect(harness.state.result).toBeUndefined();
      expect(harness.getFullSegmentNodes).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it("allows Find Path for a read-only source using inspect permission", () => {
    suppressStatusMessages();
    const harness = makeFindPathToolHarness({ readonly: true });

    try {
      expect(
        harness.getSpatialSkeletonActionsDisabledReason,
      ).toHaveBeenCalledWith(SpatialSkeletonActions.inspect);
      expect(harness.actions.has(SKELETON_FIND_PATH_SELECT_ENDPOINT)).toBe(
        true,
      );
      expect(harness.activation.cancel).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it("cancels Find Path when inspect is disabled or no source is loaded", async () => {
    suppressStatusMessages();
    const disabledHarness = makeFindPathToolHarness({
      disabledReason: "Skeleton inspection is unavailable.",
    });
    const noSourceHarness = makeFindPathToolHarness({ hasSource: false });

    try {
      await Promise.resolve();

      expect(disabledHarness.activation.cancel).toHaveBeenCalledTimes(1);
      expect(disabledHarness.actions.size).toBe(0);
      expect(noSourceHarness.activation.cancel).toHaveBeenCalledTimes(1);
      expect(noSourceHarness.actions.size).toBe(0);
      expect(StatusMessage.showTemporaryMessage).toHaveBeenCalledWith(
        "Skeleton inspection is unavailable.",
      );
      expect(StatusMessage.showTemporaryMessage).toHaveBeenCalledWith(
        "No spatially indexed skeleton source is currently loaded.",
      );
    } finally {
      disabledHarness.dispose();
      noSourceHarness.dispose();
    }
  });

  it("errors when ctrl+click has no selected parent node", () => {
    suppressStatusMessages();
    const skeletonLayer = {
      getNode: vi.fn(),
    };
    const mouseState = {
      pickedRenderLayer: undefined,
      pickedSpatialSkeleton: undefined,
      updateUnconditionally: vi.fn(() => true),
      active: true,
      unsnappedPosition: new Float32Array([1, 2, 3]),
      changed: makeChangedSignal(),
    };
    const layer = {
      displayState: {
        ...makeSkeletonRenderingOptions(),
        segmentationGroupState: {
          value: makeVisibleSegmentsState(),
        },
      },
      spatialSkeletonEditMode: makeModeWatchable(),
      spatialSkeletonMergeMode: makeModeWatchable(),
      spatialSkeletonSplitMode: makeModeWatchable(),
      spatialSkeletonSuppressSelectedNodeHighlight: makeModeWatchable(),
      selectedSpatialSkeletonNodeInfo: {
        value: undefined, // No node selected.
        changed: makeChangedSignal(),
      },
      spatialSkeletonState: {
        commandHistory: new SpatialSkeletonCommandHistory(),
        getCachedNode: vi.fn(),
        mergeAnchorNodeId: { value: undefined, changed: makeChangedSignal() },
        clearPendingNodePositions: vi.fn(),
      },
      manager: {
        root: {
          layerSelectedValues: { mouseState },
          selectionState: { value: undefined, changed: makeChangedSignal() },
          display: { panels: [] },
        },
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      getSpatialSkeletonActionsDisabledReason: vi.fn(() => undefined),
      selectSegment: vi.fn(),
      selectSpatialSkeletonNode: vi.fn(),
      layersChanged: makeChangedSignal(),
    };
    const { activation, actions, dispose } = makeToolActivation();
    const tool = Object.assign(
      Object.create(SpatialSkeletonEditTool.prototype),
      { layer, mergeTargetPrefetch: makeMergeTargetPrefetch() },
    );

    try {
      SpatialSkeletonEditTool.prototype.activate.call(tool, activation as any);

      actions.get(SKELETON_ADD_NODE)?.({
        stopPropagation: vi.fn(),
        detail: { preventDefault: vi.fn() },
      });

      expect(StatusMessage.showTemporaryMessage).toHaveBeenCalledWith(
        expect.stringContaining("Select a node first"),
      );
    } finally {
      dispose();
    }
  });

  it("rejects cold add-child, delete, split, and merge-from interactions", () => {
    suppressStatusMessages();
    const node: SpatiallyIndexedSkeletonNode = {
      nodeId: 101,
      segmentId: 11,
      parentNodeId: 100,
      position: new Float32Array([1, 2, 3]),
      isTrueEnd: false,
    };
    const source = makeCommandSkeletonSource();
    const skeletonLayer = {
      source,
      getNode: vi.fn(() => node),
    };
    const mouseState = {
      pickedRenderLayer: undefined,
      pickedSpatialSkeleton: {
        nodeId: node.nodeId,
        segmentId: node.segmentId,
        position: node.position,
      },
      position: new Float32Array([1, 2, 3]),
      updateUnconditionally: vi.fn(() => true),
      active: true,
    };
    const getCachedSegmentSnapshotHandle = vi.fn(() => undefined);
    const getFullSegmentNodes = vi.fn();
    const setSpatialSkeletonMergeAnchor = vi.fn();
    const layer = {
      displayState: {
        segmentationGroupState: {
          value: makeVisibleSegmentsState([11n]),
        },
      },
      selectedSpatialSkeletonNodeInfo: {
        value: { nodeId: node.nodeId, segmentId: node.segmentId },
      },
      spatialSkeletonState: {
        commandHistory: new SpatialSkeletonCommandHistory(),
        getCachedNode: vi.fn(),
        getCachedSegmentSnapshotHandle,
        getFullSegmentNodes,
        mergeAnchorNodeId: { value: undefined },
      },
      spatialSkeletonSuppressSelectedNodeHighlight: makeModeWatchable(),
      manager: {
        root: {
          layerSelectedValues: { mouseState },
        },
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      getSpatialSkeletonActionsDisabledReason: vi.fn(() => undefined),
      selectSegment: vi.fn(),
      selectSpatialSkeletonNode: vi.fn(),
      setSpatialSkeletonMergeAnchor,
    };
    const tool = Object.assign(
      Object.create(SpatialSkeletonEditTool.prototype),
      { layer, pending: false, mergeTargetPrefetch: makeMergeTargetPrefetch() },
    );

    expect(
      (tool as any).getSelectedParentNodeForAdd(skeletonLayer, node.nodeId),
    ).toBeUndefined();
    (tool as any).handleDeletePick();
    (tool as any).handleSplitPick();
    (tool as any).handleMergeFirstPick();

    expect(source.addNodesCommand.createCommand).not.toHaveBeenCalled();
    expect(source.deleteNodesCommand.createCommand).not.toHaveBeenCalled();
    expect(source.splitSkeletonsCommand.createCommand).not.toHaveBeenCalled();
    expect(source.mergeSkeletonsCommand.createCommand).not.toHaveBeenCalled();
    expect(setSpatialSkeletonMergeAnchor).not.toHaveBeenCalled();
    expect(getFullSegmentNodes).not.toHaveBeenCalled();
    expect(getCachedSegmentSnapshotHandle).toHaveBeenCalledWith(node.segmentId);
    expect(StatusMessage.showTemporaryMessage).toHaveBeenCalledWith(
      `Inspect skeleton ${node.segmentId} before editing it.`,
    );
  });

  it("selects a node of an uninspected skeleton without asking to inspect it", () => {
    const { layer, start, original } = makeDragHarness({ inspected: false });
    start();

    expect(layer.selectSpatialSkeletonNode).toHaveBeenCalledWith(
      original.nodeId,
      true,
      original,
    );
    expect(StatusMessage.showTemporaryMessage).not.toHaveBeenCalled();
  });

  it("does not ask to inspect an uninspected skeleton when the pointer barely moves", () => {
    const { start, event } = makeDragHarness({ inspected: false });
    const { move } = start();
    // Below the 2 px drag threshold.
    move(event, 1, 0);

    expect(StatusMessage.showTemporaryMessage).not.toHaveBeenCalled();
  });

  it("asks once to inspect the skeleton when one of its nodes is dragged", () => {
    const { state, source, start, event, original } = makeDragHarness({
      inspected: false,
    });
    const { move } = start();
    move(event, 10, 20);
    move(event, 10, 20);

    expect(StatusMessage.showTemporaryMessage).toHaveBeenCalledExactlyOnceWith(
      `Inspect skeleton ${original.segmentId} before editing it.`,
    );
    expect(state.setPendingNodePosition).not.toHaveBeenCalled();
    expect(source.moveNodesCommand.createCommand).not.toHaveBeenCalled();
  });

  for (const remapNodeId of [true, false]) {
    it.each(["before movement", "during movement", "after last movement"])(
      `resolves a dragged ${remapNodeId ? "node and skeleton" : "skeleton"} remapped %s`,
      async (when) => {
        const {
          original,
          mappings,
          handle,
          state,
          source,
          skeletonLayer,
          executeOptimistically,
          releaseBrowseExclusion,
          setCurrentNode,
          start,
          event,
        } = makeDragHarness();
        const { move, finish } = start();
        if (when !== "before movement") {
          move(event, when === "during movement" ? 5 : 10, 20);
        }
        const currentNode = {
          ...original,
          nodeId: remapNodeId ? 101 : original.nodeId,
          segmentId: 17,
        };
        setCurrentNode(currentNode);
        mappings.bindNodes([[handle, currentNode.nodeId]]);
        if (when !== "after last movement") {
          move(
            event,
            when === "during movement" ? 5 : 10,
            when === "during movement" ? 0 : 20,
          );
          expect(state.setPendingNodePosition).toHaveBeenLastCalledWith(
            currentNode.nodeId,
            new Float32Array([11, 22, 3]),
          );
        }
        finish!(event, 0, 0);
        expect(
          skeletonLayer.beginTemporaryBrowseExclusion,
        ).toHaveBeenCalledWith(
          when === "before movement"
            ? currentNode.segmentId
            : original.segmentId,
        );
        expect(
          source.moveNodesCommand.createCommand,
        ).toHaveBeenCalledExactlyOnceWith({
          node: currentNode,
          nextPositionInModelSpace: new Float32Array([11, 22, 3]),
        });
        await vi.waitFor(() => {
          expect(executeOptimistically).toHaveBeenCalledTimes(1);
          expect(releaseBrowseExclusion).toHaveBeenCalledTimes(1);
        });
      },
    );
  }

  for (const startMoving of [false, true]) {
    it.each([false, true])(
      `cancels a ${startMoving ? "moving" : "pressed"} node drag on deactivation (reactivate: %s)`,
      (reactivate) => {
        const { tool, state, source, start, event, releaseBrowseExclusion } =
          makeDragHarness();
        const first = makeToolActivation();
        const second = makeToolActivation();
        tool.activate(first.activation);
        const stale = start();
        if (startMoving) stale.move(event, 10, 20);
        const prefetchClears = tool.mergeTargetPrefetch.clear.mock.calls.length;
        const releaseMergeHover = vi.fn();
        tool.mergeTargetHoverRelease = releaseMergeHover;
        first.dispose();
        expect(tool.dragInProgress).toBe(false);
        expect(releaseMergeHover).toHaveBeenCalledOnce();
        expect(tool.mergeTargetPrefetch.clear).toHaveBeenCalledTimes(
          prefetchClears + 1,
        );
        expect(releaseBrowseExclusion).toHaveBeenCalledTimes(
          startMoving ? 1 : 0,
        );
        const previews = state.setPendingNodePosition.mock.calls.length;
        const clears = state.clearPendingNodePositions.mock.calls.length;
        try {
          if (reactivate) tool.activate(second.activation);
          stale.move(event, 30, 40);
          stale.finish(event, 0, 0);
          expect(state.setPendingNodePosition).toHaveBeenCalledTimes(previews);
          expect(state.clearPendingNodePositions).toHaveBeenCalledTimes(clears);
          expect(tool.dragInProgress).toBe(false);
          expect(source.moveNodesCommand.createCommand).not.toHaveBeenCalled();
          if (reactivate) {
            const current = start();
            current.move(event, 5, 10);
            // Delayed events from the old gesture must not clear the new preview.
            stale.move(event, 30, 40);
            stale.finish(event, 0, 0);
            expect(state.setPendingNodePosition).toHaveBeenCalledTimes(
              previews + 1,
            );
            expect(state.clearPendingNodePositions).toHaveBeenCalledTimes(
              clears + 1,
            );
            expect(tool.dragInProgress).toBe(true);
            current.finish(event, 0, 0);
            expect(source.moveNodesCommand.createCommand).toHaveBeenCalledTimes(
              1,
            );
          }
        } finally {
          if (reactivate) second.dispose();
        }
      },
    );
  }

  it("requires inspection for selected-node true-end and reroot actions", () => {
    suppressStatusMessages();
    const node: SpatiallyIndexedSkeletonNode = {
      nodeId: 101,
      segmentId: 11,
      position: new Float32Array([1, 2, 3]),
      isTrueEnd: false,
    };
    const source = makeCommandSkeletonSource();
    const skeletonLayer = {
      source,
      getNode: vi.fn(() => node),
    };
    const mouseState = {
      pickedRenderLayer: undefined,
      pickedSpatialSkeleton: undefined,
      updateUnconditionally: vi.fn(() => true),
      active: true,
      changed: makeChangedSignal(),
    };
    const rerootSpatialSkeletonNode = vi.fn(async () => {});
    const layer = {
      displayState: {
        ...makeSkeletonRenderingOptions(),
        segmentationGroupState: {
          value: makeVisibleSegmentsState([11n]),
        },
      },
      spatialSkeletonEditMode: makeModeWatchable(),
      spatialSkeletonMergeMode: makeModeWatchable(),
      spatialSkeletonSplitMode: makeModeWatchable(),
      spatialSkeletonSuppressSelectedNodeHighlight: makeModeWatchable(),
      selectedSpatialSkeletonNodeInfo: {
        value: { nodeId: node.nodeId, segmentId: node.segmentId },
        changed: makeChangedSignal(),
      },
      spatialSkeletonState: {
        commandHistory: new SpatialSkeletonCommandHistory(),
        getCachedNode: vi.fn(),
        getCachedSegmentSnapshotHandle: vi.fn(() => undefined),
        mergeAnchorNodeId: { value: undefined, changed: makeChangedSignal() },
        clearPendingNodePositions: vi.fn(),
      },
      manager: {
        root: {
          layerSelectedValues: { mouseState },
          selectionState: { value: undefined, changed: makeChangedSignal() },
          display: { panels: [] },
        },
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      getSpatialSkeletonActionsDisabledReason: vi.fn(() => undefined),
      rerootSpatialSkeletonNode,
      clearSpatialSkeletonMergeAnchor: vi.fn(),
      clearSpatialSkeletonNodeSelection: vi.fn(),
      layersChanged: makeChangedSignal(),
    };
    const { activation, actions, dispose } = makeToolActivation();
    const tool = Object.assign(
      Object.create(SpatialSkeletonEditTool.prototype),
      { layer, mergeTargetPrefetch: makeMergeTargetPrefetch() },
    );

    try {
      SpatialSkeletonEditTool.prototype.activate.call(tool, activation as any);
      actions.get(SKELETON_TOGGLE_TRUE_END)?.({});
      actions.get(SKELETON_REROOT)?.({});

      expect(
        source.editNodeTrueEndCommand.createCommand,
      ).not.toHaveBeenCalled();
      expect(rerootSpatialSkeletonNode).not.toHaveBeenCalled();
      expect(StatusMessage.showTemporaryMessage).toHaveBeenCalledWith(
        `Inspect skeleton ${node.segmentId} before editing it.`,
      );
    } finally {
      dispose();
    }
  });

  it("uses inspected ownership when a merge target pick has a retired skeleton ID", async () => {
    suppressStatusMessages();
    const fromNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 101,
      segmentId: 11,
      position: new Float32Array([1, 2, 3]),
      isTrueEnd: false,
    };
    const toNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 202,
      segmentId: 17,
      position: new Float32Array([4, 5, 6]),
      isTrueEnd: false,
    };
    const mergeExecute = vi.fn(completedEditExecution);
    const mergeSkeletonsCommand = makeCommandFactory(
      SpatialSkeletonActions.mergeSkeletons,
    );
    const source = makeCommandSkeletonSource({ mergeSkeletonsCommand });
    const skeletonLayer = {
      source,
      getNode: vi.fn((nodeId: number) =>
        nodeId === fromNode.nodeId
          ? fromNode
          : nodeId === toNode.nodeId
            ? toNode
            : undefined,
      ),
    };
    const fromSnapshot = makeCachedSegmentSnapshot([fromNode]);
    const getCachedSegmentSnapshotHandle = vi.fn((segmentId: number) =>
      segmentId === fromNode.segmentId ? fromSnapshot : undefined,
    );
    const mouseState = {
      pickedRenderLayer: undefined,
      pickedSpatialSkeleton: {
        nodeId: toNode.nodeId,
        segmentId: 6368542,
        position: toNode.position,
      },
      updateUnconditionally: vi.fn(() => true),
      active: true,
    };
    const layer = {
      displayState: {
        segmentationGroupState: {
          value: makeVisibleSegmentsState([11n]),
        },
      },
      selectedSpatialSkeletonNodeInfo: {
        value: { nodeId: fromNode.nodeId, segmentId: fromNode.segmentId },
      },
      spatialSkeletonState: {
        commandHistory: new SpatialSkeletonCommandHistory(),
        assertOptimisticEditingAllowed: vi.fn(),
        ensureOptimisticEditingEngine: vi.fn(() => ({})),
        getOptimisticEditingIdentityService: vi.fn(() => ({})),
        executeOptimisticEdit: mergeExecute,
        getCachedNode: vi.fn(),
        getCachedSegmentSnapshotHandle,
        mergeAnchorNodeId: { value: fromNode.nodeId },
      },
      spatialSkeletonSuppressSelectedNodeHighlight: makeModeWatchable(),
      manager: {
        root: {
          layerSelectedValues: { mouseState },
        },
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      getSpatialSkeletonActionsDisabledReason: vi.fn(() => undefined),
      selectSegment: vi.fn(),
      selectSpatialSkeletonNode: vi.fn(),
    };
    const tool = Object.assign(
      Object.create(SpatialSkeletonEditTool.prototype),
      { layer, pending: false, mergeTargetPrefetch: makeMergeTargetPrefetch() },
    );

    (tool as any).handleMergeSecondPick();

    expect(mergeSkeletonsCommand.createCommand).toHaveBeenCalledWith({
      firstNode: expect.objectContaining({
        nodeId: fromNode.nodeId,
        segmentId: fromNode.segmentId,
      }),
      secondNode: expect.objectContaining({
        nodeId: toNode.nodeId,
        segmentId: toNode.segmentId,
      }),
    });
    expect(getCachedSegmentSnapshotHandle).toHaveBeenCalledTimes(1);
    expect(getCachedSegmentSnapshotHandle).toHaveBeenCalledWith(
      fromNode.segmentId,
    );
    await vi.waitFor(() => expect(mergeExecute).toHaveBeenCalledTimes(1));
  });

  it.each([false, true])(
    "resolves merge targets with cached ownership when available (%s)",
    (cached) => {
      const node = makeFindPathNode(210684811, 6368977);
      const picked = { ...node, segmentId: 6368542 };
      const mouseState = {
        active: true,
        updateUnconditionally: () => true,
        pickedSpatialSkeleton: picked,
      };
      const skeletonLayer = { getNode: () => undefined };
      const layer = {
        manager: { root: { layerSelectedValues: { mouseState } } },
        spatialSkeletonState: {
          getCachedNode: () => (cached ? node : undefined),
        },
      };
      const tool = Object.assign(
        Object.create(SpatialSkeletonEditTool.prototype),
        { layer, mergeTargetPrefetch: makeMergeTargetPrefetch() },
      );
      expect(tool.resolvePickedNodeSelectionForMerge(skeletonLayer)).toEqual({
        nodeId: node.nodeId,
        segmentId: cached ? node.segmentId : picked.segmentId,
        position: node.position,
      });
    },
  );

  it("keeps root creation independent of the inspection cache", async () => {
    suppressStatusMessages();
    const addExecute = vi.fn(completedEditExecution);
    const addNodesCommand = makeCommandFactory(SpatialSkeletonActions.addNodes);
    const source = makeCommandSkeletonSource({ addNodesCommand });
    const skeletonLayer = { source };
    const getCachedSegmentSnapshotHandle = vi.fn();
    const layer = {
      spatialSkeletonState: {
        commandHistory: new SpatialSkeletonCommandHistory(),
        assertOptimisticEditingAllowed: vi.fn(),
        ensureOptimisticEditingEngine: vi.fn(() => ({})),
        getOptimisticEditingIdentityService: vi.fn(() => ({})),
        executeOptimisticEdit: addExecute,
        getCachedSegmentSnapshotHandle,
      },
      manager: {
        root: {
          layerSelectedValues: {
            mouseState: { pickedRenderLayer: undefined },
          },
        },
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      getSpatialSkeletonActionsDisabledReason: vi.fn(() => undefined),
    };
    const tool = Object.assign(
      Object.create(SpatialSkeletonEditTool.prototype),
      {
        layer,
        mergeTargetPrefetch: makeMergeTargetPrefetch(),
        pending: false,
        createPlacedThisHold: false,
        getMousePositionInSkeletonCoordinates: vi.fn(
          () => new Float32Array([7, 8, 9]),
        ),
      },
    );

    (tool as any).handleCreatePlace();

    expect(addNodesCommand.createCommand).toHaveBeenCalledWith({
      skeletonId: 0,
      parentNodeId: undefined,
      positionInModelSpace: new Float32Array([7, 8, 9]),
    });
    expect(getCachedSegmentSnapshotHandle).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(addExecute).toHaveBeenCalledTimes(1));
  });
});
