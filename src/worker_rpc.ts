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

import { promiseWithResolversAndAbortCallback } from "#src/util/abort.js";
import { RefCounted } from "#src/util/disposable.js";
import type {
  ProgressListener,
  ProgressOptions,
  ProgressSpanId,
} from "#src/util/progress_listener.js";
import { ProgressSpan } from "#src/util/progress_listener.js";

export type RPCHandler = (this: RPC, x: any) => void;

export type RpcId = number;

const IS_WORKER = !(typeof Window !== "undefined" && self instanceof Window);

const DEBUG = false;

const DEBUG_MESSAGES = false;

const PROMISE_RESPONSE_ID = "rpc.promise.response";
const PROMISE_CANCEL_ID = "rpc.promise.cancel";
const PROMISE_PROGRESS_ADD_SPAN_ID = "rpc.promise.addProgressSpan";
const PROMISE_PROGRESS_REMOVE_SPAN_ID = "rpc.promise.removeProgressSpan";
const READY_ID = "rpc.ready";

const handlers = new Map<string, RPCHandler>();

export function registerRPC(key: string, handler: RPCHandler) {
  handlers.set(key, handler);
}

export type RPCPromise<T> = Promise<{ value: T; transfers?: any[] }>;

class ProxyProgressListener implements ProgressListener {
  constructor(
    private rpc: RPC,
    private id: number,
  ) {}

  addSpan(span: ProgressSpan) {
    this.rpc.invoke(PROMISE_PROGRESS_ADD_SPAN_ID, {
      id: this.id,
      span: {
        id: span.id,
        message: span.message,
        startTime: span.startTime,
      },
    });
  }
  removeSpan(spanId: ProgressSpanId) {
    this.rpc.invoke(PROMISE_PROGRESS_REMOVE_SPAN_ID, {
      id: this.id,
      spanId,
    });
  }
}

export function registerPromiseRPC<T>(
  key: string,
  handler: (
    this: RPC,
    x: any,
    progressOptions: Partial<ProgressOptions>,
  ) => RPCPromise<T>,
) {
  registerRPC(key, function (this: RPC, x: any) {
    const id = <number>x.id;
    const abortController = new AbortController();
    let progressListener: ProgressListener | undefined;
    if (x.progressListener === true) {
      progressListener = new ProxyProgressListener(this, id);
    }
    const promise = handler.call(this, x, {
      signal: abortController.signal,
      progressListener,
    }) as RPCPromise<T>;
    this.set(id, { promise, abortController });
    promise.then(
      ({ value, transfers }) => {
        this.delete(id);
        this.invoke(PROMISE_RESPONSE_ID, { id: id, value: value }, transfers);
      },
      (error) => {
        this.delete(id);
        this.invoke(PROMISE_RESPONSE_ID, {
          id: id,
          error: error,
        });
      },
    );
  });
}

registerRPC(PROMISE_CANCEL_ID, function (this: RPC, x: any) {
  const id = <number>x.id;
  const request = this.get(id);
  if (request !== undefined) {
    const { abortController } = request;
    abortController.abort();
  }
});

registerRPC(PROMISE_RESPONSE_ID, function (this: RPC, x: any) {
  const id = <number>x.id;
  const { resolve, reject } = this.get(id);
  this.delete(id);
  if (Object.prototype.hasOwnProperty.call(x, "value")) {
    resolve(x.value);
  } else {
    reject(x.error);
  }
});

registerRPC(PROMISE_PROGRESS_ADD_SPAN_ID, function (this: RPC, x: any) {
  const id = <number>x.id;
  const { progressListener } = this.get(id);
  new ProgressSpan(progressListener, x.span);
});

registerRPC(PROMISE_PROGRESS_REMOVE_SPAN_ID, function (this: RPC, x: any) {
  const id = <number>x.id;
  const { progressListener } = this.get(id);
  progressListener.removeSpan(x.spanId);
});

registerRPC(READY_ID, function (this: RPC, x: any) {
  x;
  this.onPeerReady();
});

interface RPCTarget {
  postMessage(message?: any, ports?: any): void;
  onmessage: ((ev: MessageEvent) => any) | null;
}

const INITIAL_RPC_ID = IS_WORKER ? -1 : 0;

