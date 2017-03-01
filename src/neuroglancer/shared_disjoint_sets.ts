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

import {DisjointUint64Sets} from 'neuroglancer/util/disjoint_sets';
import {parseArray} from 'neuroglancer/util/json';
import {Uint64} from 'neuroglancer/util/uint64';
import {registerRPC, registerSharedObject, RPC, SharedObjectCounterpart} from 'neuroglancer/worker_rpc';
import {Signal} from 'signals';

const RPC_TYPE_ID = 'DisjointUint64Sets';
const ADD_METHOD_ID = 'DisjointUint64Sets.add';
const REMOVE_METHOD_ID = 'DisjointUint64Sets.remove';
const SPLIT_METHOD_ID = 'DisjointUint64Sets.split';
const CLEAR_METHOD_ID = 'DisjointUint64Sets.clear';

@registerSharedObject(RPC_TYPE_ID)
export class SharedDisjointUint64Sets extends SharedObjectCounterpart {
  disjointSets = new DisjointUint64Sets();
  changed = new Signal();

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

  link(a: Uint64, b: Uint64) {
    if (this.disjointSets.link(a, b)) {
      let {rpc} = this;
      if (rpc) {
        rpc.invoke(
            ADD_METHOD_ID,
            {'id': this.rpcId, 'al': a.low, 'ah': a.high, 'bl': b.low, 'bh': b.high});
      }
      this.changed.dispatch();
    }
  }

  unlink (a: Uint64) {
    if (this.disjointSets.unlink(a)) {
      let {rpc} = this;
      if (rpc) {
        rpc.invoke(
            REMOVE_METHOD_ID,
            {'id': this.rpcId, 'al': a.low, 'ah': a.high});
      }
      this.changed.dispatch();
    }
  }

  split(a: Uint64[], b: Uint64[]) {
    if (this.disjointSets.split(a, b)) {
      let {rpc} = this;
      if (rpc) {
        const xfer_a = Uint64.encodeUint32Array(a);
        const xfer_b = Uint64.encodeUint32Array(b);

        rpc.invoke(
            SPLIT_METHOD_ID,
            { 
              id: this.rpcId, 
              a: xfer_a,
              b: xfer_b,
            }, 
            [xfer_a.buffer, xfer_b.buffer]
        );
      }
      this.changed.dispatch();
    }
  }

  get(x: Uint64): Uint64 { return this.disjointSets.get(x); }

  clear() {
    if (this.disjointSets.clear()) {
      let {rpc} = this;
      if (rpc) {
        rpc.invoke(CLEAR_METHOD_ID, {'id': this.rpcId});
      }
      this.changed.dispatch();
    }
  }

  setElements(a: Uint64) { return this.disjointSets.setElements(a); }

  get size() { return this.disjointSets.size; }

  toJSON() { return this.disjointSets.toJSON(); }

  addSets(obj: any) {
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

  /**
   * Restores the state from a JSON representation.
   */
  restoreState(obj: any) {
    this.clear();
    this.addSets(obj);
  }
};

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

registerRPC(REMOVE_METHOD_ID, function(x) {
  let obj = <SharedDisjointUint64Sets>this.get(x['id']);
  tempA.low = x['al'];
  tempA.high = x['ah'];

  if (obj.disjointSets.unlink(tempA)) {
    obj.changed.dispatch();
  }
});

registerRPC(CLEAR_METHOD_ID, function(x) {
  let obj = <SharedDisjointUint64Sets>this.get(x['id']);
  if (obj.disjointSets.clear()) {
    obj.changed.dispatch();
  }
});

registerRPC(SPLIT_METHOD_ID, function (x) {
  const obj = <SharedDisjointUint64Sets>this.get(x['id']);
  
  const split_group_a = Uint64.decodeUint32Array(x.a);
  const split_group_b = Uint64.decodeUint32Array(x.b);

  if (obj.disjointSets.split(split_group_a, split_group_b)) {
    obj.changed.dispatch();
  }
});











