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

import {Uint64Set} from 'neuroglancer/uint64_set';
import {Uint64} from 'neuroglancer/util/uint64';

describe('Uint64Set', () => {
  it('basic', () => {
    let s = new Uint64Set();

    let v1 = new Uint64(1);
    expect(s.has(v1)).toBe(false);
    expect(s.size).toBe(0);
    s.add(v1);
    expect(s.has(v1)).toBe(true);
    expect(s.size).toBe(1);

    let v2 = new Uint64(2, 3);
    expect(s.has(v2)).toBe(false);
    s.add(v2);
    expect(s.has(v1)).toBe(true);
    expect(s.has(v2)).toBe(true);
    expect(s.size).toBe(2);

    let v1a = new Uint64(1);
    s.add(v1a);
    expect(s.has(v1)).toBe(true);
    expect(s.has(v2)).toBe(true);
    expect(s.has(v1a)).toBe(true);
    expect(s.size).toBe(2);

    s.delete(v1);
    expect(s.has(v1)).toBe(false);
    expect(s.has(v2)).toBe(true);
    expect(s.size).toBe(1);

    let v3 = new Uint64(3, 4);
    expect(s.has(v3)).toBe(false);
    s.add(v3);
    expect(s.has(v1)).toBe(false);
    expect(s.has(v2)).toBe(true);
    expect(s.has(v3)).toBe(true);
    expect(s.size).toBe(2);

    s.clear();
    expect(s.has(v1)).toBe(false);
    expect(s.has(v2)).toBe(false);
    expect(s.has(v3)).toBe(false);
    expect(s.size).toBe(0);
  });

  it('iterate', () => {
    let s = new Uint64Set();

    let v1 = new Uint64(1);
    let v2 = new Uint64(2, 3);
    let v3 = new Uint64(3, 4);
    s.add(v2);
    s.add(v1);
    s.add(v3);

    let iterated = [];
    for (let v of s.unsafeKeys()) {
      iterated.push(v.clone());
    }
    iterated.sort();
    expect(iterated).toEqual([v1, v2, v3]);
  });

  it('toJSON', () => {
    let s = new Uint64Set();

    let v1 = new Uint64(1);
    let v2 = new Uint64(2, 3);
    let v3 = new Uint64(3, 4);
    s.add(v2);
    s.add(v1);
    s.add(v3);

    let json = s.toJSON();
    expect(json).toEqual([v1.toString(), v2.toString(), v3.toString()]);
  });
});
