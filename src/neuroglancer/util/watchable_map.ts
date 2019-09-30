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
  constructor(
      private register: (v: V, k: K) => void, private unregister: (v: V, k: K) => void,
      values?: Iterable<[K, V]>) {
    super();
    if (values === undefined) {
      this.map = new Map();
    } else {
      this.map = new Map(values);
      this.map.forEach(this.register);
    }
  }
  set(key: K, value: V) {
    const {map} = this;
    const existing = map.get(key);
    if (existing !== undefined) {
      this.unregister(existing, key);
    }
    map.set(key, value);
    this.register(value, key);
    this.changed.dispatch();
    return this;
  }
  delete(key: K) {
    const {map} = this;
    const existing = map.get(key);
    if (existing !== undefined) {
      this.unregister(existing, key);
      this.changed.dispatch();
      return true;
    }
    return false;
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
    const {map} = this;
    if (map.size > 0) {
      map.forEach(this.unregister);
      map.clear();
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
    const {map} = this;
    map.forEach(this.unregister);
    this.map.clear();
    super.disposed();
  }
}
