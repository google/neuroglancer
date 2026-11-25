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

import { describe, it, expect } from "vitest";
import { DisplayContext } from "#src/display_context.js";
import { makeLayer } from "#src/layer/index.js";
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import "#layer/segmentation";
import { VertexPositionFormat } from "#src/mesh/base.js";
import type { MeshDisplayState } from "#src/mesh/frontend.js";
import { isSegmentHighlighted, MeshShaderManager } from "#src/mesh/frontend.js";
import {
  perspectivePanelEmit,
  perspectivePanelEmitWithNormals,
} from "#src/perspective_view/panel.js";
import type { SegmentSelectionState } from "#src/segmentation_display_state/frontend.js";
import { WatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import { Viewer } from "#src/viewer.js";

// Root segment 10 merges base segments 1 and 2; base 1 is under the mouse.
const ROOT = 10n;
const BASE_HOVERED = 1n;
const BASE_OTHER = 2n;

function makeState(options: {
  hoverHighlight?: boolean;
  baseSegmentHighlighting?: boolean;
  hasSelectedSegment?: boolean;
}) {
  return {
    hoverHighlight: new WatchableValue(options.hoverHighlight ?? true),
    baseSegmentHighlighting: new WatchableValue(
      options.baseSegmentHighlighting ?? false,
    ),
    segmentSelectionState: {
      hasSelectedSegment: options.hasSelectedSegment ?? true,
      selectedSegment: ROOT,
      baseSelectedSegment: BASE_HOVERED,
    } as SegmentSelectionState,
  };
}

describe("isSegmentHighlighted", () => {
  it("is false with hover highlighting off or nothing selected", () => {
    expect(
      isSegmentHighlighted(makeState({ hoverHighlight: false }), ROOT),
    ).toBe(false);
    expect(
      isSegmentHighlighted(makeState({ hasSelectedSegment: false }), ROOT),
    ).toBe(false);
  });

  it("highlights every member of a merged segment colored by root", () => {
    // Without base coloring, all members are drawn with colorObjectId = root.
    const state = makeState({});
    expect(isSegmentHighlighted(state, ROOT)).toBe(true);
    expect(isSegmentHighlighted(state, 11n)).toBe(false);
  });

  it("highlights only the hovered base segment with base highlighting", () => {
    // With base coloring, colorObjectId is each member's own id.
    const state = makeState({ baseSegmentHighlighting: true });
    expect(isSegmentHighlighted(state, BASE_HOVERED)).toBe(true);
    expect(isSegmentHighlighted(state, BASE_OTHER)).toBe(false);
    expect(isSegmentHighlighted(state, ROOT)).toBe(false);
  });
});

// Compiles the mesh shader, including the segment color shader, with and
// without the SSAO normals emitter.
describe("MeshShaderManager", () => {
  it.each([
    [false, VertexPositionFormat.float32],
    [true, VertexPositionFormat.uint10],
  ])(
    "builds with both emitters (fragmentRelativeVertices=%s, format=%s)",
    (fragmentRelativeVertices, vertexPositionFormat) => {
      const resources = new RefCounted();
      try {
        const display = resources.registerDisposer(
          new DisplayContext(document.createElement("div")),
        );
        const viewer = resources.registerDisposer(new Viewer(display));
        const managedLayer = resources.registerDisposer(
          makeLayer(viewer.layerSpecification, "test", {
            type: "segmentation",
          }),
        );
        const { displayState } = managedLayer.layer! as SegmentationUserLayer;
        const gl = viewer.chunkManager.chunkQueueManager.gl;
        const layer = resources.registerDisposer(
          Object.assign(new RefCounted(), {
            gl,
            // makeGetter uses only the segmentation fields, not transform.
            displayState: displayState as unknown as MeshDisplayState,
          }),
        );
        const getShader = new MeshShaderManager(
          fragmentRelativeVertices,
          vertexPositionFormat,
        ).makeGetter(layer);

        const plain = getShader(perspectivePanelEmit);
        expect(plain.fallback).toBe(false);
        expect(plain.shader).not.toBeNull();
        expect(() => plain.shader!.uniform("uViewNormalMatrix")).toThrow(
          "Invalid uniform",
        );

        const withNormals = getShader(perspectivePanelEmitWithNormals);
        expect(withNormals.fallback).toBe(false);
        expect(withNormals.shader).not.toBeNull();
        expect(withNormals.shader).not.toBe(plain.shader);
        // Non-null locations: the uniforms are used, not optimized away.
        expect(withNormals.shader!.uniform("uViewNormalMatrix")).not.toBeNull();
        expect(withNormals.shader!.uniform("uHighlighted")).not.toBeNull();
      } finally {
        resources.dispose();
      }
    },
  );
});
