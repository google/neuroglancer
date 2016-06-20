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

import {HashTable} from 'neuroglancer/gpu_hash/hash_table';
import {Uint64} from 'neuroglancer/util/uint64';

describe('gpu_hash/hash_table', () => {
  it('test', () => {
    let ht = new HashTable();
    let map = new Map();

    let maxValue = Math.pow(2, 32);
    function genNumber() { return Math.floor(Math.random() * maxValue); }
    function getRandomKey() {
      while (true) {
        let v = new Uint64(genNumber(), genNumber());
        if (v.low !== ht.emptyLow || v.high !== ht.emptyHigh) {
          return v;
        }
      }
    }

    function compareViaIterate() {
      let htValues = new Map();
      for (let [low, high] of ht) {
        let v = new Uint64(low, high);
        let s = v.toString();
        if (htValues.has(s)) {
          throw new Error('Duplicate key in hash table: ' + [low, high]);
        }
        if (!map.has(s)) {
          throw new Error('Unexpected key ' + [low, high] + ' in hash table');
        }
        htValues.set(s, v);
      }
      for (let [s, k] of map) {
        if (!htValues.has(s)) {
          throw new Error('Hash table is missing key ' + [k.low, k.high]);
        }
      }
    }

    function compareViaHas() {
      for (let [, k] of map) {
        expect(ht.has(k.low, k.high)).toBe(true, `Hash table is missing key ${[k.low, k.high]}`);
      }
    }

    function compare() {
      compareViaIterate();
      compareViaHas();
    }
    let numInsertions = 100;
    for (let i = 0; i < numInsertions; ++i) {
      let k: Uint64;
      let s: string;
      while (true) {
        k = getRandomKey();
        s = k.toString();
        if (!map.has(k)) {
          break;
        }
      }
      map.set(s, k);
      expect(ht.has(k.low, k.high))
          .toBe(false, `Unexpected positive has result for ${[k.low, k.high]}`);
      ht.add(k.low, k.high);
      compare();
    }
  });
});
