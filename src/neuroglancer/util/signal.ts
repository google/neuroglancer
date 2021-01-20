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
 * @file Simple signal dispatch mechanism.
 */

/**
 * This class provides a simple signal dispatch mechanism.  Handlers can be added, and then the
 * `dispatch` method calls all of them.
 *
 * If specified, Callable should be an interface containing only a callable signature returning
 * void.  Due to limitations in TypeScript, any interface containing a callable signature will be
 * accepted by the compiler, but the resultant signature of `dispatch` will not be correct.
 */
export class Signal<Callable extends Function = () => void> {
  private handlers = new Set<Callable>();

  /**
   * Count of number of times this signal has been dispatched.  This is incremented each time
   * `dispatch` is called prior to invoking the handlers.
   */
  count = 0;

  constructor() {
    const obj = this;
    this.dispatch = <Callable><Function>function(this: any) {
      ++obj.count;
      obj.handlers.forEach(handler => {
        handler.apply(this, arguments);
      });
    };
  }

  /**
   * Add a handler function.  If `dispatch` is currently be called, then the new handler will be
   * called before `dispatch` returns.
   *
   * @param handler The handler function to add.
   *
   * @return A function that unregisters the handler.
   */
  add(handler: Callable): () => boolean {
    this.handlers.add(handler);
    return () => {
      return this.remove(handler);
    };
  }

  /**
   * Remove a handler function.  If `dispatch` is currently be called and the new handler has not
   * yet been called, then it will not be called.
   *
   * @param handler Handler to remove.
   * @return `true` if the handler was present, `false` otherwise.
   */
  remove(handler: Callable): boolean {
    return this.handlers.delete(handler);
  }

  /**
   * Invokes each handler function with the same parameters (including `this`) with which it is
   * called.  Handlers are invoked in the order in which they were added.
   */
  dispatch: Callable;

  /**
   * Disposes of resources.  No methods, including `dispatch`, may be invoked afterwards.
   */
  dispose() {
    this.handlers = <any>undefined;
  }
}

export function observeSignal(
    callback: () => void,
    ...signals: {add(callback: () => void): void, remove(callback: () => void): void}[]) {
  callback();
  for (let i = 0, count = signals.length; i < count; ++i) {
    signals[i].add(callback);
  }
  return () => {
    for (let i = 0, count = signals.length; i < count; ++i) {
      signals[i].remove(callback);
    }
  };
}

/**
 * Simple specialization of Signal for the common case of a nullary handler signature.
 */
export class NullarySignal extends Signal<() => void> {}

/**
 * Interface for a signal excluding the dispatch method.
 *
 * Unlike Signal, this interface is covariant in the type of Callable.
 */
export interface ReadonlySignal<Callable extends Function> {
  readonly count: number;
  add(handler: Callable): () => void;
  remove(handler: Callable): boolean;
}

export type NullaryReadonlySignal = ReadonlySignal<() => void>;

export const neverSignal: NullaryReadonlySignal = {
  count: 0,
  add(_handler: any) {
    return () => {};
  },
  remove(_handler: any) {
    return false;
  },
};
