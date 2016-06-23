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

import {partitionArray} from 'neuroglancer/util/array';

describe('partitionArray', () => {
  it('basic test', () => {
    let arr = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    let newEnd = partitionArray(arr, 2, 9, x => (x % 2) === 0);
    expect(arr).toEqual([0, 1, 2, 8, 4, 6, 7, 5, 3, 9, 10]);
    expect(newEnd).toBe(6);
  });
});
