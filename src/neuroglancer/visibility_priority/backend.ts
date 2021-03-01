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

import 'neuroglancer/shared_watchable_value';

import {ChunkRequester} from 'neuroglancer/chunk_manager/backend';
import {ChunkPriorityTier, PREFETCH_PRIORITY_MULTIPLIER} from 'neuroglancer/chunk_manager/base';
import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value';
import {RPC} from 'neuroglancer/worker_rpc';

/**
 * Mixin for adding a visibility shared property to a ChunkRequester.  Calls
 * `this.chunkManager.scheduleUpdateChunkPriorities()` when visibility changes.
 */
export function withSharedVisibility<T extends{new (...args: any[]): ChunkRequester}>(Base: T) {
  return class extends Base {
    visibility: SharedWatchableValue<number>;

    constructor(...args: any[]) {
      super(...args);
      const rpc: RPC = args[0];
      const options: any = args[1];
      this.visibility = rpc.get(options['visibility']);
      this.registerDisposer(
          this.visibility.changed.add(() => this.chunkManager.scheduleUpdateChunkPriorities()));
    }
  };
}

/**
 * Computes the ChunkPriorityTier for the given `visibility` value.
 *
 * A value of `Number.POSITIVE_INFINITY` means `VISIBLE`.  Any other value means `PREFETCH`.
 */
export function getPriorityTier(visibility: number): ChunkPriorityTier {
  return visibility === Number.POSITIVE_INFINITY ? ChunkPriorityTier.VISIBLE :
                                                   ChunkPriorityTier.PREFETCH;
}

/**
 * Computes the base priority for the given `visibility` value.  If the value is
 * `Number.POSTIVE_INFINITY`, corresponding to actual visibility, the base priority is 0.
 * Otherwise, the value is interpreted as the prefetch priority (higher means higher priority), and
 * the base priority is equal to the product of this value and `PREFETCH_PRIORITY_MULTIPLIER`.
 */
export function getBasePriority(visibility: number): number {
  return (visibility === Number.POSITIVE_INFINITY ? 0 : visibility * PREFETCH_PRIORITY_MULTIPLIER);
}
