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

import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value';
import {WatchableValue} from 'neuroglancer/trackable_value';
import {RPC} from 'neuroglancer/worker_rpc';
import {SharedObject} from 'neuroglancer/worker_rpc';

/**
 * Numeric value specifying a visibility or prefetch priority.
 *
 * A value of `Number.POSITIVE_INFINITY` means visible.
 *
 * Any other finite value means not visible, and specifies the prefetch priority (higher means
 * higher priority); this should always be a small integer.
 *
 * A value of `Number.NEGATIVE_INFINITY` means ignored (not visible, and not prefetched).
 */
export type VisibilityPriority = number;

export class WatchableVisibilityPriority extends WatchableValue<VisibilityPriority> {
  constructor(value = Number.NEGATIVE_INFINITY) {
    super(value);
  }

  static VISIBLE = Number.POSITIVE_INFINITY;
  static IGNORED = Number.NEGATIVE_INFINITY;
  get visible() {
    return this.value === Number.POSITIVE_INFINITY;
  }

  get ignored() {
    return this.value === Number.NEGATIVE_INFINITY;
  }
}

export interface VisibilityPrioritySpecification { visibility: WatchableVisibilityPriority; }

/**
 * Maintains the maximum value of multiple WatchableVisibilityPriority values.
 */
export class VisibilityPriorityAggregator extends WatchableVisibilityPriority {
  private contributors = new Map<WatchableVisibilityPriority, () => void>();

  /**
   * Registers `x` to be included in the set of values to be aggregated.
   *
   * @returns A disposer function that unregisters the specified value.
   */
  add(x: WatchableVisibilityPriority) {
    const {contributors} = this;
    const changedDisposer = x.changed.add(() => {
      this.update();
    });
    const disposer = () => {
      contributors.delete(x);
      changedDisposer();
      this.update();
    };
    contributors.set(x, disposer);
    this.update();
    return disposer;
  }

  /**
   * Unregisters `x` from the set of values to be aggregated.
   *
   * This is equivalent to calling the disposer function returned by `this.add(x)`.
   */
  remove(x: WatchableVisibilityPriority) {
    const disposer = this.contributors.get(x)!;
    disposer();
  }

  private update() {
    let priority = Number.NEGATIVE_INFINITY;
    for (const x of this.contributors.keys()) {
      priority = Math.max(priority, x.value);
    }
    this.value = priority;
  }
}

/**
 * Mixin that adds a `visibility` property which is shared with the counterpart.
 */
export function withSharedVisibility<T extends{new (...args: any[]): SharedObject}>(Base: T) {
  return class extends Base {
    visibility = new VisibilityPriorityAggregator();

    initializeCounterpart(rpc: RPC, options: any = {}) {
      // Backend doesn't need to own a reference to SharedWatchableValue because frontend, which is
      // the owner of this SharedObject, owns a reference.
      options['visibility'] =
          this.registerDisposer(SharedWatchableValue.makeFromExisting(rpc, this.visibility)).rpcId;
      super.initializeCounterpart(rpc, options);
    }
  };
}
