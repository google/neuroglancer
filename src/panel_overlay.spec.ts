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
import {
  applyRenderViewportToProjectionMatrix,
  RenderViewport,
} from "#src/display_context.js";
import type { PanelOverlayHost } from "#src/panel_overlay.js";
import { PanelOverlayManager, projectToViewport } from "#src/panel_overlay.js";
import type { ProjectionParameters } from "#src/projection_parameters.js";
import { RefCounted } from "#src/util/disposable.js";
import { mat4 } from "#src/util/geom.js";

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
    displayDimensionRenderInfo: {
      displayDimensionIndices: Int32Array.of(0, 1, 2),
    },
  } as unknown as ProjectionParameters;
}

function makeDotOverlay(host: PanelOverlayHost) {
  const dot = document.createElement("div");
  host.container.appendChild(dot);
  return Object.assign(new RefCounted(), {
    update() {},
    disposed() {
      dot.remove();
    },
  });
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
      expect(point.focalPlaneDepthFraction).toBeCloseTo(0);
    }
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
});

describe("PanelOverlayManager", () => {
  it("removes an overlay from the panel while other overlays stay", () => {
    const panel = document.createElement("div");
    const manager = new PanelOverlayManager(
      panel,
      () => undefined,
      () => true,
    );
    const removeFirst = manager.add(makeDotOverlay);
    manager.add(makeDotOverlay);
    removeFirst();
    manager.update();
    expect(manager.container.children.length).toBe(1);
  });
});
