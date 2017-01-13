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

// Facility for storing global state in the url hash.

import {urlSafeParse, urlSafeStringify} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';


// Maps keys to objects.
let trackedKeys = new Map<string, Trackable>();
// Maps objects to keys.
let trackedObjects = new Map<Trackable, string>();

let currentHashState: any = {};
let hashStateUpdatedSinceLastUrlUpdate = false;
let updatingObject: Trackable|null = null;
let updatedObjects = new Set<Trackable>();
let lastHash: string|null = null;
let pendingUpdate = -1;

export function getCurrentState() {
  let updated = false;
  for (let obj of updatedObjects) {
    let key = trackedObjects.get(obj);
    if (key === undefined) {
      if (currentHashState.hasOwnProperty(key)) {
        updated = true;
      }
      // Object may have been unregistered after update event.
      continue;
    }
    updated = true;
    currentHashState[key] = obj.toJSON();
  }
  updatedObjects.clear();
  if (updated) {
    hashStateUpdatedSinceLastUrlUpdate = true;
  }
  return currentHashState;
}

const UPDATE_DELAY = 200;

export interface Trackable {
  restoreState: (x: any) => void;
  reset: () => void;
  changed: NullarySignal;
  toJSON: () => any;
}

function updateTrackedObjectsFromHash() {
  // console.log("updateTrackedObjectsFromHash called");
  try {
    let s = location.href.replace(/^[^#]+/, '');
    // console.log(`hash str: ${s}`);
    if (s === '' || s === '#' || s === '#!') {
      s = '#!{}';
    }
    if (s.startsWith('#!+')) {
      s = s.slice(3);
      // Firefox always %-encodes the URL even if it is not typed that way.
      s = decodeURI(s);
      let state = urlSafeParse(s);
      if (typeof state === 'object') {
        updateTrackedObjects(state);
      }
    } else if (s.startsWith('#!')) {
      s = s.slice(2);
      // Firefox always %-encodes the URL even if it is not typed that way.
      s = decodeURI(s);
      if (s === lastHash) {
        // We caused this update.
        return;
      }
      lastHash = s;
      resetTrackedObjects();
      let state = urlSafeParse(s);
      if (typeof state === 'object') {
        updateTrackedObjects(state);
      }
    } else {
      lastHash = null;
    }
  } catch (e) {
    // Failed to parse hash, ignore.
    console.log(e);
  }
}

function resetTrackedObjects() {
  for (let object of trackedKeys.values()) {
    object.reset();
  }
}

function restoreObjectState(key: string, obj: Trackable) {
  try {
    updatingObject = obj;
    obj.restoreState(currentHashState[key]);
  } catch (e) {
    console.log(`Failed to restore ${key} state: ${e}`);
  } finally {
    updatingObject = null;
  }
}

function updateTrackedObjects(newState: any) {
  currentHashState = newState;
  for (let key of Object.keys(currentHashState)) {
    let obj = trackedKeys.get(key);
    if (obj !== undefined) {
      restoreObjectState(key, obj);
    }
  }
}

let nextUpdateTime = 0;

function scheduleUpdate() {
  // Wait UPDATE_DELAY ms before updating hash.
  if (pendingUpdate === -1) {
    nextUpdateTime = Date.now() + UPDATE_DELAY;
    pendingUpdate = setTimeout(timerExpired, UPDATE_DELAY);
  }
}

function timerExpired() {
  pendingUpdate = -1;
  let time = Date.now();
  if (time >= nextUpdateTime) {
    updateHash();
  } else {
    pendingUpdate = setTimeout(timerExpired, nextUpdateTime - time);
  }
}

function updateHash() {
  // console.log(`updateHash at ${Date.now()}`);
  let state = getCurrentState();
  if (hashStateUpdatedSinceLastUrlUpdate) {
    hashStateUpdatedSinceLastUrlUpdate = false;
    let newHash = urlSafeStringify(state);
    if (newHash !== lastHash) {
      lastHash = newHash;
      // console.log(`replaceState at ${Date.now()}`);
      if (lastHash === '{}') {
        history.replaceState(null, '', '#');
      } else {
        history.replaceState(null, '', '#!' + lastHash);
      }
      // console.log(`replaceState done at ${Date.now()}`);
    }
    // window.location.hash = lastHash;
  }
}

addEventListener('hashchange', updateTrackedObjectsFromHash);

function handleObjectUpdate(obj: Trackable) {
  if (updatingObject === obj) {
    // We caused this event, so ignore it.
    return;
  }
  updatedObjects.add(obj);
  scheduleUpdate();
}

const trackedObjectRemovalFunctions = new Map<Trackable, () => void>();

export function registerTrackable(key: string, obj: Trackable) {
  if (trackedKeys.has(key)) {
    throw new Error(`Key ${JSON.stringify(key)} already registered.`);
  }
  if (trackedObjects.has(obj)) {
    throw new Error(`Object already registered.`);
  }
  trackedKeys.set(key, obj);
  trackedObjects.set(obj, key);
  if (currentHashState.hasOwnProperty(key)) {
    // console.log(`registering ${key} which has existing state`);
    obj.restoreState(currentHashState[key]);
    // console.log(obj);
  }
  trackedObjectRemovalFunctions.set(obj, obj.changed.add(() => {
    handleObjectUpdate(obj);
  }));
  handleObjectUpdate(obj);
};

export function unregisterTrackable(keyOrObject: string|Trackable) {
  let obj = trackedKeys.get(<string>keyOrObject);
  let key: string|undefined;
  if (obj !== undefined) {
    key = <string>keyOrObject;
  } else {
    key = trackedObjects.get(<Trackable>keyOrObject);
    if (key === undefined) {
      throw new Error('Key or object not registered.');
    }
    obj = <Trackable>keyOrObject;
  }
  trackedKeys.delete(key);
  trackedObjects.delete(obj);
  trackedObjectRemovalFunctions.get(obj)!();
  trackedObjectRemovalFunctions.delete(obj);
  handleObjectUpdate(obj);
};

// Initialize currentHashState.
updateTrackedObjectsFromHash();
