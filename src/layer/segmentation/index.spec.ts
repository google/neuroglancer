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

import { emptyInvalidCoordinateSpace } from "#src/coordinate_transform.js";
import { SkeletonEdgeDirection } from "#src/skeleton/api.js";
import { SpatialSkeletonActions } from "#src/skeleton/command_protocol.js";
import { SkeletonOverlaySegments } from "#src/skeleton/spatial/overlay_segments.js";
import { WatchableValue } from "#src/trackable_value.js";
import { NullarySignal } from "#src/util/signal.js";
import { DependentViewWidget } from "#src/widget/dependent_view_widget.js";

const segmentationDisplayStateCallbacks = vi.hoisted(
  () => new Set<() => void>(),
);

vi.mock(
  "#src/segmentation_display_state/frontend.js",
  async (importOriginal) => {
    const original = await importOriginal<Record<string, unknown>>();
    return {
      ...original,
      makeSegmentWidget: (_displayState: unknown, id: { key: bigint }) => {
        const row = document.createElement("div");
        row.textContent = `segment ${id.key}`;
        return row;
      },
      bindSegmentListWidth: () => () => {},
      getBaseObjectColor: () => new Float32Array([0.2, 0.4, 0.6, 1]),
      registerCallbackWhenSegmentationDisplayStateChanged: (
        _displayState: unknown,
        context: { registerDisposer(disposer: () => void): void },
        callback: () => void,
      ) => {
        segmentationDisplayStateCallbacks.add(callback);
        context.registerDisposer(() =>
          segmentationDisplayStateCallbacks.delete(callback),
        );
      },
    };
  },
);

// The layer module reads WebGL constants when it loads.
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

const { SegmentationUserLayer } = await import(
  "#src/layer/segmentation/index.js"
);
const { SkeletonNodeSelection } = await import(
  "#src/layer/segmentation/selection.js"
);
const { SkeletonSourceConnection } = await import(
  "#src/layer/segmentation/skeleton_source_connection.js"
);
const { MultiscaleSpatiallyIndexedSkeletonSource } = await import(
  "#src/skeleton/spatial/frontend.js"
);
const { LocalDataSource } = await import("#src/datasource/local.js");
const { LocalSegmentationGraphSource } = await import(
  "#src/segmentation_graph/local.js"
);
const { SharedDisjointUint64Sets } = await import(
  "#src/shared_disjoint_sets.js"
);
const { Uint64Set } = await import("#src/uint64_set.js");
const { Uint64OrderedSet } = await import("#src/uint64_ordered_set.js");
const { SelectionDetailsPanel } = await import("#src/ui/selection_details.js");
const { executeSpatialSkeletonAddNode } = await import(
  "#src/skeleton/commands.js"
);
const { RefCounted } = await import("#src/util/disposable.js");
const { StatusMessage } = await import("#src/status.js");
const { TrackableDataSelectionState } = await import("#src/layer/index.js");
const { SpatialSkeletonState } = await import(
  "#src/skeleton/spatial_skeleton_manager.js"
);
const { CatmaidSpatialSkeletonEditCommands } = await import(
  "#src/datasource/catmaid/spatial_skeleton_commands.js"
);

function makeSkeletonSourceConnection(
  spatialSkeletonState: InstanceType<typeof SpatialSkeletonState>,
) {
  return new SkeletonSourceConnection({
    spatialSkeletonState,
    selection: {} as any,
    overlaySegments: new SkeletonOverlaySegments({
      segmentationGroupState: new WatchableValue({} as any),
      editState: spatialSkeletonState,
    }),
    segmentationGroupState: new WatchableValue({} as any),
    skeletonNodeAccess: new WatchableValue(undefined),
    spatiallyIndexedSkeletonLayer: new WatchableValue(undefined),
  });
}

