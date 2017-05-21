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

import {PairingHeapOperations} from 'neuroglancer/util/pairing_heap';

interface Node<T> {
  CHILD_PROPERTY: T|null;
  NEXT_PROPERTY: T|null;
  PREV_PROPERTY: T|null;
}

/**
 * Pairing heap.
 *
 * The root node is the minimum element according to comparator.
 *
 * @final
 */
export default class Implementation<T extends Node<T>> implements PairingHeapOperations<T> {
  /**
   * @param compare Returns true iff a < b.
   */
  constructor(public compare: (a: T, b: T) => boolean) {}

  meld(a: T|null, b: T|null) {
    if (b === null) {
      return a;
    }
    if (a === null) {
      return b;
    }
    let {compare} = this;
    if (compare(b, a)) {
      let temp = a;
      a = b;
      b = temp;
    }
    var aChild = a.CHILD_PROPERTY;
    b.NEXT_PROPERTY = aChild;
    b.PREV_PROPERTY = a;
    if (aChild !== null) {
      aChild.PREV_PROPERTY = b;
    }
    a.CHILD_PROPERTY = b;
    return a;
  }
  private combineChildren(node: T) {
    var cur = node.CHILD_PROPERTY;
    if (cur === null) {
      return null;
    }
    // While in this function, we will use the nextProperty to create a
    // singly-linked list of pairwise-merged nodes that still need to be
    // merged together.
    let head: T|null = null;
    while (true) {
      let curNext: T|null = cur.NEXT_PROPERTY;
      let next: T|null, m: T;
      if (curNext === null) {
        next = null;
        m = cur;
      } else {
        next = curNext.NEXT_PROPERTY;
        m = this.meld(cur, curNext)!;
      }
      m.NEXT_PROPERTY = head;
      head = m;
      if (next === null) {
        break;
      }
      cur = next;
    }

    var root = head;
    head = head.NEXT_PROPERTY;
    while (true) {
      if (head === null) {
        break;
      }
      let next: T|null = head.NEXT_PROPERTY;
      root = this.meld(root, head)!;
      head = next;
    }
    root.PREV_PROPERTY = null;
    root.NEXT_PROPERTY = null;
    return root;
  }
  removeMin(root: T) {
    var newRoot = this.combineChildren(root);
    root.NEXT_PROPERTY = null;
    root.PREV_PROPERTY = null;
    root.CHILD_PROPERTY = null;
    return newRoot;
  }

  remove(root: T, node: T) {
    if (root === node) {
      return this.removeMin(root);
    }
    var prev = node.PREV_PROPERTY!;
    var next = node.NEXT_PROPERTY!;
    if (prev.CHILD_PROPERTY === node) {
      prev.CHILD_PROPERTY = next;
    } else {
      prev.NEXT_PROPERTY = next;
    }
    if (next !== null) {
      next.PREV_PROPERTY = prev;
    }
    let newRoot = this.meld(root, this.combineChildren(node));
    node.NEXT_PROPERTY = null;
    node.PREV_PROPERTY = null;
    node.CHILD_PROPERTY = null;
    return newRoot;
  }

  /**
   * Returns a new iterator over the entries in the heap.
   */
  * entries(root: T): IterableIterator<T> {
    if (root !== null) {
      let child = root.CHILD_PROPERTY;
      yield root;
      while (child !== null) {
        let next: T|null = child.NEXT_PROPERTY;
        yield* this.entries(child);
        child = next;
      }
    }
  }

  /**
   * Returns a new iterator over the entries in the heap.  The entries
   * will be removed as they are iterated.
   */
  * removedEntries(root: T): IterableIterator<T> {
    if (root !== null) {
      let child = root.CHILD_PROPERTY;
      root.CHILD_PROPERTY = null;
      root.NEXT_PROPERTY = null;
      root.PREV_PROPERTY = null;
      yield root;
      while (child !== null) {
        let next: T|null = child.NEXT_PROPERTY;
        child.CHILD_PROPERTY = null;
        child.NEXT_PROPERTY = null;
        child.PREV_PROPERTY = null;
        yield* this.entries(child);
        child = next;
      }
    }
  }
}
