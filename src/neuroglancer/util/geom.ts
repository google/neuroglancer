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

import {mat3, mat4, quat, vec3} from 'gl-matrix';
import { findMatchingIndices, TypedArray} from 'neuroglancer/util/array';

export {mat2, mat3, mat4, quat, vec2, vec3, vec4} from 'gl-matrix';

export const identityMat4 = mat4.create();

export const AXES_NAMES = ['x', 'y', 'z'];

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
 * Transforms a vector `a` by the transpose of a homogenous transformation matrix `m`.  The
 * translation component of `m` is ignored.
 */
export function transformVectorByMat4Transpose(out: vec3, a: vec3, m: mat4) {
  let x = a[0], y = a[1], z = a[2];
  out[0] = m[0] * x + m[1] * y + m[2] * z;
  out[1] = m[4] * x + m[5] * y + m[6] * z;
  out[2] = m[8] * x + m[9] * y + m[10] * z;
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

/**
 * Returns the value of `t` that minimizes `(p - (a + t * (b - a)))`.
 */
export function findClosestParameterizedLinePosition(a: Float32Array, b: Float32Array, p: Float32Array) {
  // http://mathworld.wolfram.com/Point-LineDistance3-Dimensional.html
  // Compute t: -dot(a-p, b-a) / |b - a|^2
  const rank = a.length;
  let denominator = 0;
  for (let i = 0; i < rank; ++i) {
    denominator += (a[i] - b[i])**2;
  }
  let numerator = 0;
  for (let i = 0; i < rank; ++i) {
    const aValue = a[i];
    numerator -= (aValue - p[i]) * (b[i] - aValue);
  }
  return numerator / Math.max(denominator, 1e-6);
}

/**
 * Sets `out` to the position on the line segment `[a, b]` closest to `p`.
 */
export function projectPointToLineSegment(out: Float32Array, a: Float32Array, b: Float32Array, p: Float32Array) {
  const rank = out.length;
  let t = findClosestParameterizedLinePosition(a, b, p);
  t = Math.max(0.0, Math.min(1.0, t));
  for (let i = 0; i < rank; ++i) {
    const aValue = a[i];
    out[i] = aValue + t * (b[i] - aValue);
  }
  return out;
}

export function mat3FromMat4(out: mat3, m: mat4) {
  const m00 = m[0], m01 = m[1], m02 = m[2], m10 = m[4], m11 = m[5], m12 = m[6], m20 = m[8],
        m21 = m[9], m22 = m[10];
  out[0] = m00;
  out[1] = m01;
  out[2] = m02;
  out[3] = m10;
  out[4] = m11;
  out[5] = m12;
  out[6] = m20;
  out[7] = m21;
  out[8] = m22;
  return out;
}

/**
 * Extracts the left, right, bottom, top, near, far clipping planes from `projectionMat`.
 * @param out Row-major array of shape `(6, 4)` specifying for each of the left, right, bottom, top,
 *     near, far clipping planes the `a`, `b`, `c`, `d` coefficients such that
 *     `0 < a * x + b * y + c * z + d` if the point `x, y, z` is inside the half-space of the
 * clipping plane.
 * @param m Projection matrix
 */
export function getFrustrumPlanes(out: Float32Array, m: mat4): Float32Array {
  // http://web.archive.org/web/20120531231005/http://crazyjoke.free.fr/doc/3D/plane%20extraction.pdf
  const m00 = m[0], m10 = m[1], m20 = m[2], m30 = m[3], m01 = m[4], m11 = m[5], m21 = m[6],
        m31 = m[7], m02 = m[8], m12 = m[9], m22 = m[10], m32 = m[11], m03 = m[12], m13 = m[13],
        m23 = m[14], m33 = m[15];

  out[0] = m30 + m00;  // left: a
  out[1] = m31 + m01;  // left: b
  out[2] = m32 + m02;  // left: c
  out[3] = m33 + m03;  // left: d

  out[4] = m30 - m00;  // right: a
  out[5] = m31 - m01;  // right: b
  out[6] = m32 - m02;  // right: c
  out[7] = m33 - m03;  // right: d

  out[8] = m30 + m10;   // bottom: a
  out[9] = m31 + m11;   // bottom: b
  out[10] = m32 + m12;  // bottom: c
  out[11] = m33 + m13;  // bottom: d

  out[12] = m30 - m10;  // top: a
  out[13] = m31 - m11;  // top: b
  out[14] = m32 - m12;  // top: c
  out[15] = m33 - m13;  // top: d

  const nearA = m30 + m20;  // near: a
  const nearB = m31 + m21;  // near: b
  const nearC = m32 + m22;  // near: c
  const nearD = m33 + m23;  // near: d

  // Normalize near plane
  const nearNorm = Math.sqrt(nearA ** 2 + nearB ** 2 + nearC ** 2);
  out[16] = nearA / nearNorm;
  out[17] = nearB / nearNorm;
  out[18] = nearC / nearNorm;
  out[19] = nearD / nearNorm;

  out[20] = m30 - m20;  // far: a
  out[21] = m31 - m21;  // far: b
  out[22] = m32 - m22;  // far: c
  out[23] = m33 - m23;  // far: d

  return out;
}

/**
 * Checks whether the specified axis-aligned bounding box (AABB) intersects the view frustrum.
 *
 * @param clippingPlanes Array of length 24 specifying the clipping planes of the view frustrum, as
 *     computed by `getFrustrumPlanes`
 */
export function isAABBVisible(
    xLower: number, yLower: number, zLower: number, xUpper: number, yUpper: number, zUpper: number,
    clippingPlanes: Float32Array) {
  for (let i = 0; i < 6; ++i) {
    const a = clippingPlanes[i * 4], b = clippingPlanes[i * 4 + 1], c = clippingPlanes[i * 4 + 2],
          d = clippingPlanes[i * 4 + 3];
    const sum = Math.max(a * xLower, a * xUpper) + Math.max(b * yLower, b * yUpper) +
        Math.max(c * zLower, c * zUpper) + d;
    if (sum < 0) {
      return false;
    }
  }
  return true;
}

/**
 * Returns the list (in sorted order) of input dimensions that depend on any of the specified output
 * dimensions.
 */
export function getDependentTransformInputDimensions(
    transform: Float32Array|Float64Array, rank: number, outputDimensions: readonly number[],
    transpose: boolean = false): number[] {
  const numOutputDimensions = outputDimensions.length;
  const isDependentInputDimension: boolean[] = [];
  const inputStride = transpose ? 1 : rank + 1;
  const outputStride = transpose ? rank + 1 : 1;
  for (let i = 0; i < numOutputDimensions; ++i) {
    const outputDim = outputDimensions[i];
    for (let inputDim = 0; inputDim < rank; ++inputDim) {
      if (transform[inputDim * inputStride + outputDim * outputStride] !== 0) {
        isDependentInputDimension[inputDim] = true;
      }
    }
  }
  return findMatchingIndices(isDependentInputDimension, true);
}

export function scaleMat3Input(out: mat3, input: mat3, scales: TypedArray) {
  for (let j = 0; j < 3; ++j) {
    const s = scales[j];
    for (let i = 0; i < 3; ++i) {
      out[i + j * 3] = s * input[i + j * 3];
    }
  }
  return out;
}

export function scaleMat3Output(out: mat3, input: mat3, scales: TypedArray) {
  for (let i = 0; i < 3; ++i) {
    const s = scales[i];
    for (let j = 0; j < 3; ++j) {
      out[i + j * 3] = s * input[i + j * 3];
    }
  }
  return out;
}
