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

import { emptyInvalidCoordinateSpace } from "#src/coordinate_transform.js";
import { CatmaidSpatialSkeletonEditCommands } from "#src/datasource/catmaid/spatial_skeleton_commands.js";
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
import { SpatialSkeletonActions } from "#src/skeleton/command_protocol.js";
import { executeSpatialSkeletonDeleteNode } from "#src/skeleton/commands.js";
import { SkeletonFindPathState } from "#src/skeleton/find_path.js";
import type {
  MultiscaleSpatiallyIndexedSkeletonSource,
  SpatiallyIndexedSkeletonLayer,
} from "#src/skeleton/frontend.js";
import type { SpatialSkeletonResolvedProjectionUiHints } from "#src/skeleton/optimistic_edit/projection_ui_hints.js";
import type { SkeletonNodeAccess } from "#src/skeleton/skeleton_navigator.js";
import { SpatialSkeletonState } from "#src/skeleton/spatial_skeleton_manager.js";
import { WatchableValue } from "#src/trackable_value.js";
import { Uint64OrderedSet } from "#src/uint64_ordered_set.js";
import { Uint64Set } from "#src/uint64_set.js";
import { RefCounted } from "#src/util/disposable.js";
import { HttpError } from "#src/util/http_request.js";
import { NullarySignal } from "#src/util/signal.js";

function makeEditableSource(
  options: { omitReroot?: boolean } = {},
): Record<string, unknown> {
  const commands = new CatmaidSpatialSkeletonEditCommands({
    getClient: () => ({}) as any,
  });
  return {
    optimisticEditing: commands.optimisticEditing,
    addNodesCommand: commands.addNodesCommand,
    deleteNodesCommand: commands.deleteNodesCommand,
    ...(options.omitReroot ? {} : { rerootCommand: commands.rerootCommand }),
  };
}

function makeSkeletonLayer(editableSource: unknown) {
  return {
    editableSource,
    getNode: () => undefined,
    remapOverlaySegments: vi.fn(),
    retainOverlaySegment: vi.fn(),
  } as unknown as SpatiallyIndexedSkeletonLayer;
}

function makeDeletingSkeletonLayer(
  getCachedNode: (nodeId: bigint) => SkeletonNode | undefined,
) {
  const client = {
    baseUrl: "https://catmaid.example.test",
    projectId: 1,
    deleteNode: vi.fn(),
  };
  const commands = new CatmaidSpatialSkeletonEditCommands({
    getClient: () => client as any,
  });
  const source = {
    optimisticEditing: commands.optimisticEditing,
    deleteNodesCommand: commands.deleteNodesCommand,
    edgeDirection: SkeletonEdgeDirection.CHILD_TO_PARENT,
    getSkeletonManifest: async () => ({ fragmentKeys: [] }),
    getSkeletonFragment: async () => ({ nodes: [], edges: [] }),
  };
  const skeletonLayer = {
    fragmentSource: source,
    editableSource: source,
    getNode: (nodeId: bigint) => getCachedNode(nodeId),
    remapOverlaySegments: vi.fn(),
    retainOverlaySegment: vi.fn(),
  } as unknown as SpatiallyIndexedSkeletonLayer;
  return { skeletonLayer, client };
}

function makeConnection(
  options: {
    skeletonLayer?: SpatiallyIndexedSkeletonLayer;
    spatialSkeletonState?: SpatialSkeletonState;
  } = {},
) {
  const spatialSkeletonState =
    options.spatialSkeletonState ?? new SpatialSkeletonState();
  const layerSelectedValues = {
    changed: new NullarySignal(),
    mouseState: { active: false },
  } as unknown as LayerSelectedValues;
  const selectionState = new TrackableDataSelectionState(
    new WatchableValue(emptyInvalidCoordinateSpace),
    layerSelectedValues,
  );
  selectionState.location.visible = true;
  const layer = {
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
    {
      getSegmentNodes: () => [],
      parentsInferred: false,
      nodesChanged: new NullarySignal(),
      hasPickableNodes: false,
      displayState: { transform: new WatchableValue(undefined as any) },
    },
  );
  const spatiallyIndexedSkeletonLayer = new WatchableValue<
    SpatiallyIndexedSkeletonLayer | undefined
  >(options.skeletonLayer);
  const selection = new SkeletonNodeSelection({
    layer,
    skeletonNodeAccess,
    spatiallyIndexedSkeletonLayer,
    spatialSkeletonState,
  });
  const group = {
    visibleSegments: new Uint64Set(),
    temporaryVisibleSegments: new Uint64Set(),
    selectedSegments: new Uint64OrderedSet(),
  };
  const connection = new SkeletonSourceConnection({
    spatialSkeletonState,
    selection,
    segmentationGroupState: new WatchableValue(
      group as unknown as SegmentationGroupState,
    ),
    skeletonNodeAccess,
    spatiallyIndexedSkeletonLayer,
  });
  return {
    connection,
    spatialSkeletonState,
    selection,
    selectionState,
    layer,
    group,
  };
}

