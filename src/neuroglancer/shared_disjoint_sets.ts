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
import {DisjointUint64Sets} from 'neuroglancer/util/disjoint_sets';
import {parseArray} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';
import {registerRPC, registerSharedObject, RPC, SharedObjectCounterpart} from 'neuroglancer/worker_rpc';

const RPC_TYPE_ID = 'DisjointUint64Sets';
const ADD_METHOD_ID = 'DisjointUint64Sets.add';
const CLEAR_METHOD_ID = 'DisjointUint64Sets.clear';
const DELETE_SET_METHOD_ID = 'DisjointUint64Sets.deleteSet';

const tempA = new Uint64();
const tempB = new Uint64();

@registerSharedObject(RPC_TYPE_ID)
export class SharedDisjointUint64Sets extends SharedObjectCounterpart implements
    WatchableValueInterface<SharedDisjointUint64Sets> {
  disjointSets = new DisjointUint64Sets();
  changed = new NullarySignal();

  /**
   * For compatibility with `WatchableValueInterface`.
   */
  get value() {
    return this
  }

  static makeWithCounterpart(rpc: RPC) {
    let obj = new this();
    obj.initializeCounterpart(rpc);
    return obj;
  }

  disposed() {
    this.disjointSets = <any>undefined;
    this.changed = <any>undefined;
    super.disposed();
  }

  link_(a: Uint64, b: Uint64[]) {
    let changed = false;
    for (const v of b) {
      tempB.low = v.low;
      tempB.high = v.high;
      changed = this.disjointSets.link(a, tempB) || changed;
    }
    return changed;
  }

  link(a: Uint64, b: Uint64|Uint64[]) {
    const tmp = Array<Uint64>().concat(b);
    if (this.link_(a, tmp)) {
      let {rpc} = this;
      if (rpc) {
        rpc.invoke(
            ADD_METHOD_ID,
            {'id': this.rpcId, 'al': a.low, 'ah': a.high, 'b': tmp});
      }
      this.changed.dispatch();
    }
  }

  deleteSet(a: Uint64) {
    if (this.disjointSets.deleteSet(a)) {
      let {rpc} = this;
      if (rpc) {
        rpc.invoke(
            DELETE_SET_METHOD_ID,
            {'id': this.rpcId, 'al': a.low, 'ah': a.high});
      }
      this.changed.dispatch();
    }
  }

  has(x: Uint64): boolean {
    return this.disjointSets.has(x);
  }

  get(x: Uint64): Uint64 {
    return this.disjointSets.get(x);
  }

  clear() {
    if (this.disjointSets.clear()) {
      let {rpc} = this;
      if (rpc) {
        rpc.invoke(CLEAR_METHOD_ID, {'id': this.rpcId});
      }
      this.changed.dispatch();
    }
  }

  setElements(a: Uint64) {
    return this.disjointSets.setElements(a);
  }

  get size() {
    return this.disjointSets.size;
  }

  toJSON() {
    return this.disjointSets.toJSON();
  }

  /**
   * Restores the state from a JSON representation.
   */
  restoreState(obj: any) {
    this.clear();
    if (obj !== undefined) {
      let ids = [new Uint64(), new Uint64()];
      parseArray(obj, z => {
        parseArray(z, (s, index) => {
          ids[index % 2].parseString(String(s), 10);
          if (index !== 0) {
            this.link(ids[0], ids[1]);
          }
        });
      });
    }
  }

  assignFrom(other: SharedDisjointUint64Sets) {
    this.clear();
    this.restoreState(other.toJSON());
  }
}

registerRPC(ADD_METHOD_ID, function(x) {
  let obj = <SharedDisjointUint64Sets>this.get(x['id']);
  tempA.low = x['al'];
  tempA.high = x['ah'];
  if (obj.link_(tempA, x['b'])) {
    obj.changed.dispatch();
  }
});

registerRPC(CLEAR_METHOD_ID, function(x) {
  let obj = <SharedDisjointUint64Sets>this.get(x['id']);
  if (obj.disjointSets.clear()) {
    obj.changed.dispatch();
  }
});

registerRPC(DELETE_SET_METHOD_ID, function(x) {
  let obj = <SharedDisjointUint64Sets>this.get(x['id']);
  tempA.low = x['al'];
  tempA.high = x['ah'];

  if (obj.disjointSets.deleteSet(tempA)) {
    obj.changed.dispatch();
  }
});
