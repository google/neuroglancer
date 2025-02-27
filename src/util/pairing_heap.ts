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

export interface ComparisonFunction<T> {
  (a: T, b: T): boolean;
}

export interface PairingHeapOperationsConstructor<T> {
  new (compare: ComparisonFunction<T>): PairingHeapOperations<T>;
}

export interface PairingHeapOperations<T> {
  meld: (a: T | null, b: T | null) => T | null;
  compare: ComparisonFunction<T>;
  removeMin: (root: T) => T | null;
  remove: (root: T, node: T) => T | null;
  entries: (root: T | null) => Iterator<T>;
  removedEntries: (root: T | null) => Iterator<T>;
}

export type Node<
  T,
  Child extends string | symbol,
  Next extends string | symbol,
  Prev extends string | symbol,
> = Record<Child | Next | Prev, T | null>;

/**
 * Pairing heap.
 *
 * The root node is the minimum element according to comparator.
 *
 * @final
 */
export default function makePairingHeapOperations<
  T extends Node<T, Child, Next, Prev>,
  Child extends string | symbol,
  Next extends string | symbol,
  Prev extends string | symbol,
>(options: {
  // Returns true iff a < b.
  compare: (a: T, b: T) => boolean;
  child: Child;
  next: Next;
  prev: Prev;
}): PairingHeapOperations<T> {
  const { child: CHILD, next: NEXT, prev: PREV, compare } = options;

  function combineChildren(node: T) {
    let cur = node[CHILD] as T | null;
    if (cur === null) {
      return null;
    }
    // While in this function, we will use the nextProperty to create a
    // singly-linked list of pairwise-merged nodes that still need to be
    // merged together.
    let head: T | null = null;
    while (true) {
      const curNext: T | null = cur[NEXT] as T | null;
      let next: T | null, m: T;
      if (curNext === null) {
        next = null;
        m = cur;
      } else {
        next = curNext[NEXT] as T | null;
        m = meld(cur, curNext)!;
      }
      (m[NEXT] as T | null) = head;
      head = m;
      if (next === null) {
        break;
      }
      cur = next;
    }

    let root = head;
    head = head[NEXT] as T | null;
    while (true) {
      if (head === null) {
        break;
      }
      const next: T | null = head[NEXT] as T | null;
      root = meld(root, head)!;
      head = next;
    }
    (root[PREV] as T | null) = null;
    (root[NEXT] as T | null) = null;
    return root;
  }

  function meld(a: T | null, b: T | null) {
    if (b === null) {
      return a;
    }
    if (a === null) {
      return b;
    }
    if (compare(b, a)) {
      const temp = a;
      a = b;
      b = temp;
    }
    const aChild = a[CHILD] as T | null;
    (b[NEXT] as T | null) = aChild;
    (b[PREV] as T | null) = a;
    if (aChild !== null) {
      (aChild[PREV] as T | null) = b;
    }
    (a[CHILD] as T | null) = b;
    return a;
  }

  function removeMin(root: T) {
    const newRoot = combineChildren(root);
    (root[NEXT] as T | null) = null;
    (root[PREV] as T | null) = null;
    (root[CHILD] as T | null) = null;
    return newRoot;
  }

  function remove(root: T, node: T) {
    if (root === node) {
      return removeMin(root);
    }
    const prev = node[PREV] as T;
    const next = node[NEXT] as T;
    if ((prev[CHILD] as T | null) === node) {
      (prev[CHILD] as T | null) = next;
    } else {
      (prev[NEXT] as T | null) = next;
    }
    if (next !== null) {
      (next[PREV] as T | null) = prev;
    }
    const newRoot = meld(root, combineChildren(node));
    (node[NEXT] as T | null) = null;
    (node[PREV] as T | null) = null;
    (node[CHILD] as T | null) = null;
    return newRoot;
  }

  /**
   * Returns a new iterator over the entries in the heap.
   */
  function* entries(root: T): IterableIterator<T> {
    if (root !== null) {
      let child = root[CHILD] as T | null;
      yield root;
      while (child !== null) {
        const next: T | null = child[NEXT] as T | null;
        yield* entries(child);
        child = next;
      }
    }
  }

  /**
   * Returns a new iterator over the entries in the heap.  The entries
   * will be removed as they are iterated.
   */
  function* removedEntries(root: T): IterableIterator<T> {
    if (root !== null) {
      let child = root[CHILD] as T | null;
      (root[CHILD] as T | null) = null;
      (root[NEXT] as T | null) = null;
      (root[PREV] as T | null) = null;
      yield root;
      while (child !== null) {
        const next: T | null = child[NEXT] as T | null;
        (child[CHILD] as T | null) = null;
        (child[NEXT] as T | null) = null;
        (child[PREV] as T | null) = null;
        yield* entries(child);
        child = next;
      }
    }
  }

  return {
    compare,
    meld,
    removeMin,
    remove,
    entries,
    removedEntries,
  };
}