export class RPC {
  private objects = new Map<RpcId, any>();
  private nextId: RpcId = INITIAL_RPC_ID;
  private queue: { data: any; transfers?: any[] }[] | undefined;
  constructor(
    public target: RPCTarget,
    waitUntilReady: boolean,
  ) {
    if (waitUntilReady) {
      this.queue = [];
    }
    target.onmessage = (e) => {
      const data = e.data;
      if (DEBUG_MESSAGES) {
        console.log("Received message", data);
      }
      const handler = handlers.get(data.functionName);
      if (handler === undefined) {
        throw new Error(`Missing RPC function: ${data.functionName}`);
      }
      handlers.get(data.functionName)!.call(this, data);
    };
  }

  sendReady() {
    this.invoke(READY_ID, {});
  }

  onPeerReady() {
    const { queue } = this;
    if (queue === undefined) return;
    this.queue = undefined;
    for (const { data, transfers } of queue) {
      this.target.postMessage(data, transfers);
    }
  }

  get numObjects() {
    return this.objects.size;
  }

  set(id: RpcId, value: any) {
    this.objects.set(id, value);
  }

  delete(id: RpcId) {
    this.objects.delete(id);
  }
  get(id: RpcId) {
    return this.objects.get(id);
  }
  getRef<T extends SharedObject>(x: { id: RpcId; gen: number }): T {
    const rpcId = x.id;
    const obj = <T>this.get(rpcId);
    obj.referencedGeneration = x.gen;
    obj.addRef();
    return obj;
  }

  getOptionalRef<T extends SharedObject>(x: {
    id: RpcId;
    gen: number;
  }): T | undefined {
    if (x === undefined) return undefined;
    const rpcId = x.id;
    const obj = this.get(rpcId) as T;
    obj.referencedGeneration = x.gen;
    obj.addRef();
    return obj;
  }

  invoke(name: string, x: any, transfers?: any[]) {
    x.functionName = name;
    if (DEBUG_MESSAGES) {
      console.trace("Sending message", x);
    }
    const { queue } = this;
    if (queue !== undefined) {
      queue.push({ data: x, transfers });
      return;
    }
    this.target.postMessage(x, transfers);
  }

  promiseInvoke<T>(
    name: string,
    x: any,
    options?: {
      signal?: AbortSignal;
      progressListener?: ProgressListener;
      transfers?: any[];
    },
  ): Promise<T> {
    let signal: AbortSignal | undefined;
    let progressListener: ProgressListener | undefined;
    let transfers: any[] | undefined;
    if (options !== undefined) {
      ({ signal, progressListener, transfers } = options);
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    if (progressListener !== undefined) {
      x.progressListener = true;
    }
    const id = (x.id = this.newId());
    this.invoke(name, x, transfers);
    const { promise, resolve, reject } =
      signal === undefined
        ? Promise.withResolvers<T>()
        : promiseWithResolversAndAbortCallback<T>(signal, () => {
            this.invoke(PROMISE_CANCEL_ID, { id: id });
          });
    this.set(id, { resolve, reject, progressListener });
    return promise;
  }

  newId() {
    return IS_WORKER ? this.nextId-- : this.nextId++;
  }
}

export class SharedObject extends RefCounted {
  rpc: RPC | null = null;
  rpcId: RpcId | null = null;
  isOwner: boolean | undefined;
  unreferencedGeneration: number;
  referencedGeneration: number;

  initializeSharedObject(rpc: RPC, rpcId = rpc.newId()) {
    this.rpc = rpc;
    this.rpcId = rpcId;
    this.isOwner = false;
    rpc.set(rpcId, this);
  }

  initializeCounterpart(rpc: RPC, options: any = {}) {
    this.initializeSharedObject(rpc);
    this.unreferencedGeneration = 0;
    this.referencedGeneration = 0;
    this.isOwner = true;
    options.id = this.rpcId;
    options.type = this.RPC_TYPE_ID;
    rpc.invoke("SharedObject.new", options);
  }

  dispose() {
    super.dispose();
  }

  /**
   * Precondition: this.isOwner === true.
   */
  addCounterpartRef() {
    return { id: this.rpcId, gen: ++this.referencedGeneration };
  }

