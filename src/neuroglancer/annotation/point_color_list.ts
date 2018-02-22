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
 * Defines a trackable in-memory list of point colors.
 */

import {Float32ArrayBuilder} from 'neuroglancer/util/float32array_builder';
import {vec3} from 'neuroglancer/util/geom';
import {parseFixedLengthArray, verifyFiniteFloat} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';

export const DEFAULT_COLOR = vec3.fromValues(1.0, 1.0, 0.0);

export class AnnotationPointColorList {
  colors = new Float32ArrayBuilder();
  changed = new NullarySignal();
  generation = 0;

  get length() {
    return this.colors.length / 3;
  }

  delete(index: number) {
    this.colors.eraseRange(index * 3, index * 3 + 3);
    ++this.generation;
    this.changed.dispatch();
  }

  get(index: number): vec3 {
    return <vec3>this.colors.data.subarray(index * 3, index * 3 + 3);
  }

  append(point: vec3) {
    this.colors.appendArray(point.subarray(0, 3));
    ++this.generation;
    this.changed.dispatch();
  }

  reset() {
    this.colors.clear();
    ++this.generation;
    this.changed.dispatch();
  }

  restoreState(obj: any) {
    try {
      if (Array.isArray(obj)) {
        const numPoints = obj.length;
        let {colors} = this;
        colors.resize(numPoints * 3);
        let {data} = colors;
        for (let i = 0; i < numPoints; ++i) {
          const j = i * 3;
          parseFixedLengthArray<number, Float32Array>(
              data.subarray(j, j + 3), obj[i], verifyFiniteFloat);
        }
        ++this.generation;
        this.changed.dispatch();
        return;
      }
    } catch (ignoredError) {
      this.reset();
    }
  }

  toJSON() {
    let {colors} = this;
    const numPoints = this.length;
    let data = colors.data;
    let result = new Array(numPoints);
    for (let i = 0; i < numPoints; ++i) {
      const j = i * 3;
      result[i] = [data[j], data[j + 1], data[j + 2]];
    }
    return result;
  }
}
