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
 * @file
 * Defines a trackable in-memory list of point locations.
 */

import {Float32ArrayBuilder} from 'neuroglancer/util/float32array_builder';
import {vec3} from 'neuroglancer/util/geom';
import {parseFixedLengthArray, verifyFiniteFloat} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';

export class AnnotationPointList {
  points = new Float32ArrayBuilder();
  changed = new NullarySignal();
  generation = 0;

  get length() { return this.points.length / 3; }

  delete (index: number) {
    this.points.eraseRange(index * 3, index * 3 + 3);
    ++this.generation;
    this.changed.dispatch();
  }

  get(index: number): vec3 {
    return <vec3>this.points.data.subarray(index * 3, index * 3 + 3);
  }

  append(point: vec3) {
    this.points.appendArray(point.subarray(0, 3));
    ++this.generation;
    this.changed.dispatch();
  }

  reset() {
    this.points.clear();
    ++this.generation;
    this.changed.dispatch();
  }

  restoreState(obj: any) {
    try {
      if (Array.isArray(obj)) {
        const numPoints = obj.length;
        let {points} = this;
        points.resize(numPoints * 3);
        let {data} = points;
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
    let {points} = this;
    const numPoints = this.length;
    let data = points.data;
    let result = new Array(numPoints);
    for (let i = 0; i < numPoints; ++i) {
      const j = i * 3;
      result[i] = [data[j], data[j + 1], data[j + 2]];
    }
    return result;
  }
}
