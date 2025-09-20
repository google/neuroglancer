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
import {
  getInsertPermutation,
  getMergeSplices,
  partitionArray,
  spliceArray,
  tile2dArray,
  transposeArray2d,
  findClosestMatchInSortedArray,
  findFirstInSortedArray,
} from "#src/util/array.js";

describe("partitionArray", () => {
  it("basic test", () => {
    const arr = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const newEnd = partitionArray(arr, 2, 9, (x) => x % 2 === 0);
    expect(arr).toEqual([0, 1, 2, 8, 4, 6, 7, 5, 3, 9, 10]);
    expect(newEnd).toBe(6);
  });
});

describe("transposeArray2d", () => {
  it("square", () => {
    const arr = new Uint8Array(4);
    const out = new Uint8Array(4);
    arr.set([0, 1, 2, 3]);
    out.set([0, 2, 1, 3]);
    expect(transposeArray2d(arr, 2, 2)).toEqual(out);
  });

  it("minor > major rectangle", () => {
    const arr = new Uint8Array(6);
    const out = new Uint8Array(6);
    arr.set([0, 1, 2, 3, 4, 5]);
    out.set([0, 3, 1, 4, 2, 5]);
    expect(transposeArray2d(arr, 2, 3)).toEqual(out);
  });

  it("major > minor rectangle", () => {
    const arr = new Uint8Array(8);
    const out = new Uint8Array(8);
    arr.set([0, 1, 2, 3, 4, 5, 6, 7]);
    out.set([0, 2, 4, 6, 1, 3, 5, 7]);
    expect(transposeArray2d(arr, 4, 2)).toEqual(out);
  });

  it("single axis", () => {
    const arr = new Uint8Array(3);
    const out = new Uint8Array(3);
    arr.set([0, 1, 2]);
    out.set([0, 1, 2]);
    expect(transposeArray2d(arr, 3, 1)).toEqual(out);
  });
});

describe("tile2dArray", () => {
  it("majorDimension=1, majorTiles work", () => {
    const input = Uint8Array.of(0, 1, 2, 3, 4);
    const expected = Uint8Array.of(0, 0, 1, 1, 2, 2, 3, 3, 4, 4);
    const result = tile2dArray(
      input,
      /*majorDimension=*/ 1,
      /*minorTiles=*/ 1,
      /*majorTiles=*/ 2,
    );
    expect(result).toEqual(expected);
  });

  it("majorDimension=1, minorTiles work", () => {
    const input = Uint8Array.of(0, 1, 2, 3, 4);
    const expected = Uint8Array.of(0, 1, 2, 3, 4, 0, 1, 2, 3, 4);
    const result = tile2dArray(
      input,
      /*majorDimension=*/ 1,
      /*minorTiles=*/ 2,
      /*majorTiles=*/ 1,
    );
    expect(result).toEqual(expected);
  });

  it("majorDimension=2, majorTiles work", () => {
    const input = Uint8Array.of(0, 1, 2, 3);
    const expected = Uint8Array.of(0, 1, 0, 1, 2, 3, 2, 3);
    const result = tile2dArray(
      input,
      /*majorDimension=*/ 2,
      /*minorTiles=*/ 1,
      /*majorTiles=*/ 2,
    );
    expect(result).toEqual(expected);
  });

  it("majorDimension=2, majorTiles work, minorTiles work", () => {
    const input = Uint8Array.of(0, 1, 2, 3);
    const expected = Uint8Array.of(
      0,
      1,
      0,
      1,
      2,
      3,
      2,
      3,
      0,
      1,
      0,
      1,
      2,
      3,
      2,
      3,
    );
    const result = tile2dArray(
      input,
      /*majorDimension=*/ 2,
      /*minorTiles=*/ 2,
      /*majorTiles=*/ 2,
    );
    expect(result).toEqual(expected);
  });
});

