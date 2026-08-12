/**
 * @license
 * Copyright 2024 Google Inc.
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

/**
 * @file Geometry and visibility logic for the cross-section hover marker: a
 * small reticle drawn at the mouse-hover position of one cross-section slice
 * panel and echoed into the other panels (see `showCrossSectionHoverPosition`).
 * The WebGL rendering lives in `./hover_position_marker_renderer.js`; this module
 * is kept free of WebGL dependencies so the logic can be unit-tested.
 */

import type { ProjectionParameters } from "#src/projection_parameters.js";
import { mat4 } from "#src/util/geom.js";

const tempMat = mat4.create();

/**
 * Computes the transform that places a fixed-size marker centered at the
 * specified global `position`, projected into the viewport described by
 * `projectionParameters`.  This mirrors `computeAxisLineMatrix` but uses an
 * arbitrary position (the mouse-hover position) rather than the navigation
 * center.
 */
export function computeHoverMarkerMatrix(
  projectionParameters: ProjectionParameters,
  markerSize: number,
  position: Float32Array,
) {
  const mat = mat4.identity(tempMat);
  const {
    displayDimensionRenderInfo: {
      canonicalVoxelFactors,
      displayDimensionIndices,
    },
  } = projectionParameters;
  for (let i = 0; i < 3; ++i) {
    const globalDim = displayDimensionIndices[i];
    mat[12 + i] =
      globalDim === -1 || globalDim >= position.length
        ? 0
        : position[globalDim];
    mat[5 * i] = markerSize / canonicalVoxelFactors[i];
  }
  mat4.multiply(mat, projectionParameters.viewProjectionMat, mat);
  return mat;
}

/**
 * Determines whether the cross-section hover marker should be drawn in a given
 * cross-section slice panel.
 *
 * The marker echoes the position hovered in one panel into the *other* panels,
 * so it is only drawn in a panel that does not currently contain the mouse
 * cursor.  With a single cross-section panel (no side-by-side layout) the active
 * cursor is always within that one panel, so the marker is never drawn; it only
 * appears once two or more panels are shown side by side and the cursor is in a
 * different panel than this one.
 */
export function shouldDrawCrossSectionHoverMarker(options: {
  // The `showCrossSectionHoverPosition` viewer toggle.
  enabled: boolean;
  // Whether the shared mouse cursor is currently active in some panel.
  mouseActive: boolean;
  // Whether the mouse cursor is within this panel (i.e. `mouseX >= 0`).
  mouseInThisPanel: boolean;
}): boolean {
  const { enabled, mouseActive, mouseInThisPanel } = options;
  return enabled && mouseActive && !mouseInThisPanel;
}

/**
 * Computes the opacity of the hover marker from its projected depth, so that the
 * marker fades with distance from this panel's slice plane.  `markerMat` is the
 * result of {@link computeHoverMarkerMatrix}; its last column is the marker
 * center in clip space.  The normalized device z (`z/w`) is the signed distance
 * from the slice plane, reaching magnitude 1 at the edge of the visible depth
 * slab, so the marker is fully opaque on the plane and invisible at/beyond the
 * slab edge.
 */
export function crossSectionHoverMarkerAlpha(markerMat: mat4): number {
  const clipW = markerMat[15];
  const ndcZ = clipW !== 0 ? markerMat[14] / clipW : 0;
  return Math.max(0, 1 - Math.abs(ndcZ));
}
