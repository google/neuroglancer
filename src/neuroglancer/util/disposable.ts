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

export interface Disposable { dispose: () => void; }

export type Disposer = Disposable | (() => void);

export interface TypedEventListener<E> extends EventListener {
  (event: E): any;
}

export class RefCounted implements Disposable {
  public refCount = 1;
  wasDisposed: boolean|undefined;
  private disposers: Disposer[];
  addRef() {
    ++this.refCount;
    return this;
  }
  dispose() {
    if (--this.refCount !== 0) {
      return;
    }
    this.refCountReachedZero();
  }

  protected refCountReachedZero() {
    this.disposed();
    let {disposers} = this;
    if (disposers != null) {
      let numDisposers = disposers.length;
      for (let i = numDisposers; i > 0; --i) {
        let disposer = disposers[i - 1];
        if (typeof disposer === 'object') {
          (<Disposable>disposer).dispose();
        } else {
          (<() => void>disposer).call(this);
        }
      }
      this.disposers = <any>undefined;
    }
    this.wasDisposed = true;
  }
  disposed() {}
  registerDisposer<T extends Disposer>(f: T): T {
    let {disposers} = this;
    if (disposers == null) {
      this.disposers = [f];
    } else {
      disposers.push(f);
    }
    return f;
  }
  unregisterDisposer<T extends Disposer>(f: T): T {
    let {disposers} = this;
    if (disposers != null) {
      let index = disposers.indexOf(f);
      if (index !== -1) {
        disposers.splice(index, 1);
      }
    }
    return f;
  }
  registerEventListener<E>(target: EventTarget, eventType: string, listener: TypedEventListener<E>, arg?: any) {
    target.addEventListener(eventType, listener, arg);
    this.registerDisposer(() => target.removeEventListener(eventType, listener, arg));
  }
  registerCancellable<T extends{cancel: () => void}>(cancellable: T) {
    this.registerDisposer(() => { cancellable.cancel(); });
    return cancellable;
  }
}

export class RefCountedValue<T> extends RefCounted {
  constructor(public value: T) { super(); }
}
