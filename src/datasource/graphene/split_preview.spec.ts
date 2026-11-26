/**
 * @license
 * Copyright 2016 Google Inc.
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
import {
  applySplitPreviewToTemporaryState,
  MulticutSplitPreviewState,
  parseGrapheneSplitPreviewResponse,
} from "#src/datasource/graphene/split_preview.js";
import { VisibleSegmentEquivalencePolicy } from "#src/segmentation_graph/segment_id.js";
import { SharedDisjointUint64Sets } from "#src/shared_disjoint_sets.js";
import { WatchableValue } from "#src/trackable_value.js";
import { Uint64Set } from "#src/uint64_set.js";

describe("graphene split preview helpers", () => {
  it("parses split preview responses", () => {
    expect(
      parseGrapheneSplitPreviewResponse({
        supervoxel_connected_components: [["1", "2"], ["9"]],
        illegal_split: true,
      }),
    ).toEqual({
      connectedComponents: [[1n, 2n], [9n]],
      isSplitIllegal: true,
    });
  });

  it("invalidates cached multicut preview state", () => {
    const state = new MulticutSplitPreviewState();
    expect(state.invalidate()).toBe(false);
    expect(state.setPending(true)).toBe(true);
    state.cachePreview({
      connectedComponents: [[1n, 2n], [3n]],
      isSplitIllegal: true,
    });
    expect(state.previewPending).toBe(false);
    expect(state.previewActive).toBe(true);
    expect(state.hasCachedPreview).toBe(true);
    expect(state.isSplitIllegal).toBe(true);
    expect(state.setPreviewActive(false)).toBe(true);
    expect(state.previewActive).toBe(false);
    expect(state.setPreviewActive(true)).toBe(true);
    expect(state.previewActive).toBe(true);
    expect(state.invalidate()).toBe(true);
    expect(state.connectedComponents).toEqual([]);
    expect(state.isSplitIllegal).toBe(false);
    expect(state.previewActive).toBe(false);
    expect(state.previewPending).toBe(false);
    expect(state.hasCachedPreview).toBe(false);
  });

  it("applies connected components to temporary visible segments", () => {
    const temporaryVisibleSegments = new Uint64Set();
    temporaryVisibleSegments.add(100n);
    const temporarySegmentEquivalences = new SharedDisjointUint64Sets();
    temporarySegmentEquivalences.disjointSets.visibleSegmentEquivalencePolicy =
      new WatchableValue(
        VisibleSegmentEquivalencePolicy.MAX_REPRESENTATIVE |
          VisibleSegmentEquivalencePolicy.NONREPRESENTATIVE_EXCLUDED,
      );
    temporarySegmentEquivalences.link(10n, 11n);
    const state = {
      temporaryVisibleSegments,
      temporarySegmentEquivalences,
      useTemporaryVisibleSegments: new WatchableValue(false),
      useTemporarySegmentEquivalences: new WatchableValue(false),
    } as any;
    const representatives = applySplitPreviewToTemporaryState(
      state,
      [[1n, 3n, 2n], [4n, 5n], [9n]],
      [42n],
    );
    expect(representatives).toEqual([3n, 5n, 9n]);
    expect(state.useTemporaryVisibleSegments.value).toBe(true);
    expect(state.useTemporarySegmentEquivalences.value).toBe(true);
    expect(state.temporaryVisibleSegments.toJSON()).toEqual([
      "3",
      "42",
      "5",
      "9",
    ]);
    expect(state.temporarySegmentEquivalences.get(1n)).toBe(3n);
    expect(state.temporarySegmentEquivalences.get(2n)).toBe(3n);
    expect(state.temporarySegmentEquivalences.get(4n)).toBe(5n);
    expect(state.temporarySegmentEquivalences.get(9n)).toBe(9n);
  });
});
