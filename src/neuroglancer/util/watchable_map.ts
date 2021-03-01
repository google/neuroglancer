/**
 * @license
 * Copyright 2018 Google Inc.
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
import {NullarySignal} from 'neuroglancer/util/signal';

export class WatchableMap<K, V> extends RefCounted {
  changed = new NullarySignal();
  map: Map<K, V>;
  private disposerMap = new Map<K, RefCounted>();
  constructor(
      private register: (context: RefCounted, v: V, k: K) => void, values?: Iterable<[K, V]>) {
    super();
    if (values === undefined) {
      this.map = new Map();
    } else {
      const map = this.map = new Map(values);
      const {disposerMap} = this;
      for (const [key, value] of map) {
        const context = new RefCounted();
        disposerMap.set(key, context);
        register(context, value, key);
      }
    }
  }

  get value(): ReadonlyMap<K, V> {
    return this.map;
  }

  set(key: K, value: V) {
    const {map, disposerMap} = this;
    let context = disposerMap.get(key);
    if (context !== undefined) {
      context.dispose();
    }
    context = new RefCounted();
    disposerMap.set(key, context);
    map.set(key, value);
    this.register(context, value, key);
    this.changed.dispatch();
    return this;
  }
  delete(key: K) {
    const {map, disposerMap} = this;
    const context = disposerMap.get(key);
    if (context !== undefined) {
      context.dispose();
      disposerMap.delete(key);
      map.delete(key);
      this.changed.dispatch();
      return true;
    }
    return false;
  }
  get(key: K) {
    return this.map.get(key);
  }
  has(key: K) {
    return this.map.has(key);
  }
  get size() {
    return this.map.size;
  }
  [Symbol.iterator]() {
    return this.map[Symbol.iterator]();
  }
  clear() {
    const {map, disposerMap} = this;
    if (map.size > 0) {
      for (const disposer of disposerMap.values()) {
        disposer.dispose();
      }
      map.clear();
      disposerMap.clear();
      this.changed.dispatch();
    }
  }
  values() {
    return this.map.values();
  }
  keys() {
    return this.map.keys();
  }
  disposed() {
    const {map, disposerMap} = this;
    for (const disposer of disposerMap.values()) {
      disposer.dispose();
    }
    map.clear();
    disposerMap.clear();
    super.disposed();
  }
}
