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

import type { WatchableValueInterface } from "#src/trackable_value.js";
import { Signal } from "#src/util/signal.js";

export class Uint64OrderedSet
  implements WatchableValueInterface<Uint64OrderedSet>
{
  changed = new Signal<(x: bigint | bigint[] | null, add: boolean) => void>();
  private data = new Set<bigint>();

  dispose() {
    this.data.clear();
  }

  get size() {
    return this.data.size;
  }

  get value() {
    return this;
  }

  has(x: bigint) {
    return this.data.has(x);
  }

  add(x: bigint | bigint[] | BigUint64Array) {
    const { data } = this;
    if (typeof x !== "bigint") {
      const added: bigint[] = [];
      for (const num of x) {
        if (data.has(num)) continue;
        added.push(num);
        data.add(num);
      }
      if (added.length !== 0) {
        this.changed.dispatch(added, true);
      }
    } else {
      if (data.has(x)) {
        return;
      }
      data.add(x);
      this.changed.dispatch(x, true);
    }
  }

  [Symbol.iterator]() {
    return this.data.values();
  }

  delete(x: bigint | bigint[] | BigUint64Array) {
    const { data } = this;
    if (typeof x !== "bigint") {
      const removed: bigint[] = [];
      for (const num of x) {
        if (!data.has(num)) continue;
        data.delete(num);
        removed.push(num);
      }
      if (removed.length !== 0) {
        this.changed.dispatch(removed, false);
      }
    } else {
      if (!data.has(x)) {
        return;
      }
      data.delete(x);
      this.changed.dispatch(x, false);
    }
  }

  set(x: bigint | bigint[] | BigUint64Array, value: boolean) {
    if (!value) {
      this.delete(x);
    } else {
      this.add(x);
    }
  }

  clear() {
    if (this.data.size > 0) {
      this.data.clear();
      this.changed.dispatch(null, false);
    }
  }

  toJSON() {
    return Array.from(this.data, (x) => x.toString());
  }

  assignFrom(other: Uint64OrderedSet) {
    this.clear();
    const otherData = other.data;
    const { data } = this;
    const added = Array.from(otherData);
    for (const x of otherData) {
      data.add(x);
    }
    this.changed.dispatch(added, true);
  }
}
