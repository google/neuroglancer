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
  next0: T|null;
  prev0: T|null;
}

export default class {
  static insertAfter<T extends Node<T>>(head: T, x: T) {
    let next = <T>head.next0;
    x.next0 = next;
    x.prev0 = head;
    head.next0 = x;
    next.prev0 = x;
  }
  static insertBefore<T extends Node<T>>(head: T, x: T) {
    let prev = <T>head.prev0;
    x.prev0 = prev;
    x.next0 = head;
    head.prev0 = x;
    prev.next0 = x;
  }
  static front<T extends Node<T>>(head: T) {
    let next = head.next0;
    if (next === head) {
      return null;
    }
    return next;
  }
  static back<T extends Node<T>>(head: T) {
    let next = head.prev0;
    if (next === head) {
      return null;
    }
    return next;
  }
  static pop<T extends Node<T>>(x: T) {
    let next = <T>x.next0;
    let prev = <T>x.prev0;
    next.prev0 = prev;
    prev.next0 = next;
    x.next0 = null;
    x.prev0 = null;
    return x;
  }
  static * iterator<T extends Node<T>>(head: T) {
    for (let x = <T>head.next0; x !== head; x = <T>x.next0) {
      yield x;
    }
  }
  static * reverseIterator<T extends Node<T>>(head: T) {
    for (let x = <T>head.prev0; x !== head; x = <T>x.prev0) {
      yield x;
    }
  }
  static initializeHead<T extends Node<T>>(head: T) {
    head.next0 = head.prev0 = head;
  }
}
