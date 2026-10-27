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
import type {
  LayerSelectedValues,
  MouseSelectionState,
  UserLayer,
  UserLayerSelectionState,
} from "#src/layer/index.js";
import { TrackableDataSelectionState } from "#src/layer/index.js";
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import {
  getSegmentIdFromLayerSelectionValue,
  SkeletonHoverState,
  SkeletonNodeSelection,
} from "#src/layer/segmentation/skeleton_node_selection.js";
import type { RenderLayerTransform } from "#src/render_coordinate_transform.js";
import { Uint64MapEntry } from "#src/segmentation_display_state/base.js";
import type { SkeletonNode } from "#src/skeleton/api.js";
import { SpatialSkeletonEditSession } from "#src/skeleton/edit/spatial_skeleton_edit_session.js";
import {
  SkeletonNavigation,
  type SkeletonNodeAccess,
} from "#src/skeleton/skeleton_navigator.js";
import type { SpatiallyIndexedSkeletonLayer } from "#src/skeleton/spatial/skeleton_render_layer.js";
import { StatusMessage } from "#src/status.js";
import { WatchableValue } from "#src/trackable_value.js";
import { NullarySignal } from "#src/util/signal.js";

describe("segment selection", () => {
  it("reads the segment of a clicked segment that has a label", () => {
    expect(
      getSegmentIdFromLayerSelectionValue({
        value: new Uint64MapEntry(7n, undefined, "axon"),
      }),
    ).toBe(7n);
  });

  it("reads the merged segment of a clicked segment that has an equivalence", () => {
    expect(
      getSegmentIdFromLayerSelectionValue({
        value: new Uint64MapEntry(7n, 3n),
      }),
    ).toBe(3n);
  });

  it("extracts the hovered node id only for matching render layers", () => {
    // Create mock state, layers, and signal handlers
    const renderLayerA = {};
    const renderLayerB = {};
    const layer = { renderLayers: [renderLayerA] };
    let mouseState: {
      active: boolean;
      pickedRenderLayer: unknown;
      pickedSpatialSkeleton?: { nodeId?: unknown; segmentId?: unknown };
    } = {
      active: false,
      pickedRenderLayer: null,
      pickedSpatialSkeleton: undefined,
    };
    const handlers: Array<() => void> = [];
    const layerSelectedValues = {
      changed: {
        add: (cb: () => void) => {
          handlers.push(cb);
          return () => true as boolean;
        },
      },
      get mouseState() {
        return mouseState;
      },
    };
    const hoverState = new SkeletonHoverState();
    hoverState.bindTo(
      layerSelectedValues as LayerSelectedValues,
      layer as SegmentationUserLayer,
    );
    const trigger = () => handlers.forEach((h) => h());

    // A node id alone is not a usable hover: consumers derive the outline colour from the hovered
    // segment, so both ids have to resolve before a hover is reported.
    mouseState = {
      active: true,
      pickedRenderLayer: renderLayerA,
      pickedSpatialSkeleton: { nodeId: 31n },
    };
    trigger();
    expect(hoverState.value).toBeUndefined();

    mouseState = {
      active: true,
      pickedRenderLayer: renderLayerA,
      pickedSpatialSkeleton: { nodeId: 31n, segmentId: 7n },
    };
    trigger();
    expect(hoverState.value).toEqual({ nodeId: 31n, segmentId: 7n });

    mouseState = {
      active: true,
      pickedRenderLayer: renderLayerB,
      pickedSpatialSkeleton: { nodeId: 31n },
    };
    trigger();
    expect(hoverState.value).toBeUndefined();

    mouseState = {
      active: false,
      pickedRenderLayer: renderLayerA,
      pickedSpatialSkeleton: { nodeId: 31n },
    };
    trigger();
    expect(hoverState.value).toBeUndefined();

    mouseState = {
      active: true,
      pickedRenderLayer: renderLayerA,
      pickedSpatialSkeleton: { nodeId: 0n },
    };
    trigger();
    expect(hoverState.value).toBeUndefined();

    hoverState.dispose();
  });
});

