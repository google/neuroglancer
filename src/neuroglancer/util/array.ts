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

export function tile2dArray<T extends TypedArray>(
    array: T, majorDimension: number, minorTiles: number, majorTiles: number) {
  const minorDimension = array.length / majorDimension;
  const length = array.length * minorTiles * majorTiles;
  const result: T = new (<any>array.constructor)(length);
  const minorTileStride = array.length * majorTiles;
  const majorTileStride = majorDimension;
  const minorStride = majorDimension * majorTiles;
  for (let minor = 0; minor < minorDimension; ++minor) {
    for (let major = 0; major < majorDimension; ++major) {
      const inputValue = array[minor * majorDimension + major];
      const baseOffset = minor * minorStride + major;
      for (let minorTile = 0; minorTile < minorTiles; ++minorTile) {
        for (let majorTile = 0; majorTile < majorTiles; ++majorTile) {
          result[minorTile * minorTileStride + majorTile * majorTileStride + baseOffset] =
              inputValue;
        }
      }
    }
  }
  return result;
}

export function binarySearch<T>(
    haystack: ArrayLike<T>, needle: T, compare: (a: T, b: T) => number, low = 0,
    high = haystack.length) {
  while (low < high) {
    const mid = (low + high - 1) >> 1;
    const compareResult = compare(needle, haystack[mid]);
    if (compareResult > 0) {
      low = mid + 1;
    } else if (compareResult < 0) {
      high = mid;
    } else {
      return mid;
    }
  }
  return ~low;
}


/**
 * Returns the first index in `[begin, end)` for which `predicate` is `true`, or returns `end` if no
 * such index exists.
 *
 * For any index `i` in `(begin, end)`, it must be the case that `predicate(i) >= predicate(i - 1)`.
 */
export function binarySearchLowerBound(
    begin: number, end: number, predicate: (index: number) => boolean): number {
  let count = end - begin;
  while (count > 0) {
    let step = Math.floor(count / 2);
    let i = begin + step;
    if (predicate(i)) {
      count = step;
    } else {
      begin = i + 1;
      count -= step + 1;
    }
  }
  return begin;
}
