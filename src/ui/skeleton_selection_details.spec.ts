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
import { CatmaidSpatialSkeletonEditCommands } from "#src/datasource/catmaid/spatial_skeleton_edit/command_factories.js";
import type {
  LayerSelectedValues,
  UserLayer,
  UserLayerSelectionState,
} from "#src/layer/index.js";
import { TrackableDataSelectionState } from "#src/layer/index.js";
import type { SegmentationLayerSelectionState } from "#src/layer/segmentation/index.js";
import { SkeletonNodeSelection } from "#src/layer/segmentation/selection.js";
import { SkeletonSourceConnection } from "#src/layer/segmentation/skeleton_source_connection.js";
import type { SegmentationGroupState } from "#src/segmentation_display_state/frontend.js";
import type { SkeletonNode } from "#src/skeleton/api.js";
import { KnownSkeletonNodeAttribute } from "#src/skeleton/api.js";
import { SpatialSkeletonEditSession } from "#src/skeleton/edit/spatial_skeleton_edit_session.js";
import {
  executeSpatialSkeletonNodeRadiusUpdate,
  executeSpatialSkeletonReroot,
} from "#src/skeleton/edit/submit_edits.js";
import type { SkeletonNodeAccess } from "#src/skeleton/skeleton_navigator.js";
import { SkeletonOverlaySegments } from "#src/skeleton/spatial/overlay_segments.js";
import type { SpatiallyIndexedSkeletonLayer } from "#src/skeleton/spatial/skeleton_render_layer.js";
import { WatchableValue } from "#src/trackable_value.js";
import { displaySkeletonNodeSelection } from "#src/ui/skeleton_selection_details.js";
import { Uint64OrderedSet } from "#src/uint64_ordered_set.js";
import { Uint64Set } from "#src/uint64_set.js";
import { NullarySignal } from "#src/util/signal.js";
import { DependentViewContext } from "#src/widget/dependent_view_widget.js";

vi.mock("#src/skeleton/edit/submit_edits.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  executeSpatialSkeletonReroot: vi.fn(() => Promise.resolve()),
  executeSpatialSkeletonNodeRadiusUpdate: vi.fn(() => Promise.resolve()),
}));

function makeNode(
  nodeId: bigint,
  options: {
    parentNodeId?: bigint;
    radius?: number;
    trueEnd?: boolean;
    position?: [number, number, number];
  } = {},
): SkeletonNode {
  const attributes: Record<string, number[]> = {};
  if (options.radius !== undefined) {
    attributes[KnownSkeletonNodeAttribute.RADIUS] = [options.radius];
  }
  if (options.trueEnd) {
    attributes[KnownSkeletonNodeAttribute.IS_TRUE_END] = [1];
  }
  return {
    nodeId,
    segmentId: 5n,
    position: new Float32Array(options.position ?? [1, 2, 3]),
    parentNodeId: options.parentNodeId,
    attributes,
  };
}

function makeEditableSource(options: { omitReroot?: boolean } = {}) {
  const commands = new CatmaidSpatialSkeletonEditCommands({
    getClient: () => ({}) as any,
  });
  return {
    editPlannerProvider: commands.editPlannerProvider,
    deleteNodesCommand: commands.deleteNodesCommand,
    editNodeTrueEndCommand: commands.editNodeTrueEndCommand,
    editNodeRadiusCommand: commands.editNodeRadiusCommand,
    ...(options.omitReroot ? {} : { rerootCommand: commands.rerootCommand }),
  };
}

