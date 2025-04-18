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

import { describe, it, expect } from "vitest";
import { HashMapUint64, HashSetUint64 } from "#src/gpu_hash/hash_table.js";
import { randomUint64 } from "#src/util/bigint.js";

describe("gpu_hash/hash_table", () => {
  it("HashSetUint64", () => {
    const ht = new HashSetUint64();
    const set = new Set<bigint>();

    function compareViaIterate() {
      const htValues = new Set<bigint>();
      for (const v of ht.keys()) {
        expect(htValues.has(v), `Duplicate key in hash table: ${v}`).toBe(
          false,
        );
        expect(set.has(v), `Unexpected key ${v} in hash table`).toBe(true);
        htValues.add(v);
      }
      for (const s of set) {
        expect(htValues.has(s), `Hash table is missing key ${s}`).toBe(true);
      }
    }

    function compareViaHas() {
      for (const s of set) {
        expect(ht.has(s), `Hash table is missing key ${s}`).toBe(true);
      }
    }

    function compare() {
      compareViaIterate();
      compareViaHas();
    }
    const numInsertions = 100;

    function testInsert(k: bigint) {
      set.add(k);
      expect(ht.has(k), `Unexpected positive has result for ${k}`).toBe(false);
      ht.add(k);
      compare();
    }

    const empty0 = ht.empty;
    testInsert(empty0);

    for (let i = 0; i < numInsertions; ++i) {
      let k: bigint;
      while (true) {
        k = randomUint64();
        if (!set.has(k)) {
          break;
        }
      }
      testInsert(k);
    }

    const empty1 = ht.empty;
    testInsert(empty1);
  });

  it("HashMapUint64", () => {
    const ht = new HashMapUint64();
    const map = new Map<bigint, bigint>();

    function compareViaIterate() {
      const htValues = new Map<bigint, bigint>();
      for (const [key, value] of ht) {
        expect(htValues.has(key), `Duplicate key in hash table: ${key}`).toBe(
          false,
        );
        expect(map.has(key), `Unexpected key ${key} in hash table`).toBe(true);
        htValues.set(key, value);
      }
      for (const [key, value] of map) {
        const v = htValues.get(key);
        expect(
          v !== undefined && v === value,
          `Hash table maps ${key} -> ${v} rather than -> ${value}`,
        ).toBe(true);
      }
    }

    function compareViaGet() {
      for (const [key, expectedValue] of map) {
        const value = ht.get(key);
        expect(
          value,
          `Hash table maps ${key} -> ${value} ` +
            `rather than -> ${expectedValue}`,
        ).toEqual(expectedValue);
      }
    }

    function compare() {
      compareViaIterate();
      compareViaGet();
    }
    const numInsertions = 100;

    function testInsert(k: bigint, v: bigint) {
      map.set(k, v);
      expect(ht.has(k), `Unexpected positive has result for ${k}`).toBe(false);
      ht.set(k, v);
      compare();
    }

    const empty0 = ht.empty;
    testInsert(empty0, randomUint64());

    for (let i = 0; i < numInsertions; ++i) {
      let k: bigint;
      while (true) {
        k = randomUint64();
        if (!map.has(k)) {
          break;
        }
      }
      testInsert(k, randomUint64());
    }

    const empty1 = ht.empty;
    testInsert(empty1, randomUint64());
  });
});
