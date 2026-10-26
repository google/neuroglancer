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

import type { VisibleSegmentsState } from "#src/segmentation_display_state/base.js";
import { getVisibleSegments } from "#src/segmentation_display_state/base.js";
import {
  buildPendingEditMarkers,
  getPendingEditMarkerPrimitives,
} from "#src/skeleton/edit/pending_edit_markers.js";
import type { SpatialSkeletonEditSession } from "#src/skeleton/edit/spatial_skeleton_edit_session.js";
import type {
  SkeletonNodeRing,
  SkeletonPanelOverlayPrimitive,
} from "#src/skeleton/spatial/node_overlay.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import {
  getSaturation,
  pickHighestContrastColor,
  saturateColor,
  serializeColor,
  useWhiteBackground,
} from "#src/util/color.js";
import { RefCounted } from "#src/util/disposable.js";
import { vec3 } from "#src/util/geom.js";
import { NullarySignal } from "#src/util/signal.js";

const OUTLINE_FALLBACK_COLOR = vec3.fromValues(1.0, 0.95, 0.35);
const PROVISIONAL_SEGMENT_COLOR = vec3.fromValues(1.0, 0.0, 0.0);

// Muted colours, so a selected node reads as calmer than a hovered one.
const SELECTED_NODE_PALETTE: readonly vec3[] = [
  vec3.fromValues(0.1, 0.1, 0.1),
  vec3.fromValues(0.7, 0.67, 0.6),
  vec3.fromValues(0.5, 0.45, 0.15),
];

// A colour that is already saturated is desaturated instead, as getObjectColor does.
const HOVERED_SATURATION_CHANGE = 0.5;
const HOVERED_SATURATION_THRESHOLD = 0.5;

export interface HighlightedSkeletonNode {
  readonly nodeId: bigint;
  readonly segmentId?: bigint;
  readonly position?: Float32Array;
}

export interface SkeletonNodeHighlightSelection {
  readonly selected: WatchableValueInterface<
    HighlightedSkeletonNode | undefined
  >;
  readonly hovered: WatchableValueInterface<
    HighlightedSkeletonNode | undefined
  >;
  toGlobalPosition(
    modelPosition: ArrayLike<number> | undefined,
  ): Float32Array | undefined;
}

export interface SkeletonNodeHighlightDisplayState {
  readonly objectAlpha: WatchableValueInterface<number>;
  readonly hiddenObjectAlpha: WatchableValueInterface<number>;
  readonly segmentationGroupState: WatchableValueInterface<VisibleSegmentsState>;
  readonly segmentSelectionState: { readonly baseValue: bigint | undefined };
}

export type SkeletonNodeHighlightEditSession = Pick<
  SpatialSkeletonEditSession,
  | "suppressSelectedNodeHighlight"
  | "spatialSkeletonDisplay"
  | "provisionalSegmentIds"
  | "getDisplayedNode"
>;

export interface SkeletonNodeHighlightOptions {
  readonly displayState: SkeletonNodeHighlightDisplayState;
  readonly nodeSelection: SkeletonNodeHighlightSelection;
  readonly editSession: SkeletonNodeHighlightEditSession;
  readonly getBaseSegmentColor: (segmentId: bigint) => vec3;
}

export class SkeletonNodeHighlight extends RefCounted {
  readonly changed = new NullarySignal();

  constructor(private readonly options: SkeletonNodeHighlightOptions) {
    super();
    const { nodeSelection, editSession } = options;
    for (const signal of [
      nodeSelection.selected.changed,
      nodeSelection.hovered.changed,
      editSession.suppressSelectedNodeHighlight.changed,
    ]) {
      this.registerDisposer(signal.add(this.changed.dispatch));
    }
  }

  /** Omits a node whose position is unavailable or whose skeleton is not drawn. */
  computePrimitives(ring: SkeletonNodeRing): SkeletonPanelOverlayPrimitive[] {
    const { displayState, nodeSelection, editSession } = this.options;
    const objectAlpha = displayState.objectAlpha.value;
    const hiddenObjectAlpha = displayState.hiddenObjectAlpha.value;
    if (objectAlpha <= 0 && hiddenObjectAlpha <= 0) return [];
    const toGlobalPosition = (modelPosition: ArrayLike<number>) =>
      nodeSelection.toGlobalPosition(modelPosition);
    const primitives: SkeletonPanelOverlayPrimitive[] = [];
    const selected = editSession.suppressSelectedNodeHighlight.value
      ? undefined
      : nodeSelection.selected.value;
    const hovered = nodeSelection.hovered.value;
    // Hovered wins over selected, so one node never shows two rings.
    if (selected !== undefined && selected.nodeId !== hovered?.nodeId) {
      this.addMarker(primitives, selected, ring, (segmentColor) =>
        pickHighestContrastColor(SELECTED_NODE_PALETTE, segmentColor),
      );
    }
    if (hovered !== undefined) {
      this.addMarker(primitives, hovered, ring, (segmentColor) =>
        saturateColor(
          segmentColor,
          getSaturation(segmentColor) > HOVERED_SATURATION_THRESHOLD
            ? 1 - HOVERED_SATURATION_CHANGE
            : 1 + HOVERED_SATURATION_CHANGE,
        ),
      );
    }
    const { pendingEdits } = editSession.spatialSkeletonDisplay.value;
    if (pendingEdits.length !== 0) {
      primitives.push(
        ...getPendingEditMarkerPrimitives(
          buildPendingEditMarkers(
            pendingEdits,
            (nodeId) => editSession.getDisplayedNode(nodeId)?.position,
          ),
          ring,
          toGlobalPosition,
        ),
      );
    }
    return primitives;
  }

  private addMarker(
    primitives: SkeletonPanelOverlayPrimitive[],
    node: HighlightedSkeletonNode,
    ring: SkeletonNodeRing,
    getRingColor: (segmentColor: vec3) => vec3,
  ) {
    const { displayState, nodeSelection, editSession } = this.options;
    const { segmentId } = node;
    if (segmentId !== undefined) {
      // Matches the alpha the shader draws the skeleton with.
      const alpha = getVisibleSegments(
        displayState.segmentationGroupState.value,
      ).has(segmentId)
        ? displayState.objectAlpha.value
        : displayState.hiddenObjectAlpha.value;
      if (alpha <= 0) return;
    }
    // The displayed node includes a pending move.
    const position = nodeSelection.toGlobalPosition(
      editSession.getDisplayedNode(node.nodeId)?.position ?? node.position,
    );
    if (position === undefined) return;
    const segmentColor = this.getSegmentColor(
      segmentId ?? displayState.segmentSelectionState.baseValue,
    );
    const color =
      segmentColor === undefined
        ? OUTLINE_FALLBACK_COLOR
        : getRingColor(segmentColor);
    primitives.push({
      kind: "marker",
      position,
      color: serializeColor(color),
      outlineColor: useWhiteBackground(color)
        ? "rgba(255, 255, 255, 0.85)"
        : "rgba(0, 0, 0, 0.75)",
      ring,
    });
  }

  private getSegmentColor(segmentId: bigint | undefined) {
    if (segmentId === undefined) return undefined;
    if (this.options.editSession.provisionalSegmentIds.has(segmentId)) {
      return PROVISIONAL_SEGMENT_COLOR;
    }
    return vec3.clone(this.options.getBaseSegmentColor(segmentId));
  }
}
