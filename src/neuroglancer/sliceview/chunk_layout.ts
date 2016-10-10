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

import {kIdentityQuat, kZeroVec, mat4, Mat4, quat, Quat, Vec3, vec3} from 'neuroglancer/util/geom';

const tempVec3 = vec3.create();

export class ChunkLayout {
  /**
   * Size of each chunk in nanometers.
   */
  size: Vec3;

  /**
   * Origin of chunk grid in global spatial coordinates (nanometers).
   */
  offset: Vec3;

  /**
   * Given a grid position g, the corresponding position in global coordinates is equal to:
   *   rotation * (g .* size .* [0, 0, zReflection]) + offfset,
   * where the .* denotes component-wise multiplication.
   */
  rotation: Quat;

  /**
   * Inverse of rotation.
   */
  inverseRotation: Quat;

  /**
   * Reflection coefficient.  Either 1 or -1.
   */
  zReflection: number;

  constructor(size: Vec3, offset?: Vec3, rotation?: Quat, zReflection = 1) {
    this.size = vec3.clone(size);
    if (offset === undefined) {
      this.offset = vec3.create();
    } else {
      this.offset = vec3.clone(offset);
    }
    if (rotation === undefined) {
      this.rotation = quat.create();
    } else {
      this.rotation = quat.clone(rotation);
    }
    this.inverseRotation = quat.invert(quat.create(), this.rotation);
    this.zReflection = zReflection;
  }
  static cache = new Map<string, ChunkLayout>();
  toObject(msg: any) {
    msg['size'] = this.size;
    msg['offset'] = this.offset;
    msg['rotation'] = this.rotation;
    msg['zReflection'] = this.zReflection;
  }

  static get(size: Vec3, offset = kZeroVec, rotation = kIdentityQuat, zReflection = 1) {
    let cache = ChunkLayout.cache;
    const key =
        JSON.stringify([Array.from(size), Array.from(offset), Array.from(rotation), zReflection]);
    let obj = cache.get(key);
    if (obj === undefined) {
      obj = new ChunkLayout(size, offset, rotation, zReflection);
      cache.set(key, obj);
    }
    return obj;
  }

  static fromObject(msg: any) {
    return ChunkLayout.get(msg['size'], msg['offset'], msg['rotation'], msg['zReflection']);
  }

  /**
   * Transform local spatial coordinates to global spatial coordinates.
   */
  localSpatialToGlobal(out: Vec3, localSpatial: Vec3): Vec3 {
    out[0] = localSpatial[0];
    out[1] = localSpatial[1];
    out[2] = this.zReflection * localSpatial[2];
    vec3.transformQuat(out, out, this.rotation);
    vec3.add(out, out, this.offset);
    return out;
  }

  globalToLocalSpatial(out: Vec3, globalSpatial: Vec3): Vec3 {
    vec3.sub(out, globalSpatial, this.offset);
    vec3.transformQuat(out, out, this.inverseRotation);
    out[2] *= this.zReflection;
    return out;
  }

  globalToLocalGrid(out: Vec3, globalSpatial: Vec3): Vec3 {
    this.globalToLocalSpatial(out, globalSpatial);
    vec3.divide(out, out, this.size);
    return out;
  }

  localSpatialVectorToGlobal(out: Vec3, localVector: Vec3): Vec3 {
    out[0] = localVector[0];
    out[1] = localVector[1];
    out[2] = this.zReflection * localVector[2];
    vec3.transformQuat(out, out, this.rotation);
    return out;
  }

  globalToLocalSpatialVector(out: Vec3, globalVector: Vec3): Vec3 {
    vec3.transformQuat(out, globalVector, this.inverseRotation);
    out[2] *= this.zReflection;
    return out;
  }

  assignLocalSpatialToGlobalMat4(out: Mat4): Mat4 {
    const scale = tempVec3;
    scale[0] = 1;
    scale[1] = 1;
    scale[2] = this.zReflection;
    return mat4.fromRotationTranslationScale(out, this.rotation, this.offset, scale);
  }
}
