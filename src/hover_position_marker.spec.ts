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

import { describe, it, expect } from "vitest";
import type { ProjectionParameters } from "#src/projection_parameters.js";
import {
  computeHoverMarkerMatrix,
  crossSectionHoverMarkerAlpha,
  shouldDrawCrossSectionHoverMarker,
} from "#src/hover_position_marker.js";
import { mat4 } from "#src/util/geom.js";

describe("shouldDrawCrossSectionHoverMarker", () => {
  // The marker echoes the position hovered in one panel into the *other*
  // cross-section panels.  It is therefore drawn only in a panel that does not
  // hold the cursor -- which never happens with a single panel, and only happens
  // once panels are shown side by side.

  it("is not drawn in a single panel (cursor always in the only panel)", () => {
    // Single panel: whenever the cursor is active it is in this (the only)
    // panel, so `mouseInThisPanel` is true and nothing is echoed.
    expect(
      shouldDrawCrossSectionHoverMarker({
        enabled: true,
        mouseActive: true,
        mouseInThisPanel: true,
      }),
    ).toBe(false);
  });

  it("is drawn in a side-by-side panel that does not hold the cursor", () => {
    // Two (or more) panels side by side: the panel the cursor is NOT over echoes
    // the hovered position.
    expect(
      shouldDrawCrossSectionHoverMarker({
        enabled: true,
        mouseActive: true,
        mouseInThisPanel: false,
      }),
    ).toBe(true);
  });

  it("is not drawn in the side-by-side panel that holds the cursor", () => {
    expect(
      shouldDrawCrossSectionHoverMarker({
        enabled: true,
        mouseActive: true,
        mouseInThisPanel: true,
      }),
    ).toBe(false);
  });

  it("is not drawn when the feature is toggled off", () => {
    // Even side by side with the cursor in another panel, the toggle gates it.
    expect(
      shouldDrawCrossSectionHoverMarker({
        enabled: false,
        mouseActive: true,
        mouseInThisPanel: false,
      }),
    ).toBe(false);
  });

  it("is not drawn when the mouse is not active in any panel", () => {
    expect(
      shouldDrawCrossSectionHoverMarker({
        enabled: true,
        mouseActive: false,
        mouseInThisPanel: false,
      }),
    ).toBe(false);
  });
});

// Builds a minimal ProjectionParameters carrying only the fields
// computeHoverMarkerMatrix reads.
function makeProjectionParameters(options: {
  viewProjectionMat: mat4;
  displayDimensionIndices: Int32Array;
  logicalWidth: number;
  logicalHeight: number;
}): ProjectionParameters {
  const {
    viewProjectionMat,
    displayDimensionIndices,
    logicalWidth,
    logicalHeight,
  } = options;
  return {
    viewProjectionMat,
    logicalWidth,
    logicalHeight,
    displayDimensionRenderInfo: {
      displayDimensionIndices,
    },
  } as unknown as ProjectionParameters;
}