function makeIdentityTransform() {
  return {
    rank: 3,
    modelToRenderLayerTransform: new Float32Array([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]),
    globalToRenderLayerDimensions: [0, 1, 2],
    error: undefined,
  } as unknown as RenderLayerTransform;
}

function makeSelectionHarness(
  options: { loadedNodes?: readonly SkeletonNode[] } = {},
) {
  const loadedNodes = options.loadedNodes ?? [];
  const layerSelectedValues = {
    changed: new NullarySignal(),
    mouseState: { active: false },
  } as unknown as LayerSelectedValues;
  const selectionState = new TrackableDataSelectionState(
    new WatchableValue(emptyInvalidCoordinateSpace),
    layerSelectedValues,
  );
  selectionState.location.visible = true;
  const setLayerPosition = vi.fn();
  const renderLayer = {};
  const layer = {
    manager: {
      layerSelectedValues,
      root: {
        selectionState,
        globalPosition: new WatchableValue(new Float32Array(3)),
      },
    },
    renderLayers: [renderLayer],
    initializeSelectionState(state: UserLayerSelectionState) {
      state.value = undefined;
      (state as { nodeId?: bigint }).nodeId = undefined;
    },
    setLayerPosition,
  } as unknown as UserLayer;
  const skeletonNodeAccess = new WatchableValue<SkeletonNodeAccess | undefined>(
    {
      getSegmentNodes: (segmentId) =>
        loadedNodes.filter((node) => node.segmentId === segmentId),
      parentsInferred: false,
      nodesChanged: new NullarySignal(),
      hasPickableNodes: false,
      displayState: {
        transform: new WatchableValue(makeIdentityTransform()),
      },
    },
  );
  const spatiallyIndexedSkeletonLayer = new WatchableValue({
    getNode: (nodeId: bigint) =>
      loadedNodes.find((node) => node.nodeId === nodeId),
  } as unknown as SpatiallyIndexedSkeletonLayer);
  const selection = new SkeletonNodeSelection({
    layer,
    skeletonNodeAccess,
    spatiallyIndexedSkeletonLayer,
    spatialSkeletonEditSession: new SpatialSkeletonEditSession(),
  });
  const readLayerEntry = () =>
    selectionState.value?.layers.find((entry) => entry.layer === layer)
      ?.state as (UserLayerSelectionState & { nodeId?: bigint }) | undefined;
  return {
    selection,
    selectionState,
    setLayerPosition,
    readLayerEntry,
  };
}

function makeHints(
  hints: {
    nodeIdRemappings?: [bigint, bigint][];
    segmentIdRemappings?: [bigint, bigint][];
  } = {},
) {
  return {
    nodeIdRemappings: new Map(hints.nodeIdRemappings),
    segmentIdRemappings: new Map(hints.segmentIdRemappings),
    segmentVisibility: [],
    selectedNode: undefined,
  };
}

