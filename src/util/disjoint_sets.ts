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

import { VisibleSegmentEquivalencePolicy } from "#src/segmentation_graph/segment_id.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { WatchableValue } from "#src/trackable_value.js";
import { bigintCompare } from "#src/util/bigint.js";

class Entry {
  rank: number = 0;
  parent: Entry = this;
  next: Entry = this;
  prev: Entry = this;
  min: bigint;

  constructor(public value: bigint) {
    this.min = value;
  }
}

function findRepresentative(v: Entry): Entry {
  // First pass: find the root, which will be stored in ancestor.
  let old = v;
  let ancestor = v.parent;
  while (ancestor !== v) {
    v = ancestor;
    ancestor = v.parent;
  }
  // Second pass: set all of the parent pointers along the path from the
  // original element `old' to refer directly to the root `ancestor'.
  v = old.parent;
  while (ancestor !== v) {
    old.parent = ancestor;
    old = v;
    v = old.parent;
  }
  return ancestor;
}

function linkUnequalSetRepresentatives(i: Entry, j: Entry): Entry {
  const iRank = i.rank;
  const jRank = j.rank;
  if (iRank > jRank) {
    j.parent = i;
    return i;
  }

  i.parent = j;
  if (iRank === jRank) {
    j.rank = jRank + 1;
  }
  return j;
}

function spliceCircularLists(i: Entry, j: Entry) {
  const iPrev = i.prev;
  const jPrev = j.prev;

  // Connect end of i to beginning of j.
  j.prev = iPrev;
  iPrev.next = j;

  // Connect end of j to beginning of i.
  i.prev = jPrev;
  jPrev.next = i;
}

function* setElementIterator(i: Entry): Generator<bigint> {
  let j = i;
  do {
    yield j.value;
    j = j.next;
  } while (j !== i);
}

function isRootElement(v: Entry) {
  return v.parent === v;
}

/**
 * Represents a collection of disjoint sets of uint64 values.
 *
 * Supports merging sets, retrieving the minimum uint64 value contained in a set (the representative
 * value), and iterating over the elements contained in a set.
 */
export class DisjointUint64Sets {
  private map = new Map<bigint, Entry>();
  visibleSegmentEquivalencePolicy: WatchableValueInterface<VisibleSegmentEquivalencePolicy> =
    new WatchableValue<VisibleSegmentEquivalencePolicy>(
      VisibleSegmentEquivalencePolicy.MIN_REPRESENTATIVE,
    );
  generation = 0;

  has(x: bigint): boolean {
    return this.map.has(x);
  }

  get(x: bigint): bigint {
    const entry = this.map.get(x);
    if (entry === undefined) {
      return x;
    }
    return findRepresentative(entry).min;
  }

  isMinElement(x: bigint) {
    return x === this.get(x);
  }

  private makeSet(x: bigint): Entry {
    const { map } = this;
    let entry = map.get(x);
    if (entry === undefined) {
      entry = new Entry(x);
      map.set(x, entry);
      return entry;
    }
    return findRepresentative(entry);
  }

  /**
   * Union the sets containing `a` and `b`.
   * @returns `false` if `a` and `b` are already in the same set, otherwise `true`.
   */
  link(a: bigint, b: bigint): boolean {
    const aEntry = this.makeSet(a);
    const bEntry = this.makeSet(b);
    if (aEntry === bEntry) {
      return false;
    }
    this.generation++;
    const newNode = linkUnequalSetRepresentatives(aEntry, bEntry);
    spliceCircularLists(aEntry, bEntry);
    const aMin = aEntry.min;
    const bMin = bEntry.min;
    const isMax =
      (this.visibleSegmentEquivalencePolicy.value &
        VisibleSegmentEquivalencePolicy.MAX_REPRESENTATIVE) !==
      0;
    newNode.min = aMin < bMin === isMax ? bMin : aMin;
    return true;
  }

  linkAll(ids: bigint[]) {
    for (let i = 1, length = ids.length; i < length; ++i) {
      this.link(ids[0], ids[i]);
    }
  }

  /**
   * Unlinks all members of the specified set.
   */
  deleteSet(x: bigint) {
    const { map } = this;
    let changed = false;
    for (const y of this.setElements(x)) {
      map.delete(y);
      changed = true;
    }
    if (changed) {
      ++this.generation;
    }
    return changed;
  }

  *setElements(a: bigint): IterableIterator<bigint> {
    const entry = this.map.get(a);
    if (entry === undefined) {
      yield a;
    } else {
      yield* setElementIterator(entry);
    }
  }

  clear() {
    const { map } = this;
    if (map.size === 0) {
      return false;
    }
    ++this.generation;
    map.clear();
    return true;
  }

  get size() {
    return this.map.size;
  }

  *mappings(): IterableIterator<[bigint, bigint]> {
    for (const entry of this.map.values()) {
      yield [entry.value, findRepresentative(entry).min];
    }
  }

  *roots(): IterableIterator<bigint> {
    for (const entry of this.map.values()) {
      if (isRootElement(entry)) {
        yield entry.value;
      }
    }
  }

  [Symbol.iterator](): IterableIterator<[bigint, bigint]> {
    return this.mappings();
  }

  /**
   * Returns an array of arrays of strings, where the arrays contained in the outer array correspond
   * to the disjoint sets, and the strings are the base-10 string representations of the members of
   * each set.  The members are sorted in numerical order, and the sets are sorted in numerical
   * order of their smallest elements.
   */
  toJSON(): string[][] {
    const sets = new Array<bigint[]>();
    for (const entry of this.map.values()) {
      if (isRootElement(entry)) {
        const members = new Array<bigint>();
        for (const member of setElementIterator(entry)) {
          members.push(member);
        }
        members.sort(bigintCompare);
        sets.push(members);
      }
    }
    sets.sort((a, b) => bigintCompare(a[0], b[0]));
    return sets.map((set) => set.map((element) => element.toString()));
  }
}
