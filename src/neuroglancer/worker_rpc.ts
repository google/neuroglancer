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

import {RefCounted} from 'neuroglancer/util/disposable';

export type RPCHandler = (this: RPC, x: any) => void;

export type RpcId = number;

const IS_WORKER = WORKER;

var handlers = new Map<string, RPCHandler>();

export function registerRPC (key: string, handler: RPCHandler) {
  handlers.set(key, handler);
};

interface RPCTarget {
  postMessage(message?: any, ports?: any): void;
  onmessage: (ev: MessageEvent) => any;
}

export class RPC {
  private objects = new Map<RpcId, any>();
  private nextId: RpcId = IS_WORKER ? -1 : 0;
  constructor (public target: RPCTarget) {
    target.onmessage = (e) => {
      let data = e.data;
      handlers.get(data.functionName).call(this, data);
    };
  }

  set(id: RpcId, value: any) {
    this.objects.set(id, value);
  }

  delete(id: RpcId) {
    this.objects.delete(id);
  }
  get (id: RpcId) {
    return this.objects.get(id);
  }
  getRef<T extends SharedObject> (x: {'id': RpcId, 'gen': number}) {
    let rpcId = x['id'];
    let obj = <T>this.get(rpcId);
    obj.referencedGeneration = x['gen'];
    obj.addRef();
    return obj;
  }
  invoke (name: string, x: any, transfers?: any[]) {
    x.functionName = name;
    this.target.postMessage(x, transfers);
  }
  newId () {
    return IS_WORKER ? this.nextId-- : this.nextId++;
  }
};

export class SharedObject extends RefCounted {
  rpc: RPC = null;
  rpcId: RpcId = null;
  isOwner: boolean|undefined;
  unreferencedGeneration: number|undefined;
  referencedGeneration: number|undefined;

  initializeSharedObject (rpc: RPC, rpcId = rpc.newId()) {
    this.rpc = rpc;
    this.rpcId = rpcId;
    this.isOwner = false;
    rpc.set(rpcId, this);
  }

  initializeCounterpart (rpc: RPC, options: any = {}) {
    this.initializeSharedObject(rpc);
    this.unreferencedGeneration = 0;
    this.referencedGeneration = 0;
    this.isOwner = true;
    options['id'] = this.rpcId;
    rpc.invoke('SharedObject.new', options);
  }

  disposed () {
    let {rpc} = this;
    if (rpc != null) {
      this.rpc = null;
      let {rpcId} = this;
      rpc.delete(rpcId);
      rpc.invoke('SharedObject.dispose', {'id': rpcId});
    }
  }

  /**
   * Precondition: this.isOwner === true.
   */
  addCounterpartRef () {
    return {'id': this.rpcId, 'gen': ++this.referencedGeneration};
  }

  protected refCountReachedZero () {
    if (this.isOwner === true) {
      if (this.referencedGeneration === this.unreferencedGeneration) {
        this.ownerDispose();
      }
    } else if (this.isOwner === false) {
      this.rpc.invoke('SharedObject.refCountReachedZero', {'id': this.rpcId, 'gen': this.referencedGeneration});
    } else {
      super.refCountReachedZero();
    }
  }

  /**
   * Precondition: this.isOwner === true.
   */
  protected ownerDispose () {
    super.refCountReachedZero();
    let {rpc, rpcId} = this;
    rpc.delete(rpcId);
    rpc.invoke('SharedObject.dispose', {'id': rpcId});
  }

  /**
   * Precondition: this.isOwner === true.
   *
   * This should be called when the counterpart's refCount is decremented and reaches zero.
   */
  counterpartRefCountReachedZero (generation: number) {
    this.unreferencedGeneration = generation;
    if (this.refCount === 0 && generation === this.referencedGeneration) {
      this.ownerDispose();
    }
  }
};

/**
 * Base class for defining a SharedObject type that will never be owned.
 */
export class SharedObjectCounterpart extends SharedObject {
  constructor(rpc?: RPC, options: any = {}) {
    super();
    if (rpc != null) {
      this.initializeSharedObject(rpc, options['id']);
    }
  }
};


export interface SharedObjectConstructor {
  new (rpc: RPC, options: any): SharedObjectCounterpart;
}

registerRPC('SharedObject.dispose', function(x) {
  let obj = <SharedObject>this.get(x['id']);
  obj.dispose();
  this.delete(obj.rpcId);
  obj.rpcId = null;
  obj.rpc = null;
});

registerRPC('SharedObject.refCountReachedZero', function(x) {
  let obj = <SharedObject>this.get(x['id']);
  let generation = <number>x['gen'];
  obj.counterpartRefCountReachedZero(generation);
});

const sharedObjectConstructors = new Map<string, SharedObjectConstructor>();

export function registerSharedObject(name: string, constructorFunction: SharedObjectConstructor) {
  sharedObjectConstructors.set(name, constructorFunction);
}

registerRPC('SharedObject.new', function(x) {
  let rpc = <RPC>this;
  let typeName = <string>x['type'];
  let constructorFunction = sharedObjectConstructors.get(typeName);
  let obj = new constructorFunction(rpc, x);
  // Counterpart objects start with a reference count of zero.
  --obj.refCount;
});