function makeSelectionHookLayer() {
  const renderLayer = {};
  const layer = Object.create(SegmentationUserLayer.prototype);
  const layerSelectedValues = {
    changed: new NullarySignal(),
    mouseState: { active: false },
  };
  const selectionState = new TrackableDataSelectionState(
    new WatchableValue(emptyInvalidCoordinateSpace),
    layerSelectedValues as any,
  );
  Object.defineProperties(layer, {
    localCoordinateSpace: { value: { value: { rank: 0 } } },
    localPosition: { value: { value: new Float32Array(0) } },
    renderLayers: { value: [renderLayer] },
    getValueAt: { value: () => 7n },
    manager: { value: { layerSelectedValues, root: { selectionState } } },
  });
  layer.skeletonNodeSelection = new SkeletonNodeSelection({
    layer,
    skeletonNodeAccess: new WatchableValue(undefined),
    spatiallyIndexedSkeletonLayer: new WatchableValue(undefined),
    spatialSkeletonState: new SpatialSkeletonState(),
  });
  return { layer, renderLayer };
}

function makeEditableSpatialSkeletonSource(
  options: {
    rerootCommand?: boolean;
  } = {},
) {
  const createCommand = () => ({
    label: "test command",
    execute: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
  });
  const makeCommand = (action: string) => ({
    action,
    createCommand,
  });
  return {
    optimisticEditing: {
      createDriver: vi.fn(),
    },
    addNodesCommand: makeCommand(SpatialSkeletonActions.addNodes),
    moveNodesCommand: makeCommand(SpatialSkeletonActions.moveNodes),
    deleteNodesCommand: makeCommand(SpatialSkeletonActions.deleteNodes),
    editNodeDescriptionCommand: makeCommand(
      SpatialSkeletonActions.editNodeDescription,
    ),
    editNodeTrueEndCommand: makeCommand(SpatialSkeletonActions.editNodeTrueEnd),
    editNodeRadiusCommand: makeCommand(SpatialSkeletonActions.editNodeRadius),
    editNodeConfidenceCommand: makeCommand(
      SpatialSkeletonActions.editNodeConfidence,
    ),
    mergeSkeletonsCommand: makeCommand(SpatialSkeletonActions.mergeSkeletons),
    splitSkeletonsCommand: makeCommand(SpatialSkeletonActions.splitSkeletons),
    edgeDirection: SkeletonEdgeDirection.CHILD_TO_PARENT,
    getSkeletonManifest: async () => ({ fragmentKeys: [] }),
    getSkeletonFragment: async () => ({ nodes: [], edges: [] }),
    ...(options.rerootCommand !== true
      ? {}
      : {
          rerootCommand: makeCommand(SpatialSkeletonActions.reroot),
        }),
  };
}

