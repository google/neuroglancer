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
import {Signal} from 'signals';


/**
 * Contains a count and signals that are invoked when the count becomes zero or non-zero.
 */
export class UseCount extends RefCounted {
  private count = 0;
  private dependencies = new Map<UseCount, number>();
  becameZero = new Signal();
  becameNonZero = new Signal();

  get value() { return this.count; }

  inc() {
    if (++this.count === 1) {
      this.becameNonZero.dispatch();
    }
  }

  dec() {
    if (--this.count === 0) {
      this.becameZero.dispatch();
    }
  }

  /**
   * Ensure that an additional count is added to other whenever this.count is non-zero.
   */
  addDependency(other: UseCount) {
    let {dependencies} = this;
    let existingCount = dependencies.get(other);
    if (existingCount !== undefined) {
      dependencies.set(other, existingCount + 1);
    } else {
      dependencies.set(other, 1);
      this.becameZero.add(other.dec, other);
      this.becameNonZero.add(other.inc, other);
      if (this.count > 0) {
        other.inc();
      }
    }
  }

  private removeDependency_(other: UseCount) {
    this.becameZero.remove(other.dec, other);
    this.becameNonZero.remove(other.inc, other);
    if (this.count > 0) {
      other.dec();
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
    if (--existing === 0) {
      dependencies.delete(other);
      this.removeDependency_(other);
    } else {
      dependencies.set(other, existing);
    }
  }

  disposed() {
    for (let other of this.dependencies.keys()) {
      this.removeDependency_(other);
    }
    this.dependencies.clear();
  }
};
