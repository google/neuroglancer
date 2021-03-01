// DO NOT EDIT.  Generated from templates/neuroglancer/util/pairing_heap.template.ts.
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
  child0: T|null;
  next0: T|null;
  prev0: T|null;
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
    var aChild = a.child0;
    b.next0 = aChild;
    b.prev0 = a;
    if (aChild !== null) {
      aChild.prev0 = b;
    }
    a.child0 = b;
    return a;
  }
  private combineChildren(node: T) {
    var cur = node.child0;
    if (cur === null) {
      return null;
    }
    // While in this function, we will use the nextProperty to create a
    // singly-linked list of pairwise-merged nodes that still need to be
    // merged together.
    let head: T|null = null;
    while (true) {
      let curNext: T|null = cur.next0;
      let next: T|null, m: T;
      if (curNext === null) {
        next = null;
        m = cur;
      } else {
        next = curNext.next0;
        m = this.meld(cur, curNext)!;
      }
      m.next0 = head;
      head = m;
      if (next === null) {
        break;
      }
      cur = next;
    }

    var root = head;
    head = head.next0;
    while (true) {
      if (head === null) {
        break;
      }
      let next: T|null = head.next0;
      root = this.meld(root, head)!;
      head = next;
    }
    root.prev0 = null;
    root.next0 = null;
    return root;
  }
  removeMin(root: T) {
    var newRoot = this.combineChildren(root);
    root.next0 = null;
    root.prev0 = null;
    root.child0 = null;
    return newRoot;
  }

  remove(root: T, node: T) {
    if (root === node) {
      return this.removeMin(root);
    }
    var prev = node.prev0!;
    var next = node.next0!;
    if (prev.child0 === node) {
      prev.child0 = next;
    } else {
      prev.next0 = next;
    }
    if (next !== null) {
      next.prev0 = prev;
    }
    let newRoot = this.meld(root, this.combineChildren(node));
    node.next0 = null;
    node.prev0 = null;
    node.child0 = null;
    return newRoot;
  }

  /**
   * Returns a new iterator over the entries in the heap.
   */
  * entries(root: T): IterableIterator<T> {
    if (root !== null) {
      let child = root.child0;
      yield root;
      while (child !== null) {
        let next: T|null = child.next0;
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
      let child = root.child0;
      root.child0 = null;
      root.next0 = null;
      root.prev0 = null;
      yield root;
      while (child !== null) {
        let next: T|null = child.next0;
        child.child0 = null;
        child.next0 = null;
        child.prev0 = null;
        yield* this.entries(child);
        child = next;
      }
    }
  }
}
