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
const HIGH_BIT_REPRESENTATIVE_CHANGED_ID = 'DisjointUint64Sets.highBitRepresentativeChanged';
const DELETE_SET_METHOD_ID = 'DisjointUint64Sets.deleteSet';

@registerSharedObject(RPC_TYPE_ID)
export class SharedDisjointUint64Sets extends SharedObjectCounterpart implements
    WatchableValueInterface<SharedDisjointUint64Sets> {
  disjointSets = new DisjointUint64Sets();
  changed = new NullarySignal();

  /**
   * For compatibility with `WatchableValueInterface`.
   */
  get value() {
    return this;
  }

  static makeWithCounterpart(rpc: RPC, highBitRepresentative: WatchableValueInterface<boolean>) {
    let obj = new this();
    obj.disjointSets.highBitRepresentative = highBitRepresentative;
    obj.registerDisposer(highBitRepresentative.changed.add(() => {
      updateHighBitRepresentative(obj);
    }));
    obj.initializeCounterpart(rpc);
    if (highBitRepresentative.value) {
      updateHighBitRepresentative(obj);
    }
    return obj;
  }

  disposed() {
    this.disjointSets = <any>undefined;
    this.changed = <any>undefined;
    super.disposed();
  }

  link(a: Uint64, b: Uint64) {
    if (this.disjointSets.link(a, b)) {
      let {rpc} = this;
      if (rpc) {
        rpc.invoke(
            ADD_METHOD_ID,
            {'id': this.rpcId, 'al': a.low, 'ah': a.high, 'bl': b.low, 'bh': b.high});
      }
      this.changed.dispatch();
      return true;
    }
    return false;
  }

  linkAll(ids: Uint64[]) {
    for (let i = 1, length = ids.length; i < length; ++i) {
      this.link(ids[0], ids[i]);
    }
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

  deleteSet(x: Uint64) {
    if (this.disjointSets.deleteSet(x)) {
      let {rpc} = this;
      if (rpc) {
        rpc.invoke(DELETE_SET_METHOD_ID, {'id': this.rpcId, 'l': x.low, 'h': x.high});
      }
      this.changed.dispatch();
    }
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

  assignFrom(other: SharedDisjointUint64Sets|DisjointUint64Sets) {
    this.clear();
    if (other instanceof SharedDisjointUint64Sets) {
      other = other.disjointSets;
    }
    for (const [a, b] of other) {
      this.link(a, b);
    }
  }
}

const tempA = new Uint64();
const tempB = new Uint64();

registerRPC(ADD_METHOD_ID, function(x) {
  let obj = <SharedDisjointUint64Sets>this.get(x['id']);
  tempA.low = x['al'];
  tempA.high = x['ah'];
  tempB.low = x['bl'];
  tempB.high = x['bh'];
  if (obj.disjointSets.link(tempA, tempB)) {
    obj.changed.dispatch();
  }
});

registerRPC(CLEAR_METHOD_ID, function(x) {
  let obj = <SharedDisjointUint64Sets>this.get(x['id']);
  if (obj.disjointSets.clear()) {
    obj.changed.dispatch();
  }
});

function updateHighBitRepresentative(obj: SharedDisjointUint64Sets) {
  obj.rpc!.invoke(
      HIGH_BIT_REPRESENTATIVE_CHANGED_ID,
      {'id': obj.rpcId, 'value': obj.disjointSets.highBitRepresentative.value});
}

registerRPC(HIGH_BIT_REPRESENTATIVE_CHANGED_ID, function(x) {
  let obj = this.get(x['id']) as SharedDisjointUint64Sets;
  obj.disjointSets.highBitRepresentative.value = x['value'];
});

registerRPC(DELETE_SET_METHOD_ID, function(x) {
  let obj = <SharedDisjointUint64Sets>this.get(x['id']);
  tempA.low = x['l'];
  tempA.high = x['h'];
  if (obj.disjointSets.deleteSet(tempA)) {
    obj.changed.dispatch();
  }
});
