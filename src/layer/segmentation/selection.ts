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
  PickedSpatialSkeletonState,
} from "#src/layer/index.js";
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { RefCounted } from "#src/util/disposable.js";
import { parseUint64 } from "#src/util/json.js";
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
  return typeof nodeId === "string" ? parseSelectionStateId(nodeId) : undefined;
}

// Segment 0 means no segment.
export function getSegmentIdFromLayerSelectionValue(
  state: { nodeId?: unknown; value?: unknown } | undefined,
) {
  const segmentId = parseSelectionStateId(state?.value);
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

  bindTo(
    layerSelectedValues: LayerSelectedValues,
    layer: SegmentationUserLayer,
  ) {
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
