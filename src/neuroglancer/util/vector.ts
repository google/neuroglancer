/**
 * @license
 * Copyright 2019 Google Inc.
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

import {TypedArray} from 'neuroglancer/util/array';

export function equal<T extends TypedArray, U extends TypedArray>(a: T, b: U) {
  const n = a.length;
  for (let i = 0; i < n; ++i) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function add<Out extends TypedArray, A extends TypedArray, B extends TypedArray>(
    out: Out, a: A, b: B) {
  const rank = out.length;
  for (let i = 0; i < rank; ++i) {
    out[i] = a[i] + b[i];
  }
  return out;
}
export function subtract<Out extends TypedArray, A extends TypedArray, B extends TypedArray>(
    out: Out, a: A, b: B) {
  const rank = out.length;
  for (let i = 0; i < rank; ++i) {
    out[i] = a[i] - b[i];
  }
  return out;
}
export function multiply<Out extends TypedArray, A extends TypedArray, B extends TypedArray>(
    out: Out, a: A, b: B) {
  const rank = out.length;
  for (let i = 0; i < rank; ++i) {
    out[i] = a[i] * b[i];
  }
  return out;
}
export function divide<Out extends TypedArray, A extends TypedArray, B extends TypedArray>(
    out: Out, a: A, b: B) {
  const rank = out.length;
  for (let i = 0; i < rank; ++i) {
    out[i] = a[i] / b[i];
  }
  return out;
}
export function scaleAndAdd<Out extends TypedArray, A extends TypedArray, B extends TypedArray>(
    out: Out, a: A, b: B, scale: number) {
  const rank = out.length;
  for (let i = 0; i < rank; ++i) {
    out[i] = a[i] + b[i] * scale;
  }
  return out;
}
export function scale<Out extends TypedArray, A extends TypedArray>(out: Out, a: A, scale: number) {
  const rank = out.length;
  for (let i = 0; i < rank; ++i) {
    out[i] = a[i] * scale;
  }
  return out;
}

export function prod(array: ArrayLike<number>) {
  let result = 1;
  for (let i = 0, length = array.length; i < length; ++i) {
    result *= array[i];
  }
  return result;
}

export function min<Out extends TypedArray, A extends TypedArray, B extends TypedArray>(
    out: Out, a: A, b: B) {
  const rank = out.length;
  for (let i = 0; i < rank; ++i) {
    out[i] = Math.min(a[i], b[i]);
  }
  return out;
}

export function max<Out extends TypedArray, A extends TypedArray, B extends TypedArray>(
    out: Out, a: A, b: B) {
  const rank = out.length;
  for (let i = 0; i < rank; ++i) {
    out[i] = Math.max(a[i], b[i]);
  }
  return out;
}

export const kEmptyFloat32Vec = new Float32Array(0);
export const kEmptyFloat64Vec = new Float64Array(0);
export const kFloat64Vec3Of1 = Float64Array.of(1, 1, 1);
