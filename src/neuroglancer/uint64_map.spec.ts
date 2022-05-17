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

import {Uint64Map} from 'neuroglancer/uint64_map';
import {Uint64} from 'neuroglancer/util/uint64';

describe('Uint64Map', () => {
  it('basic', () => {
    let m = new Uint64Map();

    let k1 = new Uint64(1);
    let v1 = new Uint64(11);
    expect(m.has(k1)).toBe(false);
    expect(m.size).toBe(0);
    m.set(k1, v1);
    expect(m.has(k1)).toBe(true);
    expect(m.size).toBe(1);
    let k1Gotten = new Uint64();
    m.get(k1, k1Gotten);
    expect(k1Gotten).toEqual(v1);

    let k2 = new Uint64(2, 3);
    let v2 = new Uint64(22, 33);
    expect(m.has(k2)).toBe(false);
    m.set(k2, v2);
    expect(m.has(k1)).toBe(true);
    expect(m.has(k2)).toBe(true);
    expect(m.size).toBe(2);
    let k2Gotten = new Uint64();
    m.get(k2, k2Gotten);
    expect(k2Gotten).toEqual(v2);

    let v2a = new Uint64(222, 333);
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

  it('iterate', () => {
    let m = new Uint64Map();

    let k1 = new Uint64(1);
    let v1 = new Uint64(11);
    let k2 = new Uint64(2, 3);
    let v2 = new Uint64(22, 33);
    let k3 = new Uint64(3, 4);
    let v3 = new Uint64(33, 44);
    m.set(k2, v2);
    m.set(k1, v1);
    m.set(k3, v3);

    let iterated = [];
    for (let [k, v] of m.unsafeEntries()) {
      iterated.push([k.clone(), v.clone()]);
    }
    iterated.sort((a, b) => Uint64.compare(a[0], b[0]));
    expect(iterated).toEqual([[k1, v1], [k2, v2], [k3, v3]]);

  });

  it('toJSON', () => {
    let m = new Uint64Map();

    let k1 = new Uint64(1);
    let v1 = new Uint64(11);
    let k2 = new Uint64(2, 3);
    let v2 = new Uint64(22, 33);
    let k3 = new Uint64(3, 4);
    let v3 = new Uint64(33, 44);
    m.set(k2, v2);
    m.set(k1, v1);
    m.set(k3, v3);

    let json = m.toJSON();
    let expected: {[key: string]: string} = {};
    expected[k1.toString()] = v1.toString();
    expected[k2.toString()] = v2.toString();
    expected[k3.toString()] = v3.toString();
    expect(json).toEqual(expected);

    expect(json.hasOwnProperty(k1.toString())).toBe(true);
    expect(json.hasOwnProperty(k2.toString())).toBe(true);
    expect(json.hasOwnProperty(k3.toString())).toBe(true);
  });
});