describe("computeHoverMarkerMatrix", () => {
  it("centers the reticle at the projected hover position", () => {
    const projectionParameters = makeProjectionParameters({
      viewProjectionMat: mat4.identity(mat4.create()),
      displayDimensionIndices: Int32Array.of(0, 1, 2),
      logicalWidth: 100,
      logicalHeight: 100,
    });
    const position = Float32Array.of(0.3, -0.4, 0.5);
    const mat = computeHoverMarkerMatrix(projectionParameters, 1, position);
    // With an identity view-projection (w = 1) the reticle center is the hovered
    // position in normalized device coordinates.
    expect(mat[12]).toBeCloseTo(0.3);
    expect(mat[13]).toBeCloseTo(-0.4);
    expect(mat[14]).toBeCloseTo(0.5);
    expect(mat[15]).toBe(1);
  });

  it("sizes the reticle in screen space (pixels -> NDC via viewport)", () => {
    const projectionParameters = makeProjectionParameters({
      viewProjectionMat: mat4.identity(mat4.create()),
      displayDimensionIndices: Int32Array.of(0, 1, 2),
      logicalWidth: 200,
      logicalHeight: 100,
    });
    const mat = computeHoverMarkerMatrix(
      projectionParameters,
      10,
      Float32Array.of(0, 0, 0),
    );
    // Half-extent in NDC = 2 * pixels / logicalSize; independent of the world.
    expect(mat[0]).toBeCloseTo((2 * 10) / 200); // x arm: 0.1
    expect(mat[5]).toBeCloseTo((2 * 10) / 100); // y arm: 0.2
    // The reticle lies in the screen plane; no local-z contribution.
    expect(mat[10]).toBe(0);
  });

  it("ignores display dimensions mapped to -1", () => {
    const projectionParameters = makeProjectionParameters({
      viewProjectionMat: mat4.identity(mat4.create()),
      displayDimensionIndices: Int32Array.of(0, -1, 2),
      logicalWidth: 100,
      logicalHeight: 100,
    });
    const position = Float32Array.of(0.3, 0.4, 0.5);
    const mat = computeHoverMarkerMatrix(projectionParameters, 1, position);
    // The second display dimension is unmapped, so its coordinate is 0.
    expect(mat[12]).toBeCloseTo(0.3);
    expect(mat[13]).toBe(0);
    expect(mat[14]).toBeCloseTo(0.5);
  });

  it("draws an identically-shaped crosshair regardless of panel orientation", () => {
    // The core of the fix: in every orthoview the reticle must be the same
    // screen-space "+", not a cross in one panel and a line in the others.  Two
    // panels viewing the same point through different orientations (identity vs
    // a 90-degree rotation about X, i.e. an xy- vs xz-style view) must yield the
    // same in-plane arm sizes.
    const viewport = { logicalWidth: 100, logicalHeight: 100 };
    const position = Float32Array.of(0.2, 0.3, 0.4);

    const xyView = computeHoverMarkerMatrix(
      makeProjectionParameters({
        viewProjectionMat: mat4.identity(mat4.create()),
        displayDimensionIndices: Int32Array.of(0, 1, 2),
        ...viewport,
      }),
      8,
      position,
    );
    const rotated = mat4.fromXRotation(mat4.create(), Math.PI / 2);
    const xzView = computeHoverMarkerMatrix(
      makeProjectionParameters({
        viewProjectionMat: rotated,
        displayDimensionIndices: Int32Array.of(0, 1, 2),
        ...viewport,
      }),
      8,
      position,
    );

    // Both arms have the same non-zero screen-space length in both panels.
    expect(xyView[0]).toBeGreaterThan(0);
    expect(xyView[5]).toBeGreaterThan(0);
    expect(xzView[0]).toBeCloseTo(xyView[0]);
    expect(xzView[5]).toBeCloseTo(xyView[5]);
  });
});

describe("crossSectionHoverMarkerAlpha", () => {
  // Builds a marker matrix whose projected center has the given normalized
  // device z (clip z / clip w) by setting the last column to [_, _, ndcZ, 1].
  function markerMatWithNdcZ(ndcZ: number): mat4 {
    const mat = mat4.identity(mat4.create());
    mat[14] = ndcZ;
    mat[15] = 1;
    return mat;
  }

  it("is fully opaque on the slice plane (ndcZ == 0)", () => {
    expect(crossSectionHoverMarkerAlpha(markerMatWithNdcZ(0))).toBe(1);
  });

  it("fades linearly with distance from the slice plane", () => {
    expect(crossSectionHoverMarkerAlpha(markerMatWithNdcZ(0.25))).toBeCloseTo(
      0.75,
    );
    expect(crossSectionHoverMarkerAlpha(markerMatWithNdcZ(-0.25))).toBeCloseTo(
      0.75,
    );
  });

  it("is invisible at and beyond the depth-slab edge (|ndcZ| >= 1)", () => {
    expect(crossSectionHoverMarkerAlpha(markerMatWithNdcZ(1))).toBe(0);
    expect(crossSectionHoverMarkerAlpha(markerMatWithNdcZ(1.5))).toBe(0);
    expect(crossSectionHoverMarkerAlpha(markerMatWithNdcZ(-2))).toBe(0);
  });

  it("treats a zero clip w as on-plane", () => {
    const mat = mat4.identity(mat4.create());
    mat[14] = 5;
    mat[15] = 0;
    expect(crossSectionHoverMarkerAlpha(mat)).toBe(1);
  });
});
