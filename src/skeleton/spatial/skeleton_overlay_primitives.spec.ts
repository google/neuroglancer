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

import type { VisibleSegmentsState } from "#src/segmentation_display_state/base.js";
import { SpatialSkeletonEditSession } from "#src/skeleton/edit/spatial_skeleton_edit_session.js";
import type { HighlightedSkeletonNode } from "#src/skeleton/spatial/skeleton_overlay_primitives.js";
import { SkeletonOverlayPrimitives } from "#src/skeleton/spatial/skeleton_overlay_primitives.js";
import type { SkeletonNodeHighlightMarker } from "#src/skeleton/spatial/skeleton_panel_overlay.js";
import { WatchableValue } from "#src/trackable_value.js";
import { Uint64Set } from "#src/uint64_set.js";
import { getContrastRatio, getSaturation } from "#src/util/color.js";
import { vec3 } from "#src/util/geom.js";

const ring = { diameter: 10, borderWidth: 3 };

function makeOverlayPrimitives(
  options: {
    visible?: readonly bigint[];
    hiddenObjectAlpha?: number;
    segmentColors?: ReadonlyMap<bigint, vec3>;
  } = {},
) {
  const state = new SpatialSkeletonEditSession();
  const visibleSegments = new Uint64Set();
  visibleSegments.add([...(options.visible ?? [])]);
  const selected = new WatchableValue<HighlightedSkeletonNode | undefined>(
    undefined,
  );
  const hovered = new WatchableValue<HighlightedSkeletonNode | undefined>(
    undefined,
  );
  const overlayPrimitives = new SkeletonOverlayPrimitives({
    displayState: {
      objectAlpha: new WatchableValue(1),
      hiddenObjectAlpha: new WatchableValue(options.hiddenObjectAlpha ?? 0.5),
      segmentationGroupState: new WatchableValue({
        visibleSegments,
        temporaryVisibleSegments: new Uint64Set(),
        useTemporaryVisibleSegments: new WatchableValue(false),
      } as unknown as VisibleSegmentsState),
      segmentSelectionState: { baseValue: undefined },
    },
    nodeSelection: {
      selected,
      hovered,
      toGlobalPosition: (modelPosition) =>
        modelPosition === undefined
          ? undefined
          : Float32Array.from(modelPosition),
    },
    editSession: state,
    getBaseSegmentColor: (segmentId) =>
      options.segmentColors?.get(segmentId) ?? vec3.fromValues(0.2, 0.6, 0.9),
  });
  return { overlayPrimitives, state, selected, hovered };
}

function makeNode(nodeId: bigint, segmentId: bigint, x = Number(nodeId)) {
  return { nodeId, segmentId, position: new Float32Array([x, 0, 0]) };
}

function getMarkers(overlayPrimitives: SkeletonOverlayPrimitives) {
  return overlayPrimitives
    .computePrimitives(ring)
    .filter(
      (primitive): primitive is SkeletonNodeHighlightMarker =>
        primitive.kind === "marker",
    );
}

function parseColor(hexColor: string) {
  return vec3.fromValues(
    ...([1, 3, 5].map(
      (offset) => parseInt(hexColor.slice(offset, offset + 2), 16) / 255,
    ) as [number, number, number]),
  );
}

