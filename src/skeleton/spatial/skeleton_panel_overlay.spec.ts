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
import type { ProjectionParameters } from "#src/projection_parameters.js";
import type { RenderedDataPanel } from "#src/rendered_data_panel.js";
import type { SkeletonOverlayPrimitives } from "#src/skeleton/spatial/skeleton_overlay_primitives.js";
import type {
  SkeletonPanelOverlayPrimitive,
  SkeletonPanelView,
} from "#src/skeleton/spatial/skeleton_panel_overlay.js";
import {
  getSkeletonNodeRing,
  projectToViewport,
  SkeletonPanelOverlay,
} from "#src/skeleton/spatial/skeleton_panel_overlay.js";
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
      expect(point.viewportX).toBeCloseTo(100);
      expect(point.viewportY).toBeCloseTo(50);
      expect(point.focalPlaneScale).toBeCloseTo(1);
      expect(point.focalPlaneDepthFraction).toBeCloseTo(0);
    }
  });

  it("magnifies a point nearer than the focal plane only under perspective projection", () => {
    const perspective = makeParameters({
      projectionMat: mat4.perspective(mat4.create(), Math.PI / 2, 2, 0.5, 3),
      focalDistance: 2,
      logicalWidth: 200,
      logicalHeight: 100,
    });
    const orthographic = makeParameters({
      projectionMat: mat4.ortho(mat4.create(), -2, 2, -1, 1, 0.5, 3),
      focalDistance: 2,
      logicalWidth: 200,
      logicalHeight: 100,
    });
    const halfWayToTheCamera = [0, 0, 1];
    expect(
      projectToViewport(perspective, halfWayToTheCamera)!.focalPlaneScale,
    ).toBeCloseTo(2);
    expect(
      projectToViewport(orthographic, halfWayToTheCamera)!.focalPlaneScale,
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
    expect(point.viewportX).toBeCloseTo(100);
    expect(point.viewportY).toBeCloseTo(50);
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

  it("measures depth linearly from the focal plane to each clipping plane when the two planes lie at unequal distances from it", () => {
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
      const atNearPlane = 0.9;
      const atFarPlane = -2;
      const halfWayToFar = -1;
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

function makeOrthographicPanel() {
  // The slice plane is z = 0. The clipping planes are at z = 4 and z = -4.
  const parameters = makeParameters({
    projectionMat: mat4.ortho(mat4.create(), -2, 2, -1, 1, -4, 4),
    focalDistance: 0,
    logicalWidth: 200,
    logicalHeight: 100,
  });
  return {
    projectionParameters: new WatchableValue(parameters),
  } as unknown as RenderedDataPanel;
}

function makeOverlayPrimitives(primitives: SkeletonPanelOverlayPrimitive[]) {
  return {
    changed: new NullarySignal(),
    computePrimitives: () => primitives,
  } as unknown as SkeletonOverlayPrimitives;
}

function makeMarker(position: number[]): SkeletonPanelOverlayPrimitive {
  return {
    kind: "marker",
    position: Float32Array.from(position),
    color: "#ff0000",
    outlineColor: "rgba(0, 0, 0, 0.75)",
    ring: { diameter: 10, borderWidth: 3 },
  };
}

function drawOverlay(
  primitives: SkeletonPanelOverlayPrimitive[],
  view: SkeletonPanelView = "2d",
) {
  const overlay = new SkeletonPanelOverlay(
    makeOrthographicPanel(),
    makeOverlayPrimitives(primitives),
    new WatchableValue(4),
    view,
  );
  overlay.update();
  return overlay;
}

function getDrawnElements(overlay: SkeletonPanelOverlay) {
  return [...overlay.element.children] as HTMLElement[];
}

describe("SkeletonPanelOverlay", () => {
  it("centres each ring on its node in the panel", () => {
    const [ring] = getDrawnElements(drawOverlay([makeMarker([0, 0, 0])]));

    expect(ring.dataset.kind).toBe("marker");
    // The panel centre is (100, 50) and the ring is 10 pixels wide.
    expect(ring.style.transform).toBe("translate(95px, 45px)");
  });

  it("fades a ring in a 2D panel as its node moves away from the slice", () => {
    const halfWayToTheFarPlane = [0, 0, -2];

    const [ring2d] = getDrawnElements(
      drawOverlay([makeMarker(halfWayToTheFarPlane)], "2d"),
    );
    const [ring3d] = getDrawnElements(
      drawOverlay([makeMarker(halfWayToTheFarPlane)], "3d"),
    );

    expect(Number(ring2d.style.opacity)).toBeCloseTo(0.5);
    expect(Number(ring3d.style.opacity)).toBe(1);
  });

  it("joins two cue nodes with a connector that ends at both nodes", () => {
    const [connector] = getDrawnElements(
      drawOverlay([
        {
          kind: "preparationConnector",
          from: Float32Array.of(0, 0, 0),
          to: Float32Array.of(1, 0, 0),
          width: 2,
        },
      ]),
    );

    expect(connector.dataset.kind).toBe("preparationConnector");
    // One unit along x is 50 pixels in a 200 pixel panel that shows 4 units.
    expect(connector.style.getPropertyValue("--connector-length")).toBe("50px");
    expect(connector.style.transform).toBe(
      "translate(100px, 50px) rotate(0rad)",
    );
  });

  it("hides the overlay while there is nothing to draw", () => {
    const primitives = [makeMarker([0, 0, 0])];
    const overlay = drawOverlay(primitives);
    expect(overlay.element.hidden).toBe(false);

    primitives.length = 0;
    overlay.update();

    expect(overlay.element.hidden).toBe(true);
    expect(getDrawnElements(overlay)).toEqual([]);
  });

  it("keeps the ring outside the node at every node size", () => {
    for (const view of ["2d", "3d"] as const) {
      for (const nodeDiameter of [1, 5, 20, 100]) {
        const ring = getSkeletonNodeRing(nodeDiameter, view);
        expect(ring.diameter - 2 * ring.borderWidth).toBeGreaterThanOrEqual(
          nodeDiameter,
        );
        expect(ring.borderWidth).toBeGreaterThan(0);
      }
    }
  });
});
