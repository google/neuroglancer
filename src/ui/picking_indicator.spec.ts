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
import type { CoordinateSpace } from "#src/coordinate_transform.js";
import { makeCoordinateSpace } from "#src/coordinate_transform.js";
import {
  applyRenderViewportToProjectionMatrix,
  RenderViewport,
} from "#src/display_context.js";
import type { MouseSelectionState } from "#src/layer/index.js";
import type { NavigationState } from "#src/navigation_state.js";
import type { ProjectionParameters } from "#src/projection_parameters.js";
import type { WatchableValueChangeInterface } from "#src/trackable_value.js";
import { WatchableValue } from "#src/trackable_value.js";
import { PanelOverlays } from "#src/ui/panel_overlays.js";
import { PickingIndicator } from "#src/ui/picking_indicator.js";
import { mat4 } from "#src/util/geom.js";
import { NullarySignal } from "#src/util/signal.js";
import {
  ScreenshotMode,
  TrackableScreenshotMode,
} from "#src/util/trackable_screenshot_mode.js";

function makeCoordinateSpaceXyz(): CoordinateSpace {
  return makeCoordinateSpace({
    names: ["x", "y", "z"],
    units: ["m", "m", "m"],
    scales: Float64Array.of(1, 1, 1),
  });
}

function makePerspectiveParameters(options: {
  focalDistance: number;
  nearDistance: number;
  farDistance: number;
  logicalWidth: number;
  logicalHeight: number;
}): ProjectionParameters {
  const {
    focalDistance,
    nearDistance,
    farDistance,
    logicalWidth,
    logicalHeight,
  } = options;
  const renderViewport = Object.assign(new RenderViewport(), {
    logicalWidth,
    logicalHeight,
    visibleWidthFraction: 1,
    visibleHeightFraction: 1,
  });
  const projectionMat = mat4.perspective(
    mat4.create(),
    Math.PI / 2,
    logicalWidth / logicalHeight,
    nearDistance,
    farDistance,
  );
  applyRenderViewportToProjectionMatrix(renderViewport, projectionMat);
  const viewMatrix = mat4.fromTranslation(mat4.create(), [
    0,
    0,
    -focalDistance,
  ]);
  return {
    ...renderViewport,
    projectionMat,
    viewProjectionMat: mat4.multiply(mat4.create(), projectionMat, viewMatrix),
    globalPosition: Float32Array.of(0, 0, 0),
    displayDimensionRenderInfo: {
      displayDimensionIndices: Int32Array.of(0, 1, 2),
    },
  } as unknown as ProjectionParameters;
}

function makePanel(options: {
  coordinateSpace: CoordinateSpace;
  projectionParameters: ProjectionParameters;
}) {
  return {
    element: document.createElement("div"),
    mouseX: -1,
    mouseY: -1,
    navigationState: {
      coordinateSpace: new WatchableValue(options.coordinateSpace),
    } as unknown as NavigationState,
    projectionParameters: {
      value: options.projectionParameters,
    } as WatchableValueChangeInterface<ProjectionParameters>,
  };
}

function makeMouseState(
  position: number[],
  coordinateSpace: CoordinateSpace,
): MouseSelectionState {
  return {
    active: true,
    position: Float32Array.from(position),
    coordinateSpace,
    changed: new NullarySignal(),
  } as unknown as MouseSelectionState;
}

function nextAnimationFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function isShown(element: HTMLElement) {
  for (
    let ancestor: HTMLElement | null = element;
    ancestor !== null;
    ancestor = ancestor.parentElement
  ) {
    if (ancestor.hidden) return false;
  }
  return true;
}

function getRingCentre(ring: HTMLElement): number[] {
  const [left, top] = ring.style.transform.match(/-?[\d.]+/g)!.map(Number);
  const radius = parseFloat(ring.style.width) / 2;
  return [left + radius, top + radius];
}

