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
import {Uint64} from 'neuroglancer/util/uint64';
import {vec3} from 'neuroglancer/util/geom';
import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value';

export interface Bounds {
  center: vec3;
  size: vec3;
}

export interface VisibleSegmentsState {
  rootSegments: Uint64Set;
  visibleSegments2D?: Uint64Set; // not needed for backend
  visibleSegments3D: Uint64Set;
  segmentEquivalences: SharedDisjointUint64Sets;
  clipBounds: SharedWatchableValue<Bounds|undefined>;
}

/**
 * Returns a string key for identifying a uint64 object id.  This is faster than
 * Uint64.prototype.toString().
 */
export function getObjectKey(objectId: Uint64, bounds?: Bounds): string {
  let boundsSuffix = bounds ? `_${bounds.center.toString()}_${bounds.size.toString()}` : '';
  return `${objectId.low},${objectId.high}${boundsSuffix}`;
}

export function forEachRootSegment(
    state: VisibleSegmentsState, callback: (rootObjectId: Uint64) => void) {
  let {rootSegments} = state;
  for (let rootObjectId of rootSegments) {
    callback(rootObjectId);
  }
}

export function forEachVisibleSegment2D(
    state: VisibleSegmentsState, callback: (objectId: Uint64, rootObjectId: Uint64) => void) {
  let {visibleSegments2D, segmentEquivalences} = state;
  for (let objectId of visibleSegments2D!) {
    let rootObjectId = segmentEquivalences.get(objectId);
    callback(objectId, rootObjectId);
  }
}

export function forEachVisibleSegment3D(
    state: VisibleSegmentsState, callback: (objectId: Uint64, rootObjectId: Uint64) => void) {
  let {visibleSegments3D, segmentEquivalences} = state;
  for (let objectId of visibleSegments3D) {
    let rootObjectId = segmentEquivalences.get(objectId);
    callback(objectId, rootObjectId);
  }
}
