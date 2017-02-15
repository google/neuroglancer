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

import {Trackable} from 'neuroglancer/util/trackable';
import {NullarySignal} from 'neuroglancer/util/signal';

export class WatchableValue<T> {
  get value() { return this.value_; }
  set value(newValue: T) {
    if (newValue !== this.value_) {
      this.value_ = newValue;
      this.changed.dispatch();
    }
  }
  changed = new NullarySignal();
  constructor(protected value_: T) {}
};

export class TrackableValue<T> extends WatchableValue<T> implements Trackable {
  constructor(value: T, public validator: (value: any) => T, public defaultValue = value) {
    super(value);
  }
  toJSON() {
    let {value_} = this;
    if (value_ === this.defaultValue) {
      return undefined;
    }
    return this.value_;
  }
  reset() { this.value = this.defaultValue; }
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
};
