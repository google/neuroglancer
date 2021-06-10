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

import {SharedDisjointUint64Sets} from 'neuroglancer/shared_disjoint_sets';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {RefCounted} from 'neuroglancer/util/disposable';
import {Uint64} from 'neuroglancer/util/uint64';

export interface VisibleSegmentsState {
  rootSegments: Uint64Set;
  rootSegmentsAfterEdit?: Uint64Set; // new roots generated as result of edit operation
  hiddenRootSegments?: Uint64Set; // not needed for backend, for segment_set_widget.ts
  visibleSegments: Uint64Set;
  segmentEquivalences: SharedDisjointUint64Sets;
}

export const VISIBLE_SEGMENTS_STATE_PROPERTIES: (keyof VisibleSegmentsState)[] = [
  'visibleSegments',
  'segmentEquivalences',
  'rootSegments',
];

export function onVisibleSegmentsStateChanged(
    context: RefCounted, state: VisibleSegmentsState, callback: () => void) {
  context.registerDisposer(state.visibleSegments.changed.add(callback));
  context.registerDisposer(state.segmentEquivalences.changed.add(callback));

  context.registerDisposer(state.rootSegments.changed.add(callback));
}

/**
 * Returns a string key for identifying a uint64 object id.  This is faster than
 * Uint64.prototype.toString().
 */
export function getObjectKey(objectId: Uint64): string {
  return `${objectId.low},${objectId.high}`;
}

export function getVisibleSegments(state: VisibleSegmentsState) {
  return state.visibleSegments;
}

export function getSegmentEquivalences(state: VisibleSegmentsState) {
  return state.segmentEquivalences;
}

export function forEachRootSegment(
  state: VisibleSegmentsState, callback: (rootObjectId: Uint64) => void) {
  let {rootSegments} = state;
  for (let rootObjectId of rootSegments) {
    callback(rootObjectId);
  }
}

export function forEachVisibleSegment3D(
  state: VisibleSegmentsState, callback: (objectId: Uint64, rootObjectId: Uint64) => void) {
  let {visibleSegments, segmentEquivalences} = state;
  for (let objectId of visibleSegments) {
    let rootObjectId = segmentEquivalences.get(objectId);
    callback(objectId, rootObjectId);
  }
}

export interface IndexedSegmentProperty {
  id: string;
  type: 'string';
  description: string|undefined;
}