function makeDetailsLayer(
  options: {
    editableSource?: unknown;
    layerDimensionNames?: string[];
  } = {},
) {
  const spatialSkeletonEditSession = new SpatialSkeletonEditSession();
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
  const transform =
    options.layerDimensionNames === undefined
      ? undefined
      : {
          rank: 3,
          modelToRenderLayerTransform: new Float32Array([
            1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
          ]),
          layerDimensionNames: options.layerDimensionNames,
        };
  const skeletonNodeAccess = new WatchableValue<SkeletonNodeAccess | undefined>(
    {
      getSegmentNodes: () => [],
      parentsInferred: false,
      nodesChanged: new NullarySignal(),
      hasPickableNodes: false,
      displayState: { transform: new WatchableValue(transform as any) },
    },
  );
  const spatiallyIndexedSkeletonLayer = new WatchableValue<
    SpatiallyIndexedSkeletonLayer | undefined
  >({
    editableSource: options.editableSource,
    getNode: () => undefined,
  } as unknown as SpatiallyIndexedSkeletonLayer);
  const skeletonNodeSelection = new SkeletonNodeSelection({
    layer: userLayer,
    skeletonNodeAccess,
    spatiallyIndexedSkeletonLayer,
    spatialSkeletonEditSession,
  });
  const skeletonSourceConnection = new SkeletonSourceConnection({
    spatialSkeletonEditSession,
    selection: skeletonNodeSelection,
    overlaySegments: new SkeletonOverlaySegments({
      segmentationGroupState: new WatchableValue({} as any),
      editSession: spatialSkeletonEditSession,
    }),
    segmentationGroupState: new WatchableValue({
      visibleSegments: new Uint64Set(),
      temporaryVisibleSegments: new Uint64Set(),
      selectedSegments: new Uint64OrderedSet(),
    } as unknown as SegmentationGroupState),
    skeletonNodeAccess,
    spatiallyIndexedSkeletonLayer,
  });
  return {
    spatialSkeletonEditSession,
    skeletonSourceConnection,
    skeletonNodeSelection,
    skeletonNodeAccess,
    selectSegment: vi.fn(),
  };
}

function showSelectedNode(
  layer: ReturnType<typeof makeDetailsLayer>,
  nodeId: bigint,
  segmentId?: bigint,
) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const context = new DependentViewContext(() => {});
  displaySkeletonNodeSelection(
    layer,
    { nodeId, value: segmentId } as SegmentationLayerSelectionState,
    parent,
    context,
    {
      changed: new NullarySignal(),
      get: () => new Float32Array([0.2, 0.4, 0.6, 1]),
    },
  );
  return parent;
}

function getChoice(parent: HTMLElement, choice: string) {
  return parent.querySelector<HTMLButtonElement>(`[data-choice="${choice}"]`);
}

function getPropertyValue(parent: HTMLElement, label: string) {
  for (const row of parent.querySelectorAll(
    ".neuroglancer-annotation-property",
  )) {
    if (row.firstElementChild?.textContent === label) {
      return row.lastElementChild as HTMLElement;
    }
  }
  return undefined;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.mocked(executeSpatialSkeletonReroot).mockClear();
  vi.mocked(executeSpatialSkeletonNodeRadiusUpdate).mockClear();
  vi.useRealTimers();
});

describe("skeleton node type control", () => {
  it("the root node shows Root checked and cannot be chosen again", () => {
    const layer = makeDetailsLayer({ editableSource: makeEditableSource() });
    layer.spatialSkeletonEditSession.replaceCachedSegmentSnapshots([
      [5n, [makeNode(1n), makeNode(2n, { parentNodeId: 1n })]],
    ]);
    const parent = showSelectedNode(layer, 1n);
    const root = getChoice(parent, "root")!;
    expect(root.hasAttribute("data-checked")).toBe(true);
    expect(root.disabled).toBe(true);
    root.click();
    expect(executeSpatialSkeletonReroot).not.toHaveBeenCalled();
  });

  it("choosing Root on a regular node reroots the skeleton at that node", () => {
    const layer = makeDetailsLayer({ editableSource: makeEditableSource() });
    layer.spatialSkeletonEditSession.replaceCachedSegmentSnapshots([
      [
        5n,
        [
          makeNode(1n),
          makeNode(2n, { parentNodeId: 1n }),
          makeNode(3n, { parentNodeId: 2n }),
        ],
      ],
    ]);
    const parent = showSelectedNode(layer, 2n);
    getChoice(parent, "root")!.click();
    expect(executeSpatialSkeletonReroot).toHaveBeenCalledWith(
      layer.skeletonSourceConnection,
      expect.objectContaining({ nodeId: 2n, parentNodeId: 1n }),
    );
  });

  it("a true end cannot become root until its true end state is cleared", () => {
    const layer = makeDetailsLayer({ editableSource: makeEditableSource() });
    layer.spatialSkeletonEditSession.replaceCachedSegmentSnapshots([
      [5n, [makeNode(1n), makeNode(2n, { parentNodeId: 1n, trueEnd: true })]],
    ]);
    const parent = showSelectedNode(layer, 2n);
    const root = getChoice(parent, "root")!;
    expect(root.disabled).toBe(true);
    expect(root.title).toContain("Clear the true end state first");
    expect(getChoice(parent, "true-end")!.hasAttribute("data-checked")).toBe(
      true,
    );
  });

  it("a leaf offers Virtual end and True end alongside Root", () => {
    const layer = makeDetailsLayer({ editableSource: makeEditableSource() });
    layer.spatialSkeletonEditSession.replaceCachedSegmentSnapshots([
      [5n, [makeNode(1n), makeNode(2n, { parentNodeId: 1n })]],
    ]);
    const parent = showSelectedNode(layer, 2n);
    const virtualEnd = getChoice(parent, "virtual-end")!;
    const trueEnd = getChoice(parent, "true-end")!;
    expect(getChoice(parent, "root")!.disabled).toBe(false);
    expect(virtualEnd.hasAttribute("data-checked")).toBe(true);
    expect(trueEnd.hasAttribute("data-checked")).toBe(false);
    expect(trueEnd.disabled).toBe(false);
  });

  it("a branch point shows its type as a label, not as a choice", () => {
    const layer = makeDetailsLayer({ editableSource: makeEditableSource() });
    layer.spatialSkeletonEditSession.replaceCachedSegmentSnapshots([
      [
        5n,
        [
          makeNode(1n),
          makeNode(2n, { parentNodeId: 1n }),
          makeNode(3n, { parentNodeId: 2n }),
          makeNode(4n, { parentNodeId: 2n }),
        ],
      ],
    ]);
    const parent = showSelectedNode(layer, 2n);
    const nodeType = getPropertyValue(parent, "Node type")!;
    expect(nodeType.textContent).toContain("Branch point");
    expect(getChoice(parent, "root")).not.toBeNull();
    expect(getChoice(parent, "virtual-end")).toBeNull();
    expect(getChoice(parent, "true-end")).toBeNull();
  });

  it("Root is disabled with the reason when the source cannot reroot", () => {
    const layer = makeDetailsLayer({
      editableSource: makeEditableSource({ omitReroot: true }),
    });
    layer.spatialSkeletonEditSession.replaceCachedSegmentSnapshots([
      [
        5n,
        [
          makeNode(1n),
          makeNode(2n, { parentNodeId: 1n }),
          makeNode(3n, { parentNodeId: 2n }),
        ],
      ],
    ]);
    const parent = showSelectedNode(layer, 2n);
    const root = getChoice(parent, "root")!;
    expect(root.disabled).toBe(true);
    expect(root.title).toMatch(/does not support/);
  });
});

