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

import type {
  LayerSelectedValues,
  MouseSelectionState,
  PickedSpatialSkeletonState,
  UserLayer,
  UserLayerSelectionState,
} from "#src/layer/index.js";
import type { SegmentationLayerSelectionState } from "#src/layer/segmentation/index.js";
import type { RenderLayerTransform } from "#src/render_coordinate_transform.js";
import { Uint64MapEntry } from "#src/segmentation_display_state/base.js";
import type { SkeletonNode } from "#src/skeleton/api.js";
import type { SpatialSkeletonEditSession } from "#src/skeleton/edit/spatial_skeleton_edit_session.js";
import type {
  SpatialSkeletonPreviewSelectionPin,
  SpatialSkeletonResolvedPreviewUiHints,
} from "#src/skeleton/edit_queue/preview_ui_hints.js";
import {
  type SkeletonNavigation,
  SkeletonNavigator,
  type SkeletonNodeAccess,
} from "#src/skeleton/skeleton_navigator.js";
import type { SpatiallyIndexedSkeletonLayer } from "#src/skeleton/spatial/skeleton_render_layer.js";
import { StatusMessage } from "#src/status.js";
import {
  WatchableValue,
  type WatchableValueInterface,
} from "#src/trackable_value.js";
import { gatherUpdate } from "#src/util/array.js";
import { RefCounted } from "#src/util/disposable.js";
import { parseUint64, verifyOptionalObjectProperty } from "#src/util/json.js";
import * as matrix from "#src/util/matrix.js";
import { NullarySignal } from "#src/util/signal.js";

interface SkeletonViewerHoverMouseStateLike<TRenderLayer> {
  active: boolean;
  pickedRenderLayer: TRenderLayer | null | undefined;
  pickedSpatialSkeleton?: PickedSpatialSkeletonState;
}

export interface SkeletonHoverInfo {
  readonly nodeId: bigint;
  // A hover is only reported once both ids resolve, so consumers (e.g. outline colouring, which
  // derives from the hovered segment) can rely on the segment being known.
  readonly segmentId: bigint;
  // Model-space position of the picked node, carried so the highlight overlay can
  // still be placed when the node's skeleton is not currently loaded/cached.
  readonly position?: Float32Array;
}

interface SkeletonViewerHoverLayerLike<TRenderLayer> {
  renderLayers: readonly TRenderLayer[];
}

function parseSelectionStateId(value: unknown) {
  try {
    return parseUint64(value);
  } catch {
    return undefined;
  }
}

// Node 0 is a valid node.
export function getNodeIdFromLayerSelectionState(
  state: { nodeId?: unknown; value?: unknown } | undefined,
) {
  const nodeId = state?.nodeId;
  return typeof nodeId === "bigint" ? nodeId : undefined;
}

// Segment 0 means no segment.
export function getSegmentIdFromLayerSelectionValue(
  state: { nodeId?: unknown; value?: unknown } | undefined,
) {
  const value = state?.value;
  const segmentId =
    value instanceof Uint64MapEntry
      ? value.value || value.key
      : parseSelectionStateId(value);
  return segmentId === 0n ? undefined : segmentId;
}

export function hasSkeletonNodeSelection(
  state: { nodeId?: unknown; value?: unknown } | undefined,
) {
  return getNodeIdFromLayerSelectionState(state) !== undefined;
}

function getSkeletonHoverInfoFromViewerHover<TRenderLayer>(
  mouseState: SkeletonViewerHoverMouseStateLike<TRenderLayer>,
  layer: SkeletonViewerHoverLayerLike<TRenderLayer>,
): SkeletonHoverInfo | undefined {
  if (!mouseState.active) return undefined;
  const { pickedRenderLayer } = mouseState;
  if (pickedRenderLayer !== null) {
    if (
      pickedRenderLayer === undefined ||
      !layer.renderLayers.includes(pickedRenderLayer)
    ) {
      return undefined;
    }
  }
  const { pickedSpatialSkeleton } = mouseState;
  const nodeId = pickedSpatialSkeleton?.nodeId;
  if (nodeId === undefined) return undefined;
  const segmentId = pickedSpatialSkeleton?.segmentId;
  if (segmentId === undefined) return undefined;
  return { nodeId, segmentId, position: pickedSpatialSkeleton?.position };
}

