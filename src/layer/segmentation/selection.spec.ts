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

import { describe, expect, it } from "vitest";

import type { LayerSelectedValues } from "#src/layer/index.js";
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import {
  getNodeIdFromLayerSelectionState,
  getNodeIdFromViewerSelection,
  getSegmentIdFromLayerSelectionValue,
  getSpatialSkeletonMissingSelectionDisplayState,
  getSpatialSkeletonSelectionRecoveryKey,
  hasSpatialSkeletonNodeSelection,
  SpatialSkeletonHoverState,
  SpatialSkeletonSelectionRecoveryStatus,
} from "#src/layer/segmentation/selection.js";

describe("layer/segmentation/selection", () => {
  it("recognizes field-based spatial skeleton node selections", () => {
    expect(
      hasSpatialSkeletonNodeSelection({
        nodeId: "17",
        value: 9n,
      }),
    ).toBe(true);
    expect(
      hasSpatialSkeletonNodeSelection({
        nodeId: "18446744073709551615",
      }),
    ).toBe(true);
    expect(
      hasSpatialSkeletonNodeSelection({
        nodeId: 17,
      }),
    ).toBe(false);
    expect(
      hasSpatialSkeletonNodeSelection({
        nodeId: 0,
      }),
    ).toBe(false);
    expect(hasSpatialSkeletonNodeSelection({})).toBe(false);
  });

  it("extracts node and segment ids from a layer selection state", () => {
    expect(
      getNodeIdFromLayerSelectionState({
        nodeId: "23",
        value: 7n,
      }),
    ).toBe(23);
    expect(
      getSegmentIdFromLayerSelectionValue({
        nodeId: "23",
        value: "7",
      }),
    ).toBe(7);
    expect(
      getNodeIdFromLayerSelectionState({
        nodeId: -1,
      }),
    ).toBeUndefined();
    expect(
      getSegmentIdFromLayerSelectionValue({
        value: "9",
      }),
    ).toBe(9);
    expect(
      getSpatialSkeletonSelectionRecoveryKey({
        nodeId: "23",
        value: 7n,
      }),
    ).toBe("23:7");
    expect(
      getNodeIdFromLayerSelectionState({
        nodeId: "18446744073709551615",
      }),
    ).toBeUndefined();
    expect(
      getSpatialSkeletonSelectionRecoveryKey({
        nodeId: 23,
      }),
    ).toBeUndefined();
  });

  it("extracts the selected node id for the matching layer", () => {
    const layerA = {};
    const layerB = {};
    expect(
      getNodeIdFromViewerSelection(
        {
          layers: [
            {
              layer: layerA,
              state: {},
            },
            {
              layer: layerB,
              state: {
                nodeId: "31",
                value: 8n,
              },
            },
          ],
        },
        layerB,
      ),
    ).toBe(31);
    expect(
      getNodeIdFromViewerSelection(
        {
          layers: [
            {
              layer: layerA,
              state: {
                nodeId: 4,
              },
            },
          ],
        },
        layerB,
      ),
    ).toBeUndefined();
  });

  it("extracts the hovered node id only for matching render layers", () => {
    // Create mock state, layers, and signal handlers
    const renderLayerA = {};
    const renderLayerB = {};
    const layer = { renderLayers: [renderLayerA] };
    let mouseState: {
      active: boolean;
      pickedRenderLayer: unknown;
      pickedSpatialSkeleton?: { nodeId?: unknown };
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
    const hoverState = new SpatialSkeletonHoverState();
    hoverState.bindTo(
      layerSelectedValues as LayerSelectedValues,
      layer as SegmentationUserLayer,
    );
    const trigger = () => handlers.forEach((h) => h());

    mouseState = {
      active: true,
      pickedRenderLayer: renderLayerA,
      pickedSpatialSkeleton: { nodeId: 31 },
    };
    trigger();
    expect(hoverState.value).toBe(31);

    mouseState = {
      active: true,
      pickedRenderLayer: renderLayerB,
      pickedSpatialSkeleton: { nodeId: 31 },
    };
    trigger();
    expect(hoverState.value).toBeUndefined();

    mouseState = {
      active: false,
      pickedRenderLayer: renderLayerA,
      pickedSpatialSkeleton: { nodeId: 31 },
    };
    trigger();
    expect(hoverState.value).toBeUndefined();

    mouseState = {
      active: true,
      pickedRenderLayer: renderLayerA,
      pickedSpatialSkeleton: { nodeId: -1 },
    };
    trigger();
    expect(hoverState.value).toBeUndefined();

    hoverState.dispose();
  });

  it("requests selection recovery only when a full-segment fetch can help", () => {
    expect(
      getSpatialSkeletonMissingSelectionDisplayState(
        {
          nodeId: "31",
          value: 8n,
        },
        {
          hasInspectableSource: true,
          hasCachedSegment: false,
          recoveryStatus: undefined,
        },
      ),
    ).toEqual({
      recoveryKey: "31:8",
      recoveryStatus: undefined,
      shouldRequestRecovery: true,
      loading: true,
    });
    expect(
      getSpatialSkeletonMissingSelectionDisplayState(
        {
          nodeId: "31",
          value: 8n,
        },
        {
          hasInspectableSource: true,
          hasCachedSegment: false,
          recoveryStatus: SpatialSkeletonSelectionRecoveryStatus.PENDING,
        },
      ),
    ).toEqual({
      recoveryKey: "31:8",
      recoveryStatus: SpatialSkeletonSelectionRecoveryStatus.PENDING,
      shouldRequestRecovery: false,
      loading: true,
    });
    expect(
      getSpatialSkeletonMissingSelectionDisplayState(
        {
          nodeId: "31",
          value: 8n,
        },
        {
          hasInspectableSource: true,
          hasCachedSegment: true,
          recoveryStatus: undefined,
        },
      ),
    ).toEqual({
      recoveryKey: "31:8",
      recoveryStatus: undefined,
      shouldRequestRecovery: false,
      loading: false,
    });
    expect(
      getSpatialSkeletonMissingSelectionDisplayState(
        {
          nodeId: "31",
          value: 8n,
        },
        {
          hasInspectableSource: true,
          hasCachedSegment: false,
          recoveryStatus: SpatialSkeletonSelectionRecoveryStatus.FAILED,
        },
      ),
    ).toEqual({
      recoveryKey: "31:8",
      recoveryStatus: SpatialSkeletonSelectionRecoveryStatus.FAILED,
      shouldRequestRecovery: false,
      loading: false,
    });
    expect(
      getSpatialSkeletonMissingSelectionDisplayState(
        {
          nodeId: 31,
        },
        {
          hasInspectableSource: true,
          hasCachedSegment: false,
          recoveryStatus: undefined,
        },
      ),
    ).toEqual({
      recoveryKey: undefined,
      recoveryStatus: undefined,
      shouldRequestRecovery: false,
      loading: false,
    });
  });
});