describe("layer/segmentation spatial skeleton source teardown", () => {
  function makeActivatingSegmentationLayer() {
    const spatialSkeletonState = new SpatialSkeletonState();
    const layer = Object.assign(
      Object.create(SegmentationUserLayer.prototype),
      {
        spatialSkeletonState,
        displayState: {
          linkedSegmentationGroup: { root: { value: undefined } },
          segmentationGroupState: { value: {} },
          originalSegmentationGroupState: {
            segmentPropertyMap: new WatchableValue(undefined),
            graph: new WatchableValue(undefined),
          },
          hasVolume: new WatchableValue(false),
        },
      },
    );
    layer.skeletonSourceConnection =
      makeSkeletonSourceConnection(spatialSkeletonState);
    Object.defineProperty(layer, "manager", {
      value: { chunkManager: { memoize: { getUncounted: () => undefined } } },
    });
    return { layer, spatialSkeletonState };
  }

  function makeSpatialSkeletonSubsource() {
    return {
      subsourceEntry: {
        subsource: {
          spatialSkeleton: Object.create(
            MultiscaleSpatiallyIndexedSkeletonSource.prototype,
          ),
        },
      },
      loadedDataSource: { dataSource: { state: undefined } },
      activate: vi.fn(),
      deactivate: vi.fn(),
    };
  }

  it("clears edit state when the skeleton source is replaced or removed", () => {
    const { layer, spatialSkeletonState } = makeActivatingSegmentationLayer();
    const original = makeSpatialSkeletonSubsource();
    const replacement = makeSpatialSkeletonSubsource();
    layer.activateDataSubsources([original]);
    spatialSkeletonState.editMode.value = true;
    spatialSkeletonState.setMergeAnchor(5n);

    const { commandHistory } = spatialSkeletonState;
    commandHistory.confirm(commandHistory.stageExecute("add node"));

    layer.activateDataSubsources([replacement]);
    expect(spatialSkeletonState.editMode.value).toBe(false);
    expect(spatialSkeletonState.mergeAnchorNodeId.value).toBeUndefined();
    expect(commandHistory.canUndo.value).toBe(false);

    spatialSkeletonState.editMode.value = true;
    spatialSkeletonState.setMergeAnchor(6n);
    layer.activateDataSubsources([]);
    expect(spatialSkeletonState.editMode.value).toBe(false);
    expect(spatialSkeletonState.mergeAnchorNodeId.value).toBeUndefined();
  });

  it("keeps edit mode, merge anchor, edit queue and undo history when the same skeleton source is activated again", () => {
    const { layer, spatialSkeletonState } = makeActivatingSegmentationLayer();
    const subsource = makeSpatialSkeletonSubsource();
    layer.activateDataSubsources([subsource]);
    spatialSkeletonState.editMode.value = true;
    spatialSkeletonState.setMergeAnchor(5n);
    (spatialSkeletonState as any).optimisticEditQueue = {
      hasUnconfirmedActions: () => true,
      dispose: async () => {},
    };
    const { commandHistory } = spatialSkeletonState;
    commandHistory.confirm(commandHistory.stageExecute("add node"));

    layer.activateDataSubsources([subsource]);

    expect(spatialSkeletonState.editMode.value).toBe(true);
    expect(spatialSkeletonState.mergeAnchorNodeId.value).toBe(5n);
    expect(spatialSkeletonState.hasUnconfirmedOptimisticEdits()).toBe(true);
    expect(commandHistory.undoLabel.value).toBe("add node");
  });
});

describe("layer/segmentation spatial skeleton selection state", () => {
  it("a saved node selection keeps both the node and its skeleton", () => {
    const { layer } = makeSelectionHookLayer();
    const state: any = {};
    layer.initializeSelectionState(state);

    layer.selectionStateFromJson(state, { nodeId: "23", value: "7" });

    expect(state.nodeId).toBe(23n);
    expect(state.value).toBe(7n);
    expect(layer.selectionStateToJson(state, false)).toEqual({
      nodeId: "23",
      value: "7",
    });
    const copiedState: any = {};
    layer.initializeSelectionState(copiedState);
    layer.copySelectionState(copiedState, state);
    expect(copiedState.nodeId).toBe(23n);
    expect(copiedState.value).toBe(7n);
  });

  it("ignores legacy spatial skeleton selection keys", () => {
    const { layer } = makeSelectionHookLayer();
    const state: any = {};
    layer.initializeSelectionState(state);

    layer.selectionStateFromJson(state, {
      spatialSkeletonNodeId: "23",
      spatialSkeletonSegmentId: "7",
    });

    expect(state.nodeId).toBeUndefined();
    expect(state.value).toBeUndefined();
    expect(layer.selectionStateToJson(state, false)).toEqual({});
  });

  it("clicking a skeleton node selects the node and its skeleton, not the voxel below it", () => {
    const { layer, renderLayer } = makeSelectionHookLayer();
    const state: any = {};
    layer.initializeSelectionState(state);

    layer.captureSelectionState(state, {
      active: true,
      position: new Float32Array(0),
      pickedRenderLayer: renderLayer,
      pickedSpatialSkeleton: { nodeId: 31n, segmentId: 9n },
    } as any);

    expect(state.nodeId).toBe(31n);
    expect(state.value).toBe(9n);
  });

  it("a node picked in another layer's skeleton leaves the voxel selection", () => {
    const { layer } = makeSelectionHookLayer();
    const state: any = {};
    layer.initializeSelectionState(state);

    layer.captureSelectionState(state, {
      active: true,
      position: new Float32Array(0),
      pickedRenderLayer: {},
      pickedSpatialSkeleton: { nodeId: 31n, segmentId: 9n },
    } as any);

    expect(state.nodeId).toBeUndefined();
    expect(state.value).toBe(7n);
  });
});

