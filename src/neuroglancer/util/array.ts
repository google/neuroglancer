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

export interface WritableArrayLike<T> {
  length: number;
  [n: number]: T;
}

/**
 * Partitions array[start:end] such that all elements for which predicate
 * returns true are before the elements for which predicate returns false.
 *
 * predicate will be called exactly once for each element in array[start:end],
 * in order.
 *
 * @returns {number} The index of the first element for which predicate returns
 * false, or end if there is no such element.
 */
export function partitionArray<T>(
    array: T[], start: number, end: number, predicate: (x: T) => boolean): number {
  while (start < end) {
    let x = array[start];
    if (predicate(x)) {
      ++start;
      continue;
    }
    --end;
    array[start] = array[end];
    array[end] = x;
  }
  return end;
}

export interface TypedArrayConstructor {
  new(n: number): TypedArray;
  new(buffer: ArrayBuffer, byteOffset: number, length: number): TypedArray;
  BYTES_PER_ELEMENT: number;
}

export type TypedArray = Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array |
    Uint32Array | Float32Array | Float64Array;

/**
 * Returns an array of size newSize that starts with the contents of array.
 * Either returns array if it has the correct size, or a new array with zero
 * padding at the end.
 */
export function maybePadArray<T extends TypedArray>(array: T, newSize: number): T {
  if (array.length === newSize) {
    return array;
  }
  let newArray = new (<any>array.constructor)(newSize);
  newArray.set(array);
  return newArray;
}

export function getFortranOrderStrides(size: ArrayLike<number>, baseStride = 1) {
  let length = size.length;
  let strides = new Array<number>(length);
  let stride = strides[0] = baseStride;
  for (let i = 1; i < length; ++i) {
    stride *= size[i - 1];
    strides[i] = stride;
  }
  return strides;
}

/**
 * Converts an array of shape [majorSize, minorSize] to
 * [minorSize, majorSize].
 */
export function transposeArray2d<T extends TypedArray>(
    array: T, majorSize: number, minorSize: number): T {
  let transpose = new (<any>array.constructor)(array.length);
  for (let i = 0; i < majorSize * minorSize; i += minorSize) {
    for (let j = 0; j < minorSize; j++) {
      let index: number = i / minorSize;
      transpose[j * majorSize + index] = array[i + j];
    }
  }
  return transpose;
}
