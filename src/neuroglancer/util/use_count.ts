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

import {RefCounted} from 'neuroglancer/util/disposable';
import {Signal} from 'neuroglancer/util/signal';

/**
 * Contains a count and signals that are invoked when the count becomes zero or non-zero.
 */
export class UseCount extends RefCounted {
  private count = 0;
  private dependencies = new Map<UseCount, {refCount: number, unregister: () => void}>();
  signChanged = new Signal<{(sign: number): void}>();

  get value() {
    return this.count;
  }

  inc() {
    if (++this.count === 1) {
      this.signChanged.dispatch(1);
    }
  }

  dec() {
    if (--this.count === 0) {
      this.signChanged.dispatch(0);
    }
  }

  /**
   * Ensure that an additional count is added to other whenever this.count is non-zero.
   */
  addDependency(other: UseCount) {
    let {dependencies} = this;
    let existing = dependencies.get(other);
    if (existing !== undefined) {
      existing.refCount += 1;
    } else {
      dependencies.set(other, {
        refCount: 1,
        unregister: this.signChanged.add(sign => sign ? other.inc() : other.dec())
      });
      if (this.count > 0) {
        other.inc();
      }
    }
  }

  /**
   * Undoes the effect of addDependency.
   */
  removeDependency(other: UseCount) {
    let {dependencies} = this;
    let existing = dependencies.get(other);
    if (existing === undefined) {
      throw new Error('Attempted to remove non-existing dependency.');
    }
    if (--existing.refCount === 0) {
      dependencies.delete(other);
      existing.unregister();
      if (this.count) {
        other.dec();
      }
    }
  }

  disposed() {
    const {count} = this;
    for (let [other, info] of this.dependencies) {
      info.unregister();
      if (count) {
        other.dec();
      }
    }
    this.dependencies.clear();
  }
}
