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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RenderScaleHistogram,
  trackableRenderScaleTarget,
} from "#src/render_scale_statistics.js";
import { WatchableVisibilityPriority } from "#src/visibility_priority/frontend.js";
import { RenderScaleWidget } from "#src/widget/render_scale_widget.js";

let widget: RenderScaleWidget | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: vi.fn(),
    fillRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  widget?.dispose();
  widget = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("RenderScaleWidget", () => {
  it("shows 0/0 when projection is inactive without subtracting indicator bars", () => {
    const histogram = new RenderScaleHistogram();
    const visibility = new WatchableVisibilityPriority(
      Number.POSITIVE_INFINITY,
    );
    const removeVisibility = histogram.visibility.add(visibility);
    histogram.begin(1);
    histogram.add(100, 8, 3, 2);
    for (const scale of [200, 300, Number.POSITIVE_INFINITY]) {
      histogram.add(scale, 16, 0, 10, true);
    }
    const target = trackableRenderScaleTarget(8);
    widget = new RenderScaleWidget(histogram, target);
    expect(widget.legendChunks.textContent).toBe("3/5");
    removeVisibility();
    widget.updateView();
    expect(widget.legendChunks.textContent).toBe("0/0");
    expect(target.value).toBe(8);
  });

  it("preserves shared histogram data across hiding and reactivation", () => {
    const histogram = new RenderScaleHistogram();
    const visibility = new WatchableVisibilityPriority(
      Number.POSITIVE_INFINITY,
    );
    histogram.visibility.add(visibility);
    histogram.begin(7);
    histogram.add(100, 8, 18, 0);
    histogram.add(200, 16, 0, 10, true);
    widget = new RenderScaleWidget(histogram, trackableRenderScaleTarget(8));
    const originalBins = histogram.value.slice();
    visibility.value = Number.NEGATIVE_INFINITY;
    widget.updateView();
    expect(histogram.value).toEqual(originalBins);
    visibility.value = Number.POSITIVE_INFINITY;
    widget.updateView();
    expect(widget.legendChunks.textContent).toBe("18/18");
  });
});
