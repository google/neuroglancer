/**
 * @license
 * This work is a derivative of the Google Neuroglancer project,
 * Copyright 2016 Google Inc.
 * The Derivative Work is covered by
 * Copyright 2019 Howard Hughes Medical Institute
 *
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

import {HashMapUint64} from 'neuroglancer/gpu_hash/hash_table';
import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {Signal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';
import {registerRPC, registerSharedObject, RPC, SharedObjectCounterpart} from 'neuroglancer/worker_rpc';

@registerSharedObject('Uint64Map')
export class Uint64Map extends SharedObjectCounterpart implements
    WatchableValueInterface<Uint64Map> {
  hashTable = new HashMapUint64();
  changed = new Signal<(x: Uint64|null, add: boolean) => void>();

  get value() {
    return this;
  }

  static makeWithCounterpart(rpc: RPC) {
    let obj = new Uint64Map();
    obj.initializeCounterpart(rpc);
    return obj;
  }

  set_(key: Uint64, value: Uint64) {
    return this.hashTable.set(key, value);
  }

  set(key: Uint64, value: Uint64) {
    if (this.set_(key, value)) {
      let {rpc} = this;
      if (rpc) {
        rpc.invoke('Uint64Map.set', {'id': this.rpcId, 'key': key, 'value': value});
      }
      this.changed.dispatch(key, true);
    }
  }

  has(key: Uint64) {
    return this.hashTable.has(key);
  }

  get(key: Uint64, value: Uint64): boolean {
    return this.hashTable.get(key, value);
  }

  [Symbol.iterator]() {
    return this.hashTable.entries();
  }

  delete_(key: Uint64) {
    return this.hashTable.delete(key);
  }

  delete(key: Uint64) {
    if (this.delete_(key)) {
      let {rpc} = this;
      if (rpc) {
        rpc.invoke('Uint64Map.delete', {'id': this.rpcId, 'key': key});
      }
      this.changed.dispatch(key, false);
    }
  }

  get size() {
    return this.hashTable.size;
  }

  assignFrom(other: Uint64Map) {
    this.clear();
    for (const [key, value] of other) {
      this.set(key, value);
    }
  }

  clear() {
    if (this.hashTable.clear()) {
      let {rpc} = this;
      if (rpc) {
        rpc.invoke('Uint64Map.clear', {'id': this.rpcId});
      }
      this.changed.dispatch(null, false);
    }
  }

  toJSON() {
    let result: {[key: string]: string} = {};
    for (let [key, value] of this.hashTable.entries()) {
      result[key.toString()] = value.toString();
    }
    return result;
  }
}

registerRPC('Uint64Map.set', function(x) {
  let obj = this.get(x['id']);
  if (obj.set_(x['key'], x['value'])) {
    obj.changed.dispatch();
  }
});

registerRPC('Uint64Map.delete', function(x) {
  let obj = this.get(x['id']);
  if (obj.delete_(x['key'])) {
    obj.changed.dispatch();
  }
});

registerRPC('Uint64Map.clear', function(x) {
  let obj = this.get(x['id']);
  if (obj.hashTable.clear()) {
    obj.changed.dispatch();
  }
});
