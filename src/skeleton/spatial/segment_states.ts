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

import { HashMapUint64 } from "#src/gpu_hash/hash_table.js";
import { SkeletonSegmentState } from "#src/skeleton/frontend.js";
import type { Uint64Set } from "#src/uint64_set.js";

// One hash map, so that the shader reads one texture for both sets.
export class SpatialSkeletonSegmentStates {
  readonly hashMap = new HashMapUint64();
  private excludedGeneration = Number.NaN;
  private provisionalGeneration = Number.NaN;

  constructor(
    private readonly excludedFromChunks: Uint64Set,
    private readonly provisional: Uint64Set,
  ) {}

  update() {
    const excludedGeneration = this.excludedFromChunks.hashTable.generation;
    const provisionalGeneration = this.provisional.hashTable.generation;
    if (
      excludedGeneration === this.excludedGeneration &&
      provisionalGeneration === this.provisionalGeneration
    ) {
      return;
    }
    this.excludedGeneration = excludedGeneration;
    this.provisionalGeneration = provisionalGeneration;
    const states = new Map<bigint, number>();
    for (const segmentId of this.excludedFromChunks) {
      states.set(segmentId, SkeletonSegmentState.EXCLUDED_FROM_CHUNKS);
    }
    for (const segmentId of this.provisional) {
      states.set(
        segmentId,
        (states.get(segmentId) ?? 0) | SkeletonSegmentState.PROVISIONAL,
      );
    }
    const { hashMap } = this;
    hashMap.clear();
    for (const [segmentId, state] of states) {
      hashMap.set(segmentId, BigInt(state));
    }
  }
}
