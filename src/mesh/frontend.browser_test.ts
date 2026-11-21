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
import { isSegmentHighlighted } from "#src/mesh/frontend.js";
import type { SegmentSelectionState } from "#src/segmentation_display_state/frontend.js";
import { WatchableValue } from "#src/trackable_value.js";

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
