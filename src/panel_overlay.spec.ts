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
import { emptyInvalidCoordinateSpace } from "#src/coordinate_transform.js";
import {
  applyRenderViewportToProjectionMatrix,
  RenderViewport,
} from "#src/display_context.js";
import type { MouseSelectionState } from "#src/layer/index.js";
import {
  PanelOverlayManager,
  PickingIndicator,
  projectToViewport,
} from "#src/panel_overlay.js";
import type { ProjectionParameters } from "#src/projection_parameters.js";
import { WatchableValue } from "#src/trackable_value.js";
import { mat4 } from "#src/util/geom.js";
import { NullarySignal } from "#src/util/signal.js";

function makeParameters(options: {
  projectionMat: mat4;
  focalDistance: number;
  logicalWidth: number;
  logicalHeight: number;
  visibleRegion?: {
    leftFraction: number;
    topFraction: number;
    widthFraction: number;
    heightFraction: number;
  };
}): ProjectionParameters {
  const {
    focalDistance,
    logicalWidth,
    logicalHeight,
    visibleRegion = {
      leftFraction: 0,
      topFraction: 0,
      widthFraction: 1,
      heightFraction: 1,
    },
  } = options;
  const renderViewport = Object.assign(new RenderViewport(), {
    logicalWidth,
    logicalHeight,
    visibleLeftFraction: visibleRegion.leftFraction,
    visibleTopFraction: visibleRegion.topFraction,
    visibleWidthFraction: visibleRegion.widthFraction,
    visibleHeightFraction: visibleRegion.heightFraction,
  });
  const projectionMat = mat4.clone(options.projectionMat);
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

function makeMouseState(): MouseSelectionState {
  return {
    active: true,
    position: new Float32Array([0, 0, 0]),
    coordinateSpace: emptyInvalidCoordinateSpace,
    changed: new NullarySignal(),
  } as unknown as MouseSelectionState;
}

function getRingCentre(ring: HTMLElement): number[] {
  const [left, top] = ring.style.transform.match(/-?[\d.]+/g)!.map(Number);
  const radius = parseFloat(ring.style.width) / 2;
  return [left + radius, top + radius];
}

describe("projectToViewport", () => {
  it("puts the focal point at the panel center, on the focal plane", () => {
    for (const projectionMat of [
      mat4.perspective(mat4.create(), Math.PI / 2, 2, 0.5, 1.5),
      mat4.ortho(mat4.create(), -2, 2, -1, 1, 0.5, 1.5),
    ]) {
      const parameters = makeParameters({
        projectionMat,
        focalDistance: 1,
        logicalWidth: 200,
        logicalHeight: 100,
      });
      const point = projectToViewport(parameters, [0, 0, 0])!;
      expect(point.viewportLeft).toBeCloseTo(100);
      expect(point.viewportTop).toBeCloseTo(50);
      expect(point.perspectiveDivideFactor).toBeCloseTo(1);
      expect(point.focalPlaneDepthFraction).toBeCloseTo(0);
    }
  });

  it("magnifies a nearer point only under perspective projection", () => {
    const perspective = makeParameters({
      projectionMat: mat4.perspective(mat4.create(), Math.PI / 2, 2, 0.5, 1.5),
      focalDistance: 1,
      logicalWidth: 200,
      logicalHeight: 100,
    });
    const orthographic = makeParameters({
      projectionMat: mat4.ortho(mat4.create(), -2, 2, -1, 1, 0.5, 1.5),
      focalDistance: 1,
      logicalWidth: 200,
      logicalHeight: 100,
    });
    const halfWayToNear = [0, 0, 0.5];
    expect(
      projectToViewport(perspective, halfWayToNear)!.perspectiveDivideFactor,
    ).toBeCloseTo(2);
    expect(
      projectToViewport(orthographic, halfWayToNear)!.perspectiveDivideFactor,
    ).toBeCloseTo(1);
  });

  it("keeps the focal point at the panel center when part of the panel is clipped", () => {
    const parameters = makeParameters({
      projectionMat: mat4.perspective(mat4.create(), Math.PI / 2, 2, 0.5, 1.5),
      focalDistance: 1,
      logicalWidth: 200,
      logicalHeight: 100,
      visibleRegion: {
        leftFraction: 0.5,
        topFraction: 0.25,
        widthFraction: 0.5,
        heightFraction: 0.75,
      },
    });
    const point = projectToViewport(parameters, [0, 0, 0])!;
    expect(point.viewportLeft).toBeCloseTo(100);
    expect(point.viewportTop).toBeCloseTo(50);
  });

  it("gives no position for a point beyond the far plane", () => {
    for (const projectionMat of [
      mat4.perspective(mat4.create(), Math.PI / 2, 2, 0.5, 1.5),
      mat4.ortho(mat4.create(), -2, 2, -1, 1, 0.5, 1.5),
    ]) {
      const parameters = makeParameters({
        projectionMat,
        focalDistance: 1,
        logicalWidth: 200,
        logicalHeight: 100,
      });
      const twiceTheFocalDistance = [0, 0, -1];
      expect(projectToViewport(parameters, twiceTheFocalDistance)).toBe(
        undefined,
      );
    }
  });

  it("measures depth linearly from the focal plane under both projections", () => {
    const perspective = makeParameters({
      projectionMat: mat4.perspective(mat4.create(), Math.PI / 2, 2, 0.5, 1.5),
      focalDistance: 1,
      logicalWidth: 200,
      logicalHeight: 100,
    });
    const orthographic = makeParameters({
      projectionMat: mat4.ortho(mat4.create(), -2, 2, -1, 1, 0.5, 1.5),
      focalDistance: 1,
      logicalWidth: 200,
      logicalHeight: 100,
    });
    const halfWayToFar = [0, 0, -0.25];
    expect(
      projectToViewport(perspective, halfWayToFar)!.focalPlaneDepthFraction,
    ).toBeCloseTo(0.5);
    expect(
      projectToViewport(orthographic, halfWayToFar)!.focalPlaneDepthFraction,
    ).toBeCloseTo(0.5);
  });

  it("measures depth linearly from the focal plane to each clipping plane when the near plane is closer than the far plane", () => {
    for (const projectionMat of [
      mat4.perspective(mat4.create(), Math.PI / 2, 2, 0.1, 3),
      mat4.ortho(mat4.create(), -2, 2, -1, 1, 0.1, 3),
    ]) {
      const parameters = makeParameters({
        projectionMat,
        focalDistance: 1,
        logicalWidth: 200,
        logicalHeight: 100,
      });
      const depthAt = (z: number) =>
        projectToViewport(parameters, [0, 0, z])!.focalPlaneDepthFraction;
      const atFocus = 0;
      const atNearPlane = 0.9;
      const atFarPlane = -2;
      const halfWayToFar = -1;
      expect(depthAt(atFocus)).toBeCloseTo(0);
      expect(depthAt(atNearPlane)).toBeCloseTo(-1);
      expect(depthAt(atFarPlane)).toBeCloseTo(1);
      expect(depthAt(halfWayToFar)).toBeCloseTo(0.5);
    }
  });

  it("measures depth from the slice plane when the clipping planes lie on both sides of the camera", () => {
    const parameters = makeParameters({
      projectionMat: mat4.ortho(mat4.create(), -2, 2, -1, 1, -4, 4),
      focalDistance: 0,
      logicalWidth: 200,
      logicalHeight: 100,
    });
    const depthAt = (z: number) =>
      projectToViewport(parameters, [0, 0, z])!.focalPlaneDepthFraction;
    expect(depthAt(0)).toBeCloseTo(0);
    expect(depthAt(4)).toBeCloseTo(-1);
    expect(depthAt(-4)).toBeCloseTo(1);
    expect(depthAt(-2)).toBeCloseTo(0.5);
  });
});

describe("PickingIndicator", () => {
  it("centres one ring on the picked point and fades it by depth", () => {
    const panel = document.createElement("div");
    const manager = new PanelOverlayManager(
      panel,
      () => ({
        viewportLeft: 100,
        viewportTop: 50,
        perspectiveDivideFactor: 1,
        focalPlaneDepthFraction: -0.25,
      }),
      () => true,
    );
    manager.add(
      (host) =>
        new PickingIndicator(host, makeMouseState(), new WatchableValue(true)),
    );
    manager.update();
    const rings = panel.querySelectorAll<HTMLElement>(
      ".neuroglancer-picking-indicator",
    );
    expect(rings.length).toBe(1);
    const [ring] = rings;
    expect(ring.hidden).toBe(false);
    expect(getRingCentre(ring)).toEqual([100, 50]);
    expect(ring.style.opacity).toBe("0.75");
  });

  it("draws the ring larger for a nearer point", () => {
    const panel = document.createElement("div");
    let perspectiveDivideFactor = 1;
    const manager = new PanelOverlayManager(
      panel,
      () => ({
        viewportLeft: 100,
        viewportTop: 50,
        perspectiveDivideFactor,
        focalPlaneDepthFraction: 0,
      }),
      () => true,
    );
    manager.add(
      (host) =>
        new PickingIndicator(host, makeMouseState(), new WatchableValue(true)),
    );
    const ring = panel.querySelector<HTMLElement>(
      ".neuroglancer-picking-indicator",
    )!;
    manager.update();
    const focalPlaneWidth = parseFloat(ring.style.width);

    perspectiveDivideFactor = 1.5;
    manager.update();
    expect(parseFloat(ring.style.width)).toBeCloseTo(1.5 * focalPlaneWidth);
    expect(getRingCentre(ring)).toEqual([100, 50]);
  });

  it("hides the ring when the picked point is outside the view's depth range", () => {
    const panel = document.createElement("div");
    const manager = new PanelOverlayManager(
      panel,
      () => undefined,
      () => true,
    );
    manager.add(
      (host) =>
        new PickingIndicator(host, makeMouseState(), new WatchableValue(true)),
    );
    manager.update();
    const ring = panel.querySelector<HTMLElement>(
      ".neuroglancer-picking-indicator",
    )!;
    expect(ring.hidden).toBe(true);
  });

  it("shows the ring as soon as the picking indicator setting is turned on", () => {
    const panel = document.createElement("div");
    const manager = new PanelOverlayManager(
      panel,
      () => ({
        viewportLeft: 100,
        viewportTop: 50,
        perspectiveDivideFactor: 1,
        focalPlaneDepthFraction: 0,
      }),
      () => true,
    );
    const showPickingIndicator = new WatchableValue(false);
    manager.add(
      (host) =>
        new PickingIndicator(host, makeMouseState(), showPickingIndicator),
    );
    manager.update();
    const ring = panel.querySelector<HTMLElement>(
      ".neuroglancer-picking-indicator",
    )!;
    expect(ring.hidden).toBe(true);

    showPickingIndicator.value = true;
    manager.scheduleUpdate.flush();
    expect(ring.hidden).toBe(false);
  });

  it("moves the ring when the mouse moves, without a redraw", () => {
    const panel = document.createElement("div");
    const mouseState = makeMouseState();
    let pickedLeft = 100;
    const manager = new PanelOverlayManager(
      panel,
      () => ({
        viewportLeft: pickedLeft,
        viewportTop: 50,
        perspectiveDivideFactor: 1,
        focalPlaneDepthFraction: 0,
      }),
      () => true,
    );
    manager.add(
      (host) =>
        new PickingIndicator(host, mouseState, new WatchableValue(true)),
    );
    manager.update();

    pickedLeft = 20;
    mouseState.changed.dispatch();
    manager.scheduleUpdate.flush();

    const ring = panel.querySelector<HTMLElement>(
      ".neuroglancer-picking-indicator",
    )!;
    expect(getRingCentre(ring)).toEqual([20, 50]);
  });

  it("keeps the ring under the cursor in its own panel before the pick completes", () => {
    const panel = document.createElement("div");
    const manager = new PanelOverlayManager(
      panel,
      () => ({
        viewportLeft: 100,
        viewportTop: 50,
        perspectiveDivideFactor: 1,
        focalPlaneDepthFraction: 0,
      }),
      () => true,
    );
    manager.add(
      (host) =>
        new PickingIndicator(host, makeMouseState(), new WatchableValue(true)),
    );
    manager.moveCursor({ viewportLeft: 30, viewportTop: 40 });
    manager.scheduleUpdate.flush();

    const ring = panel.querySelector<HTMLElement>(
      ".neuroglancer-picking-indicator",
    )!;
    expect(getRingCentre(ring)).toEqual([30, 40]);
  });
});