function positionsEqual(
  a: Float32Array | undefined,
  b: Float32Array | undefined,
) {
  if (a === b) return true;
  if (a === undefined || b === undefined || a.length !== b.length) return false;
  for (let i = 0; i < a.length; ++i) if (a[i] !== b[i]) return false;
  return true;
}

function skeletonHoverInfoEqual(
  a: SkeletonHoverInfo | undefined,
  b: SkeletonHoverInfo | undefined,
) {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return (
    a.nodeId === b.nodeId &&
    a.segmentId === b.segmentId &&
    positionsEqual(a.position, b.position)
  );
}

export class SkeletonHoverState extends RefCounted {
  value: SkeletonHoverInfo | undefined = undefined;
  readonly changed = new NullarySignal();

  setValue(value: SkeletonHoverInfo | undefined) {
    if (!skeletonHoverInfoEqual(this.value, value)) {
      this.value = value;
      this.changed.dispatch();
    }
  }

  bindTo(layerSelectedValues: LayerSelectedValues, layer: UserLayer) {
    this.registerDisposer(
      layerSelectedValues.changed.add(() => {
        this.setValue(
          getSkeletonHoverInfoFromViewerHover(
            layerSelectedValues.mouseState,
            layer,
          ),
        );
      }),
    );
  }
}

export type SkeletonSelectionPin = boolean | "toggle" | "force-unpin";

export interface SelectedSkeletonNodeInfo {
  readonly nodeId: bigint;
  readonly segmentId?: bigint;
  readonly position?: Float32Array;
}

type SkeletonNodeSelectionState = Pick<
  SegmentationLayerSelectionState,
  "nodeId" | "value"
>;

export interface SkeletonNodeSelectionOptions {
  readonly layer: UserLayer;
  readonly skeletonNodeAccess: WatchableValueInterface<
    SkeletonNodeAccess | undefined
  >;
  readonly spatiallyIndexedSkeletonLayer: WatchableValueInterface<
    SpatiallyIndexedSkeletonLayer | undefined
  >;
  readonly spatialSkeletonEditSession: SpatialSkeletonEditSession;
}

export class SkeletonNodeSelection extends RefCounted {
  readonly hovered = this.registerDisposer(new SkeletonHoverState());
  readonly navigator: SkeletonNavigator;
  private readonly selectedValue = new WatchableValue<
    SelectedSkeletonNodeInfo | undefined
  >(undefined);
  readonly selected: Readonly<
    WatchableValueInterface<SelectedSkeletonNodeInfo | undefined>
  > = this.selectedValue;
  private knownPosition:
    | { readonly nodeId: bigint; readonly position: Float32Array }
    | undefined;

  constructor(private readonly options: SkeletonNodeSelectionOptions) {
    super();
    const { layer, spatialSkeletonEditSession } = options;
    this.navigator = new SkeletonNavigator(options.skeletonNodeAccess);
    this.hovered.bindTo(layer.manager.layerSelectedValues, layer);
    const updateSelected = () => {
      this.reconcileSegmentOwnership();
      this.updateSelected();
    };
    this.registerDisposer(
      layer.manager.root.selectionState.changed.add(updateSelected),
    );
    this.registerDisposer(
      spatialSkeletonEditSession.nodeDataVersion.changed.add(updateSelected),
    );
    updateSelected();
  }