describe("SkeletonOverlayPrimitives", () => {
  it("rings the selected node and the hovered node", () => {
    const { overlayPrimitives, selected, hovered } = makeOverlayPrimitives({
      visible: [7n],
    });
    selected.value = makeNode(1n, 7n);
    hovered.value = makeNode(2n, 7n);

    expect(
      getMarkers(overlayPrimitives).map((marker) => [...marker.position]),
    ).toEqual([
      [1, 0, 0],
      [2, 0, 0],
    ]);
  });

  it("shows one ring when the hovered node is also the selected node", () => {
    const { overlayPrimitives, selected, hovered } = makeOverlayPrimitives({
      visible: [7n],
    });
    selected.value = makeNode(1n, 7n);
    hovered.value = makeNode(1n, 7n);

    expect(getMarkers(overlayPrimitives)).toHaveLength(1);
  });

  it("hides the selected node's ring while the selection highlight is suppressed", () => {
    const { overlayPrimitives, state, selected } = makeOverlayPrimitives({
      visible: [7n],
    });
    selected.value = makeNode(1n, 7n);

    state.suppressSelectedNodeHighlight.value = true;

    expect(getMarkers(overlayPrimitives)).toEqual([]);
  });

  it("draws no ring for a node whose skeleton is fully transparent", () => {
    const { overlayPrimitives, hovered } = makeOverlayPrimitives({
      visible: [],
      hiddenObjectAlpha: 0,
    });

    hovered.value = makeNode(1n, 7n);

    expect(getMarkers(overlayPrimitives)).toEqual([]);
  });

  it("follows a node while it is dragged to a new position", () => {
    const { overlayPrimitives, state, selected } = makeOverlayPrimitives({
      visible: [7n],
    });
    state.replaceCachedSegmentSnapshots([[7n, [makeNode(1n, 7n)]]]);
    selected.value = makeNode(1n, 7n);

    state.setPendingNodePosition(1n, [40, 5, 0]);

    expect([...getMarkers(overlayPrimitives)[0].position]).toEqual([40, 5, 0]);
  });

  it("gives the selected node's ring a colour that contrasts with its skeleton's colour", () => {
    const white = vec3.fromValues(1, 1, 1);
    const black = vec3.fromValues(0, 0, 0);
    const { overlayPrimitives, selected } = makeOverlayPrimitives({
      visible: [7n, 8n],
      segmentColors: new Map([
        [7n, white],
        [8n, black],
      ]),
    });

    selected.value = makeNode(1n, 7n);
    const onWhite = parseColor(getMarkers(overlayPrimitives)[0].color);
    selected.value = makeNode(2n, 8n);
    const onBlack = parseColor(getMarkers(overlayPrimitives)[0].color);

    expect(getContrastRatio(onWhite, white)).toBeGreaterThan(4);
    expect(getContrastRatio(onBlack, black)).toBeGreaterThan(4);
  });

  it("tints the hovered ring with its skeleton's colour, never black or white", () => {
    const red = vec3.fromValues(1, 0, 0);
    const { overlayPrimitives, hovered } = makeOverlayPrimitives({
      visible: [7n],
      segmentColors: new Map([[7n, red]]),
    });

    hovered.value = makeNode(1n, 7n);
    const color = parseColor(getMarkers(overlayPrimitives)[0].color);

    expect(getSaturation(color)).toBeGreaterThan(0);
    expect(color[0]).toBeGreaterThan(color[1]);
    expect(color[0]).toBeGreaterThan(color[2]);
  });

  it("draws the ring of a provisional skeleton in the provisional colour", () => {
    const { overlayPrimitives, state, hovered } = makeOverlayPrimitives({
      visible: [7n],
    });
    state.provisionalSegmentIds.add(7n);

    hovered.value = makeNode(1n, 7n);

    // A saturated red hovered ring is desaturated towards grey.
    const color = parseColor(getMarkers(overlayPrimitives)[0].color);
    expect(color[0]).toBeGreaterThan(0.5);
    expect(color[1]).toBeCloseTo(color[2]);
    expect(color[1]).toBeLessThan(color[0]);
  });

  it("marks each queued edit on the nodes it changes", () => {
    const { overlayPrimitives, state } = makeOverlayPrimitives({
      visible: [7n],
    });
    state.replaceCachedSegmentSnapshots([[7n, [makeNode(1n, 7n)]]]);

    state.addSpatialSkeletonPendingEdit({
      intentId: 1,
      sequence: 1,
      direction: "execute",
      kind: "delete",
      lifecycle: "preparing",
      segmentIds: [7n],
      nodeId: 1n,
    });

    expect(overlayPrimitives.computePrimitives(ring)).toEqual([
      expect.objectContaining({
        kind: "preparationMarker",
        label: "×",
        position: new Float32Array([1, 0, 0]),
      }),
    ]);
  });
});
