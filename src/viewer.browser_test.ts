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
import { NullarySignal } from "#src/util/signal.js";
import type { Trackable } from "#src/util/trackable.js";
import type { Viewer } from "#src/viewer.js";
import { TrackableViewerState } from "#src/viewer.js";

// The `TrackableViewerState` constructor reads many trackable fields of
// `Viewer`. A proxy returns one stub trackable for each unknown field. The
// proxy continues to work when the state gets a new field.
function makeFakeTrackable(): Trackable {
  return {
    changed: new NullarySignal(),
    reset: () => {},
    restoreState: () => {},
    toJSON: () => undefined,
  };
}

// The fake viewer has no `sidePanelManager`, as a viewer with no chrome.
function makeFakeViewer(): Viewer {
  const fakeTrackable = makeFakeTrackable();
  const target = {
    sidePanelManager: undefined,
    dataContext: {
      chunkQueueManager: {
        enablePrefetch: fakeTrackable,
        capacities: {
          gpuMemory: { sizeLimit: fakeTrackable },
          systemMemory: { sizeLimit: fakeTrackable },
          download: { itemLimit: fakeTrackable },
        },
      },
    },
  };
  return new Proxy(target, {
    get: (obj, prop) =>
      prop in obj
        ? (obj as Record<string | symbol, unknown>)[prop]
        : fakeTrackable,
  }) as unknown as Viewer;
}

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()!();
});

describe("TrackableViewerState.reset", () => {
  it("dispatches stateReset once for each call", () => {
    const state = new TrackableViewerState(makeFakeViewer());
    disposers.push(() => state.dispose());
    const listener = vi.fn();
    state.stateReset.add(listener);

    state.reset();
    state.reset();

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("does not require a side panel manager", () => {
    const state = new TrackableViewerState(makeFakeViewer());
    disposers.push(() => state.dispose());

    expect(() => state.reset()).not.toThrow();
  });
});
