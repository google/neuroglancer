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

import { VisibleSegmentEquivalencePolicy } from "#src/segmentation_graph/segment_id.js";
import type { SharedDisjointUint64Sets } from "#src/shared_disjoint_sets.js";
import type { SharedWatchableValue } from "#src/shared_watchable_value.js";
import type { Uint64OrderedSet } from "#src/uint64_ordered_set.js";
import type { Uint64Set } from "#src/uint64_set.js";
import type { RefCounted } from "#src/util/disposable.js";

export interface VisibleSegmentsState {
  visibleSegments: Uint64Set;
  selectedSegments: Uint64OrderedSet;
  segmentEquivalences: SharedDisjointUint64Sets;

  // Specifies a temporary/alternative set of segments/equivalences to use for display purposes,
  // used for previewing a merge/split.
  temporaryVisibleSegments: Uint64Set;
  temporarySegmentEquivalences: SharedDisjointUint64Sets;
  useTemporaryVisibleSegments: SharedWatchableValue<boolean>;
  useTemporarySegmentEquivalences: SharedWatchableValue<boolean>;
}

export const VISIBLE_SEGMENTS_STATE_PROPERTIES = [
  "visibleSegments",
  "segmentEquivalences",
  "temporaryVisibleSegments",
  "temporarySegmentEquivalences",
  "useTemporaryVisibleSegments",
  "useTemporarySegmentEquivalences",
] as const;

export function onVisibleSegmentsStateChanged(
  context: RefCounted,
  state: VisibleSegmentsState,
  callback: () => void,
) {
  context.registerDisposer(state.visibleSegments.changed.add(callback));
  context.registerDisposer(state.segmentEquivalences.changed.add(callback));
}

export function onTemporaryVisibleSegmentsStateChanged(
  context: RefCounted,
  state: VisibleSegmentsState,
  callback: () => void,
) {
  context.registerDisposer(
    state.temporaryVisibleSegments.changed.add(callback),
  );
  context.registerDisposer(
    state.temporarySegmentEquivalences.changed.add(callback),
  );
  context.registerDisposer(
    state.useTemporaryVisibleSegments.changed.add(callback),
  );
  context.registerDisposer(
    state.useTemporarySegmentEquivalences.changed.add(callback),
  );
}

/**
 * Returns a string key for identifying a uint64 object id.
 */
export function getObjectKey(objectId: bigint): string {
  return objectId.toString();
}

function isHighBitSegment(segmentId: bigint): boolean {
  return (segmentId & 0x8000000000000000n) !== 0n;
}

export function getVisibleSegments(state: VisibleSegmentsState) {
  return state.useTemporaryVisibleSegments.value
    ? state.temporaryVisibleSegments
    : state.visibleSegments;
}

export function getSegmentEquivalences(state: VisibleSegmentsState) {
  return state.useTemporarySegmentEquivalences.value
    ? state.temporarySegmentEquivalences
    : state.segmentEquivalences;
}

export function forEachVisibleSegment(
  state: VisibleSegmentsState,
  callback: (objectId: bigint, rootObjectId: bigint) => void,
) {
  const visibleSegments = getVisibleSegments(state);
  const segmentEquivalences = getSegmentEquivalences(state);
  const equivalencePolicy =
    segmentEquivalences.disjointSets.visibleSegmentEquivalencePolicy.value;
  for (const rootObjectId of visibleSegments.keys()) {
    if (
      equivalencePolicy &
      VisibleSegmentEquivalencePolicy.NONREPRESENTATIVE_EXCLUDED
    ) {
      const rootObjectId2 = segmentEquivalences.get(rootObjectId);
      callback(rootObjectId, rootObjectId2);
    } else {
      // TODO(jbms): Remove this check if logic is added to ensure that it always holds.
      if (!segmentEquivalences.disjointSets.isMinElement(rootObjectId)) {
        continue;
      }
      for (const objectId of segmentEquivalences.setElements(rootObjectId)) {
        if (
          equivalencePolicy &
            VisibleSegmentEquivalencePolicy.REPRESENTATIVE_EXCLUDED &&
          equivalencePolicy &
            VisibleSegmentEquivalencePolicy.MAX_REPRESENTATIVE &&
          isHighBitSegment(objectId)
        ) {
          continue;
        }
        callback(objectId, rootObjectId);
      }
    }
  }
}

export interface IndexedSegmentProperty {
  id: string;
  type: "string";
  description: string | undefined;
}