function makeEquivalencesLayer(savedEquivalences: string[][]) {
  const layer = Object.create(SegmentationUserLayer.prototype);
  const localGraph = new LocalSegmentationGraphSource();
  localGraph.restoreState(savedEquivalences);
  const groupState = {
    localGraph,
    graph: new WatchableValue(undefined),
    segmentPropertyMap: new WatchableValue(undefined),
    segmentEquivalences: new SharedDisjointUint64Sets(),
    visibleSegments: new Uint64Set(),
  };
  Object.defineProperty(layer, "manager", {
    value: { chunkManager: { memoize: { getUncounted: () => undefined } } },
  });
  Object.assign(layer, {
    displayState: {
      linkedSegmentationGroup: { root: { value: layer } },
      originalSegmentationGroupState: groupState,
      segmentationGroupState: { value: groupState },
      hasVolume: new WatchableValue(false),
    },
    graphConnection: new WatchableValue(undefined),
    skeletonSourceConnection: makeSkeletonSourceConnection(
      new SpatialSkeletonState(),
    ),
  });
  return { layer, groupState };
}

function makeLinkedLayer(rootEquivalences: [bigint, bigint][]) {
  const { layer, groupState } = makeEquivalencesLayer([]);
  const { groupState: rootGroupState } = makeEquivalencesLayer([]);
  for (const [firstSegment, secondSegment] of rootEquivalences) {
    rootGroupState.segmentEquivalences.link(firstSegment, secondSegment);
  }
  const root = { value: { managedLayer: { name: "merged" } } as unknown };
  layer.managedLayer = { name: "catmaid" };
  layer.displayState.segmentationGroupState.value = rootGroupState;
  layer.displayState.linkedSegmentationGroup = {
    root,
    isolate: () => {
      root.value = layer;
      layer.displayState.segmentationGroupState.value = groupState;
    },
  };
  return { layer, root };
}

function makeLoadedSubsource(subsource: object) {
  return {
    subsourceEntry: { subsource },
    loadedDataSource: { dataSource: { state: undefined } },
    activated: undefined as InstanceType<typeof RefCounted> | undefined,
    errorMessage: undefined as string | undefined,
    activate(callback: (refCounted: InstanceType<typeof RefCounted>) => void) {
      this.errorMessage = undefined;
      if (this.activated !== undefined) return;
      this.activated = new RefCounted();
      callback(this.activated);
    },
    deactivate(message: string) {
      this.errorMessage = message;
      this.activated?.dispose();
      this.activated = undefined;
    },
  };
}

function makeEquivalencesSubsource() {
  return makeLoadedSubsource({ local: LocalDataSource.equivalences });
}

function makeSkeletonSubsource(editableSource: unknown) {
  const spatialSkeleton = Object.create(
    MultiscaleSpatiallyIndexedSkeletonSource.prototype,
  );
  Object.defineProperty(spatialSkeleton, "editableSource", {
    value: editableSource,
  });
  return { ...makeLoadedSubsource({ spatialSkeleton }), activate: vi.fn() };
}

