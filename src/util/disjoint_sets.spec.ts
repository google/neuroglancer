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
import { bigintCompare } from "#src/util/bigint.js";
import { DisjointUint64Sets } from "#src/util/disjoint_sets.js";

function getSortedElements(disjointSets: DisjointUint64Sets, x: bigint) {
  const members = Array.from(disjointSets.setElements(x));
  members.sort(bigintCompare);
  return members;
}

function getContiguousElements(start: bigint, end: bigint) {
  const result = new Array<bigint>();
  for (let i = start; i < end; ++i) {
    result.push(i);
  }
  return result;
}

describe("disjoint_sets", () => {
  it("basic", () => {
    const disjointSets = new DisjointUint64Sets();
    // Link the first 25 elements.
    for (let i = 0n; i < 24n; ++i) {
      const a = i;
      const b = i + 1n;
      expect(disjointSets.get(a)).toEqual(0n);
      expect(disjointSets.get(b)).toBe(b);
      disjointSets.link(a, b);
      expect(disjointSets.get(a)).toEqual(0n);
      expect(disjointSets.get(b)).toEqual(0n);
      expect(getSortedElements(disjointSets, a)).toEqual(
        getContiguousElements(0n, i + 2n),
      );
    }

    // Link the next 25 elements.
    for (let i = 25n; i < 49n; ++i) {
      const a = i;
      const b = i + 1n;
      expect(disjointSets.get(a)).toEqual(25n);
      expect(disjointSets.get(b)).toBe(b);
      disjointSets.link(a, b);
      expect(disjointSets.get(a)).toEqual(25n);
      expect(disjointSets.get(b)).toEqual(25n);
      expect(getSortedElements(disjointSets, a)).toEqual(
        getContiguousElements(25n, i + 2n),
      );
    }

    // Link the two sets of 25 elements each.
    expect(disjointSets.link(15n, 40n)).toBe(true);
    expect(disjointSets.get(15n)).toEqual(0n);
    expect(disjointSets.get(40n)).toEqual(0n);
    expect(getSortedElements(disjointSets, 15n)).toEqual(
      getContiguousElements(0n, 50n),
    );

    // Does nothing, the two elements are already merged.
    expect(disjointSets.link(15n, 40n)).toBe(false);

    for (let x = 0n; x < 50n; ++x) {
      // Check that the same representative is returned.
      expect(disjointSets.get(x)).toEqual(0n);
      // Check that getSortedElements returns the same list for each member of a set.
      expect(getSortedElements(disjointSets, x)).toEqual(
        getContiguousElements(0n, 50n),
      );
    }

    // Check that non-linked elements correctly have only a single element.
    for (let i = 51n; i < 100n; ++i) {
      expect(getSortedElements(disjointSets, i)).toEqual(
        getContiguousElements(i, i + 1n),
      );
    }
  });

  it("toJSON", () => {
    const disjointSets = new DisjointUint64Sets();
    disjointSets.link(5n, 0n);
    disjointSets.link(2n, 10n);
    disjointSets.link(2n, 3n);
    expect(JSON.stringify(disjointSets)).toEqual('[["0","5"],["2","3","10"]]');
  });
});