  select(
    nodeId: bigint,
    pin: SkeletonSelectionPin = false,
    node: { segmentId?: bigint; position?: ArrayLike<number> } = {},
  ): void {
    const loadedNode = this.findNode(nodeId);
    const segmentId = undefinedIfZero(node.segmentId ?? loadedNode?.segmentId);
    const position =
      node.position ?? loadedNode?.position ?? this.getKnownPosition(nodeId);
    if (position !== undefined) {
      this.knownPosition = { nodeId, position: new Float32Array(position) };
    }
    this.captureState(
      (state) => {
        state.nodeId = nodeId;
        state.value = segmentId;
        return true;
      },
      pin,
      this.toGlobalPosition(position),
    );
  }

  clear(pin: SkeletonSelectionPin = false): void {
    this.captureState((state) => {
      state.nodeId = undefined;
      state.value = undefined;
      return true;
    }, pin);
  }

  navigate(navigation: SkeletonNavigation): void {
    const selected = this.selected.value;
    const result = this.navigator.navigate(navigation, {
      segmentId:
        getSegmentIdFromLayerSelectionValue(this.getLayerEntryState()) ??
        selected?.segmentId,
      nodeId: selected?.nodeId,
    });
    if (typeof result === "number") {
      StatusMessage.showTemporaryMessage(
        this.navigator.describeFailure(navigation, result),
      );
      return;
    }
    this.selectAndMoveTo(result, true);
  }

  moveViewTo(modelPosition: ArrayLike<number>): void {
    const transform = this.getRenderLayerTransform();
    if (transform === undefined) return;
    this.options.layer.setLayerPosition(
      transform,
      transformModelPosition(transform, modelPosition),
    );
  }

  toGlobalPosition(
    modelPosition: ArrayLike<number> | undefined,
  ): Float32Array | undefined {
    if (modelPosition === undefined) return undefined;
    const transform = this.getRenderLayerTransform();
    if (transform === undefined) return undefined;
    const globalPosition =
      this.options.layer.manager.root.globalPosition.value.slice();
    gatherUpdate(
      globalPosition,
      transformModelPosition(transform, modelPosition),
      transform.globalToRenderLayerDimensions,
    );
    return globalPosition;
  }

  applyPreviewUiHints(
    hints: Pick<
      SpatialSkeletonResolvedPreviewUiHints,
      | "nodeIdRemappings"
      | "segmentIdRemappings"
      | "selectedNode"
      | "segmentVisibility"
    >,
  ): void {
    this.remapSelectionEntry(hints.nodeIdRemappings, hints.segmentIdRemappings);
    const { selectionState } = this.options.layer.manager.root;
    for (const visibility of hints.segmentVisibility) {
      if (visibility.select === undefined) continue;
      this.selectSegment(
        visibility.segmentId,
        resolveHintPin(visibility.select, selectionState.pin.value),
      );
    }
    const selectedNode = hints.selectedNode;
    if (selectedNode === undefined) return;
    if (selectedNode.kind === "clear") {
      this.clear(selectionState.pin.value);
      return;
    }
    if (
      selectedNode.kind === "refresh-if-selected" &&
      this.selected.value?.nodeId !== selectedNode.nodeId
    ) {
      return;
    }
    const cachedNode = this.options.spatialSkeletonEditSession.getCachedNode(
      selectedNode.nodeId,
    );
    const position = selectedNode.position ?? cachedNode?.position;
    this.select(
      selectedNode.nodeId,
      resolveHintPin(selectedNode.pin, selectionState.pin.value),
      {
        segmentId: selectedNode.segmentId ?? cachedNode?.segmentId,
        position,
      },
    );
    if (selectedNode.moveView && position !== undefined) {
      this.moveViewTo(position);
    }
  }

  initializeSelectionState(state: SkeletonNodeSelectionState): void {
    state.nodeId = undefined;
  }

  resetSelectionState(state: SkeletonNodeSelectionState): void {
    state.nodeId = undefined;
  }

  copySelectionState(
    dest: SkeletonNodeSelectionState,
    source: SkeletonNodeSelectionState,
  ): void {
    dest.nodeId = source.nodeId;
  }

