// DO NOT EDIT.  Generated from templates/util/pairing_heap.template.ts.
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

import type { PairingHeapOperations } from "#src/util/pairing_heap.js";

interface Node<T> {
  child1: T | null;
  next1: T | null;
  prev1: T | null;
}

/**
 * Pairing heap.
 *
 * The root node is the minimum element according to comparator.
 *
 * @final
 */
export default class Implementation<T extends Node<T>>
  implements PairingHeapOperations<T>
{
  /**
   * @param compare Returns true iff a < b.
   */
  constructor(public compare: (a: T, b: T) => boolean) {}

  meld(a: T | null, b: T | null) {
    if (b === null) {
      return a;
    }
    if (a === null) {
      return b;
    }
    const { compare } = this;
    if (compare(b, a)) {
      const temp = a;
      a = b;
      b = temp;
    }
    const aChild = a.child1;
    b.next1 = aChild;
    b.prev1 = a;
    if (aChild !== null) {
      aChild.prev1 = b;
    }
    a.child1 = b;
    return a;
  }
  private combineChildren(node: T) {
    let cur = node.child1;
    if (cur === null) {
      return null;
    }
    // While in this function, we will use the nextProperty to create a
    // singly-linked list of pairwise-merged nodes that still need to be
    // merged together.
    let head: T | null = null;
    while (true) {
      const curNext: T | null = cur.next1;
      let next: T | null, m: T;
      if (curNext === null) {
        next = null;
        m = cur;
      } else {
        next = curNext.next1;
        m = this.meld(cur, curNext)!;
      }
      m.next1 = head;
      head = m;
      if (next === null) {
        break;
      }
      cur = next;
    }

    let root = head;
    head = head.next1;
    while (true) {
      if (head === null) {
        break;
      }
      const next: T | null = head.next1;
      root = this.meld(root, head)!;
      head = next;
    }
    root.prev1 = null;
    root.next1 = null;
    return root;
  }
  removeMin(root: T) {
    const newRoot = this.combineChildren(root);
    root.next1 = null;
    root.prev1 = null;
    root.child1 = null;
    return newRoot;
  }

  remove(root: T, node: T) {
    if (root === node) {
      return this.removeMin(root);
    }
    const prev = node.prev1!;
    const next = node.next1!;
    if (prev.child1 === node) {
      prev.child1 = next;
    } else {
      prev.next1 = next;
    }
    if (next !== null) {
      next.prev1 = prev;
    }
    const newRoot = this.meld(root, this.combineChildren(node));
    node.next1 = null;
    node.prev1 = null;
    node.child1 = null;
    return newRoot;
  }

  /**
   * Returns a new iterator over the entries in the heap.
   */
  *entries(root: T): IterableIterator<T> {
    if (root !== null) {
      let child = root.child1;
      yield root;
      while (child !== null) {
        const next: T | null = child.next1;
        yield* this.entries(child);
        child = next;
      }
    }
  }

  /**
   * Returns a new iterator over the entries in the heap.  The entries
   * will be removed as they are iterated.
   */
  *removedEntries(root: T): IterableIterator<T> {
    if (root !== null) {
      let child = root.child1;
      root.child1 = null;
      root.next1 = null;
      root.prev1 = null;
      yield root;
      while (child !== null) {
        const next: T | null = child.next1;
        child.child1 = null;
        child.next1 = null;
        child.prev1 = null;
        yield* this.entries(child);
        child = next;
      }
    }
  }
}