describe("SkeletonNodeSelection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("selecting a node shows it in the Selection panel with its skeleton and position", () => {
    const { selection, selectionState, readLayerEntry } = makeSelectionHarness({
      loadedNodes: [
        { nodeId: 5n, segmentId: 1n, position: new Float32Array([4, 5, 6]) },
      ],
    });

    selection.select(5n, true);

    expect(readLayerEntry()).toMatchObject({ nodeId: 5n, value: 1n });
    expect(selectionState.pin.value).toBe(true);
    expect(selectionState.value?.position).toEqual(new Float32Array([4, 5, 6]));
    expect(selection.selected.value).toEqual({
      nodeId: 5n,
      segmentId: 1n,
      position: new Float32Array([4, 5, 6]),
    });
  });

  it("selecting a node that is not loaded keeps the last known position for the same node", () => {
    const { selection } = makeSelectionHarness();

    selection.select(5n, true, { segmentId: 1n, position: [1, 2, 3] });
    selection.select(5n, true, { segmentId: 1n });

    expect(selection.selected.value?.position).toEqual(
      new Float32Array([1, 2, 3]),
    );
  });

  it("clearing the selection removes the node from the Selection panel", () => {
    const { selection, readLayerEntry } = makeSelectionHarness();
    selection.select(5n, true, { segmentId: 1n });

    selection.clear(true);

    expect(readLayerEntry()?.nodeId).toBeUndefined();
    expect(selection.selected.value).toBeUndefined();
  });

  it("a pinned node selection follows the node when the server renumbers it", () => {
    const { selection, selectionState, readLayerEntry } =
      makeSelectionHarness();
    selection.select(5n, true, { segmentId: 1n, position: [1, 2, 3] });

    selection.applyPreviewUiHints(makeHints({ nodeIdRemappings: [[5n, 9n]] }));

    expect(readLayerEntry()?.nodeId).toBe(9n);
    expect(selectionState.pin.value).toBe(true);
    expect(selection.selected.value).toEqual({
      nodeId: 9n,
      segmentId: 1n,
      position: new Float32Array([1, 2, 3]),
    });
  });

  it("a pinned node selection moves to the surviving skeleton after a merge", () => {
    const { selection, readLayerEntry } = makeSelectionHarness();
    selection.select(5n, true, { segmentId: 1n });

    selection.applyPreviewUiHints(
      makeHints({ segmentIdRemappings: [[1n, 2n]] }),
    );

    expect(readLayerEntry()?.value).toBe(2n);
    expect(selection.selected.value?.segmentId).toBe(2n);
  });

  it("choosing a node in the Selection panel history restores that node as selected", () => {
    const { selection, selectionState } = makeSelectionHarness();
    selection.select(5n, true, { segmentId: 1n });
    selection.select(6n, true, { segmentId: 1n });

    selectionState.goBack();

    expect(selection.selected.value?.nodeId).toBe(5n);
  });

  it("navigating to a parent selects it and moves the view to it", () => {
    const { selection, setLayerPosition } = makeSelectionHarness({
      loadedNodes: [
        { nodeId: 1n, segmentId: 1n, position: new Float32Array([0, 0, 0]) },
        {
          nodeId: 2n,
          segmentId: 1n,
          parentNodeId: 1n,
          position: new Float32Array([10, 0, 0]),
        },
      ],
    });
    selection.select(2n, true);

    selection.navigate(SkeletonNavigation.PARENT);

    expect(selection.selected.value?.nodeId).toBe(1n);
    expect(setLayerPosition).toHaveBeenCalledWith(
      expect.anything(),
      new Float32Array([0, 0, 0]),
    );
  });

  it("navigating when no node is selected reports why instead of moving the view", () => {
    const { selection, setLayerPosition } = makeSelectionHarness();
    const showMessage = vi
      .spyOn(StatusMessage, "showTemporaryMessage")
      .mockReturnValue(undefined as unknown as StatusMessage);

    selection.navigate(SkeletonNavigation.PARENT);

    expect(showMessage).toHaveBeenCalledWith(
      "No segment/skeleton is selected.",
    );
    expect(setLayerPosition).not.toHaveBeenCalled();
  });

  it("a saved state with a node selection restores the same node", () => {
    const { selection } = makeSelectionHarness();
    const nodeIdAboveDoublePrecision = 2n ** 60n + 1n;
    const savedJson: Record<string, unknown> = {};
    selection.writeSelectionState(
      { nodeId: nodeIdAboveDoublePrecision, value: 1n },
      savedJson,
    );

    const restoredState = { nodeId: undefined, value: undefined };
    selection.restoreSelectionState(
      restoredState,
      JSON.parse(JSON.stringify(savedJson)),
    );

    expect(restoredState.nodeId).toBe(nodeIdAboveDoublePrecision);
  });

  it("a saved state with an unreadable node id restores no node", () => {
    const { selection } = makeSelectionHarness();
    const restoredState = { nodeId: 3n as bigint | undefined, value: "7" };

    selection.restoreSelectionState(restoredState, { nodeId: "not-a-node" });

    expect(restoredState.nodeId).toBeUndefined();
  });

  it("picking a node in another layer leaves this layer's selection alone", () => {
    const { selection } = makeSelectionHarness();
    const state = { nodeId: undefined, value: undefined };

    selection.captureSelectionState(state, {
      pickedRenderLayer: {},
      pickedSpatialSkeleton: { nodeId: 5n, segmentId: 1n },
    } as unknown as MouseSelectionState);

    expect(state).toEqual({ nodeId: undefined, value: undefined });
  });
});
