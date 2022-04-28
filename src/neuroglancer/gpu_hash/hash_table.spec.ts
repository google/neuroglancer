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

import {HashMapUint64, HashSetUint64} from 'neuroglancer/gpu_hash/hash_table';
import {Uint64} from 'neuroglancer/util/uint64';

describe('gpu_hash/hash_table', () => {
  it('HashSetUint64', () => {
    let ht = new HashSetUint64();
    let set = new Set<string>();

    function compareViaIterate() {
      let htValues = new Set<string>();
      for (let v of ht.unsafeKeys()) {
        let s = v.toString();
        expect(htValues.has(s)).toBe(false, `Duplicate key in hash table: ${s}`);
        expect(set.has(s)).toBe(true, `Unexpected key ${s} in hash table`);
        htValues.add(s);
      }
      for (let s of set) {
        expect(htValues.has(s)).toBe(true, `Hash table is missing key ${s}`);
      }
    }

    function compareViaHas() {
      for (let s of set) {
        let k = Uint64.parseString(s);
        expect(ht.has(k)).toBe(true, `Hash table is missing key ${s}`);
      }
    }

    function compare() {
      compareViaIterate();
      compareViaHas();
    }
    let numInsertions = 100;

    function testInsert(k: Uint64) {
      let s = '' + k;
      set.add(s);
      expect(ht.has(k)).toBe(false, `Unexpected positive has result for ${[k.low, k.high]}`);
      ht.add(k);
      compare();
    }

    let empty0 = new Uint64(ht.emptyLow, ht.emptyHigh);
    testInsert(empty0);

    for (let i = 0; i < numInsertions; ++i) {
      let k: Uint64;
      let s: string;
      while (true) {
        k = Uint64.random();
        s = k.toString();
        if (!set.has(s)) {
          break;
        }
      }
      testInsert(k);
    }

    let empty1 = new Uint64(ht.emptyLow, ht.emptyHigh);
    testInsert(empty1);

  });

  it('HashMapUint64', () => {
    let ht = new HashMapUint64();
    let map = new Map<string, Uint64>();

    function compareViaIterate() {
      let htValues = new Map<string, Uint64>();
      for (let [key, value] of ht) {
        let s = key.toString();
        expect(htValues.has(s)).toBe(false, `Duplicate key in hash table: ${s}`);
        expect(map.has(s)).toBe(true, `Unexpected key ${s} in hash table`);
        htValues.set(s, value.clone());
      }
      for (let [s, value] of map) {
        let v = htValues.get(s);
        expect(v !== undefined && Uint64.equal(v, value))
            .toBe(true, `Hash table maps ${s} -> ${v} rather than -> ${value}`);
      }
    }

    function compareViaGet() {
      let value = new Uint64();
      for (let [s, expectedValue] of map) {
        let key = Uint64.parseString(s);
        let has = ht.get(key, value);
        expect(has && Uint64.equal(value, expectedValue))
            .toBe(
                true,
                `Hash table maps ${key} -> ${has ? value : undefined} ` +
                    `rather than -> ${expectedValue}`);
      }
    }

    function compare() {
      compareViaIterate();
      compareViaGet();
    }
    let numInsertions = 100;

    function testInsert(k: Uint64, v: Uint64) {
      let s = '' + k;
      map.set(s, v);
      expect(ht.has(k)).toBe(false, `Unexpected positive has result for ${s}`);
      ht.set(k, v);
      compare();
    }

    let empty0 = new Uint64(ht.emptyLow, ht.emptyHigh);
    testInsert(empty0, Uint64.random());

    for (let i = 0; i < numInsertions; ++i) {
      let k: Uint64;
      let s: string;
      while (true) {
        k = Uint64.random();
        s = k.toString();
        if (!map.has(s)) {
          break;
        }
      }
      testInsert(k, Uint64.random());
    }

    let empty1 = new Uint64(ht.emptyLow, ht.emptyHigh);
    testInsert(empty1, Uint64.random());
  });

});
