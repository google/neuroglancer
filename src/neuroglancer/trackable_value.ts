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

import debounce from 'lodash/debounce';
import {Borrowed, Disposable, invokeDisposers, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {neverSignal, NullaryReadonlySignal, NullarySignal, Signal} from 'neuroglancer/util/signal';
import {Trackable} from 'neuroglancer/util/trackable';

export interface WatchableValueInterface<T> {
  value: T;
  changed: NullaryReadonlySignal;
}

export interface WatchableValueChangeInterface<T> {
  readonly value: T;
  readonly changed: Signal<(oldValue: T, newValue: T) => void>;
}

export class WatchableValue<T> implements WatchableValueInterface<T> {
  get value() {
    return this.value_;
  }
  set value(newValue: T) {
    if (newValue !== this.value_) {
      this.value_ = newValue;
      this.changed.dispatch();
    }
  }
  changed = new NullarySignal();
  constructor(protected value_: T) {}
}

export class TrackableValue<T> extends WatchableValue<T> implements Trackable {
  constructor(value: T, public validator: (value: any) => T, public defaultValue = value) {
    super(value);
  }
  toJSON(): any {
    let {value_} = this;
    if (value_ === this.defaultValue) {
      return undefined;
    }
    return this.value_;
  }
  reset() {
    this.value = this.defaultValue;
  }
  restoreState(x: any) {
    if (x !== undefined) {
      let {validator} = this;
      try {
        this.value = validator(x);
        return;
      } catch (ignoredError) {
      }
    }
    this.value = this.defaultValue;
  }
}

class DerivedWatchableValue<U> extends RefCounted implements WatchableValueInterface<U> {
  changed = new NullarySignal();
  get value() {
    return this.f(...this.ws.map(w => w.value));
  }
  private f: (...v: any[]) => U;
  private ws: WatchableValueInterface<any>[];

  constructor(f: (...v: any[]) => U, ws: WatchableValueInterface<any>[]) {
    super();
    this.f = f;
    this.ws = ws;
    for (const w of ws) {
      this.registerDisposer(w.changed.add(this.changed.dispatch));
    }
  }
}

export function makeDerivedWatchableValue<U, T extends any[]>(
    f: (...v: T) => U, ...ws: {[K in keyof T]: WatchableValueInterface<T[K]>}) {
  return new DerivedWatchableValue(f, ws);
}

class CachedLazyDerivedWatchableValue<U> extends RefCounted implements WatchableValueInterface<U> {
  changed = new NullarySignal();
  private value_: U|undefined;
  private valueGeneration = -1;
  get value() {
    const generation = this.changed.count;
    if (generation !== this.valueGeneration) {
      this.value_ = this.f(...this.ws.map(w => w.value));
      this.valueGeneration = generation;
    }
    return this.value_ as U;
  }
  private f: (...v: any[]) => U;
  private ws: WatchableValueInterface<any>[];

  constructor(f: (...v: any[]) => U, ws: WatchableValueInterface<any>[]) {
    super();
    this.f = f;
    this.ws = ws;
    for (const w of ws) {
      this.registerDisposer(w.changed.add(this.changed.dispatch));
    }
  }
}

export function makeCachedLazyDerivedWatchableValue<U, T extends any[]>(
    f: (...v: T) => U, ...ws: {[K in keyof T]: WatchableValueInterface<T[K]>}) {
  return new CachedLazyDerivedWatchableValue(f, ws);
}

export class CachedWatchableValue<T> extends RefCounted implements WatchableValueInterface<T> {
  changed = new Signal();
  value: T;
  constructor(
      base: WatchableValueInterface<T>, isEqual: (a: T, b: T) => boolean = (a, b) => a === b) {
    super();
    this.value = base.value;
    this.registerDisposer(base.changed.add(() => {
      const newValue = base.value;
      if (!isEqual(this.value, newValue)) {
        this.value = newValue;
        this.changed.dispatch();
      }
    }));
  }
}

export function makeCachedDerivedWatchableValue<U, T extends any[]>(
    f: (...v: T) => U, ws: {[K in keyof T]: WatchableValueInterface<T[K]>},
    isEqual?: (a: U, b: U) => boolean) {
  const derived = new DerivedWatchableValue(f, ws);
  const cached = new CachedWatchableValue(derived, isEqual);
  cached.registerDisposer(derived);
  return cached;
}

export class AggregateWatchableValue<T> extends RefCounted implements WatchableValueInterface<T> {
  changed = new NullarySignal();
  value: T;
  constructor(
      getWatchables: (self: RefCounted) => {[k in keyof T]: WatchableValueInterface<T[k]>}) {
    super();
    const watchables = getWatchables(this);
    const keys = Object.keys(watchables) as (keyof T)[];
    const updateValue = () => {
      const obj = (Array.isArray(watchables) ? [] : {}) as T;
      for (const k of keys) {
        obj[k] = watchables[k].value;
      }
      this.value = obj;
      this.changed.dispatch();
    };
    updateValue();
    for (const k of keys) {
      const watchable = watchables[k];
      // Ensure a unique function is used each time in case the same watchable is assigned to
      // multiple properties.
      this.registerDisposer(watchable.changed.add(() => updateValue()));
    }
  }
}

export class ComputedWatchableValue<U> extends RefCounted implements WatchableValueInterface<U> {
  get value() {
    return this.f();
  }
  changed = new NullarySignal();
  constructor(public f: () => U, ...signals: NullarySignal[]) {
    super();
    for (const signal of signals) {
      this.registerDisposer(signal.add(this.changed.dispatch));
    }
  }
}

export class WatchableRefCounted<T extends RefCounted> extends RefCounted implements
    WatchableValueInterface<T|undefined> {
  changed = new NullarySignal();

  private value_: Owned<T>|undefined;
  private valueHandler: (() => void)|undefined;

  get value(): Borrowed<T>|undefined {
    return this.value_;
  }

  set value(value: Owned<T>|undefined) {
    const {value_} = this;
    this.value_ = value;
    if (value_ !== undefined) {
      value_.dispose();
      value_.unregisterDisposer(this.valueHandler!);
      this.valueHandler = undefined;
    }
    if (value !== undefined) {
      const valueHandler = this.valueHandler = () => {
        if (this.value_ === value) {
          this.value_ = undefined;
          this.changed.dispatch();
        }
      };
      value.registerDisposer(valueHandler);
    }

    if (value !== value_) {
      this.changed.dispatch();
    }
  }

  reset() {
    this.value = undefined;
  }

  disposed() {
    if (this.value_ !== undefined) {
      this.value_.unregisterDisposer(this.valueHandler!);
      this.value_.dispose();
    }
    this.value_ = undefined;
    super.disposed();
  }
}


export interface TrackableValueInterface<T> extends WatchableValueInterface<T>, Trackable {}

export class TrackableRefCounted<T extends RefCounted> extends WatchableRefCounted<T> implements
    TrackableValueInterface<T|undefined> {
  constructor(
      public validator: (value: any) => T | undefined, public jsonConverter: (value: T) => any) {
    super();
  }
  toJSON() {
    const {value} = this;
    return value && this.jsonConverter(value);
  }

  restoreState(x: any) {
    this.value = this.validator(x);
  }
}

export class WatchableSet<T> {
  changed = new Signal<(x: T|null, add: boolean) => void>();
  values: Set<T>;
  constructor(values?: Iterable<T>) {
    if (values === undefined) {
      this.values = new Set();
    } else {
      this.values = new Set(values);
    }
  }
  add(x: T) {
    const {values} = this;
    if (!values.has(x)) {
      values.add(x);
      this.changed.dispatch(x, true);
    }
    return this;
  }
  delete(x: T) {
    const {values} = this;
    if (values.delete(x)) {
      this.changed.dispatch(x, false);
      return true;
    }
    return false;
  }
  has(x: T) {
    return this.values.has(x);
  }
  get size() {
    return this.values.size;
  }
  [Symbol.iterator]() {
    return this.values[Symbol.iterator]();
  }
  clear() {
    const {values} = this;
    if (values.size > 0) {
      values.clear();
      this.changed.dispatch(null, false);
    }
  }
}

export interface NestedStateManager<T = undefined> extends Disposable {
  flush: () => void;
  value: T;
}

export function registerNested<U, T extends any[]>(
    f: (context: RefCounted, ...values: T) => U,
    ...watchables: {[K in keyof T]: WatchableValueInterface<T[K]>}): NestedStateManager<U> {
  let values = watchables.map(w => w.value) as T;
  const count = watchables.length;
  let context = new RefCounted();
  let result = f(context, ...values);

  const handleChange = debounce(() => {
    let changed = false;
    for (let i = 0; i < count; ++i) {
      const watchable = watchables[i];
      const value = watchable.value;
      if (values[i] !== value) {
        values[i] = value;
        changed = true;
      }
    }
    if (!changed) return;
    context.dispose();
    context = new RefCounted();
    result = f(context, ...values);
  }, 0);

  const signalDisposers = watchables.map(w => w.changed.add(handleChange));

  return {
    flush() {
      handleChange.flush();
    },
    dispose() {
      handleChange.cancel();
      invokeDisposers(signalDisposers);
      context.dispose();
    },
    get value() {
      handleChange.flush();
      return result;
    },
  };
}

export function registerNestedSync<U, T extends any[]>(
    f: (context: RefCounted, ...values: T) => U,
    ...watchables: {[K in keyof T]: WatchableValueInterface<T[K]>}):
    {readonly value: U, dispose(): void} {
  let values = watchables.map(w => w.value) as T;
  const count = watchables.length;
  let context = new RefCounted();
  let result = f(context, ...values);

  const handleChange = () => {
    let changed = false;
    for (let i = 0; i < count; ++i) {
      const watchable = watchables[i];
      const value = watchable.value;
      if (values[i] !== value) {
        values[i] = value;
        changed = true;
      }
    }
    if (!changed) return;
    context.dispose();
    context = new RefCounted();
    result = f(context, ...values);
  };

  const signalDisposers = watchables.map(w => w.changed.add(handleChange));

  return {
    dispose() {
      invokeDisposers(signalDisposers);
      context.dispose();
    },
    get value() {
      return result;
    },
  };
}

export function constantWatchableValue<T>(value: T): WatchableValueInterface<T> {
  return {changed: neverSignal, value};
}

export function observeWatchable<T>(
    callback: (value: T) => void, watchable: WatchableValueInterface<T>) {
  callback(watchable.value);
  return watchable.changed.add(() => callback(watchable.value));
}

export function linkWatchableValue<T>(
    source: WatchableValueInterface<T>, target: WatchableValueInterface<T>) {
  target.value = source.value;
  return source.changed.add(() => {
    target.value = source.value;
  });
}

export class IndirectWatchableValue<U, T> implements Disposable, WatchableValueInterface<T> {
  protected inner: WatchableValueInterface<T>;
  changed = new NullarySignal();
  disposer: (() => void) | undefined;
  private update = () => {
    const {disposer, outer} = this;
    if (disposer !== undefined) {
      disposer();
    }
    const inner = this.inner = this.getInner(outer.value);
    this.disposer = inner.changed.add(this.changed.dispatch);
    this.changed.dispatch();
  };
  constructor(private outer: WatchableValueInterface<U>, private getInner: (outer: U) => WatchableValueInterface<T>) {
    outer.changed.add(this.update);
    this.update();
  }

  dispose() {
    this.outer.changed.remove(this.update);
    this.disposer!();
  }

  get value() {
    return this.inner.value;
  }
  set value(value: T) {
    this.inner.value = value;
  }
}

export class IndirectTrackableValue<U, T> extends IndirectWatchableValue<U, T> implements
    Trackable {
  declare inner: TrackableValueInterface<T>;
  reset() {
    this.inner.reset();
  }
  restoreState(obj: unknown) {
    this.inner.restoreState(obj);
  }
  toJSON() {
    return this.inner.toJSON();
  }
}
