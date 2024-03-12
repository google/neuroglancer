/**
 * @license
 * This work is a derivative of the Google Neuroglancer project,
 * Copyright 2016 Google Inc.
 * The Derivative Work is covered by
 * Copyright 2019 Howard Hughes Medical Institute
 *
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
import { Uint64Map } from "#src/uint64_map.js";
import { Uint64 } from "#src/util/uint64.js";

describe("Uint64Map", () => {
  it("basic", () => {
    const m = new Uint64Map();

    const k1 = new Uint64(1);
    const v1 = new Uint64(11);
    expect(m.has(k1)).toBe(false);
    expect(m.size).toBe(0);
    m.set(k1, v1);
    expect(m.has(k1)).toBe(true);
    expect(m.size).toBe(1);
    const k1Gotten = new Uint64();
    m.get(k1, k1Gotten);
    expect(k1Gotten).toEqual(v1);

    const k2 = new Uint64(2, 3);
    const v2 = new Uint64(22, 33);
    expect(m.has(k2)).toBe(false);
    m.set(k2, v2);
    expect(m.has(k1)).toBe(true);
    expect(m.has(k2)).toBe(true);
    expect(m.size).toBe(2);
    const k2Gotten = new Uint64();
    m.get(k2, k2Gotten);
    expect(k2Gotten).toEqual(v2);

    const v2a = new Uint64(222, 333);
    m.set(k2, v2a);
    expect(m.has(k1)).toBe(true);
    expect(m.has(k2)).toBe(true);
    expect(m.size).toBe(2);
    m.get(k2, k2Gotten);
    expect(k2Gotten).toEqual(v2);

    m.delete(k2);
    expect(m.has(k1)).toBe(true);
    expect(m.has(k2)).toBe(false);
    expect(m.size).toBe(1);
    m.set(k2, v2a);
    expect(m.has(k1)).toBe(true);
    expect(m.has(k2)).toBe(true);
    expect(m.size).toBe(2);
    m.get(k2, k2Gotten);
    expect(k2Gotten).toEqual(v2a);

    m.clear();
    expect(m.has(k1)).toBe(false);
    expect(m.has(k2)).toBe(false);
    expect(m.size).toBe(0);
  });

  it("iterate", () => {
    const m = new Uint64Map();

    const k1 = new Uint64(1);
    const v1 = new Uint64(11);
    const k2 = new Uint64(2, 3);
    const v2 = new Uint64(22, 33);
    const k3 = new Uint64(3, 4);
    const v3 = new Uint64(33, 44);
    m.set(k2, v2);
    m.set(k1, v1);
    m.set(k3, v3);

    const iterated = [];
    for (const [k, v] of m.unsafeEntries()) {
      iterated.push([k.clone(), v.clone()]);
    }
    iterated.sort((a, b) => Uint64.compare(a[0], b[0]));
    expect(iterated).toEqual([
      [k1, v1],
      [k2, v2],
      [k3, v3],
    ]);
  });

  it("toJSON", () => {
    const m = new Uint64Map();

    const k1 = new Uint64(1);
    const v1 = new Uint64(11);
    const k2 = new Uint64(2, 3);
    const v2 = new Uint64(22, 33);
    const k3 = new Uint64(3, 4);
    const v3 = new Uint64(33, 44);
    m.set(k2, v2);
    m.set(k1, v1);
    m.set(k3, v3);

    const json = m.toJSON();
    const expected: { [key: string]: string } = {};
    expected[k1.toString()] = v1.toString();
    expected[k2.toString()] = v2.toString();
    expected[k3.toString()] = v3.toString();
    expect(json).toEqual(expected);

    expect(Object.prototype.hasOwnProperty.call(json, k1.toString())).toBe(
      true,
    );
    expect(Object.prototype.hasOwnProperty.call(json, k2.toString())).toBe(
      true,
    );
    expect(Object.prototype.hasOwnProperty.call(json, k3.toString())).toBe(
      true,
    );
  });
});