describe("skeleton selection details", () => {
  it("shows the node position in the layer's own dimension names", () => {
    const layer = makeDetailsLayer({
      editableSource: makeEditableSource(),
      layerDimensionNames: ["a", "b", "c"],
    });
    layer.spatialSkeletonEditSession.replaceCachedSegmentSnapshots([
      [5n, [makeNode(1n, { position: [10.4, 20.6, 30] })]],
    ]);
    const parent = showSelectedNode(layer, 1n);
    const coordinates = parent.querySelector<HTMLElement>(
      ".neuroglancer-selection-details-skeleton-summary-coordinates",
    )!;
    expect(coordinates.textContent).toBe("10 21 30");
    expect(coordinates.title).toBe("a: 10 b: 21 c: 30");
  });

  it("shows Preview as the node id until the server confirms the node", () => {
    const layer = makeDetailsLayer({ editableSource: makeEditableSource() });
    layer.spatialSkeletonEditSession.replaceCachedSegmentSnapshots([
      [5n, [makeNode(1n)]],
    ]);
    const { spatialSkeletonDisplay } = layer.spatialSkeletonEditSession;
    spatialSkeletonDisplay.value = {
      ...spatialSkeletonDisplay.value,
      provisionalNodeIds: [1n],
    };
    const parent = showSelectedNode(layer, 1n);
    expect(getPropertyValue(parent, "Node ID")!.textContent).toBe("Preview");
    spatialSkeletonDisplay.value = {
      ...spatialSkeletonDisplay.value,
      provisionalNodeIds: [],
    };
    expect(getPropertyValue(parent, "Node ID")!.textContent).toBe("1");
  });

  it("shows Preview as the skeleton id until the server confirms the skeleton", () => {
    const layer = makeDetailsLayer({ editableSource: makeEditableSource() });
    layer.spatialSkeletonEditSession.replaceCachedSegmentSnapshots([
      [5n, [makeNode(1n)]],
    ]);
    const { spatialSkeletonDisplay } = layer.spatialSkeletonEditSession;
    const alias = {
      logicalHandle: { kind: "segment", stableId: "intent:1:created-segment" },
      segmentId: 5n,
    } as const;
    spatialSkeletonDisplay.value = {
      ...spatialSkeletonDisplay.value,
      numericAliases: [{ ...alias, authoritative: false }] as any,
    };
    const parent = showSelectedNode(layer, 1n);
    expect(getPropertyValue(parent, "Segment ID")!.textContent).toBe("Preview");
    spatialSkeletonDisplay.value = {
      ...spatialSkeletonDisplay.value,
      numericAliases: [{ ...alias, authoritative: true }] as any,
    };
    expect(getPropertyValue(parent, "Segment ID")!.textContent).toBe("5");
  });

  it("keeps a radius being typed when the server confirms an earlier edit", () => {
    const layer = makeDetailsLayer({ editableSource: makeEditableSource() });
    layer.spatialSkeletonEditSession.replaceCachedSegmentSnapshots([
      [5n, [makeNode(1n, { radius: 2 })]],
    ]);
    const parent = showSelectedNode(layer, 1n);
    const radius = getPropertyValue(parent, "Radius")!
      .firstElementChild as HTMLInputElement;
    expect(radius.value).toBe("2");
    radius.focus();
    radius.value = "7";
    radius.dispatchEvent(new Event("input"));
    layer.spatialSkeletonEditSession.replaceCachedSegmentSnapshots([
      [5n, [makeNode(1n, { radius: 3 })]],
    ]);
    expect(radius.isConnected).toBe(true);
    expect(radius.value).toBe("7");
  });

  it("three quick Radius steps save one edit with the last value", () => {
    vi.useFakeTimers();
    const layer = makeDetailsLayer({ editableSource: makeEditableSource() });
    layer.spatialSkeletonEditSession.replaceCachedSegmentSnapshots([
      [5n, [makeNode(1n, { radius: 2 })]],
    ]);
    const parent = showSelectedNode(layer, 1n);
    const radius = getPropertyValue(parent, "Radius")!
      .firstElementChild as HTMLInputElement;
    radius.focus();
    for (const value of ["3", "4", "5"]) {
      radius.value = value;
      radius.dispatchEvent(new Event("change"));
      vi.advanceTimersByTime(100);
    }
    expect(executeSpatialSkeletonNodeRadiusUpdate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);

    expect(executeSpatialSkeletonNodeRadiusUpdate).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(executeSpatialSkeletonNodeRadiusUpdate).mock.calls[0][1],
    ).toMatchObject({ nextRadius: 5 });
  });

  it("leaving Radius saves at once, and 2.0 over a radius of 2 saves nothing", () => {
    const layer = makeDetailsLayer({ editableSource: makeEditableSource() });
    layer.spatialSkeletonEditSession.replaceCachedSegmentSnapshots([
      [5n, [makeNode(1n, { radius: 2 })]],
    ]);
    const parent = showSelectedNode(layer, 1n);
    const radius = getPropertyValue(parent, "Radius")!
      .firstElementChild as HTMLInputElement;

    radius.focus();
    radius.value = "2.0";
    radius.dispatchEvent(new Event("change"));
    radius.blur();
    expect(executeSpatialSkeletonNodeRadiusUpdate).not.toHaveBeenCalled();

    radius.focus();
    radius.value = "6";
    radius.dispatchEvent(new Event("change"));
    radius.blur();
    expect(executeSpatialSkeletonNodeRadiusUpdate).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(executeSpatialSkeletonNodeRadiusUpdate).mock.calls[0][1],
    ).toMatchObject({ nextRadius: 6 });
  });

  it("the segment chip follows a change of the skeleton's colour", () => {
    const layer = makeDetailsLayer({ editableSource: makeEditableSource() });
    layer.spatialSkeletonEditSession.replaceCachedSegmentSnapshots([
      [5n, [makeNode(1n)]],
    ]);
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const colorsChanged = new NullarySignal();
    let color = new Float32Array([1, 0, 0, 1]);
    displaySkeletonNodeSelection(
      layer,
      { nodeId: 1n } as SegmentationLayerSelectionState,
      parent,
      new DependentViewContext(() => {}),
      { changed: colorsChanged, get: () => color },
    );
    const chip = getPropertyValue(parent, "Segment ID")!
      .firstElementChild as HTMLElement;
    expect(chip.style.backgroundColor).toBe("rgb(255, 0, 0)");

    color = new Float32Array([0, 0, 1, 1]);
    colorsChanged.dispatch();

    expect(chip.style.backgroundColor).toBe("rgb(0, 0, 255)");
  });

  it("explains when the selected node is not in loaded or cached skeleton data", () => {
    const layer = makeDetailsLayer({ editableSource: makeEditableSource() });
    const parent = showSelectedNode(layer, 9n);
    expect(parent.textContent).toContain(
      "Selected node is not available in the current loaded or cached skeleton data.",
    );
  });
});
