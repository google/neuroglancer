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

import {HashSetUint64} from 'neuroglancer/gpu_hash/hash_table';
import {getRandomValues} from 'neuroglancer/util/random';
import {Uint64} from 'neuroglancer/util/uint64';

suite('gpu_hash/hash_table', () => {
  let ht = new HashSetUint64();
  const numValues = 100;
  let values = new Uint32Array(numValues * 2);
  let temp = new Uint64();
  getRandomValues(values);
  benchmark('insert', () => {
    ht.clear();
    for (let i = 0, length = values.length; i < length; i += 2) {
      temp.low = values[i];
      temp.high = values[i + 1];
      ht.add(temp);
    }
  });
});