describe("layer/segmentation equivalences with editable skeletons", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("turns off equivalences when the layer has an editable skeleton source", () => {
    const { layer, groupState } = makeEquivalencesLayer([["3", "7"]]);
    const equivalences = makeEquivalencesSubsource();

    layer.activateDataSubsources([
      equivalences,
      makeSkeletonSubsource(makeEditableSpatialSkeletonSource()),
    ]);

    expect(groupState.segmentEquivalences.get(7n)).toBe(7n);
    expect(groupState.graph.value).toBeUndefined();
    expect(equivalences.errorMessage).toBe(
      "Not supported with editable skeletons",
    );
  });

  it("removes merges that were applied before the editable skeleton source loaded", () => {
    const { layer, groupState } = makeEquivalencesLayer([["3", "7"]]);
    const equivalences = makeEquivalencesSubsource();
    layer.activateDataSubsources([equivalences]);
    expect(groupState.segmentEquivalences.get(7n)).toBe(3n);

    layer.activateDataSubsources([
      equivalences,
      makeSkeletonSubsource(makeEditableSpatialSkeletonSource()),
    ]);

    expect(groupState.segmentEquivalences.get(7n)).toBe(7n);
  });

  it("removes merges that a linked layer left behind", () => {
    const { layer, groupState } = makeEquivalencesLayer([]);
    groupState.segmentEquivalences.link(3n, 7n);

    layer.activateDataSubsources([
      makeSkeletonSubsource(makeEditableSpatialSkeletonSource()),
    ]);

    expect(groupState.segmentEquivalences.get(7n)).toBe(7n);
  });

  it("keeps equivalences for a skeleton source that cannot be edited", () => {
    const { layer, groupState } = makeEquivalencesLayer([["3", "7"]]);

    layer.activateDataSubsources([
      makeEquivalencesSubsource(),
      makeSkeletonSubsource(undefined),
    ]);

    expect(groupState.segmentEquivalences.get(7n)).toBe(3n);
  });

  it("keeps the saved equivalences while they are turned off", () => {
    const { layer, groupState } = makeEquivalencesLayer([["3", "7"]]);
    const equivalences = makeEquivalencesSubsource();
    layer.activateDataSubsources([equivalences]);

    layer.activateDataSubsources([
      equivalences,
      makeSkeletonSubsource(makeEditableSpatialSkeletonSource()),
    ]);

    expect(groupState.localGraph.toJSON()).toEqual([["3", "7"]]);
  });

  it("unlinks a layer with editable skeletons from a layer that has equivalences", () => {
    const showMessage = vi
      .spyOn(StatusMessage, "showTemporaryMessage")
      .mockImplementation(() => ({}) as any);
    const { layer, root } = makeLinkedLayer([[3n, 7n]]);

    layer.activateDataSubsources([
      makeSkeletonSubsource(makeEditableSpatialSkeletonSource()),
    ]);

    expect(root.value).toBe(layer);
    expect(showMessage).toHaveBeenCalledWith(
      "Unlinked catmaid from merged: layers with editable skeletons do not support equivalences.",
    );
  });

  it("keeps a layer with editable skeletons linked to a layer without equivalences", () => {
    const { layer, root } = makeLinkedLayer([]);
    const linkedRoot = root.value;

    layer.activateDataSubsources([
      makeSkeletonSubsource(makeEditableSpatialSkeletonSource()),
    ]);

    expect(root.value).toBe(linkedRoot);
  });

  it("keeps a layer without editable skeletons linked to a layer with equivalences", () => {
    const { layer, root } = makeLinkedLayer([[3n, 7n]]);
    const linkedRoot = root.value;

    layer.activateDataSubsources([makeSkeletonSubsource(undefined)]);

    expect(root.value).toBe(linkedRoot);
  });
});

