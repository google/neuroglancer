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

import { describe, expect, it } from "vitest";

import type { VisibleSegmentsState } from "#src/segmentation_display_state/base.js";
import {
  addSegmentToVisibleSets,
  removeSegmentFromVisibleSets,
} from "#src/segmentation_display_state/base.js";

class FakeUint64Set {
  private values = new Set<bigint>();

  add(value: bigint) {
    this.values.add(value);
  }

  delete(value: bigint) {
    this.values.delete(value);
  }

  has(value: bigint) {
    return this.values.has(value);
  }
}

function makeState(useTemporaryVisibleSegments: boolean) {
  const visibleSegments = new FakeUint64Set();
  const temporaryVisibleSegments = new FakeUint64Set();
  const selectedSegments = new FakeUint64Set();
  const state = {
    visibleSegments,
    selectedSegments,
    segmentEquivalences: {},
    temporaryVisibleSegments,
    temporarySegmentEquivalences: {},
    useTemporaryVisibleSegments: { value: useTemporaryVisibleSegments },
    useTemporarySegmentEquivalences: { value: false },
  } as unknown as VisibleSegmentsState;
  return {
    state,
    visibleSegments,
    temporaryVisibleSegments,
    selectedSegments,
  };
}

describe("segmentation_display_state/base visible set helpers", () => {
  it("adds only the persistent visible set when temporary visibility is disabled", () => {
    const { state, visibleSegments, temporaryVisibleSegments } =
      makeState(false);

    addSegmentToVisibleSets(state, 11n);

    expect(visibleSegments.has(11n)).toBe(true);
    expect(temporaryVisibleSegments.has(11n)).toBe(false);
  });

  it("keeps persistent and temporary visibility in sync when temporary visibility is enabled", () => {
    const {
      state,
      visibleSegments,
      temporaryVisibleSegments,
      selectedSegments,
    } = makeState(true);
    visibleSegments.add(11n);
    temporaryVisibleSegments.add(11n);
    selectedSegments.add(11n);

    addSegmentToVisibleSets(state, 12n);
    removeSegmentFromVisibleSets(state, 11n, { deselect: true });

    expect(visibleSegments.has(12n)).toBe(true);
    expect(temporaryVisibleSegments.has(12n)).toBe(true);
    expect(visibleSegments.has(11n)).toBe(false);
    expect(temporaryVisibleSegments.has(11n)).toBe(false);
    expect(selectedSegments.has(11n)).toBe(false);
  });
});