  restoreSelectionState(state: SkeletonNodeSelectionState, json: unknown) {
    try {
      state.nodeId = verifyOptionalObjectProperty(json, "nodeId", parseUint64);
    } catch {
      state.nodeId = undefined;
    }
  }

  writeSelectionState(
    state: SkeletonNodeSelectionState,
    json: Record<string, unknown>,
  ) {
    if (state.nodeId !== undefined) {
      json.nodeId = state.nodeId.toString();
    }
  }

  captureSelectionState(
    state: SkeletonNodeSelectionState,
    mouseState: MouseSelectionState,
  ): void {
    const { pickedSpatialSkeleton, pickedRenderLayer } = mouseState;
    if (pickedSpatialSkeleton === undefined) return;
    if (
      pickedRenderLayer !== null &&
      !this.options.layer.renderLayers.includes(pickedRenderLayer)
    ) {
      return;
    }
    state.nodeId = undefinedIfZero(pickedSpatialSkeleton.nodeId);
    const segmentId = undefinedIfZero(pickedSpatialSkeleton.segmentId);
    if (segmentId !== undefined) {
      state.value = segmentId;
    }
  }

  private selectAndMoveTo(
    node: Pick<SkeletonNode, "nodeId" | "segmentId" | "position"> | undefined,
    pin: boolean | "toggle" = this.options.layer.manager.root.selectionState.pin
      .value,
  ): boolean {
    if (node === undefined) {
      this.clear(pin);
      return false;
    }
    this.select(node.nodeId, pin, node);
    this.moveViewTo(node.position);
    return true;
  }

  private selectSegment(segmentId: bigint, pin: SkeletonSelectionPin) {
    this.options.layer.manager.root.selectionState.captureSingleLayerState(
      this.options.layer,
      (state) => {
        state.value = segmentId;
        return true;
      },
      pin,
    );
  }

  private captureState(
    capture: (state: UserLayerSelectionState & { nodeId?: bigint }) => boolean,
    pin: SkeletonSelectionPin,
    globalPosition?: Float32Array,
  ) {
    const { layer } = this.options;
    const { selectionState } = layer.manager.root;
    if (pin !== false || selectionState.pin.value) {
      selectionState.captureSingleLayerState(layer, capture, pin);
      return;
    }
    const state = {} as UserLayerSelectionState;
    layer.initializeSelectionState(state);
    if (!capture(state)) return;
    selectionState.value = {
      layers: [{ layer, state }],
      coordinateSpace: selectionState.coordinateSpace.value,
      position: globalPosition,
    };
  }

  private getLayerEntry() {
    const { layer } = this.options;
    return layer.manager.root.selectionState.value?.layers.find(
      (entry) => entry.layer === layer,
    );
  }

  private getLayerEntryState(): SkeletonNodeSelectionState | undefined {
    return this.getLayerEntry()?.state as
      | SkeletonNodeSelectionState
      | undefined;
  }

  private findNode(nodeId: bigint) {
    return (
      this.options.spatiallyIndexedSkeletonLayer.value?.getNode(nodeId) ??
      this.options.spatialSkeletonEditSession.getCachedNode(nodeId)
    );
  }

  private getKnownPosition(nodeId: bigint) {
    const { knownPosition } = this;
    return knownPosition?.nodeId === nodeId
      ? knownPosition.position
      : undefined;
  }

  private getRenderLayerTransform() {
    const transform =
      this.options.skeletonNodeAccess.value?.displayState.transform.value;
    if (transform === undefined || transform.error !== undefined) {
      return undefined;
    }
    return transform;
  }

