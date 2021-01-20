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

import {mat4, transformVectorByMat4, transformVectorByMat4Transpose, vec3} from 'neuroglancer/util/geom';
import * as matrix from 'neuroglancer/util/matrix';

export class ChunkLayout {
  /**
   * Size of each chunk in "chunk" coordinates.
   */
  size: vec3;

  /**
   * Transform from local "chunk" coordinates to global voxel coordinates.
   */
  transform: mat4;

  /**
   * Inverse of transform.  Transform from global voxel coordinates to "chunk" coordinates.
   */
  invTransform: mat4;

  /**
   * Determinant of `transform`.
   */
  detTransform: number;

  finiteRank: number;

  constructor(size: vec3, transform: mat4, finiteRank: number) {
    this.size = vec3.clone(size);
    this.transform = mat4.clone(transform);
    this.finiteRank = finiteRank;
    const invTransform = mat4.create();
    const det = matrix.inverse(invTransform, 4, transform, 4, 4);
    if (det === 0) {
      throw new Error('Transform is singular');
    }
    this.invTransform = invTransform;
    this.detTransform = det;
  }
  toObject() {
    return {size: this.size, transform: this.transform, finiteRank: this.finiteRank};
  }

  static fromObject(msg: any) {
    return new ChunkLayout(msg.size, msg.transform, msg.finiteRank);
  }

  /**
   * Transform global spatial coordinates to local spatial coordinates.
   */
  globalToLocalSpatial(out: vec3, globalSpatial: vec3): vec3 {
    return vec3.transformMat4(out, globalSpatial, this.invTransform);
  }

  localSpatialVectorToGlobal(out: vec3, localVector: vec3): vec3 {
    return transformVectorByMat4(out, localVector, this.transform);
  }

  /**
   * Returns the unnormalized normal vector.
   */
  globalToLocalNormal(globalNormal: vec3, localNormal: vec3) {
    return transformVectorByMat4Transpose(globalNormal, localNormal, this.transform);
  }
}