describe("PickingIndicator", () => {
  it("centres the ring on the picked point", () => {
    const panel = makePanel({
      coordinateSpace: makeCoordinateSpaceXyz(),
      projectionParameters: makePerspectiveParameters({
        focalDistance: 1,
        nearDistance: 0.5,
        farDistance: 1.5,
        logicalWidth: 200,
        logicalHeight: 100,
      }),
    });
    const overlays = new PanelOverlays(
      panel.element,
      new TrackableScreenshotMode(ScreenshotMode.OFF),
    );
    const indicator = new PickingIndicator(
      panel,
      makeMouseState([0, 0, 0], makeCoordinateSpaceXyz()),
      new WatchableValue(true),
    );
    overlays.add(indicator);
    overlays.frameDrawn();

    const ring = indicator.element;
    expect(panel.element.contains(ring)).toBe(true);
    expect(isShown(ring)).toBe(true);
    expect(getRingCentre(ring)).toEqual([100, 50]);
  });

  it("fades the ring by depth in a panel the cursor is not in", () => {
    const panel = makePanel({
      coordinateSpace: makeCoordinateSpaceXyz(),
      projectionParameters: makePerspectiveParameters({
        focalDistance: 1,
        nearDistance: 0.5,
        farDistance: 1.5,
        logicalWidth: 200,
        logicalHeight: 100,
      }),
    });
    const overlays = new PanelOverlays(
      panel.element,
      new TrackableScreenshotMode(ScreenshotMode.OFF),
    );
    const halfWayToFar = [0, 0, -0.25];
    const indicator = new PickingIndicator(
      panel,
      makeMouseState(halfWayToFar, makeCoordinateSpaceXyz()),
      new WatchableValue(true),
    );
    overlays.add(indicator);
    overlays.frameDrawn();

    expect(indicator.element.style.opacity).toBe("0.5");
  });

  it("draws the ring larger for a nearer pick, without a redraw", async () => {
    const panel = makePanel({
      coordinateSpace: makeCoordinateSpaceXyz(),
      projectionParameters: makePerspectiveParameters({
        focalDistance: 1,
        nearDistance: 0.5,
        farDistance: 1.5,
        logicalWidth: 200,
        logicalHeight: 100,
      }),
    });
    const overlays = new PanelOverlays(
      panel.element,
      new TrackableScreenshotMode(ScreenshotMode.OFF),
    );
    const mouseState = makeMouseState([0, 0, 0], makeCoordinateSpaceXyz());
    const indicator = new PickingIndicator(
      panel,
      mouseState,
      new WatchableValue(true),
    );
    overlays.add(indicator);
    overlays.frameDrawn();
    const ring = indicator.element;
    const focalPlaneWidth = parseFloat(ring.style.width);

    const twoThirdsOfTheFocalDistance = [0, 0, 1 / 3];
    mouseState.position.set(twoThirdsOfTheFocalDistance);
    mouseState.changed.dispatch();
    await nextAnimationFrame();

    expect(parseFloat(ring.style.width)).toBeCloseTo(1.5 * focalPlaneWidth);
    expect(getRingCentre(ring)).toEqual([100, 50]);
  });

  it("follows a new pick to another point, without a redraw", async () => {
    const panel = makePanel({
      coordinateSpace: makeCoordinateSpaceXyz(),
      projectionParameters: makePerspectiveParameters({
        focalDistance: 1,
        nearDistance: 0.5,
        farDistance: 1.5,
        logicalWidth: 200,
        logicalHeight: 100,
      }),
    });
    const overlays = new PanelOverlays(
      panel.element,
      new TrackableScreenshotMode(ScreenshotMode.OFF),
    );
    const mouseState = makeMouseState([0, 0, 0], makeCoordinateSpaceXyz());
    const indicator = new PickingIndicator(
      panel,
      mouseState,
      new WatchableValue(true),
    );
    overlays.add(indicator);
    overlays.frameDrawn();

    const halfWayToTheRightEdge = [1, 0, 0];
    mouseState.position.set(halfWayToTheRightEdge);
    mouseState.changed.dispatch();
    await nextAnimationFrame();

    expect(getRingCentre(indicator.element)).toEqual([150, 50]);
  });

  it("draws the ring at full opacity in the panel the cursor is in", async () => {
    const panel = makePanel({
      coordinateSpace: makeCoordinateSpaceXyz(),
      projectionParameters: makePerspectiveParameters({
        focalDistance: 1,
        nearDistance: 0.5,
        farDistance: 1.5,
        logicalWidth: 200,
        logicalHeight: 100,
      }),
    });
    const overlays = new PanelOverlays(
      panel.element,
      new TrackableScreenshotMode(ScreenshotMode.OFF),
    );
    const halfWayToFar = [0, 0, -0.25];
    const indicator = new PickingIndicator(
      panel,
      makeMouseState(halfWayToFar, makeCoordinateSpaceXyz()),
      new WatchableValue(true),
    );
    overlays.add(indicator);
    overlays.frameDrawn();

    panel.mouseX = 100;
    panel.mouseY = 50;
    overlays.mouseMoved();
    await nextAnimationFrame();

    expect(indicator.element.style.opacity).toBe("1");
  });

  it("keeps the ring under the cursor in its own panel before the pick completes", async () => {
    const panel = makePanel({
      coordinateSpace: makeCoordinateSpaceXyz(),
      projectionParameters: makePerspectiveParameters({
        focalDistance: 1,
        nearDistance: 0.5,
        farDistance: 1.5,
        logicalWidth: 200,
        logicalHeight: 100,
      }),
    });
    const overlays = new PanelOverlays(
      panel.element,
      new TrackableScreenshotMode(ScreenshotMode.OFF),
    );
    const indicator = new PickingIndicator(
      panel,
      makeMouseState([0, 0, 0], makeCoordinateSpaceXyz()),
      new WatchableValue(true),
    );
    overlays.add(indicator);
    overlays.frameDrawn();

    panel.mouseX = 30;
    panel.mouseY = 40;
    overlays.mouseMoved();
    await nextAnimationFrame();

    expect(getRingCentre(indicator.element)).toEqual([30, 40]);
  });

  it("hides the ring when nothing is picked", () => {
    const panel = makePanel({
      coordinateSpace: makeCoordinateSpaceXyz(),
      projectionParameters: makePerspectiveParameters({
        focalDistance: 1,
        nearDistance: 0.5,
        farDistance: 1.5,
        logicalWidth: 200,
        logicalHeight: 100,
      }),
    });
    const overlays = new PanelOverlays(
      panel.element,
      new TrackableScreenshotMode(ScreenshotMode.OFF),
    );
    const mouseState = makeMouseState([0, 0, 0], makeCoordinateSpaceXyz());
    mouseState.active = false;
    const indicator = new PickingIndicator(
      panel,
      mouseState,
      new WatchableValue(true),
    );
    overlays.add(indicator);
    overlays.frameDrawn();

    expect(isShown(indicator.element)).toBe(false);
  });

  it("hides the ring for a pick in another coordinate space", () => {
    const panel = makePanel({
      coordinateSpace: makeCoordinateSpaceXyz(),
      projectionParameters: makePerspectiveParameters({
        focalDistance: 1,
        nearDistance: 0.5,
        farDistance: 1.5,
        logicalWidth: 200,
        logicalHeight: 100,
      }),
    });
    const overlays = new PanelOverlays(
      panel.element,
      new TrackableScreenshotMode(ScreenshotMode.OFF),
    );
    const otherSpace = makeCoordinateSpace({
      names: ["a", "b", "c"],
      units: ["m", "m", "m"],
      scales: Float64Array.of(1, 1, 1),
    });
    const indicator = new PickingIndicator(
      panel,
      makeMouseState([0, 0, 0], otherSpace),
      new WatchableValue(true),
    );
    overlays.add(indicator);
    overlays.frameDrawn();

    expect(isShown(indicator.element)).toBe(false);
  });

  it("shows the ring as soon as the picking indicator setting is turned on", async () => {
    const panel = makePanel({
      coordinateSpace: makeCoordinateSpaceXyz(),
      projectionParameters: makePerspectiveParameters({
        focalDistance: 1,
        nearDistance: 0.5,
        farDistance: 1.5,
        logicalWidth: 200,
        logicalHeight: 100,
      }),
    });
    const overlays = new PanelOverlays(
      panel.element,
      new TrackableScreenshotMode(ScreenshotMode.OFF),
    );
    const showPickingIndicator = new WatchableValue(false);
    const indicator = new PickingIndicator(
      panel,
      makeMouseState([0, 0, 0], makeCoordinateSpaceXyz()),
      showPickingIndicator,
    );
    overlays.add(indicator);
    overlays.frameDrawn();
    expect(isShown(indicator.element)).toBe(false);

    showPickingIndicator.value = true;
    await nextAnimationFrame();
    expect(isShown(indicator.element)).toBe(true);
  });
});