describe("getInsertPermutation", () => {
  it("works for 1 element", () => {
    expect(getInsertPermutation(1, 0, 0)).toEqual([0]);
  });
  it("works for 2 elements", () => {
    expect(getInsertPermutation(2, 0, 1)).toEqual([1, 0]);
    expect(getInsertPermutation(2, 1, 0)).toEqual([1, 0]);
    expect(getInsertPermutation(2, 0, 0)).toEqual([0, 1]);
    expect(getInsertPermutation(2, 1, 1)).toEqual([0, 1]);
  });
  it("works for 3 elements", () => {
    expect(getInsertPermutation(3, 0, 1)).toEqual([1, 0, 2]);
    expect(getInsertPermutation(3, 1, 0)).toEqual([1, 0, 2]);
    expect(getInsertPermutation(3, 0, 2)).toEqual([1, 2, 0]);
    expect(getInsertPermutation(3, 2, 0)).toEqual([2, 0, 1]);
    expect(getInsertPermutation(3, 2, 1)).toEqual([0, 2, 1]);
    expect(getInsertPermutation(3, 0, 0)).toEqual([0, 1, 2]);
    expect(getInsertPermutation(3, 1, 1)).toEqual([0, 1, 2]);
    expect(getInsertPermutation(3, 2, 2)).toEqual([0, 1, 2]);
  });

  it("works for 4 elements", () => {
    expect(getInsertPermutation(4, 0, 1)).toEqual([1, 0, 2, 3]);
    expect(getInsertPermutation(4, 0, 2)).toEqual([1, 2, 0, 3]);
    expect(getInsertPermutation(4, 2, 0)).toEqual([2, 0, 1, 3]);
  });
});

describe("spliceArray", () => {
  it("works for simple examaples", () => {
    const a = Array.from(new Array(10), (_, i) => i);
    expect(
      spliceArray(a, [{ retainCount: 10, insertCount: 0, deleteCount: 0 }]),
    ).toEqual(a);
    expect(
      spliceArray(a, [{ retainCount: 5, deleteCount: 3, insertCount: 2 }]),
    ).toEqual([0, 1, 2, 3, 4, undefined, undefined, 8, 9]);
    expect(
      spliceArray(a, [
        { retainCount: 2, deleteCount: 1, insertCount: 1 },
        { retainCount: 3, deleteCount: 0, insertCount: 2 },
      ]),
    ).toEqual([0, 1, undefined, 3, 4, 5, undefined, undefined, 6, 7, 8, 9]);
  });
});

describe("getMergeSplices", () => {
  it("works for simple examaples", () => {
    const compare = (a: number, b: number) => a - b;
    expect(getMergeSplices([0, 1, 2, 3], [0, 1, 2, 3], compare)).toEqual([
      { retainCount: 4, deleteCount: 0, insertCount: 0 },
    ]);
    expect(getMergeSplices([0, 1, 2, 3], [], compare)).toEqual([
      { retainCount: 0, deleteCount: 4, insertCount: 0 },
    ]);
    expect(getMergeSplices([], [0, 1, 2, 3], compare)).toEqual([
      { retainCount: 0, deleteCount: 0, insertCount: 4 },
    ]);
    expect(getMergeSplices([0, 1, 2, 3], [0, 1, 1.5, 2, 3], compare)).toEqual([
      { retainCount: 2, deleteCount: 0, insertCount: 0 },
      { retainCount: 0, deleteCount: 0, insertCount: 1 },
      { retainCount: 2, deleteCount: 0, insertCount: 0 },
    ]);
    expect(getMergeSplices([0, 1, 2, 3], [0, 1, 1.5, 3, 4], compare)).toEqual([
      { retainCount: 2, deleteCount: 0, insertCount: 0 },
      { retainCount: 0, deleteCount: 0, insertCount: 1 },
      { retainCount: 0, deleteCount: 1, insertCount: 0 },
      { retainCount: 1, deleteCount: 0, insertCount: 0 },
      { retainCount: 0, deleteCount: 0, insertCount: 1 },
    ]);
  });
});

