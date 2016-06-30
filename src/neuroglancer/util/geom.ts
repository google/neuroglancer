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

import {mat4, vec3, vec4} from 'gl-matrix';

export {mat2, mat3, mat4, quat, vec2, vec3, vec4} from 'gl-matrix';

export type Vec2 = Float32Array;
export type Vec3 = Float32Array;
export type Vec4 = Float32Array;
export type Mat3 = Float32Array;
export type Mat4 = Float32Array;
export type Quat = Float32Array;

export const identityMat4 = mat4.create();

export const AXES_NAMES = ['x', 'y', 'z'];

export class BoundingBox {
  constructor(public lower: Vec3, public upper: Vec3) {}
};

export const kAxes =
    [vec4.fromValues(1, 0, 0, 0), vec4.fromValues(0, 1, 0, 0), vec4.fromValues(0, 0, 1, 0)];
export const kZeroVec = vec3.fromValues(0, 0, 0);
export const kInfinityVec = vec3.fromValues(Infinity, Infinity, Infinity);

export function prod3(x: ArrayLike<number>) {
  return x[0] * x[1] * x[2];
}

export function prod4(x: ArrayLike<number>) {
  return x[0] * x[1] * x[2] * x[3];
}

/**
 * Implements a one-to-one conversion from Vec3 to string, suitable for use a Map key.
 *
 * Specifically, returns the string representation of the 3 values separated by commas.
 */
export function vec3Key(x: ArrayLike<number>) {
  return `${x[0]},${x[1]},${x[2]}`;
}

const RECTIFY_EPSILON = 1e-4;

export function rectifyVec3IfAxisAligned(v: Float32Array, offset: number) {
  let a0 = Math.abs(v[offset]), a1 = Math.abs(v[offset + 1]), a2 = Math.abs(v[offset + 2]);
  let max = Math.max(a0, a1, a2);
  if (a0 / max < RECTIFY_EPSILON) {
    v[offset] = 0;
  }
  if (a1 / max < RECTIFY_EPSILON) {
    v[offset + 1] = 0;
  }
  if (a2 / max < RECTIFY_EPSILON) {
    v[offset + 2] = 0;
  }
}

/**
 * Makes columns of m that are approximately axis-aligned exactly axis aligned.
 *
 * Note that mat is stored in Fortran order, and therefore the first column is m[0], m[1], m[2].
 */
export function rectifyTransformMatrixIfAxisAligned(m: Mat4) {
  rectifyVec3IfAxisAligned(m, 0);
  rectifyVec3IfAxisAligned(m, 4);
  rectifyVec3IfAxisAligned(m, 8);
}
