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


import {vec3} from 'neuroglancer/util/geom';
import {verify3dVec} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Trackable} from 'neuroglancer/util/trackable';

export function trackableVec3(defaultValue = vec3.create()) {
  return new TrackableVec3(defaultValue, defaultValue);
}

export class TrackableVec3 implements Trackable {
  get value() {
    return this.value_;
  }
  set value(newValue: vec3) {
    if (newValue !== this.value_) {
      this.value_ = newValue;
      this.changed.dispatch();
    }
  }
  changed = new NullarySignal();
  constructor(private value_: vec3, public defaultValue: vec3) {}
  toJSON() {
    let {value_} = this;
    if (value_ === this.defaultValue) {
      return undefined;
    }
    return this.value_.toString();
  }
  restoreState(x: any) {
    try {
      this.value = verify3dVec(x.split(','));
    } catch (e) {
      this.value = this.defaultValue;
    }
  }
  reset() {
    this.value = this.defaultValue;
  }
}
