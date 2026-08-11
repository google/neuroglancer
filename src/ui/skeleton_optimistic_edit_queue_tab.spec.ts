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

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import type { SpatialSkeletonOptimisticEditDebugEntry } from "#src/skeleton/spatial_skeleton_manager.js";
import {
  maybeRegisterSpatialSkeletonOptimisticEditQueueTab,
  OPTIMISTIC_EDIT_QUEUE_DEBUG,
  SpatialSkeletonOptimisticEditQueueTab,
} from "#src/ui/skeleton_optimistic_edit_queue_tab.js";

function makeSignal() {
  const listeners = new Set<() => void>();
  return {
    changed: {
      add(listener: () => void) {
        listeners.add(listener);
        return {
          dispose() {
            listeners.delete(listener);
          },
        };
      },
    },
    dispatch() {
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

function makeQueueTabLayer(
  getEntries: () => readonly SpatialSkeletonOptimisticEditDebugEntry[],
) {
  const optimisticEditQueueVersion = makeSignal();
  const clearSettledOptimisticEdits = vi.fn();
  const layer = {
    spatialSkeletonState: {
      optimisticEditQueueVersion,
      getOptimisticEditQueueDebugSnapshot: getEntries,
      clearSettledOptimisticEdits,
    },
    tabs: {
      add: vi.fn(),
    },
  } as unknown as SegmentationUserLayer;
  return {
    layer,
    clearSettledOptimisticEdits,
    optimisticEditQueueVersion,
  };
}

describe("SpatialSkeletonOptimisticEditQueueTab", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("registers no Queue tab when debug registration is disabled", () => {
    const { layer } = makeQueueTabLayer(() => []);
    const hidden = { value: false, changed: makeSignal().changed };

    expect(
      maybeRegisterSpatialSkeletonOptimisticEditQueueTab(
        layer,
        hidden as any,
        false,
      ),
    ).toBe(false);
    expect(layer.tabs.add).not.toHaveBeenCalled();
  });

  it("defaults to the OPTIMISTIC_EDIT_QUEUE_DEBUG flag when not told otherwise", () => {
    const { layer } = makeQueueTabLayer(() => []);
    const hidden = { value: false, changed: makeSignal().changed };

    // Asserted against the flag rather than a literal: this is a development toggle, so pinning its
    // shipped value here only breaks the suite whenever someone flips it.
    expect(
      maybeRegisterSpatialSkeletonOptimisticEditQueueTab(layer, hidden as any),
    ).toBe(OPTIMISTIC_EDIT_QUEUE_DEBUG);
  });

  it("registers a dedicated Queue tab when debug registration is enabled", () => {
    const { layer } = makeQueueTabLayer(() => []);
    const hidden = { value: false, changed: makeSignal().changed };

    expect(
      maybeRegisterSpatialSkeletonOptimisticEditQueueTab(
        layer,
        hidden as any,
        true,
      ),
    ).toBe(true);

    expect(layer.tabs.add).toHaveBeenCalledWith(
      "skeletonQueue",
      expect.objectContaining({
        label: "Queue",
        order: -44,
        hidden,
      }),
    );
  });

  it("renders an empty queue state and disables Clear settled", () => {
    const { layer } = makeQueueTabLayer(() => []);

    const tab = new SpatialSkeletonOptimisticEditQueueTab(layer);

    expect(tab.element.textContent).toContain("Optimistic edit queue");
    expect(tab.element.textContent).toContain("empty");
    expect(tab.element.textContent).toContain("No queued optimistic edits.");
    expect(
      tab.element.querySelector<HTMLButtonElement>(
        ".neuroglancer-skeleton-queue-debug-clear",
      )?.disabled,
    ).toBe(true);
    tab.dispose();
  });

  it("renders queue rows, updates on queue version changes, and clears settled entries", () => {
    let entries: readonly SpatialSkeletonOptimisticEditDebugEntry[] = [
      {
        operationId: 1,
        kind: "addNode",
        status: "pending",
        tempNodeId: Number.MAX_SAFE_INTEGER,
        parentNodeId: 10,
        segmentId: 10,
      },
      {
        operationId: 2,
        kind: "deleteNode",
        status: "committed",
        nodeId: 20,
        segmentId: 10,
      },
    ];
    const { layer, optimisticEditQueueVersion, clearSettledOptimisticEdits } =
      makeQueueTabLayer(() => entries);
    const tab = new SpatialSkeletonOptimisticEditQueueTab(layer);

    expect(tab.element.textContent).toContain("committed: 1");
    expect(tab.element.textContent).toContain("pending: 1");
    expect(tab.element.textContent).toContain("#1 addNode");
    expect(tab.element.textContent).toContain("#2 deleteNode");
    const clearSettledButton = tab.element.querySelector<HTMLButtonElement>(
      ".neuroglancer-skeleton-queue-debug-clear",
    )!;
    expect(clearSettledButton.disabled).toBe(false);

    clearSettledButton.click();

    expect(clearSettledOptimisticEdits).toHaveBeenCalledTimes(1);

    entries = [
      {
        operationId: 3,
        kind: "moveNode",
        status: "inFlight",
        nodeId: 30,
        segmentId: 10,
      },
    ];
    optimisticEditQueueVersion.dispatch();

    expect(tab.element.textContent).toContain("inFlight: 1");
    expect(tab.element.textContent).toContain("#3 moveNode");
    expect(tab.element.textContent).not.toContain("#1 addNode");
    tab.dispose();
  });
});
