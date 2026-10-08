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

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackableDataSelectionState } from "#src/layer/index.js";
import { copySelectionPositionToClipboard } from "#src/ui/selection_details.js";
import { setClipboard } from "#src/util/clipboard.js";
import { formatPositionText } from "#src/widget/position_widget.js";

vi.mock("#src/util/clipboard.js", () => ({ setClipboard: vi.fn(() => true) }));

beforeEach(() => {
  vi.mocked(setClipboard).mockClear();
});

function makeSelectionState(position: Float32Array | undefined) {
  return {
    value: position === undefined ? undefined : { position },
  } as unknown as TrackableDataSelectionState;
}

describe("formatPositionText", () => {
  it("rounds each coordinate down and separates them with commas", () => {
    expect(formatPositionText(Float32Array.of(1.5, -0.5, 30))).toBe(
      "1, -1, 30",
    );
  });
});

describe("copySelectionPositionToClipboard", () => {
  it("copies the position of the selection", () => {
    copySelectionPositionToClipboard(
      makeSelectionState(Float32Array.of(10.9, 20.1, 3)),
    );
    expect(setClipboard).toHaveBeenCalledWith("10, 20, 3");
  });

  it("copies nothing when there is no selection", () => {
    copySelectionPositionToClipboard(makeSelectionState(undefined));
    expect(setClipboard).not.toHaveBeenCalled();
  });
});
