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

import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {identityMat4, kOneVec, kZeroVec, mat4, quat, vec3} from 'neuroglancer/util/geom';
import {parseFiniteVec} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';

export interface RotationTranslationScale {
  rotation: quat;
  translation: vec3;
  scale: vec3;
}

/**
 * Class for representing a coordinate transform specified by a user.
 *
 * Typically it represents a transform from a local coordinate space to a global coordinate space.
 */
export class CoordinateTransform implements WatchableValueInterface<mat4> {
  changed = new NullarySignal();

  get value() {
    return this.transform;
  }

  constructor(public transform = mat4.create()) {}

  /**
   * Resets to the identity transform.
   */
  reset() {
    mat4.copy(this.transform, identityMat4);
    this.changed.dispatch();
  }

  toJSON() {
    if (mat4.equals(identityMat4, this.transform)) {
      return undefined;
    }
    const m = this.transform;
    return [
      [m[0], m[4], m[8], m[12]],   //
      [m[1], m[5], m[9], m[13]],   //
      [m[2], m[6], m[10], m[14]],  //
      [m[3], m[7], m[11], m[15]],  //
    ];
  }

  restoreState(obj: any) {
    if (obj == null) {
      this.reset();
      return;
    }
    if (Array.isArray(obj)) {
      if (obj.length === 4) {
        try {
          for (let i = 0; i < 4; ++i) {
            parseFiniteVec(this.transform.subarray(i * 4, (i + 1) * 4), obj[i]);
          }
          mat4.transpose(this.transform, this.transform);
        } catch (ignoredError) {
          this.reset();
        }
        return;
      }
      if (obj.length === 16) {
        try {
          parseFiniteVec(this.transform, obj);
          mat4.transpose(this.transform, this.transform);
        } catch (ignoredError) {
          this.reset();
        }
        return;
      }
      // Invalid size.
      this.reset();
      return;
    }

    if (typeof obj === 'object') {
      const rotation = quat.create();
      const translation = vec3.create();
      const scale = vec3.fromValues(1, 1, 1);
      try {
        parseFiniteVec(rotation, obj['rotation']);
        quat.normalize(rotation, rotation);
      } catch (ignoredError) {
        quat.identity(rotation);
      }

      try {
        parseFiniteVec(translation, obj['translation']);
      } catch (ignoredError) {
        vec3.copy(translation, kZeroVec);
      }

      try {
        parseFiniteVec(scale, obj['scale']);
      } catch (ignoredError) {
        vec3.copy(scale, kOneVec);
      }
      mat4.fromRotationTranslationScale(this.transform, rotation, translation, scale);
      this.changed.dispatch();
    } else {
      this.reset();
    }
  }

  clone() {
    return new CoordinateTransform(mat4.clone(this.transform));
  }
}

export function makeDerivedCoordinateTransform(
    derivedTransform: CoordinateTransform, baseTransform: CoordinateTransform,
    update: (output: mat4, input: mat4) => void): () => void {
  update(derivedTransform.transform, baseTransform.transform);
  return baseTransform.changed.add(() => {
    update(derivedTransform.transform, baseTransform.transform);
    derivedTransform.changed.dispatch();
  });
}
