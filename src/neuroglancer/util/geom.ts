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

import {mat4, quat, vec2, vec3, vec4} from 'gl-matrix';

export {mat2, mat3, mat4, quat, vec2, vec3, vec4} from 'gl-matrix';

export const identityMat4 = mat4.create();

export const AXES_NAMES = ['x', 'y', 'z'];

export class BoundingBox {
  constructor(public lower: vec3, public upper: vec3) {}
};

export const kAxes = [
  vec3.fromValues(1, 0, 0),
  vec3.fromValues(0, 1, 0),
  vec3.fromValues(0, 0, 1),
];
export const kZeroVec = vec3.fromValues(0, 0, 0);
export const kOneVec = vec3.fromValues(1, 1, 1);
export const kInfinityVec = vec3.fromValues(Infinity, Infinity, Infinity);
export const kIdentityQuat = quat.create();

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
export function rectifyTransformMatrixIfAxisAligned(m: mat4) {
  rectifyVec3IfAxisAligned(m, 0);
  rectifyVec3IfAxisAligned(m, 4);
  rectifyVec3IfAxisAligned(m, 8);
}

/**
 * Transforms `a` by a 180-degree rotation about X, stores result in `out`.
 */
export function quatRotateX180(out: quat, a: quat) {
  let x = a[0], y = a[1], z = a[2], w = a[3];
  out[0] = w;
  out[1] = z;
  out[2] = -y;
  out[3] = -x;
}

/**
 * Transforms `a` by a 180-degree rotation about Y, stores result in `out`.
 */
export function quatRotateY180(out: quat, a: quat) {
  let x = a[0], y = a[1], z = a[2], w = a[3];
  out[0] = -z;
  out[1] = w;
  out[2] = x;
  out[3] = -y;
}

/**
 * Transforms `a` by a 180-degree rotation about Z, stores result in `out`.
 */
export function quatRotateZ180(out: quat, a: quat) {
  let x = a[0], y = a[1], z = a[2], w = a[3];
  out[0] = y;
  out[1] = -x;
  out[2] = w;
  out[3] = -z;
}


/**
 * Transforms a vector `a` by a homogenous transformation matrix `m`.  The translation component of
 * `m` is ignored.
 */
export function transformVectorByMat4(out: vec3, a: vec3, m: mat4) {
  let x = a[0], y = a[1], z = a[2];
  out[0] = m[0] * x + m[4] * y + m[8] * z;
  out[1] = m[1] * x + m[5] * y + m[9] * z;
  out[2] = m[2] * x + m[6] * y + m[10] * z;
  return out;
}


/**
 * Computes the effective scaling factor of each local spatial dimension by `m`, which is assumed to
 * transform local coordinates to global coordinates.
 */
export function effectiveScalingFactorFromMat4(out: vec3, m: mat4) {
  const m0 = m[0], m1 = m[1], m2 = m[2], m4 = m[4], m5 = m[5], m6 = m[6], m8 = m[8], m9 = m[9],
        m10 = m[10];
  out[0] = Math.sqrt(m0 * m0 + m1 * m1 + m2 * m2);
  out[1] = Math.sqrt(m4 * m4 + m5 * m5 + m6 * m6);
  out[2] = Math.sqrt(m8 * m8 + m9 * m9 + m10 * m10);
  return out;
}

export function translationRotationScaleZReflectionToMat4(
  out: mat4, translation: vec3, rotation: quat, scale: vec3, zReflection: number) {
  const temp: Float32Array = out;
  out[0] = scale[0];
  out[1] = scale[1];
  out[2] = scale[2] * zReflection;
  return mat4.fromRotationTranslationScale(out, rotation, translation, <vec3>temp);
}
