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

import {HashSetUint64} from 'neuroglancer/gpu_hash/hash_table';
import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {Signal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';
import {registerRPC, registerSharedObject, RPC, SharedObjectCounterpart} from 'neuroglancer/worker_rpc';

@registerSharedObject('Uint64Set')
export class Uint64Set extends SharedObjectCounterpart implements
    WatchableValueInterface<Uint64Set> {
  hashTable = new HashSetUint64();
  changed = new Signal<(x: Uint64|null, add: boolean) => void>();

  get value() {
    return this;
  }

  static makeWithCounterpart(rpc: RPC) {
    let obj = new Uint64Set();
    obj.initializeCounterpart(rpc);
    return obj;
  }

  set(x: Uint64, value: boolean) {
    if (!value) {
      this.delete(x);
    } else {
      this.add(x);
    }
  }

  add_(x: Uint64) {
    return this.hashTable.add(x);
  }

  add(x: Uint64) {
    if (this.add_(x)) {
      let {rpc} = this;
      if (rpc) {
        rpc.invoke('Uint64Set.add', {'id': this.rpcId, 'value': x});
      }
      this.changed.dispatch(x, true);
    }
  }

  has(x: Uint64) {
    return this.hashTable.has(x);
  }

  [Symbol.iterator]() {
    return this.hashTable.keys();
  }

  delete_(x: Uint64) {
    return this.hashTable.delete(x);
  }

  delete(x: Uint64) {
    if (this.delete_(x)) {
      let {rpc} = this;
      if (rpc) {
        rpc.invoke('Uint64Set.delete', {'id': this.rpcId, 'value': x});
      }
      this.changed.dispatch(x, false);
    }
  }

  get size() {
    return this.hashTable.size;
  }

  clear() {
    if (this.hashTable.clear()) {
      let {rpc} = this;
      if (rpc) {
        rpc.invoke('Uint64Set.clear', {'id': this.rpcId});
      }
      this.changed.dispatch(null, false);
    }
  }

  toJSON() {
    let result = new Array<string>();
    for (let id of this) {
      result.push(id.toString());
    }
    // Need to sort entries, otherwise serialization changes every time.
    result.sort();
    return result;
  }

  assignFrom(other: Uint64Set) {
    this.clear();
    for (const key of other) {
      this.add(key);
    }
  }
}

registerRPC('Uint64Set.add', function(x) {
  let obj = this.get(x['id']);
  if (obj.add_(x['value'])) {
    obj.changed.dispatch();
  }
});

registerRPC('Uint64Set.delete', function(x) {
  let obj = this.get(x['id']);
  if (obj.delete_(x['value'])) {
    obj.changed.dispatch();
  }
});

registerRPC('Uint64Set.clear', function(x) {
  let obj = this.get(x['id']);
  if (obj.hashTable.clear()) {
    obj.changed.dispatch();
  }
});
