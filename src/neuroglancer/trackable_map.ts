/**
 * @license
 * Copyright 2017 Google Inc.
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
 * @file Convenience interface for creating TrackableValue instances designed to represent alpha
 * (opacity) values.
 */

import {NullarySignal} from 'neuroglancer/util/signal';
import {Trackable} from 'neuroglancer/util/trackable';

interface JsonSerializable {
  toJSON?: () => {};
}
type JsonableKey = number|string;
type PossibleJsonableValue = JsonableKey|JsonSerializable|{}|null;
type JsonableValue = PossibleJsonableValue | PossibleJsonableValue[];

// Note: Cannot extend from ES2015 Map type :(
export class TrackableMap<K extends JsonableKey, V extends JsonableValue> implements Trackable {
  changed = new NullarySignal();

  private map: Map<K, V>;

  constructor(initialValue: Iterable<[K, V]> = [], private defaultValue = initialValue) {
    this.map = new Map<K, V>(initialValue);
  }
  clear() {
    this.map.clear();
    this.changed.dispatch();
  }
  delete(key: K) {
    let result = this.map.delete(key);
    this.changed.dispatch();
    return result;
  }
  entries() {
    return this.map.entries();
  }
  forEach(callbackFn: (value: V, key: K, map: Map<K, V>) => void, thisArg?: any) {
    return this.map.forEach(callbackFn, thisArg);
  }
  get(key: K) {
    return this.map.get(key);
  }
  has(key: K) {
    return this.map.has(key);
  }
  keys() {
    return this.map.keys();
  }
    set(key: K, value: V) {
    let result = this.map.set(key, value);
    this.changed.dispatch();
    return result;
  }
  values() {
    return this.map.values();
  }

  reset() {
    this.map = new Map<K, V>(this.defaultValue);
    this.changed.dispatch();
  }
  restoreState(x: any){
    this.map = new Map<K, V>(x);
  }
  toJSON() {
    let json: {[key: string]: JsonableValue}  = {};
    this.forEach((value, key) => {
      let maybeSerializable = value as JsonSerializable;
      let jsonValue = maybeSerializable.toJSON ? maybeSerializable.toJSON() : value;
      json[key as string] = jsonValue;
    });
    return json;
  }
  [Symbol.iterator]() {
    return this.map;
  }
}
