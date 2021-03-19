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
 * @file Defines a generic interface for a simple state tracking mechanism.
 */

import {RefCounted} from 'neuroglancer/util/disposable';
import {verifyObject, verifyOptionalObjectProperty} from 'neuroglancer/util/json';
import {NullaryReadonlySignal, NullarySignal} from 'neuroglancer/util/signal';

export interface JsonRestorable {
  restoreState: (x: any) => void;
}

export function optionallyRestoreFromJsonMember(
    obj: any, member: string, restorable: JsonRestorable) {
  verifyOptionalObjectProperty(obj, member, x => restorable.restoreState(x));
}

export interface Trackable extends JsonRestorable {
  restoreState: (x: any) => void;
  reset: () => void;
  changed: NullaryReadonlySignal;
  toJSON: () => any;
}

export class CompoundTrackable extends RefCounted implements Trackable {
  children = new Map<string, Trackable>();
  changed = new NullarySignal();

  add(key: string, value: Trackable): () => void {
    const {children} = this;
    if (children.has(key)) {
      throw new Error(`Key ${JSON.stringify(key)} already registered.`);
    }
    this.children.set(key, value);
    value.changed.add(this.changed.dispatch);
    this.changed.dispatch();
    return () => {
      this.remove(key);
    };
  }

  remove(key: string): void {
    const {children} = this;
    if (children.has(key)) {
      throw new Error(`Key ${JSON.stringify(key)} not registered.`);
    }
    const value = children.get(key)!;
    this.children.delete(key);
    value.changed.remove(this.changed.dispatch);
    this.changed.dispatch();
  }

  disposed() {
    const {changed} = this;
    for (let value of this.children.values()) {
      value.changed.remove(changed.dispatch);
    }
    this.children = <any>undefined;
    super.disposed();
  }

  toJSON() {
    const result = this.baseJSON();
    for (let [key, value] of this.children) {
      result[key] = value.toJSON();
    }
    return result;
  }

  baseJSON() {
    return <{[key: string]: any}>{};
  }

  reset() {
    for (let value of this.children.values()) {
      value.reset();
    }
  }

  restoreState(x: any) {
    verifyObject(x);
    for (let [key, value] of this.children) {
      try {
        if (x.hasOwnProperty(key)) {
          const subValue = x[key];
          if (subValue === undefined) {
            continue;
          }
          value.restoreState(subValue);
        }
      } catch (restoreError) {
        throw new Error(`Error restoring property ${JSON.stringify(key)}: ${restoreError.message}`);
      }
    }
  }
}

export class PersistentCompoundTrackable extends CompoundTrackable {
  lastState: {[key: string]: any} = {};

  restoreState(x: any) {
    verifyObject(x);
    this.lastState = x;
    super.restoreState(x);
  }

  reset () {
    this.lastState = {};
    super.reset();
  }

  baseJSON() {
    const result = Object.assign(super.baseJSON(), this.lastState);
    for (const key of this.children.keys()) {
      delete result[key];
    }
    return result;
  }

  toJSON() {
    const result = super.toJSON();
    this.lastState = result;
    return result;
  }
  add(key: string, value: Trackable) {
    const result = super.add(key, value);
    const existingValue = this.lastState[key];
    if (existingValue !== undefined) {
      value.reset();
      value.restoreState(existingValue);
    }
    return result;
  }
}

/**
 * Cache used by getCachedJson.
 */
const jsonCache = new WeakMap<Trackable, {value: any, generation: number}>();

/**
 * Returns a JSON representation of a Trackable object.
 *
 * Recursively caches the result, such that it is only necessary to traverse the changed portions of
 * the object.
 *
 * The returned value must not be modified.
 */
export function getCachedJson(root: Trackable): {value: any, generation: number} {
  let cacheState = jsonCache.get(root);
  const generation = root.changed.count;
  if (cacheState !== undefined) {
    if (cacheState.generation === generation) {
      return cacheState;
    }
  }
  let value: any;
  if (root instanceof CompoundTrackable) {
    value = root.baseJSON();
    for (let [k, v] of root.children) {
      value[k] = getCachedJson(v).value;
    }
  } else {
    value = root.toJSON();
  }
  if (cacheState === undefined) {
    cacheState = {generation, value};
    jsonCache.set(root, cacheState);
  } else {
    cacheState.generation = generation;
    cacheState.value = value;
  }
  return cacheState;
}
