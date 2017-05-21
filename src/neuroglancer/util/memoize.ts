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

import {RefCounted, RefCountedValue} from 'neuroglancer/util/disposable';
import {stableStringify} from 'neuroglancer/util/json';

export class Memoize<Key, Value extends RefCounted> {
  private map = new Map<Key, Value>();

  /**
   * If getter throws an exception, no value is added.
   */
  get<T extends Value>(key: Key, getter: () => T): T {
    let {map} = this;
    let obj = <T>map.get(key);
    if (obj === undefined) {
      obj = getter();
      obj.registerDisposer(() => {
        map.delete(key);
      });
      map.set(key, obj);
    } else {
      obj.addRef();
    }
    return obj;
  }
}

export class StringMemoize extends Memoize<string, RefCounted> {
  get<T extends RefCounted>(x: any, getter: () => T) {
    if (typeof x !== 'string') {
      x = stableStringify(x);
    }
    return super.get(x, getter);
  }

  getUncounted<T>(x: any, getter: () => T) {
    return this.get(x, () => new RefCountedValue(getter())).value;
  }
}
