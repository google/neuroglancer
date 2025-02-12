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

export type Node<
  T,
  Next extends string | symbol,
  Prev extends string | symbol,
> = Record<Next | Prev, T | null>;

export interface LinkedListOperations<T> {
  insertAfter: (head: T, x: T) => void;
  pop: (head: T) => T;
  insertBefore: (head: T, x: T) => void;
  front: (head: T) => T | null;
  back: (head: T) => T | null;
  iterator: (head: T) => Iterator<T>;
  reverseIterator: (head: T) => Iterator<T>;
  initializeHead: (head: T) => void;
}

export default function linkedListOperations<
  Next extends string | symbol,
  Prev extends string | symbol,
>(options: { next: Next; prev: Prev }) {
  const { next: NEXT, prev: PREV } = options;
  return {
    insertAfter<T extends Node<T, Next, Prev>>(head: T, x: T) {
      const next = head[NEXT]!;
      (x[NEXT] as T) = next;
      (x[PREV] as T) = head;
      (head[NEXT] as T) = x;
      (next[PREV] as T) = x;
    },
    insertBefore<T extends Node<T, Next, Prev>>(head: T, x: T) {
      const prev = <T>head[PREV];
      (x[PREV] as T) = prev;
      (x[NEXT] as T) = head;
      (head[PREV] as T) = x;
      (prev[NEXT] as T) = x;
    },
    front<T extends Node<T, Next, Prev>>(head: T) {
      const next = head[NEXT];
      if (next === head) {
        return null;
      }
      return next;
    },
    back<T extends Node<T, Next, Prev>>(head: T): T | null {
      const next = head[PREV];
      if (next === head) {
        return null;
      }
      return next;
    },
    pop<T extends Node<T, Next, Prev>>(x: T) {
      const next = x[NEXT] as T;
      const prev = x[PREV] as T;
      (next[PREV] as T) = prev;
      (prev[NEXT] as T) = next;
      (x[NEXT] as T | null) = null;
      (x[PREV] as T | null) = null;
      return x;
    },
    *iterator<T extends Node<T, Next, Prev>>(head: T) {
      for (let x = <T>head[NEXT]; x !== head; x = <T>x[NEXT]) {
        yield x;
      }
    },
    *reverseIterator<T extends Node<T, Next, Prev>>(head: T) {
      for (let x = <T>head[PREV]; x !== head; x = <T>x[PREV]) {
        yield x;
      }
    },
    initializeHead<T extends Node<T, Next, Prev>>(head: T) {
      (head[NEXT] as T) = (head[PREV] as T) = head;
    },
  };
}
