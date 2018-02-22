/**
 * @license
 * Copyright 2018 The Neuroglancer Authors
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
 * @file
 * Defines a trackable in-memory list of point sizes.
 */

import {Float32ArrayBuilder} from 'neuroglancer/util/float32array_builder';
import {parseFixedLengthArray, verifyFiniteFloat} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';

export const DEFAULT_SIZE = 32.0;

export class AnnotationPointSizeList {
  sizes = new Float32ArrayBuilder();
  changed = new NullarySignal();
  generation = 0;

  get length() {
    return this.sizes.length;
  }

  delete(index: number) {
    this.sizes.eraseRange(index, index + 1);
    ++this.generation;
    this.changed.dispatch();
  }

  get(index: number): number {
    return this.sizes.data[index];
  }

  append(point: number) {
    this.sizes.appendArray([point]);
    ++this.generation;
    this.changed.dispatch();
  }

  reset() {
    this.sizes.clear();
    ++this.generation;
    this.changed.dispatch();
  }

  restoreState(obj: any) {
    try {
      if (Array.isArray(obj)) {
        const numPoints = obj.length;
        let {sizes} = this;
        sizes.resize(numPoints);
        let {data} = sizes;
        parseFixedLengthArray<number, Float32Array>(
            data.subarray(0, numPoints), obj, verifyFiniteFloat);
        ++this.generation;
        this.changed.dispatch();
        return;
      }
    } catch (ignoredError) {
      this.reset();
    }
  }

  toJSON() {
    return Array.from(this.sizes.view);
  }
}
