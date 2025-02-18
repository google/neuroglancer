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

import type { VisibleSegmentEquivalencePolicy } from "#src/segmentation_graph/segment_id.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { DisjointUint64Sets } from "#src/util/disjoint_sets.js";
import { parseArray, parseUint64 } from "#src/util/json.js";
import { NullarySignal } from "#src/util/signal.js";
import type { RPC } from "#src/worker_rpc.js";
import {
  registerRPC,
  registerSharedObject,
  SharedObjectCounterpart,
} from "#src/worker_rpc.js";

const RPC_TYPE_ID = "DisjointUint64Sets";
const ADD_METHOD_ID = "DisjointUint64Sets.add";
const CLEAR_METHOD_ID = "DisjointUint64Sets.clear";
const HIGH_BIT_REPRESENTATIVE_CHANGED_ID =
  "DisjointUint64Sets.highBitRepresentativeChanged";
const DELETE_SET_METHOD_ID = "DisjointUint64Sets.deleteSet";

@registerSharedObject(RPC_TYPE_ID)
export class SharedDisjointUint64Sets
  extends SharedObjectCounterpart
  implements WatchableValueInterface<SharedDisjointUint64Sets>
{
  disjointSets = new DisjointUint64Sets();
  changed = new NullarySignal();

  /**
   * For compatibility with `WatchableValueInterface`.
   */
  get value() {
    return this;
  }

  static makeWithCounterpart(
    rpc: RPC,
    highBitRepresentative: WatchableValueInterface<VisibleSegmentEquivalencePolicy>,
  ) {
    const obj = new SharedDisjointUint64Sets();
    obj.disjointSets.visibleSegmentEquivalencePolicy = highBitRepresentative;
    obj.registerDisposer(
      highBitRepresentative.changed.add(() => {
        updateHighBitRepresentative(obj);
      }),
    );
    obj.initializeCounterpart(rpc);
    if (highBitRepresentative.value) {
      updateHighBitRepresentative(obj);
    }
    return obj;
  }

  link(a: bigint, b: bigint) {
    if (this.disjointSets.link(a, b)) {
      const { rpc } = this;
      if (rpc) {
        rpc.invoke(ADD_METHOD_ID, {
          id: this.rpcId,
          a: a,
          b: b,
        });
      }
      this.changed.dispatch();
      return true;
    }
    return false;
  }

  linkAll(ids: bigint[]) {
    for (let i = 1, length = ids.length; i < length; ++i) {
      this.link(ids[0], ids[i]);
    }
  }

  has(x: bigint): boolean {
    return this.disjointSets.has(x);
  }

  get(x: bigint): bigint {
    return this.disjointSets.get(x);
  }

  clear() {
    if (this.disjointSets.clear()) {
      const { rpc } = this;
      if (rpc) {
        rpc.invoke(CLEAR_METHOD_ID, { id: this.rpcId });
      }
      this.changed.dispatch();
    }
  }

  setElements(a: bigint) {
    return this.disjointSets.setElements(a);
  }

  deleteSet(x: bigint) {
    if (this.disjointSets.deleteSet(x)) {
      const { rpc } = this;
      if (rpc) {
        rpc.invoke(DELETE_SET_METHOD_ID, {
          id: this.rpcId,
          x,
        });
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
      parseArray(obj, (z) => {
        let prev: bigint | undefined;
        parseArray(z, (s) => {
          const cur = parseUint64(s);
          if (prev !== undefined) {
            this.link(prev, cur);
          }
          prev = cur;
        });
      });
    }
  }

  assignFrom(other: SharedDisjointUint64Sets | DisjointUint64Sets) {
    this.clear();
    if (other instanceof SharedDisjointUint64Sets) {
      other = other.disjointSets;
    }
    for (const [a, b] of other) {
      this.link(a, b);
    }
  }
}

registerRPC(ADD_METHOD_ID, function (x) {
  const obj = <SharedDisjointUint64Sets>this.get(x.id);
  if (obj.disjointSets.link(x.a, x.b)) {
    obj.changed.dispatch();
  }
});

registerRPC(CLEAR_METHOD_ID, function (x) {
  const obj = <SharedDisjointUint64Sets>this.get(x.id);
  if (obj.disjointSets.clear()) {
    obj.changed.dispatch();
  }
});

function updateHighBitRepresentative(obj: SharedDisjointUint64Sets) {
  obj.rpc!.invoke(HIGH_BIT_REPRESENTATIVE_CHANGED_ID, {
    id: obj.rpcId,
    value: obj.disjointSets.visibleSegmentEquivalencePolicy.value,
  });
}

registerRPC(HIGH_BIT_REPRESENTATIVE_CHANGED_ID, function (x) {
  const obj = this.get(x.id) as SharedDisjointUint64Sets;
  obj.disjointSets.visibleSegmentEquivalencePolicy.value = x.value;
});

registerRPC(DELETE_SET_METHOD_ID, function (x) {
  const obj = <SharedDisjointUint64Sets>this.get(x.id);
  if (obj.disjointSets.deleteSet(x.x)) {
    obj.changed.dispatch();
  }
});
