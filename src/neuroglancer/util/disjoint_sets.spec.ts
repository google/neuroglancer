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

import {DisjointUint64Sets} from 'neuroglancer/util/disjoint_sets';
import {Uint64} from 'neuroglancer/util/uint64';

function getSortedElementStrings(disjointSets: DisjointUint64Sets, x: Uint64) {
  let members = Array.from(disjointSets.setElements(x));
  members.sort(Uint64.compare);
  return members.map(v => v.toString());
}

function getContiguousElementStrings(start: number, end: number) {
  let result = new Array<string>(end - start);
  for (let i = 0, length = result.length; i < length; ++i) {
    result[i] = (start + i).toString();
  }
  return result;
}

describe('disjoint_sets', () => {
  it('basic', () => {
    let disjointSets = new DisjointUint64Sets();
    // Link the first 25 elements.
    for (let i = 0; i < 24; ++i) {
      let a = new Uint64(i, 0);
      let b = new Uint64(i + 1, 0);
      expect(disjointSets.get(a).toString()).toEqual('0');
      expect(disjointSets.get(b)).toBe(b);
      disjointSets.link(a, b);
      expect(disjointSets.get(a).toString()).toEqual('0');
      expect(disjointSets.get(b).toString()).toEqual('0');
      expect(getSortedElementStrings(disjointSets, a))
          .toEqual(getContiguousElementStrings(0, i + 2));
    }

    // Link the next 25 elements.
    for (let i = 25; i < 49; ++i) {
      let a = new Uint64(i, 0);
      let b = new Uint64(i + 1, 0);
      expect(disjointSets.get(a).toString()).toEqual('25');
      expect(disjointSets.get(b)).toBe(b);
      disjointSets.link(a, b);
      expect(disjointSets.get(a).toString()).toEqual('25');
      expect(disjointSets.get(b).toString()).toEqual('25');
      expect(getSortedElementStrings(disjointSets, a))
          .toEqual(getContiguousElementStrings(25, i + 2));
    }

    // Link the two sets of 25 elements each.
    expect(disjointSets.link(new Uint64(15, 0), new Uint64(40, 0))).toBe(true);
    expect(disjointSets.get(new Uint64(15, 0)).toString()).toEqual('0');
    expect(disjointSets.get(new Uint64(40, 0)).toString()).toEqual('0');
    expect(getSortedElementStrings(disjointSets, new Uint64(15, 0)))
        .toEqual(getContiguousElementStrings(0, 50));

    // Does nothing, the two elements are already merged.
    expect(disjointSets.link(new Uint64(15, 0), new Uint64(40, 0))).toBe(false);

    for (let i = 0; i < 50; ++i) {
      const x = new Uint64(i, 0);
      // Check that the same representative is returned.
      expect(disjointSets.get(x).toString()).toEqual('0');
      // Check that getSortedElementStrings returns the same list for each member of a set.
      expect(getSortedElementStrings(disjointSets, x)).toEqual(getContiguousElementStrings(0, 50));
    }

    // Check that non-linked elements correctly have only a single element.
    for (let i = 51; i < 100; ++i) {
      expect(getSortedElementStrings(disjointSets, new Uint64(i, 0)))
          .toEqual(getContiguousElementStrings(i, i + 1));
    }
  });

  it('toJSON', () => {
    let disjointSets = new DisjointUint64Sets();
    disjointSets.link(Uint64.parseString('5'), Uint64.parseString('0'));
    disjointSets.link(Uint64.parseString('2'), Uint64.parseString('10'));
    disjointSets.link(Uint64.parseString('2'), Uint64.parseString('3'));
    expect(JSON.stringify(disjointSets)).toEqual('[["0","5"],["2","3","10"]]');
  });
});
