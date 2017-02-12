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

import {identityMat4, mat4, transformVectorByMat4, vec3} from 'neuroglancer/util/geom';

export class ChunkLayout {
  /**
   * Size of each chunk in local spatial coordinates.
   */
  size: vec3;

  /**
   * Transform from local spatial coordinates to global coordinates (nm).
   */
  transform: mat4;

  /**
   * Inverse of transform.  Transform from global spatial coordinates to local spatial coordinates.
   */
  invTransform: mat4;

  constructor(size: vec3, transform: mat4 = identityMat4) {
    this.size = vec3.clone(size);
    this.transform = mat4.clone(transform);
    this.invTransform = mat4.invert(mat4.create(), transform)!;
  }
  static cache = new Map<string, ChunkLayout>();
  toObject(msg: any) {
    msg['size'] = this.size;
    msg['transform'] = this.transform;
  }

  static get(size: vec3, transform = identityMat4) {
    let cache = ChunkLayout.cache;
    const key = JSON.stringify([Array.from(size), Array.from(transform)]);
    let obj = cache.get(key);
    if (obj === undefined) {
      obj = new ChunkLayout(size, transform);
      cache.set(key, obj);
    }
    return obj;
  }

  static fromObject(msg: any) {
    return ChunkLayout.get(msg['size'], msg['transform']);
  }

  /**
   * Transform local spatial coordinates to global spatial coordinates.
   */
  localSpatialToGlobal(out: vec3, localSpatial: vec3): vec3 {
    return vec3.transformMat4(out, localSpatial, this.transform);
  }

  /**
   * Transform global spatial coordinates to local spatial coordinates.
   */
  globalToLocalSpatial(out: vec3, globalSpatial: vec3): vec3 {
    return vec3.transformMat4(out, globalSpatial, this.invTransform);
  }

  globalToLocalGrid(out: vec3, globalSpatial: vec3): vec3 {
    this.globalToLocalSpatial(out, globalSpatial);
    vec3.divide(out, out, this.size);
    return out;
  }

  localSpatialVectorToGlobal(out: vec3, localVector: vec3): vec3 {
    return transformVectorByMat4(out, localVector, this.transform);
  }

  globalToLocalSpatialVector(out: vec3, globalVector: vec3): vec3 {
    return transformVectorByMat4(out, globalVector, this.invTransform);
  }

  assignLocalSpatialToGlobalMat4(out: mat4): mat4 {
    return mat4.copy(out, this.transform);
  }
}
