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
  getSegmentIdFromLayerSelectionValue,
  hasSkeletonNodeSelection,
  SkeletonHoverState,
} from "#src/layer/segmentation/selection.js";

describe("layer/segmentation/selection", () => {
  it("recognizes field-based spatial skeleton node selections", () => {
    expect(
      hasSkeletonNodeSelection({
        nodeId: "17",
        value: 9n,
      }),
    ).toBe(true);
    expect(
      hasSkeletonNodeSelection({
        nodeId: "18446744073709551615",
      }),
    ).toBe(true);
    expect(
      hasSkeletonNodeSelection({
        nodeId: 17n,
      }),
    ).toBe(false);
    expect(
      hasSkeletonNodeSelection({
        nodeId: 0n,
      }),
    ).toBe(false);
    expect(hasSkeletonNodeSelection({})).toBe(false);
  });

  it("extracts node and segment ids from a layer selection state", () => {
    expect(
      getNodeIdFromLayerSelectionState({
        nodeId: "23",
        value: 7n,
      }),
    ).toBe(23n);
    expect(
      getSegmentIdFromLayerSelectionValue({
        nodeId: "23",
        value: "7",
      }),
    ).toBe(7n);
    expect(
      getNodeIdFromLayerSelectionState({
        nodeId: 0n,
      }),
    ).toBeUndefined();
    expect(
      getSegmentIdFromLayerSelectionValue({
        value: "9",
      }),
    ).toBe(9n);
    expect(
      getNodeIdFromLayerSelectionState({
        nodeId: "18446744073709551615",
      }),
    ).toBe(18446744073709551615n);
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
