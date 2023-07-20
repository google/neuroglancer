/**
 * @license
 * Copyright 2020 Google Inc.
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

import {Uint64} from 'neuroglancer/util/uint64';

export enum VisibleSegmentEquivalencePolicy {
  MIN_REPRESENTATIVE = 0, // defafult, representative elmement is the minimum element in equivalence set
  MAX_REPRESENTATIVE = 1, // representative elmement is the maximum element in equivalence set
  REPRESENTATIVE_EXCLUDED = 1 << 1, // filter out the representative element when iterating over visible segments
  NONREPRESENTATIVE_EXCLUDED = 1 << 2, // filter out non representative elements when iterating over visible segments
}


// Returns `true` if `segmentId` is a base segment id, rather than a segment id added to the graph.
export function isBaseSegmentId(segmentId: Uint64) {
  return (segmentId.high >>> 31) ? false : true;
}

export const UNKNOWN_NEW_SEGMENT_ID = new Uint64(0xffffffff, 0xffffffff);
