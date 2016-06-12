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

export {vec2, vec3, vec4, mat3, mat4, quat} from 'gl-matrix';
import {vec3, vec4, mat4} from 'gl-matrix';

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

export const kAxes = [
  vec4.fromValues(1, 0, 0, 0), vec4.fromValues(0, 1, 0, 0),
  vec4.fromValues(0, 0, 1, 0)
];
export const kZeroVec = vec3.fromValues(0, 0, 0);

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