  private updateSelected() {
    const entryState = this.getLayerEntryState();
    const nodeId = getNodeIdFromLayerSelectionState(entryState);
    if (nodeId === undefined) {
      this.selectedValue.value = undefined;
      return;
    }
    const segmentId = getSegmentIdFromLayerSelectionValue(entryState);
    const loadedPosition = toFloat32Position(this.findNode(nodeId)?.position);
    if (loadedPosition !== undefined) {
      this.knownPosition = { nodeId, position: loadedPosition };
    }
    const position = loadedPosition ?? this.getKnownPosition(nodeId);
    const previous = this.selectedValue.value;
    if (
      previous?.nodeId === nodeId &&
      previous.segmentId === segmentId &&
      positionsEqual(previous.position, position)
    ) {
      return;
    }
    this.selectedValue.value = { nodeId, segmentId, position };
  }

  // Merge, split and rollback can change a node's skeleton without an id remap.
  private reconcileSegmentOwnership() {
    const entry = this.getLayerEntry();
    const nodeId = getNodeIdFromLayerSelectionState(entry?.state);
    if (entry === undefined || nodeId === undefined) return;
    const node =
      this.options.spatiallyIndexedSkeletonLayer.value === undefined
        ? undefined
        : this.findNode(nodeId);
    if (
      node === undefined ||
      node.segmentId === getSegmentIdFromLayerSelectionValue(entry.state)
    ) {
      return;
    }
    this.replaceLayerEntryState({ value: node.segmentId });
  }

  private remapSelectionEntry(
    nodeIdRemappings: ReadonlyMap<bigint, bigint>,
    segmentIdRemappings: ReadonlyMap<bigint, bigint>,
  ) {
    const entryState = this.getLayerEntryState();
    const nodeId = getNodeIdFromLayerSelectionState(entryState);
    const segmentId = getSegmentIdFromLayerSelectionValue(entryState);
    const nextNodeId =
      nodeId === undefined ? undefined : nodeIdRemappings.get(nodeId);
    const nextSegmentId =
      segmentId === undefined ? undefined : segmentIdRemappings.get(segmentId);
    if (nextNodeId === undefined && nextSegmentId === undefined) return;
    if (nextNodeId !== undefined) {
      const position = this.getKnownPosition(nodeId!);
      if (position !== undefined) {
        this.knownPosition = { nodeId: nextNodeId, position };
      }
    }
    this.replaceLayerEntryState({
      ...(nextNodeId === undefined ? {} : { nodeId: nextNodeId }),
      ...(nextSegmentId === undefined ? {} : { value: nextSegmentId }),
    });
  }

  private replaceLayerEntryState(changes: Partial<SkeletonNodeSelectionState>) {
    const { layer } = this.options;
    const { selectionState } = layer.manager.root;
    const selection = selectionState.value;
    if (selection === undefined) return;
    selectionState.value = {
      ...selection,
      layers: selection.layers.map((entry) =>
        entry.layer === layer
          ? { ...entry, state: { ...entry.state, ...changes } }
          : entry,
      ),
    };
  }
}

function toFloat32Position(position: ArrayLike<number> | undefined) {
  if (position === undefined || position instanceof Float32Array) {
    return position;
  }
  return new Float32Array(position);
}

function undefinedIfZero(value: bigint | undefined) {
  return value === 0n ? undefined : value;
}

function resolveHintPin(
  pin: SpatialSkeletonPreviewSelectionPin,
  currentPin: boolean,
): boolean | "force-unpin" {
  return pin === "pin" ? true : pin === "unpin" ? "force-unpin" : currentPin;
}

function transformModelPosition(
  transform: RenderLayerTransform,
  modelPosition: ArrayLike<number>,
) {
  const { rank } = transform;
  const paddedModelPosition = new Float32Array(rank);
  for (let i = 0; i < Math.min(modelPosition.length, rank); ++i) {
    paddedModelPosition[i] = Number(modelPosition[i]);
  }
  const layerPosition = new Float32Array(rank);
  matrix.transformPoint(
    layerPosition,
    transform.modelToRenderLayerTransform,
    rank + 1,
    paddedModelPosition,
    rank,
  );
  return layerPosition;
}
