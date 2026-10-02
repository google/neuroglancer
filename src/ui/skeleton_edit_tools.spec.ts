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

import { makeCatmaidNodeSourceState } from "#src/datasource/catmaid/api.js";
import { CatmaidSpatialSkeletonEditCommands } from "#src/datasource/catmaid/spatial_skeleton_commands.js";
import {
  SKELETON_ADD_NODE,
  SKELETON_CLEAR_SELECTION,
  SKELETON_ENTER_INSERT_MODE,
  SKELETON_ENTER_MERGE_MODE,
  SKELETON_ENTER_SPLIT_MODE,
  SKELETON_FIND_PATH_SELECT_ENDPOINT,
} from "#src/skeleton/actions.js";
import type { SpatiallyIndexedSkeletonNode } from "#src/skeleton/api.js";
import { SpatialSkeletonCommandHistory } from "#src/skeleton/command_history.js";
import {
  SpatialSkeletonActions,
  type SpatialSkeletonAction,
} from "#src/skeleton/command_protocol.js";
import {
  executeSpatialSkeletonAddNode,
  executeSpatialSkeletonMerge,
} from "#src/skeleton/commands.js";
import { SkeletonFindPathState } from "#src/skeleton/find_path.js";
import { buildSpatiallyIndexedSkeletonNavigationGraph } from "#src/skeleton/navigation_graph.js";
import { StatusMessage } from "#src/status.js";
import { WatchableValue } from "#src/trackable_value.js";
import { getDefaultSkeletonFindPathToolBindings } from "#src/ui/default_input_event_bindings.js";

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
  const client = makeCatmaidClient(clientOverrides);
  const commands = new CatmaidSpatialSkeletonEditCommands({
    getClient: () => client as any,
  });
  return {
    readonly: false,
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
    listSkeletons: vi.fn(),
    getSkeleton: vi.fn(),
    fetchNodes: vi.fn(),
    getSpatialIndexMetadata: vi.fn(),
    getSkeletonRootNode: vi.fn(),
    ...sourceOverrides,
  };
}

function testSourceState(revisionToken: string) {
  return makeCatmaidNodeSourceState(revisionToken);
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

function makeChangedSignal() {
  return {
    add: vi.fn((_listener: () => void) => () => {}),
    dispatch: vi.fn(),
  };
}

function makeModeWatchable(value = false) {
  return { value };
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
  return { activation, actions, dispose };
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
  const { activation, actions, dispose } = makeToolActivation();
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
    skeletonLayer,
    secondSkeletonLayer,
    state,
    visibleSegmentsState,
  };
}

function makeCommandFactory(
  action: SpatialSkeletonAction,
  execute = vi.fn(async () => {}),
) {
  return {
    action,
    createCommand: vi.fn(() => ({
      label: action,
      execute,
      undo: vi.fn(async () => {}),
    })),
  };
}

