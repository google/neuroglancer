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

import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {Signal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';

export class Uint64OrderedSet implements WatchableValueInterface<Uint64OrderedSet> {
  changed = new Signal<(x: Uint64|Uint64[]|null, add: boolean) => void>();
  private data = new Map<BigInt, Uint64>();

  dispose() {
    this.data.clear();
  }

  get size() {
    return this.data.size;
  }

  get value() {
    return this;
  }

  has(x: Uint64) {
    return this.data.has(BigInt(x.toString()));
  }

  add(x: Uint64|Uint64[]) {
    const {data} = this;
    if (Array.isArray(x)) {
      let added: Uint64[] = [];
      for (let num of x) {
        const bignum = BigInt(num.toString());
        if (data.has(bignum)) continue;
        num = num.clone();
        added.push(num);
        data.set(bignum, num);
      }
      if (added.length !== 0) {
        this.changed.dispatch(added, true);
      }
    } else {
      const bignum = BigInt(x.toString());
      if (data.has(bignum)) {
        return;
      }
      data.set(bignum, x.clone());
      this.changed.dispatch(x, true);
    }
  }

  [Symbol.iterator]() {
    return this.data.values();
  }

  delete(x: Uint64|Uint64[]) {
    const {data} = this;
    if (Array.isArray(x)) {
      let removed: Uint64[] = [];
      for (let num of x) {
        const bignum = BigInt(num.toString());
        if (!data.has(bignum)) continue;
        data.delete(bignum);
        removed.push(num);
      }
      if (removed.length !== 0) {
        this.changed.dispatch(removed, false);
      }
    } else {
      const bignum = BigInt(x.toString());
      if (!data.has(bignum)) {
        return;
      }
      data.delete(bignum);
      this.changed.dispatch(x, false);
    }
  }

  set(x: Uint64|Uint64[], value: boolean) {
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
    return Array.from(this.data.keys(), x => x.toString());
  }

  assignFrom(other: Uint64OrderedSet) {
    this.clear();
    const otherData = other.data;
    const {data} = this;
    const added = Array.from(otherData.values());
    for (const [key, value] of otherData) {
      data.set(key, value);
    }
    this.changed.dispatch(added, true);
  }
}
