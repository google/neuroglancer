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
import { mat4, vec4 } from "#src/util/geom.js";

const tempMat = mat4.create();
const tempPoint = vec4.create();

/**
 * Computes the transform that draws the hover marker as a fixed-size,
 * screen-aligned "+" reticle centered at the projected location of the global
 * `position` within the panel described by `projectionParameters`.
 *
 * The reticle is built in screen space -- rather than in the plane of the first
 * two display dimensions -- so that it appears as a consistent crosshair in
 * every cross-section panel regardless of that panel's orientation.  If it were
 * built in a fixed world plane, an arm of the "+" that happens to point along a
 * panel's depth axis would collapse to a point, leaving only a line in the
 * orthoviews whose slice plane differs from that world plane.
 *
 * The returned matrix maps the unit "+" vertices (local x/y in [-1, 1], z = 0)
 * directly to clip space with w = 1, so no view-projection multiply is applied
 * afterwards.  Its third row carries the marker center's normalized device z
 * (the signed distance from this panel's slice plane) for use by
 * {@link crossSectionHoverMarkerAlpha}.
 */
export function computeHoverMarkerMatrix(
  projectionParameters: ProjectionParameters,
  markerSizeInPixels: number,
  position: Float32Array,
) {
  const {
    displayDimensionRenderInfo: { displayDimensionIndices },
    viewProjectionMat,
    logicalWidth,
    logicalHeight,
  } = projectionParameters;
  // Project the hover position (taken along the display dimensions) into clip
  // space to obtain the reticle center.
  const point = tempPoint;
  for (let i = 0; i < 3; ++i) {
    const globalDim = displayDimensionIndices[i];
    point[i] =
      globalDim === -1 || globalDim >= position.length
        ? 0
        : position[globalDim];
  }
  point[3] = 1;
  vec4.transformMat4(point, point, viewProjectionMat);
  const w = point[3];
  const cx = w !== 0 ? point[0] / w : 0;
  const cy = w !== 0 ? point[1] / w : 0;
  const cz = w !== 0 ? point[2] / w : 0;
  // Half-extent of the reticle in normalized device coordinates for the
  // requested pixel size (the unit "+" vertices span [-1, 1]).
  const hx = logicalWidth !== 0 ? (2 * markerSizeInPixels) / logicalWidth : 0;
  const hy = logicalHeight !== 0 ? (2 * markerSizeInPixels) / logicalHeight : 0;
  const mat = mat4.identity(tempMat);
  mat[0] = hx;
  mat[5] = hy;
  mat[10] = 0;
  mat[12] = cx;
  mat[13] = cy;
  mat[14] = cz;
  mat[15] = 1;
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