function makeCommandSkeletonSource(overrides: Record<string, unknown> = {}) {
  return {
    readonly: false,
    addNodesCommand: makeCommandFactory(SpatialSkeletonActions.addNodes),
    insertNodesCommand: makeCommandFactory(SpatialSkeletonActions.insertNodes),
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

  it("keeps parented add-node commits overlay-first without refetching chunks", async () => {
    suppressStatusMessages();
    const upsertCachedNode = vi.fn();
    const setCachedNodeSourceState = vi.fn();
    const selectSegment = vi.fn();
    const selectSpatialSkeletonNode = vi.fn();
    const markSpatialSkeletonNodeDataChanged = vi.fn();
    const moveViewToSpatialSkeletonNodePosition = vi.fn();
    const getFullSegmentNodes = vi.fn();
    const parentNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 5,
      segmentId: 11,
      position: new Float32Array([8, 9, 10]),
      isTrueEnd: false,
      sourceState: testSourceState("parent-before"),
    };
    const addNode = vi.fn().mockResolvedValue({
      nodeId: 17,
      segmentId: 11,
      sourceState: testSourceState("node-after"),
      parentSourceState: testSourceState("parent-after"),
    });
    const skeletonLayer = {
      source: makeEditableSkeletonSource({ addNode }),
      getNode: vi.fn((nodeId: number) =>
        nodeId === parentNode.nodeId ? parentNode : undefined,
      ),
      retainOverlaySegment: vi.fn(),
    };
    const commandHistory = new SpatialSkeletonCommandHistory();
    const visibleSegmentsState = makeVisibleSegmentsState();
    const layer = {
      displayState: {
        segmentationGroupState: {
          value: visibleSegmentsState,
        },
      },
      spatialSkeletonState: {
        commandHistory,
        getCachedNode: vi.fn((nodeId: number) =>
          nodeId === parentNode.nodeId ? parentNode : undefined,
        ),
        getCachedSegmentNodes: vi.fn((segmentId: number) =>
          segmentId === parentNode.segmentId ? [parentNode] : undefined,
        ),
        getFullSegmentNodes,
        upsertCachedNode,
        setCachedNodeSourceState,
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      selectSegment,
      selectSpatialSkeletonNode,
      markSpatialSkeletonNodeDataChanged,
      moveViewToSpatialSkeletonNodePosition,
      manager: {
        root: {
          selectionState: {
            pin: {
              value: true,
            },
          },
        },
      },
    };
    const position = new Float32Array([1, 2, 3]);

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: 11,
      parentNodeId: 5,
      positionInModelSpace: position,
    });

    expect(addNode).toHaveBeenCalledWith(
      11,
      1,
      2,
      3,
      5,
      expect.objectContaining({
        node: expect.objectContaining({ nodeId: 5 }),
      }),
      {
        nocheck: undefined,
        signal: undefined,
      },
    );
    expect(upsertCachedNode).toHaveBeenCalledWith(
      {
        nodeId: 17,
        segmentId: 11,
        position: new Float32Array([1, 2, 3]),
        parentNodeId: 5,
        isTrueEnd: false,
        sourceState: testSourceState("node-after"),
      },
      { allowUncachedSegment: false },
    );
    expect(setCachedNodeSourceState).toHaveBeenCalledWith(
      5,
      testSourceState("parent-after"),
    );
    expect(visibleSegmentsState.visibleSegments.has(11n)).toBe(true);
    expect(selectSegment).toHaveBeenCalledWith(11n, true);
    expect(selectSpatialSkeletonNode).toHaveBeenCalledWith(17, true, {
      segmentId: 11,
      position: new Float32Array([1, 2, 3]),
    });
    expect(moveViewToSpatialSkeletonNodePosition).toHaveBeenCalledWith(
      new Float32Array([1, 2, 3]),
    );
    expect(skeletonLayer.retainOverlaySegment).toHaveBeenCalledWith(11);
    expect(markSpatialSkeletonNodeDataChanged).toHaveBeenCalledWith({
      invalidateFullSkeletonCache: false,
    });
    expect(getFullSegmentNodes).not.toHaveBeenCalled();
  });

  it("seeds root add-node commits locally without overlay retention or refetching chunks", async () => {
    suppressStatusMessages();
    const upsertCachedNode = vi.fn();
    const setCachedNodeSourceState = vi.fn();
    const selectSegment = vi.fn();
    const selectSpatialSkeletonNode = vi.fn();
    const markSpatialSkeletonNodeDataChanged = vi.fn();
    const moveViewToSpatialSkeletonNodePosition = vi.fn();
    const getFullSegmentNodes = vi.fn();
    const addNode = vi.fn().mockResolvedValue({
      nodeId: 29,
      segmentId: 13,
      sourceState: testSourceState("root-after"),
    });
    const skeletonLayer = {
      source: makeEditableSkeletonSource({ addNode }),
      getNode: vi.fn(),
      retainOverlaySegment: vi.fn(),
    };
    const commandHistory = new SpatialSkeletonCommandHistory();
    const visibleSegmentsState = makeVisibleSegmentsState();
    const layer = {
      displayState: {
        segmentationGroupState: {
          value: visibleSegmentsState,
        },
      },
      spatialSkeletonState: {
        commandHistory,
        getCachedNode: vi.fn(),
        getCachedSegmentNodes: vi.fn(),
        getFullSegmentNodes,
        upsertCachedNode,
        setCachedNodeSourceState,
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      selectSegment,
      selectSpatialSkeletonNode,
      markSpatialSkeletonNodeDataChanged,
      moveViewToSpatialSkeletonNodePosition,
      manager: {
        root: {
          selectionState: {
            pin: {
              value: false,
            },
          },
        },
      },
    };
    const position = new Float32Array([4, 5, 6]);

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: 13,
      parentNodeId: undefined,
      positionInModelSpace: position,
    });

    expect(addNode).toHaveBeenCalledWith(13, 4, 5, 6, undefined, undefined, {
      nocheck: undefined,
      signal: undefined,
    });
    expect(upsertCachedNode).toHaveBeenCalledWith(
      {
        nodeId: 29,
        segmentId: 13,
        position: new Float32Array([4, 5, 6]),
        parentNodeId: undefined,
        isTrueEnd: false,
        sourceState: testSourceState("root-after"),
      },
      { allowUncachedSegment: true },
    );
    expect(setCachedNodeSourceState).not.toHaveBeenCalled();
    expect(visibleSegmentsState.visibleSegments.has(13n)).toBe(true);
    expect(selectSegment).toHaveBeenCalledWith(13n, true);
    expect(selectSpatialSkeletonNode).toHaveBeenCalledWith(29, false, {
      segmentId: 13,
      position: new Float32Array([4, 5, 6]),
    });
    expect(moveViewToSpatialSkeletonNodePosition).toHaveBeenCalledWith(
      new Float32Array([4, 5, 6]),
    );
    expect(skeletonLayer.retainOverlaySegment).not.toHaveBeenCalled();
    expect(markSpatialSkeletonNodeDataChanged).toHaveBeenCalledWith({
      invalidateFullSkeletonCache: false,
    });
    expect(getFullSegmentNodes).not.toHaveBeenCalled();
  });

  it("blocks appending a child to a selected true-end node", () => {
    const getAddNodeBlockedReason = (SpatialSkeletonEditTool.prototype as any)
      .getAddNodeBlockedReason as (
      this: any,
      skeletonLayer: any,
      parentNodeId: number | undefined,
    ) => string | undefined;
    const getCachedNode = vi.fn((nodeId: number) =>
      nodeId === 17
        ? {
            nodeId: 17,
            segmentId: 11,
            position: new Float32Array([1, 2, 3]),
            isTrueEnd: true,
          }
        : undefined,
    );
    const getNode = vi.fn();
    const tool = {
      layer: {
        spatialSkeletonState: {
          getCachedNode,
        },
      },
      getSelectedParentNodeForAdd: (SpatialSkeletonEditTool.prototype as any)
        .getSelectedParentNodeForAdd,
    };

    expect(getAddNodeBlockedReason.call(tool, { getNode }, 17)).toBe(
      "Node 17 is marked as a true end. Clear the true end state before appending a child node.",
    );
    expect(getAddNodeBlockedReason.call(tool, { getNode }, 18)).toBe(undefined);
    expect(getAddNodeBlockedReason.call(tool, { getNode }, undefined)).toBe(
      undefined,
    );
    expect(getNode).toHaveBeenCalledTimes(1);
    expect(getNode).toHaveBeenCalledWith(18);
  });

  it("suppresses the deleted merge segment while keeping the surviving result selected", async () => {
    suppressStatusMessages();
    const firstNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 101,
      segmentId: 11,
      position: new Float32Array([1, 2, 3]),
      isTrueEnd: false,
      sourceState: testSourceState("first-before"),
    };
    const secondNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 202,
      segmentId: 17,
      position: new Float32Array([4, 5, 6]),
      isTrueEnd: false,
      sourceState: testSourceState("second-before"),
    };
    const mergeSkeletons = vi.fn().mockResolvedValue({
      resultSegmentId: 17,
      deletedSegmentId: 11,
      directionAdjusted: true,
    });
    const invalidateCachedSegments = vi.fn();
    const refreshCachedSegments = vi.fn(async () => true);
    const getFullSegmentNodes = vi.fn(async () => []);
    const selectSegment = vi.fn();
    const selectSpatialSkeletonNode = vi.fn();
    const markSpatialSkeletonNodeDataChanged = vi.fn();
    const clearSpatialSkeletonMergeAnchor = vi.fn();
    const deleteSegmentColor = vi.fn();
    const skeletonLayer = {
      source: makeEditableSkeletonSource({ mergeSkeletons }),
      getNode: vi.fn((nodeId: number) => {
        if (nodeId === firstNode.nodeId) return firstNode;
        if (nodeId === secondNode.nodeId) return secondNode;
        return undefined;
      }),
      markSegmentEdited: vi.fn(),
      retainOverlaySegment: vi.fn(),
      invalidateSourceCellsForPositions: vi.fn(),
    };
    const commandHistory = new SpatialSkeletonCommandHistory();
    const visibleSegmentsState = makeVisibleSegmentsState([11n, 17n]);
    const layer = {
      displayState: {
        segmentationGroupState: {
          value: visibleSegmentsState,
        },
        segmentStatedColors: {
          value: {
            delete: deleteSegmentColor,
          },
        },
      },
      spatialSkeletonState: {
        commandHistory,
        getCachedNode: vi.fn((nodeId: number) => {
          if (nodeId === firstNode.nodeId) return firstNode;
          if (nodeId === secondNode.nodeId) return secondNode;
          return undefined;
        }),
        getCachedSegmentNodes: vi.fn((segmentId: number) => {
          if (segmentId === firstNode.segmentId) return [firstNode];
          if (segmentId === secondNode.segmentId) return [secondNode];
          return undefined;
        }),
        getFullSegmentNodes,
        invalidateCachedSegments,
        // Post-merge topology refresh re-fetches the surviving segments in place rather than
        // dropping them from the cache; a truthy result means the cache changed.
        refreshCachedSegments,
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      selectSegment,
      selectSpatialSkeletonNode,
      markSpatialSkeletonNodeDataChanged,
      clearSpatialSkeletonMergeAnchor,
      manager: {
        root: {
          selectionState: {
            pin: {
              value: true,
            },
          },
        },
      },
    };

    await executeSpatialSkeletonMerge(
      layer as any,
      { nodeId: 101, segmentId: 11 },
      { nodeId: 202, segmentId: 17 },
    );

    expect(mergeSkeletons).toHaveBeenCalledWith(
      101,
      202,
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({ nodeId: 101 }),
          expect.objectContaining({ nodeId: 202 }),
        ]),
      }),
    );
    // The surviving and absorbed segments are re-fetched in place rather than dropped, so renderers
    // never observe a cache with them missing.
    expect(refreshCachedSegments).toHaveBeenCalledWith(
      skeletonLayer,
      [17, 11],
      { notify: false },
    );
    expect(invalidateCachedSegments).not.toHaveBeenCalled();
    expect(selectSegment).toHaveBeenCalledWith(17n, false);
    expect(selectSpatialSkeletonNode).toHaveBeenCalledWith(101, true, {
      segmentId: 17,
    });
    expect(deleteSegmentColor).toHaveBeenCalledWith(11n);
    expect(skeletonLayer.markSegmentEdited).toHaveBeenCalledWith(11);
    expect(markSpatialSkeletonNodeDataChanged).toHaveBeenCalledWith({
      invalidateFullSkeletonCache: false,
    });
    expect(visibleSegmentsState.visibleSegments.has(17n)).toBe(true);
    expect(visibleSegmentsState.visibleSegments.has(11n)).toBe(false);
    expect(
      skeletonLayer.invalidateSourceCellsForPositions,
    ).toHaveBeenCalledWith([firstNode.position, secondNode.position]);
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

  it("enters merge mode without selecting a node or setting an anchor", () => {
    suppressStatusMessages();
    const hoveredNode = {
      nodeId: 101,
      segmentId: 11,
      position: new Float32Array([1, 2, 3]),
      sourceState: testSourceState("hovered"),
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
    const skeletonLayer = {
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
        sourceState: hoveredNode.sourceState,
      },
      updateUnconditionally: vi.fn(() => true),
      active: true,
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
      { layer },
    );

    try {
      SpatialSkeletonEditTool.prototype.activate.call(tool, activation as any);

      // Fire the merge action (simulates pressing "m" while hovering node 101).
      actions.get(SKELETON_ENTER_MERGE_MODE)?.({});

      expect(layer.spatialSkeletonMergeMode.value).toBe(true);
      // Entering merge preserves the existing selection and only hides its highlight; the anchor is
      // set solely by the first in-mode pick, so hovering a node while pressing "m" must not select
      // it or anchor to it.
      expect(selectSpatialSkeletonNode).not.toHaveBeenCalled();
      expect(setSpatialSkeletonMergeAnchor).not.toHaveBeenCalled();
      expect(mergeAnchorNodeId.value).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it("arms split mode without splitting when the split action fires", () => {
    suppressStatusMessages();
    const hoveredNode = {
      nodeId: 77,
      segmentId: 11,
      position: new Float32Array([7, 8, 9]),
      sourceState: testSourceState("hovered"),
    };
    const splitExecute = vi.fn(async () => {});
    const splitSkeletonsCommand = makeCommandFactory(
      SpatialSkeletonActions.splitSkeletons,
      splitExecute,
    );
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
        sourceState: hoveredNode.sourceState,
      },
      updateUnconditionally: vi.fn(() => true),
      active: true,
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
      selectSegment,
      selectSpatialSkeletonNode,
      layersChanged: makeChangedSignal(),
    };
    const { activation, actions, dispose } = makeToolActivation();
    const tool = Object.assign(
      Object.create(SpatialSkeletonEditTool.prototype),
      { layer },
    );

    try {
      SpatialSkeletonEditTool.prototype.activate.call(tool, activation as any);

      // Fire the split action (simulates pressing "s" while hovering node 77).
      actions.get(SKELETON_ENTER_SPLIT_MODE)?.({});

      expect(layer.spatialSkeletonSplitMode.value).toBe(true);
      // The selected-node highlight stays hidden until the user clicks the node to split.
      expect(layer.spatialSkeletonSuppressSelectedNodeHighlight.value).toBe(
        true,
      );
      // Pressing "s" only arms split mode: the split itself runs on the in-mode pick, so nothing is
      // selected and no command is created yet.
      expect(selectSegment).not.toHaveBeenCalled();
      expect(selectSpatialSkeletonNode).not.toHaveBeenCalled();
      expect(splitSkeletonsCommand.createCommand).not.toHaveBeenCalled();
      expect(splitExecute).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  // Activates the edit tool over a single visible skeleton whose nodes are
  // all resolvable, and exposes the in-mode pick handler so tests can drive
  // insert mode without a rendered panel.
  function makeInsertToolHarness(nodes: SpatiallyIndexedSkeletonNode[]) {
    suppressStatusMessages();
    const insertExecute = vi.fn(async () => {});
    const insertNodesCommand = makeCommandFactory(
      SpatialSkeletonActions.insertNodes,
      insertExecute,
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
      pickingIndicatorSuppressed: false,
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
          selectionState: { value: undefined, changed: makeChangedSignal() },
          display: { panels: [] },
        },
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      getSpatialSkeletonActionsDisabledReason: vi.fn(() => undefined),
      selectSegment: vi.fn(),
      selectSpatialSkeletonNode,
      layersChanged: makeChangedSignal(),
    };
    const { activation, actions, dispose } = makeToolActivation();
    const tool = Object.assign(
      Object.create(SpatialSkeletonEditTool.prototype),
      { layer },
    );
    SpatialSkeletonEditTool.prototype.activate.call(tool, activation as any);
    const pickNode = async (node: SpatiallyIndexedSkeletonNode) => {
      mouseState.pickedSpatialSkeleton = node;
      tool.handleInsertPick();
      // Let the command execution promise chain settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return {
      actions,
      dispose,
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
      expect(harness.insertNodesCommand.createCommand).not.toHaveBeenCalled();
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
        expect(harness.insertNodesCommand.createCommand).toHaveBeenCalledWith(
          harness.layer,
          {
            skeletonId: 11,
            parentNodeId: 1,
            childNodeIds: [2],
            positionInModelSpace: new Float32Array([1, 2, 3]),
          },
        );
        // After the insert the mode is re-armed for the next pair.
        expect(harness.tool.insertFirstNode).toBeUndefined();
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
      expect(harness.tool.insertFirstNode).toBeUndefined();
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

      expect(harness.insertNodesCommand.createCommand).not.toHaveBeenCalled();
      expect(showTemporaryMessage).toHaveBeenCalledWith(
        expect.stringContaining("Node 3 is not connected to node 1"),
      );
      expect(harness.tool.insertFirstNode).toBe(rootNode);

      // A connected neighbour of the retained first pick completes the insert.
      await harness.pickNode(middleNode);
      expect(harness.insertNodesCommand.createCommand).toHaveBeenCalledWith(
        harness.layer,
        expect.objectContaining({ parentNodeId: 1, childNodeIds: [2] }),
      );
    } finally {
      harness.dispose();
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
      const status = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".neuroglancer-skeleton-find-path-message",
        ),
      ).at(-1);
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

      const clearButton = Array.from(
        document.querySelectorAll<HTMLElement>('[title="Clear Find Path"]'),
      ).at(-1);
      expect(clearButton).toBeDefined();
      clearButton?.click();

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
      { layer },
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
});