describe("findClosestMatchInSortedArray", () => {
  const compare = (a: number, b: number) => a - b;
  it("works for empty array", () => {
    expect(findClosestMatchInSortedArray([], 0, compare)).toEqual(-1);
  });
  it("works for simple examples", () => {
    expect(findClosestMatchInSortedArray([0, 1, 2, 3], 0, compare)).toEqual(0);
    expect(findClosestMatchInSortedArray([0, 1, 2, 3], 1, compare)).toEqual(1);
    expect(findClosestMatchInSortedArray([0, 1, 2, 3], 2, compare)).toEqual(2);
    expect(findClosestMatchInSortedArray([0, 1, 2, 3], 3, compare)).toEqual(3);
    expect(findClosestMatchInSortedArray([0, 1, 2, 3], 4, compare)).toEqual(3);
    expect(findClosestMatchInSortedArray([0, 1, 2, 3], -1, compare)).toEqual(0);
    expect(findClosestMatchInSortedArray([0, 1, 2, 3], 1.5, compare)).toEqual(
      1,
    );
    expect(findClosestMatchInSortedArray([0, 1, 2, 3], 1.6, compare)).toEqual(
      2,
    );
  });
});

describe("findFirst", () => {
  it("returns -1 for an empty array", () => {
    expect(findFirstInSortedArray([], (x) => x === 5)).toEqual(-1);
  });

  describe("ascending direction (default)", () => {
    it("finds the first item >= 3", () => {
      const arr = [1, 2, 3, 3, 4, 5];
      expect(findFirstInSortedArray(arr, (x) => x >= 3)).toEqual(2);
    });

    it("finds the first item > 4", () => {
      const arr = [1, 2, 3, 4, 5];
      expect(findFirstInSortedArray(arr, (x) => x > 4)).toEqual(4);
    });

    it("returns -1 if no item matches", () => {
      const arr = [1, 2, 3];
      expect(findFirstInSortedArray(arr, (x) => x > 10)).toEqual(-1);
    });

    it("returns 0 if first item matches", () => {
      const arr = [5, 6, 7];
      expect(findFirstInSortedArray(arr, (x) => x >= 5)).toEqual(0);
    });

    it("respects custom bounds", () => {
      const arr = [0, 1, 2, 3, 4, 0, 5, 6, 7];
      expect(findFirstInSortedArray(arr, (x) => x >= 4, "asc", 5, 8)).toEqual(
        6,
      );
    });
  });

  describe("descending direction", () => {
    it("finds the first item < 4 from the right", () => {
      const arr = [1, 2, 3, 4, 5];
      expect(findFirstInSortedArray(arr, (x) => x < 4, "desc")).toEqual(2);
    });

    it("finds the first item <= 3 from the right", () => {
      const arr = [1, 2, 3, 3, 4, 5];
      expect(findFirstInSortedArray(arr, (x) => x <= 3, "desc")).toEqual(3);
    });

    it("returns -1 if no match", () => {
      const arr = [5, 6, 7];
      expect(findFirstInSortedArray(arr, (x) => x < 5, "desc")).toEqual(-1);
    });

    it("respects custom bounds", () => {
      const arr = [1, 2, 3, 4, 5, 6];
      expect(findFirstInSortedArray(arr, (x) => x <= 4, "desc", 1, 3)).toEqual(
        2,
      );
    });
  });

  describe("complex predicates", () => {
    it("works with object arrays", () => {
      const arr = [{ v: 1 }, { v: 2 }, { v: 3 }];
      expect(findFirstInSortedArray(arr, (x) => x.v >= 2)).toEqual(1);
    });

    it("handles multiple matches, returns first in 'asc'", () => {
      const arr = [1, 2, 2, 2, 3];
      expect(findFirstInSortedArray(arr, (x) => x === 2, "asc")).toEqual(1);
    });

    it("handles multiple matches, returns last in 'desc'", () => {
      const arr = [1, 2, 2, 2, 3];
      expect(findFirstInSortedArray(arr, (x) => x === 2, "desc")).toEqual(3);
    });
  });
});