  protected refCountReachedZero() {
    if (this.isOwner === true) {
      if (this.referencedGeneration === this.unreferencedGeneration) {
        this.ownerDispose();
      }
    } else if (this.isOwner === false) {
      this.rpc!.invoke("SharedObject.refCountReachedZero", {
        id: this.rpcId,
        gen: this.referencedGeneration,
      });
    } else {
      super.refCountReachedZero();
    }
  }

  /**
   * Precondition: this.isOwner === true.
   */
  protected ownerDispose() {
    if (DEBUG) {
      console.log(`[${IS_WORKER}] #rpc object = ${this.rpc!.numObjects}`);
    }
    const { rpc, rpcId } = this;
    super.refCountReachedZero();
    rpc!.delete(rpcId!);
    rpc!.invoke("SharedObject.dispose", { id: rpcId });
  }

  /**
   * Precondition: this.isOwner === true.
   *
   * This should be called when the counterpart's refCount is decremented and reaches zero.
   */
  counterpartRefCountReachedZero(generation: number) {
    this.unreferencedGeneration = generation;
    if (this.refCount === 0 && generation === this.referencedGeneration) {
      this.ownerDispose();
    }
  }

  /**
   * Should be set to a constant specifying the SharedObject type identifier on the prototype of
   * final derived owner classes.  It is not used on counterpart (non-owner) classes.
   */
  declare RPC_TYPE_ID: string;
}

export function initializeSharedObjectCounterpart(
  obj: SharedObject,
  rpc?: RPC,
  options: any = {},
) {
  if (rpc != null) {
    obj.initializeSharedObject(rpc, options.id);
  }
}

/**
 * Base class for defining a SharedObject type that will never be owned.
 */
export class SharedObjectCounterpart extends SharedObject {
  constructor(rpc?: RPC, options: any = {}) {
    super();
    initializeSharedObjectCounterpart(this, rpc, options);
  }
}

export interface SharedObjectConstructor {
  new (rpc: RPC, options: any): SharedObjectCounterpart;
}

registerRPC("SharedObject.dispose", function (x) {
  const obj = <SharedObject>this.get(x.id);
  if (obj.refCount !== 0) {
    throw new Error(
      "Attempted to dispose object with non-zero reference count.",
    );
  }
  if (DEBUG) {
    console.log(`[${IS_WORKER}] #rpc objects: ${this.numObjects}`);
  }
  obj.disposed();
  this.delete(obj.rpcId!);
  obj.rpcId = null;
  obj.rpc = null;
});

registerRPC("SharedObject.refCountReachedZero", function (x) {
  const obj = <SharedObject>this.get(x.id);
  const generation = <number>x.gen;
  obj.counterpartRefCountReachedZero(generation);
});

const sharedObjectConstructors = new Map<string, SharedObjectConstructor>();

/**
 * Register a class as a SharedObject owner type under the specified identifier.
 *
 * This is intended to be used as a decorator.
 */
export function registerSharedObjectOwner(identifier: string) {
  return (constructorFunction: { prototype: { RPC_TYPE_ID: string } }) => {
    constructorFunction.prototype.RPC_TYPE_ID = identifier;
  };
}

/**
 * Register a class as a SharedObject counterpart type under the specified identifier.
 *
 * This is intended to be used as a decorator.
 *
 * Also register the type as a SharedObject owner, which is useful if this type is also used as a
 * SharedObject owner.
 */
export function registerSharedObject(identifier?: string) {
  return (constructorFunction: SharedObjectConstructor) => {
    if (identifier !== undefined) {
      constructorFunction.prototype.RPC_TYPE_ID = identifier;
    } else {
      identifier = constructorFunction.prototype.RPC_TYPE_ID;
      if (identifier === undefined) {
        throw new Error("RPC_TYPE_ID should have already been defined");
      }
    }
    sharedObjectConstructors.set(identifier, constructorFunction);
  };
}

registerRPC("SharedObject.new", function (x) {
  const rpc = <RPC>this;
  const typeName = <string>x.type;
  const constructorFunction = sharedObjectConstructors.get(typeName)!;
  const obj = new constructorFunction(rpc, x);
  // Counterpart objects start with a reference count of zero.
  --obj.refCount;
});
