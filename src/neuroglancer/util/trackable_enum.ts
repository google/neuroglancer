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

import {verifyEnumString} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Trackable} from 'neuroglancer/util/trackable';

export class TrackableEnum<T extends number> implements Trackable {
  changed = new NullarySignal();

  constructor(
      public enumType: {[x: string]: any},
      private value_: T,
      private defaultValue: T = value_,
  ) {}

  set value(value: T) {
    if (this.value_ !== value) {
      this.value_ = value;
      this.changed.dispatch();
    }
  }

  get value() {
    return this.value_;
  }

  reset() {
    this.value = this.defaultValue;
  }

  restoreState(obj: any) {
    this.value = verifyEnumString(obj, this.enumType);
  }

  toJSON(): string|undefined {
    if (this.value_ === this.defaultValue) return undefined;
    return this.enumType[this.value_].toLowerCase();
  }
}
