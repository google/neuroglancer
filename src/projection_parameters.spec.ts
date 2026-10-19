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
import { projectToViewport } from "#src/projection_parameters.js";
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