function makeHints(
  hints: Partial<SpatialSkeletonResolvedProjectionUiHints>,
): SpatialSkeletonResolvedProjectionUiHints {
  return {
    nodeIdRemappings: new Map(),
    segmentIdRemappings: new Map(),
    segmentVisibility: [],
    retainSegmentIds: [],
    selectedNode: undefined,
    ...hints,
  } as SpatialSkeletonResolvedProjectionUiHints;
}

describe("SkeletonSourceConnection", () => {
  it("edit actions are unavailable while the page needs a reload", () => {
    const { connection, spatialSkeletonState } = makeConnection({
      skeletonLayer: makeSkeletonLayer(makeEditableSource()),
    });
    const deleteNodes = SpatialSkeletonActions.deleteNodes;
    expect(connection.getActionsDisabledReason(deleteNodes)).toBeUndefined();
    spatialSkeletonState.latchOptimisticEditFatalState({
      reason: "authority-indeterminate",
      authority: "indeterminate",
      intentId: 1,
      cause: new Error("lost response"),
    });
    expect(connection.getActionsDisabledReason(deleteNodes)).toMatch(/reload/i);
    expect(
      connection.getActionsDisabledReason(SpatialSkeletonActions.inspect),
    ).toBeUndefined();
  });

  it("a read-only skeleton source explains that editing is not possible", () => {
    const { connection } = makeConnection({
      skeletonLayer: makeSkeletonLayer(undefined),
    });
    expect(
      connection.getActionsDisabledReason(SpatialSkeletonActions.addNodes),
    ).toBe("The active spatial skeleton source is read-only.");
    expect(
      connection.getActionsDisabledReason(SpatialSkeletonActions.inspect),
    ).toBeUndefined();
  });

  it("a source without an action names the missing action in the disabled reason", () => {
    const { connection } = makeConnection({
      skeletonLayer: makeSkeletonLayer(
        makeEditableSource({ omitReroot: true }),
      ),
    });
    expect(
      connection.getActionsDisabledReason([
        SpatialSkeletonActions.addNodes,
        SpatialSkeletonActions.reroot,
      ]),
    ).toBe(
      "The active spatial skeleton source does not support skeleton rerooting.",
    );
    expect(
      connection.getActionsDisabledReason(SpatialSkeletonActions.addNodes),
    ).toBeUndefined();
  });

  it("only a change to a different skeleton source clears pending edit state", () => {
    const { connection, spatialSkeletonState } = makeConnection();
    const firstSource = {} as MultiscaleSpatiallyIndexedSkeletonSource;
    const secondSource = {} as MultiscaleSpatiallyIndexedSkeletonSource;

    connection.sourceChanged(firstSource);
    spatialSkeletonState.setPendingNodePosition(7n, [1, 2, 3]);
    connection.sourceChanged(firstSource);
    expect(spatialSkeletonState.getPendingNodePosition(7n)).toBeDefined();

    connection.sourceChanged(secondSource);
    expect(spatialSkeletonState.getPendingNodePosition(7n)).toBeUndefined();
  });

  it("an adopted optimistic edit invalidates the shown Find Path result", () => {
    const { connection, spatialSkeletonState } = makeConnection();
    const findPathState = new SkeletonFindPathState();
    const lifetime = new RefCounted();
    connection.attachFindPath(
      {
        skeletonLayer: makeSkeletonLayer(undefined),
        state: findPathState,
        annotationController: {} as any,
      },
      lifetime,
    );
    const result = [{ nodeId: 1n, segmentId: 5n, position: [0, 0, 0] }];

    findPathState.setResult(result as any);
    spatialSkeletonState.nodeDataVersion.value += 1;
    expect(findPathState.result).toBe(result);

    vi.spyOn(
      spatialSkeletonState,
      "hasUnconfirmedOptimisticEdits",
    ).mockReturnValue(true);
    spatialSkeletonState.nodeDataVersion.value += 1;
    expect(findPathState.result).toBeUndefined();

    lifetime.dispose();
    expect(connection.getFindPathContext()).toBeUndefined();
  });

  it("a renumbered skeleton stays visible and selected after the server confirms an edit", () => {
    const skeletonLayer = makeSkeletonLayer(undefined);
    const { connection, group } = makeConnection({ skeletonLayer });
    group.visibleSegments.add(5n);
    group.temporaryVisibleSegments.add(5n);
    group.selectedSegments.add(5n);

    connection.applySpatialSkeletonProjectionUiHints(
      makeHints({ segmentIdRemappings: new Map([[5n, 9n]]) }),
    );

    expect(group.visibleSegments.has(9n)).toBe(true);
    expect(group.visibleSegments.has(5n)).toBe(false);
    expect(group.selectedSegments.has(9n)).toBe(true);
    expect(group.selectedSegments.has(5n)).toBe(false);
    expect(skeletonLayer.remapOverlaySegments).toHaveBeenCalledWith(
      new Map([[5n, 9n]]),
    );
  });

  it("deleting the last node of a skeleton hides and deselects it", () => {
    const { connection, group, selection } = makeConnection({
      skeletonLayer: makeSkeletonLayer(undefined),
    });
    group.visibleSegments.add(5n);
    group.temporaryVisibleSegments.add(5n);
    group.selectedSegments.add(5n);
    selection.select(3n, true, {
      segmentId: 5n,
      position: new Float32Array([1, 2, 3]),
    });

    connection.applySpatialSkeletonProjectionUiHints(
      makeHints({
        segmentVisibility: [{ segmentId: 5n, visible: false, deselect: true }],
        selectedNode: { kind: "clear" },
      } as Partial<SpatialSkeletonResolvedProjectionUiHints>),
    );

    expect(group.visibleSegments.has(5n)).toBe(false);
    expect(group.temporaryVisibleSegments.has(5n)).toBe(false);
    expect(group.selectedSegments.has(5n)).toBe(false);
    expect(selection.selected.value).toBeUndefined();
  });

  it("a rejected delete restores the skeleton's visibility and the pinned node", async () => {
    const spatialSkeletonState = new SpatialSkeletonState();
    const { skeletonLayer, client } = makeDeletingSkeletonLayer((nodeId) =>
      spatialSkeletonState.getCachedNode(nodeId),
    );
    const { connection, group, selection, selectionState, layer } =
      makeConnection({ skeletonLayer, spatialSkeletonState });
    const node = {
      nodeId: 725n,
      segmentId: 87n,
      position: new Float32Array([4, 5, 6]),
    };
    spatialSkeletonState.replaceCachedSegmentSnapshots([[87n, [node]]]);
    group.visibleSegments.add(87n);
    selection.select(node.nodeId, true, node);
    let rejectDelete: ((error: Error) => void) | undefined;
    client.deleteNode.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectDelete = reject;
        }),
    );
    const readLayerEntry = () =>
      selectionState.value?.layers.find((entry) => entry.layer === layer)
        ?.state as (UserLayerSelectionState & { nodeId?: bigint }) | undefined;

    const execution = executeSpatialSkeletonDeleteNode(connection, node);
    await execution;
    await vi.waitFor(() => expect(rejectDelete).toBeDefined());
    expect(readLayerEntry()?.nodeId).toBeUndefined();
    expect(group.visibleSegments.has(87n)).toBe(false);

    rejectDelete!(
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
    expect(readLayerEntry()).toMatchObject({ nodeId: 725n, value: 87n });
    expect(group.visibleSegments.has(87n)).toBe(true);
    expect(spatialSkeletonState.getCachedNode(725n)).toMatchObject(node);
    spatialSkeletonState.dispose();
  });
});
