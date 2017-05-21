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

/**
 * @file Facility for sharing arbitrary values that support structural cloning between threads.
 */

import {WatchableValue} from 'neuroglancer/trackable_value';
import {registerRPC, registerSharedObject, RPC, SharedObjectCounterpart} from 'neuroglancer/worker_rpc';

const CHANGED_RPC_METHOD_ID = 'SharedWatchableValue.changed';

@registerSharedObject('SharedWatchableValue')
export class SharedWatchableValue<T> extends SharedObjectCounterpart {
  base: WatchableValue<T>;

  /**
   * The value is being updated to reflect a remote change.
   * @internal
   */
  updatingValue_ = false;

  constructor(rpc?: RPC, options: any = {}) {
    super(rpc, options);
    if (rpc !== undefined) {
      this.base = new WatchableValue<T>(options['value']);
      this.setupChangedHandler();
    }
  }

  initializeCounterpart(rpc: RPC, options: any = {}) {
    options['value'] = this.value;
    super.initializeCounterpart(rpc, options);
  }

  private setupChangedHandler() {
    this.registerDisposer(this.base.changed.add(() => {
      if (this.updatingValue_) {
        this.updatingValue_ = false;
      } else {
        const {rpc} = this;
        if (rpc !== null) {
          rpc.invoke(CHANGED_RPC_METHOD_ID, {'id': this.rpcId, 'value': this.value});
        }
      }
    }));
  }

  static makeFromExisting<T>(rpc: RPC, base: WatchableValue<T>) {
    let obj = new SharedWatchableValue<T>();
    obj.base = base;
    obj.setupChangedHandler();
    obj.initializeCounterpart(rpc);
    return obj;
  }

  static make<T>(rpc: RPC, value: T) {
    return SharedWatchableValue.makeFromExisting(rpc, new WatchableValue<T>(value));
  }

  get value() {
    return this.base.value;
  }

  set value(value: T) {
    this.base.value = value;
  }

  get changed() {
    return this.base.changed;
  }
}

registerRPC(CHANGED_RPC_METHOD_ID, function(x) {
  const obj = <SharedWatchableValue<any>>this.get(x['id']);
  obj.updatingValue_ = true;
  obj.base.value = x['value'];
  obj.updatingValue_ = false;
});
