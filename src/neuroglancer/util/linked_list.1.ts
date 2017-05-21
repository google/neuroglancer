// DO NOT EDIT.  Generated from templates/neuroglancer/util/linked_list.template.ts.
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

interface Node<T> {
  next1: T|null;
  prev1: T|null;
}

export default class {
  static insertAfter<T extends Node<T>>(head: T, x: T) {
    let next = <T>head.next1;
    x.next1 = next;
    x.prev1 = head;
    head.next1 = x;
    next.prev1 = x;
  }
  static insertBefore<T extends Node<T>>(head: T, x: T) {
    let prev = <T>head.prev1;
    x.prev1 = prev;
    x.next1 = head;
    head.prev1 = x;
    prev.next1 = x;
  }
  static front<T extends Node<T>>(head: T) {
    let next = head.next1;
    if (next === head) {
      return null;
    }
    return next;
  }
  static back<T extends Node<T>>(head: T) {
    let next = head.prev1;
    if (next === head) {
      return null;
    }
    return next;
  }
  static pop<T extends Node<T>>(x: T) {
    let next = <T>x.next1;
    let prev = <T>x.prev1;
    next.prev1 = prev;
    prev.next1 = next;
    x.next1 = null;
    x.prev1 = null;
    return x;
  }
  static * iterator<T extends Node<T>>(head: T) {
    for (let x = <T>head.next1; x !== head; x = <T>x.next1) {
      yield x;
    }
  }
  static * reverseIterator<T extends Node<T>>(head: T) {
    for (let x = <T>head.prev1; x !== head; x = <T>x.prev1) {
      yield x;
    }
  }
  static initializeHead<T extends Node<T>>(head: T) {
    head.next1 = head.prev1 = head;
  }
}