describe("layer/segmentation selection details", () => {
  function makeDetailsHostLayer() {
    const layer = Object.create(SegmentationUserLayer.prototype);
    const layerSelectedValues = {
      changed: new NullarySignal(),
      mouseState: { active: false },
    };
    const selectionState = new TrackableDataSelectionState(
      new WatchableValue(emptyInvalidCoordinateSpace),
      layerSelectedValues as any,
    );
    const spatialSkeletonState = new SpatialSkeletonState();
    const commands = new CatmaidSpatialSkeletonEditCommands({
      getClient: () => ({}) as any,
    });
    const skeletonNodeAccess = new WatchableValue<any>({
      getSegmentNodes: () => [],
      parentsInferred: false,
      nodesChanged: new NullarySignal(),
      hasPickableNodes: false,
      displayState: { transform: new WatchableValue(undefined) },
    });
    const spatiallyIndexedSkeletonLayer = new WatchableValue<any>({
      editableSource: {
        optimisticEditing: commands.optimisticEditing,
        editNodeRadiusCommand: commands.editNodeRadiusCommand,
      },
      getNode: () => undefined,
    });
    Object.defineProperties(layer, {
      manager: {
        value: {
          layerSelectedValues,
          root: {
            selectionState,
            globalPosition: new WatchableValue(new Float32Array(3)),
          },
        },
      },
      renderLayers: { value: [] },
      displayState: {
        value: {
          segmentationGroupState: {
            value: {
              segmentEquivalences: { get: (id: bigint) => id },
              segmentPropertyMap: { value: undefined },
            },
          },
        },
      },
    });
    const skeletonNodeSelection = new SkeletonNodeSelection({
      layer,
      skeletonNodeAccess,
      spatiallyIndexedSkeletonLayer,
      spatialSkeletonState,
    });
    Object.assign(layer, {
      spatialSkeletonState,
      skeletonNodeAccess,
      skeletonNodeSelection,
      skeletonSourceConnection: new SkeletonSourceConnection({
        spatialSkeletonState,
        selection: skeletonNodeSelection,
        overlaySegments: new SkeletonOverlaySegments({
          segmentationGroupState: new WatchableValue({} as any),
          editState: spatialSkeletonState,
        }),
        segmentationGroupState: new WatchableValue({} as any),
        skeletonNodeAccess,
        spatiallyIndexedSkeletonLayer,
      }),
    });
    return { layer, spatialSkeletonState };
  }

  it("keeps a radius being typed while the hovered segment changes", async () => {
    const { layer, spatialSkeletonState } = makeDetailsHostLayer();
    spatialSkeletonState.replaceCachedSegmentSnapshots([
      [
        5n,
        [
          {
            nodeId: 1n,
            segmentId: 5n,
            position: new Float32Array([1, 2, 3]),
            attributes: { radius: [2] },
          },
        ],
      ],
    ]);
    const state: any = {};
    layer.initializeSelectionState(state);
    state.nodeId = 1n;
    state.value = 5n;
    const panel = new DependentViewWidget(
      { value: undefined, changed: new NullarySignal() },
      (_, parent, context) => {
        layer.displaySelectionState(state, parent, context);
      },
    );
    document.body.appendChild(panel.element);
    const radius = [
      ...panel.element.querySelectorAll(".neuroglancer-annotation-property"),
    ].find((row) => row.firstElementChild?.textContent === "Radius")!
      .lastElementChild!.firstElementChild as HTMLInputElement;
    radius.focus();
    radius.value = "7";
    radius.dispatchEvent(new Event("input"));

    for (const callback of segmentationDisplayStateCallbacks) callback();
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(radius.isConnected).toBe(true);
    expect(radius.value).toBe("7");
    expect(document.activeElement).toBe(radius);
    panel.dispose();
    panel.element.remove();
  });

  function makeCreatingHostLayer() {
    const layer = Object.create(SegmentationUserLayer.prototype);
    const layerSelectedValues = {
      changed: new NullarySignal(),
      mouseState: { active: false },
    };
    const selectionState = new TrackableDataSelectionState(
      new WatchableValue(emptyInvalidCoordinateSpace),
      layerSelectedValues as any,
    );
    selectionState.location.visible = true;
    const spatialSkeletonState = new SpatialSkeletonState();
    let confirmCreation:
      | ((created: { nodeId: bigint; segmentId: bigint }) => void)
      | undefined;
    const client = {
      baseUrl: "https://catmaid.example.test",
      projectId: 1,
      addNode: vi.fn(
        () =>
          new Promise<{ nodeId: bigint; segmentId: bigint }>((resolve) => {
            confirmCreation = resolve;
          }),
      ),
      updateDescription: vi.fn(),
    };
    const commands = new CatmaidSpatialSkeletonEditCommands({
      getClient: () => client as any,
    });
    const source = {
      optimisticEditing: commands.optimisticEditing,
      addNodesCommand: commands.addNodesCommand,
      editNodeDescriptionCommand: commands.editNodeDescriptionCommand,
      edgeDirection: SkeletonEdgeDirection.CHILD_TO_PARENT,
      getSkeletonManifest: async () => ({ fragmentKeys: [] }),
      getSkeletonFragment: async () => ({ nodes: [], edges: [] }),
    };
    const skeletonNodeAccess = new WatchableValue<any>({
      getSegmentNodes: () => [],
      parentsInferred: false,
      nodesChanged: new NullarySignal(),
      hasPickableNodes: false,
      displayState: { transform: new WatchableValue(undefined) },
    });
    const spatiallyIndexedSkeletonLayer = new WatchableValue<any>({
      fragmentSource: source,
      editableSource: source,
      getNode: (nodeId: bigint) => spatialSkeletonState.getCachedNode(nodeId),
      remapOverlaySegments: vi.fn(),
      retainOverlaySegment: vi.fn(),
    });
    const segmentationGroupState = new WatchableValue<any>({
      visibleSegments: new Uint64Set(),
      temporaryVisibleSegments: new Uint64Set(),
      selectedSegments: new Uint64OrderedSet(),
      segmentEquivalences: { get: (id: bigint) => id },
      segmentPropertyMap: { value: undefined },
    });
    Object.defineProperties(layer, {
      manager: {
        value: {
          layerSelectedValues,
          root: {
            selectionState,
            globalPosition: new WatchableValue(new Float32Array(3)),
          },
        },
      },
      managedLayer: {
        value: { layerChanged: new NullarySignal(), name: "skeletons" },
      },
      isReady: { value: true },
      wasDisposed: { value: false },
      renderLayers: { value: [] },
      displayState: { value: { segmentationGroupState } },
    });
    const skeletonNodeSelection = new SkeletonNodeSelection({
      layer,
      skeletonNodeAccess,
      spatiallyIndexedSkeletonLayer,
      spatialSkeletonState,
    });
    Object.assign(layer, {
      spatialSkeletonState,
      skeletonNodeAccess,
      skeletonNodeSelection,
      skeletonSourceConnection: new SkeletonSourceConnection({
        spatialSkeletonState,
        selection: skeletonNodeSelection,
        overlaySegments: new SkeletonOverlaySegments({
          segmentationGroupState: segmentationGroupState,
          editState: spatialSkeletonState,
        }),
        segmentationGroupState,
        skeletonNodeAccess,
        spatiallyIndexedSkeletonLayer,
      }),
    });
    const panel = new SelectionDetailsPanel(
      {} as any,
      selectionState,
      { globalPosition: new WatchableValue(new Float32Array(3)) } as any,
      {} as any,
    );
    document.body.appendChild(panel.element);
    return {
      layer,
      panel,
      client,
      spatialSkeletonState,
      confirmCreation: (created: { nodeId: bigint; segmentId: bigint }) =>
        confirmCreation!(created),
    };
  }

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(resolve));
  }

  it("labels a new skeleton and node as Preview, without their provisional IDs, until the server confirms them", async () => {
    const { layer, panel, spatialSkeletonState, confirmCreation } =
      makeCreatingHostLayer();
    await executeSpatialSkeletonAddNode(layer.skeletonSourceConnection, {
      skeletonId: 0n,
      parentNodeId: undefined,
      positionInModelSpace: new Float32Array([1, 2, 3]),
    });
    const [provisionalNodeId] =
      spatialSkeletonState.spatialSkeletonPresentation.value.provisionalNodeIds;
    layer.skeletonNodeSelection.select(provisionalNodeId, true);
    await nextFrame();
    await nextFrame();
    const provisionalSegmentId =
      layer.skeletonNodeSelection.selected.value!.segmentId!;

    expect(panel.element.textContent).toContain("Segment IDPreview");
    expect(panel.element.textContent).toContain("Node IDPreview");
    expect(panel.element.textContent).not.toContain(`${provisionalSegmentId}`);
    expect(panel.element.textContent).not.toContain(`${provisionalNodeId}`);

    confirmCreation({ nodeId: 501n, segmentId: 77n });
    await vi.waitFor(() =>
      expect(layer.skeletonNodeSelection.selected.value?.nodeId).toBe(501n),
    );
    await nextFrame();
    await nextFrame();
    expect(panel.element.textContent).toContain("segment 77");
    expect(panel.element.textContent).toContain("Segment ID77");
    expect(panel.element.textContent).toContain("Node ID501");
    panel.dispose();
    panel.element.remove();
    spatialSkeletonState.dispose();
  });

  it("labels a selected new skeleton as Preview, without its provisional ID, until the server confirms it", async () => {
    const { layer, panel, spatialSkeletonState, confirmCreation } =
      makeCreatingHostLayer();
    await executeSpatialSkeletonAddNode(layer.skeletonSourceConnection, {
      skeletonId: 0n,
      parentNodeId: undefined,
      positionInModelSpace: new Float32Array([1, 2, 3]),
    });
    const [provisionalNodeId] =
      spatialSkeletonState.spatialSkeletonPresentation.value.provisionalNodeIds;
    const provisionalSegmentId =
      spatialSkeletonState.getCachedNode(provisionalNodeId)!.segmentId;
    layer.manager.root.selectionState.captureSingleLayerState(
      layer,
      (state: { value?: bigint }) => {
        state.value = provisionalSegmentId;
        return true;
      },
      true,
    );
    await nextFrame();
    await nextFrame();

    expect(panel.element.textContent).toContain("Segment IDPreview");
    expect(panel.element.textContent).not.toContain(`${provisionalSegmentId}`);

    confirmCreation({ nodeId: 501n, segmentId: 77n });
    await vi.waitFor(() =>
      expect(panel.element.textContent).toContain("segment 77"),
    );
    expect(panel.element.textContent).not.toContain("Preview");
    panel.dispose();
    panel.element.remove();
    spatialSkeletonState.dispose();
  });

  it("keeps a description being typed when the server gives its new node a permanent ID", async () => {
    const { layer, panel, client, spatialSkeletonState, confirmCreation } =
      makeCreatingHostLayer();
    await executeSpatialSkeletonAddNode(layer.skeletonSourceConnection, {
      skeletonId: 0n,
      parentNodeId: undefined,
      positionInModelSpace: new Float32Array([1, 2, 3]),
    });
    const [provisionalNodeId] =
      spatialSkeletonState.spatialSkeletonPresentation.value.provisionalNodeIds;
    layer.skeletonNodeSelection.select(provisionalNodeId, true);
    await nextFrame();
    const description = panel.element.querySelector("textarea")!;
    description.focus();
    description.value = "unfinished draft";
    description.dispatchEvent(new Event("input"));
    description.setSelectionRange(3, 3);

    confirmCreation({ nodeId: 501n, segmentId: 77n });
    await vi.waitFor(() =>
      expect(layer.skeletonNodeSelection.selected.value?.nodeId).toBe(501n),
    );
    await nextFrame();

    expect(description.isConnected).toBe(true);
    expect(document.activeElement).toBe(description);
    expect(description.value).toBe("unfinished draft");
    expect(description.selectionStart).toBe(3);
    expect(client.updateDescription).not.toHaveBeenCalled();
    expect(panel.element.textContent).toContain("Node ID501");
    description.blur();
    panel.dispose();
    panel.element.remove();
    spatialSkeletonState.dispose();
  });
});
