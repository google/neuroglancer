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

import {kIdentityQuat, kZeroVec, Mat4, mat4, Quat, quat, vec3, Vec3} from 'neuroglancer/util/geom';
import {parseFiniteVec} from 'neuroglancer/util/json';
import {Signal} from 'signals';

/**
 * Class for representing a coordinate transform specified by a user in the form of a rotation
 * quaternion, translation vector, and scale vector.
 *
 * Typically it represents a transform from a local coordinate space to a global coordinate space.
 *
 * globalCoordinate = rotation * (localCoordinate .* scale) + translation.
 */
export class CoordinateTransform {
  rotation: Quat;
  translation: Vec3;
  scale: Vec3;
  changed = new Signal();

  constructor(rotation = kIdentityQuat, translation = kZeroVec, scale = kZeroVec) {
    this.rotation = quat.clone(rotation);
    this.translation = vec3.clone(translation);
    this.scale = vec3.clone(scale);
  }

  /**
   * Sets `out` to the transformation matrix from local to global coordinates.
   */
  toMat4(out: Mat4) {
    return mat4.fromRotationTranslationScale(out, this.rotation, this.translation, this.scale);
  }

  /**
   * Resets to the identity transform.
   */
  reset() {
    quat.identity(this.rotation);
    vec3.copy(this.translation, kZeroVec);
    vec3.copy(this.scale, kZeroVec);
    this.changed.dispatch();
  }

  toJSON() {
    let x: any = {};
    let {rotation, translation, scale} = this;
    let empty = true;
    if (!quat.equals(kIdentityQuat, rotation)) {
      x['rotation'] = Array.prototype.slice.call(rotation);
      empty = false;
    }
    if (!vec3.equals(kZeroVec, translation)) {
      x['translation'] = Array.prototype.slice.call(translation);
      empty = false;
    }
    if (!vec3.equals(kZeroVec, scale)) {
      x['scale'] = Array.prototype.slice.call(scale);
      empty = false;
    }
    if (empty) {
      return undefined;
    }
    return x;
  }

  restoreState(obj: any) {
    try {
      parseFiniteVec(this.rotation, obj['rotation']);
      quat.normalize(this.rotation, this.rotation);
    } catch (ignoredError) {
      quat.identity(this.rotation);
    }

    try {
      parseFiniteVec(this.translation, obj['translation']);
    } catch (ignoredError) {
      vec3.copy(this.translation, kZeroVec);
    }

    try {
      parseFiniteVec(this.scale, obj['scale']);
    } catch (ignoredError) {
      vec3.copy(this.scale, kZeroVec);
    }

    this.changed.dispatch();
  }
}
