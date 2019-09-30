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

import {partitionArray, tile2dArray, transposeArray2d} from 'neuroglancer/util/array';

describe('partitionArray', () => {
  it('basic test', () => {
    let arr = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    let newEnd = partitionArray(arr, 2, 9, x => (x % 2) === 0);
    expect(arr).toEqual([0, 1, 2, 8, 4, 6, 7, 5, 3, 9, 10]);
    expect(newEnd).toBe(6);
  });
});

describe('transposeArray2d', () => {

  it('square', () => {
    let arr = new Uint8Array(4), out = new Uint8Array(4);
    arr.set([0, 1, 2, 3]);
    out.set([0, 2, 1, 3]);
    expect(transposeArray2d(arr, 2, 2)).toEqual(out);
  });

  it('minor > major rectangle', () => {
    let arr = new Uint8Array(6), out = new Uint8Array(6);
    arr.set([0, 1, 2, 3, 4, 5]);
    out.set([0, 3, 1, 4, 2, 5]);
    expect(transposeArray2d(arr, 2, 3)).toEqual(out);
  });

  it('major > minor rectangle', () => {
    let arr = new Uint8Array(8), out = new Uint8Array(8);
    arr.set([0, 1, 2, 3, 4, 5, 6, 7]);
    out.set([0, 2, 4, 6, 1, 3, 5, 7]);
    expect(transposeArray2d(arr, 4, 2)).toEqual(out);
  });

  it('single axis', () => {
    let arr = new Uint8Array(3), out = new Uint8Array(3);
    arr.set([0, 1, 2]);
    out.set([0, 1, 2]);
    expect(transposeArray2d(arr, 3, 1)).toEqual(out);
  });

});

describe('tile2dArray', () => {
  it('majorDimension=1, majorTiles work', () => {
    const input = Uint8Array.of(0, 1, 2, 3, 4);
    const expected = Uint8Array.of(0, 0, 1, 1, 2, 2, 3, 3, 4, 4);
    const result = tile2dArray(input, /*majorDimension=*/1, /*minorTiles=*/1, /*majorTiles=*/2);
    expect(result).toEqual(expected);
  });

  it('majorDimension=1, minorTiles work', () => {
    const input = Uint8Array.of(0, 1, 2, 3, 4);
    const expected = Uint8Array.of(0, 1, 2, 3, 4, 0, 1, 2, 3, 4);
    const result = tile2dArray(input, /*majorDimension=*/1, /*minorTiles=*/2, /*majorTiles=*/1);
    expect(result).toEqual(expected);
  });

  it('majorDimension=2, majorTiles work', () => {
    const input = Uint8Array.of(0, 1, 2, 3);
    const expected = Uint8Array.of(0, 1, 0, 1, 2, 3, 2, 3);
    const result = tile2dArray(input, /*majorDimension=*/2, /*minorTiles=*/1, /*majorTiles=*/2);
    expect(result).toEqual(expected);
  });

  it('majorDimension=2, majorTiles work, minorTiles work', () => {
    const input = Uint8Array.of(0, 1, 2, 3);
    const expected = Uint8Array.of(0, 1, 0, 1, 2, 3, 2, 3, 0, 1, 0, 1, 2, 3, 2, 3);
    const result = tile2dArray(input, /*majorDimension=*/2, /*minorTiles=*/2, /*majorTiles=*/2);
    expect(result).toEqual(expected);
  });
});
