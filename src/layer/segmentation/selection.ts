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

import type { LayerSelectedValues } from "#src/layer/index.js";
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { RefCounted } from "#src/util/disposable.js";
import { parseUint64 } from "#src/util/json.js";
import { NullarySignal } from "#src/util/signal.js";

interface SpatialSkeletonViewerHoverMouseStateLike<TRenderLayer> {
  active: boolean;
  pickedRenderLayer: TRenderLayer | null | undefined;
  pickedSpatialSkeleton?:
    | {
        nodeId?: unknown;
      }
    | undefined;
}

interface SpatialSkeletonViewerHoverLayerLike<TRenderLayer> {
  renderLayers: readonly TRenderLayer[];
}

export enum SpatialSkeletonSelectionRecoveryStatus {
  PENDING = "pending",
  FAILED = "failed",
}

const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function parseSelectionStateStringId(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const parsedValue = parseUint64(value);
    return parsedValue > 0n ? parsedValue : undefined;
  } catch {
    return undefined;
  }
}

function normalizeSelectionStateStringId(value: unknown) {
  const parsedValue = parseSelectionStateStringId(value);
  if (parsedValue === undefined || parsedValue > MAX_SAFE_INTEGER_BIGINT) {
    return undefined;
  }
  return Number(parsedValue);
}

function getSelectionIdString(value: unknown) {
  return parseSelectionStateStringId(value)?.toString();
}

function normalizeSelectionStateValueId(value: unknown) {
  try {
    const parsedValue = parseUint64(value);
    if (parsedValue <= 0n || parsedValue > MAX_SAFE_INTEGER_BIGINT) {
      return undefined;
    }
    return Number(parsedValue);
  } catch {
    return undefined;
  }
}

function getSelectionValueIdString(value: unknown) {
  try {
    const parsedValue = parseUint64(value);
    return parsedValue > 0n && parsedValue <= MAX_SAFE_INTEGER_BIGINT
      ? parsedValue.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeSpatialSkeletonViewerHoverNodeId(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

export function getNodeIdFromLayerSelectionState(
  state: { nodeId?: unknown; value?: unknown } | undefined,
) {
  return normalizeSelectionStateStringId(state?.nodeId);
}

export function getSegmentIdFromLayerSelectionValue(
  state: { nodeId?: unknown; value?: unknown } | undefined,
) {
  return normalizeSelectionStateValueId(state?.value);
}

export function getSpatialSkeletonSelectionRecoveryKey(
  state: { nodeId?: unknown; value?: unknown } | undefined,
) {
  const nodeId = getSelectionIdString(state?.nodeId);
  const segmentId = getSelectionValueIdString(state?.value);
  if (nodeId === undefined || segmentId === undefined) {
    return undefined;
  }
  return `${nodeId}:${segmentId}`;
}

export function getSpatialSkeletonMissingSelectionDisplayState(
  state: { nodeId?: unknown; value?: unknown } | undefined,
  options: {
    hasInspectableSource: boolean;
    hasCachedSegment: boolean;
    recoveryStatus: SpatialSkeletonSelectionRecoveryStatus | undefined;
  },
) {
  const recoveryKey = getSpatialSkeletonSelectionRecoveryKey(state);
  if (recoveryKey === undefined) {
    return {
      recoveryKey,
      recoveryStatus: undefined,
      shouldRequestRecovery: false,
      loading: false,
    };
  }
  const { hasInspectableSource, hasCachedSegment, recoveryStatus } = options;
  if (recoveryStatus === SpatialSkeletonSelectionRecoveryStatus.PENDING) {
    return {
      recoveryKey,
      recoveryStatus,
      shouldRequestRecovery: false,
      loading: true,
    };
  }
  const shouldRequestRecovery =
    !hasCachedSegment && hasInspectableSource && recoveryStatus === undefined;
  return {
    recoveryKey,
    recoveryStatus,
    shouldRequestRecovery,
    loading: shouldRequestRecovery,
  };
}

export function hasSpatialSkeletonNodeSelection(
  state: { nodeId?: unknown; value?: unknown } | undefined,
) {
  return getSelectionIdString(state?.nodeId) !== undefined;
}

export function getNodeIdFromViewerSelection<TLayer>(
  selection:
    | {
        layers: readonly {
          layer: TLayer;
          state: { nodeId?: unknown; value?: unknown };
        }[];
      }
    | undefined,
  layer: TLayer,
) {
  return getNodeIdFromLayerSelectionState(
    selection?.layers.find((entry) => entry.layer === layer)?.state,
  );
}

function getSpatialSkeletonNodeIdFromViewerHover<TRenderLayer>(
  mouseState: SpatialSkeletonViewerHoverMouseStateLike<TRenderLayer>,
  layer: SpatialSkeletonViewerHoverLayerLike<TRenderLayer>,
) {
  if (!mouseState.active) return undefined;
  const pickedRenderLayer = mouseState.pickedRenderLayer;
  if (pickedRenderLayer !== null) {
    if (
      pickedRenderLayer === undefined ||
      !layer.renderLayers.includes(pickedRenderLayer)
    ) {
      return undefined;
    }
  }
  // TODO (SKM): I think we can inline this function
  return normalizeSpatialSkeletonViewerHoverNodeId(
    mouseState.pickedSpatialSkeleton?.nodeId,
  );
}

export class SpatialSkeletonHoverState extends RefCounted {
  value: number | undefined = undefined;
  readonly changed = new NullarySignal();

  setValue(value: number | undefined) {
    if (this.value !== value) {
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
          getSpatialSkeletonNodeIdFromViewerHover(
            layerSelectedValues.mouseState,
            layer,
          ),
        );
      }),
    );
  }
}
