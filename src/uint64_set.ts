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

import { HashSetUint64 } from "#src/gpu_hash/hash_table.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { Signal } from "#src/util/signal.js";
import type { RPC } from "#src/worker_rpc.js";
import {
  registerRPC,
  registerSharedObject,
  SharedObjectCounterpart,
} from "#src/worker_rpc.js";

@registerSharedObject("Uint64Set")
export class Uint64Set
  extends SharedObjectCounterpart
  implements WatchableValueInterface<Uint64Set>
{
  hashTable = new HashSetUint64();
  changed = new Signal<
    (x: bigint | bigint[] | BigUint64Array | null, add: boolean) => void
  >();

  get value() {
    return this;
  }

  static makeWithCounterpart(rpc: RPC) {
    const obj = new Uint64Set();
    obj.initializeCounterpart(rpc);
    return obj;
  }

  set(x: bigint | bigint[] | BigUint64Array, value: boolean) {
    if (!value) {
      this.delete(x);
    } else {
      this.add(x);
    }
  }

  reserve_(x: number) {
    return this.hashTable.reserve(x);
  }

  reserve(x: number) {
    if (this.reserve_(x)) {
      const { rpc } = this;
      if (rpc) {
        rpc.invoke("Uint64Set.reserve", { id: this.rpcId, value: x });
      }
    }
  }

  add_(x: bigint[] | BigUint64Array) {
    let changed = false;
    for (const v of x) {
      changed = this.hashTable.add(v) || changed;
    }
    return changed;
  }

  add(x: bigint | bigint[] | BigUint64Array) {
    const tmp = typeof x === "bigint" ? [x] : x;
    if (this.add_(tmp)) {
      const { rpc } = this;
      if (rpc) {
        rpc.invoke("Uint64Set.add", { id: this.rpcId, value: tmp });
      }
      this.changed.dispatch(x, true);
    }
  }

  has(x: bigint) {
    return this.hashTable.has(x);
  }

  [Symbol.iterator]() {
    return this.hashTable.keys();
  }

  keys() {
    return this.hashTable.keys();
  }

  delete_(x: bigint[] | BigUint64Array) {
    let changed = false;
    for (const v of x) {
      changed = this.hashTable.delete(v) || changed;
    }
    return changed;
  }

  delete(x: bigint | bigint[] | BigUint64Array) {
    const tmp = typeof x === "bigint" ? [x] : x;
    if (this.delete_(tmp)) {
      const { rpc } = this;
      if (rpc) {
        rpc.invoke("Uint64Set.delete", { id: this.rpcId, value: tmp });
      }
      this.changed.dispatch(x, false);
    }
  }

  get size() {
    return this.hashTable.size;
  }

  clear() {
    if (this.hashTable.clear()) {
      const { rpc } = this;
      if (rpc) {
        rpc.invoke("Uint64Set.clear", { id: this.rpcId });
      }
      this.changed.dispatch(null, false);
    }
  }

  toJSON() {
    const result = new Array<string>();
    for (const id of this.keys()) {
      result.push(id.toString());
    }
    // Need to sort entries, otherwise serialization changes every time.
    result.sort();
    return result;
  }

  assignFrom(other: Uint64Set) {
    this.clear();
    for (const key of other.keys()) {
      this.add(key);
    }
  }
}

registerRPC("Uint64Set.reserve", function (x) {
  const obj = this.get(x.id);
  if (obj.reserve_(x.value)) {
    obj.changed.dispatch();
  }
});

registerRPC("Uint64Set.add", function (x) {
  const obj = this.get(x.id);
  if (obj.add_(x.value)) {
    obj.changed.dispatch();
  }
});

registerRPC("Uint64Set.delete", function (x) {
  const obj = this.get(x.id);
  if (obj.delete_(x.value)) {
    obj.changed.dispatch();
  }
});

registerRPC("Uint64Set.clear", function (x) {
  const obj = this.get(x.id);
  if (obj.hashTable.clear()) {
    obj.changed.dispatch();
  }
});
