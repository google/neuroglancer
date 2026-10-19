/**
 * @license
 * Copyright 2019 Google Inc.
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

import { RenderViewport, renderViewportsEqual } from "#src/display_context.js";
import type { DisplayDimensionRenderInfo } from "#src/navigation_state.js";
import { arraysEqual } from "#src/util/array.js";
import { getEyeDepth, mat4, vec4 } from "#src/util/geom.js";
import { kEmptyFloat32Vec } from "#src/util/vector.js";

export class ProjectionParameters extends RenderViewport {
  displayDimensionRenderInfo: DisplayDimensionRenderInfo;

  /**
   * Global position.
   */
  globalPosition: Float32Array = kEmptyFloat32Vec;

  /**
   * Transform from camera coordinates to OpenGL clip coordinates.
   */
  projectionMat: mat4 = mat4.create();

  /**
   * Transform from world coordinates to camera coordinates.
   */
  viewMatrix: mat4 = mat4.create();

  /**
   * Inverse of `viewMat`.
   */
  invViewMatrix: mat4 = mat4.create();

  /**
   * Transform from world coordinates to OpenGL clip coordinates.  Equal to:
   * `projectionMat * viewMat`.
   */
  viewProjectionMat: mat4 = mat4.create();

  /**
   * Inverse of `viewProjectionMat`.
   */
  invViewProjectionMat: mat4 = mat4.create();
}

export function projectionParametersEqual(
  a: ProjectionParameters,
  b: ProjectionParameters,
) {
  return (
    a.displayDimensionRenderInfo === b.displayDimensionRenderInfo &&
    renderViewportsEqual(a, b) &&
    arraysEqual(a.globalPosition, b.globalPosition) &&
    arraysEqual(a.projectionMat, b.projectionMat) &&
    arraysEqual(a.viewMatrix, b.viewMatrix)
  );
}

export function updateProjectionParametersFromInverseViewAndProjection(
  p: ProjectionParameters,
) {
  const { viewMatrix, viewProjectionMat } = p;
  mat4.invert(viewMatrix, p.invViewMatrix);
  mat4.multiply(viewProjectionMat, p.projectionMat, viewMatrix);
  mat4.invert(p.invViewProjectionMat, viewProjectionMat);
}

export interface ViewportPoint {
  readonly viewportX: number;
  readonly viewportY: number;
  readonly focalPlaneDepthFraction: number;
  /** Apparent size relative to a point on the focal plane. */
  readonly focalPlaneScale: number;
}

const tempClip = vec4.create();
const tempFocalClip = vec4.create();

function getClipCoordinates(
  out: vec4,
  parameters: ProjectionParameters,
  position: ArrayLike<number>,
): vec4 {
  const {
    viewProjectionMat,
    displayDimensionRenderInfo: { displayDimensionIndices },
  } = parameters;
  for (let i = 0; i < 3; ++i) {
    const index = displayDimensionIndices[i];
    out[i] = index >= 0 ? position[index] : 0;
  }
  out[3] = 1;
  return vec4.transformMat4(out, out, viewProjectionMat);
}

export function projectToViewport(
  parameters: ProjectionParameters,
  position: ArrayLike<number>,
): ViewportPoint | undefined {
  const {
    projectionMat,
    logicalWidth,
    logicalHeight,
    visibleLeftFraction,
    visibleTopFraction,
    visibleWidthFraction,
    visibleHeightFraction,
  } = parameters;
  const clip = getClipCoordinates(tempClip, parameters, position);
  const w = clip[3];
  if (w <= 0) return undefined;
  const normalizedDeviceX = clip[0] / w;
  const normalizedDeviceY = clip[1] / w;
  const normalizedDeviceZ = clip[2] / w;
  if (normalizedDeviceZ < -1 || normalizedDeviceZ > 1) return undefined;
  const eyeDepth = getEyeDepth(projectionMat, normalizedDeviceZ);
  const focalClip = getClipCoordinates(
    tempFocalClip,
    parameters,
    parameters.globalPosition,
  );
  const focalEyeDepth = getEyeDepth(projectionMat, focalClip[2] / focalClip[3]);
  // The near and far planes can be unequally far from the focal plane.
  const boundEyeDepth = getEyeDepth(
    projectionMat,
    eyeDepth < focalEyeDepth ? -1 : 1,
  );
  return {
    viewportX:
      (visibleLeftFraction +
        (normalizedDeviceX * 0.5 + 0.5) * visibleWidthFraction) *
      logicalWidth,
    viewportY:
      (visibleTopFraction +
        (0.5 - normalizedDeviceY * 0.5) * visibleHeightFraction) *
      logicalHeight,
    focalPlaneDepthFraction:
      (eyeDepth - focalEyeDepth) / Math.abs(boundEyeDepth - focalEyeDepth),
    focalPlaneScale: focalClip[3] / w,
  };
}
