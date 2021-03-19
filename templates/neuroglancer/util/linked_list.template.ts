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
  NEXT_PROPERTY: T|null;
  PREV_PROPERTY: T|null;
}

export default class {
  static insertAfter<T extends Node<T>>(head: T, x: T) {
    let next = <T>head.NEXT_PROPERTY;
    x.NEXT_PROPERTY = next;
    x.PREV_PROPERTY = head;
    head.NEXT_PROPERTY = x;
    next.PREV_PROPERTY = x;
  }
  static insertBefore<T extends Node<T>>(head: T, x: T) {
    let prev = <T>head.PREV_PROPERTY;
    x.PREV_PROPERTY = prev;
    x.NEXT_PROPERTY = head;
    head.PREV_PROPERTY = x;
    prev.NEXT_PROPERTY = x;
  }
  static front<T extends Node<T>>(head: T) {
    let next = head.NEXT_PROPERTY;
    if (next === head) {
      return null;
    }
    return next;
  }
  static back<T extends Node<T>>(head: T) {
    let next = head.PREV_PROPERTY;
    if (next === head) {
      return null;
    }
    return next;
  }
  static pop<T extends Node<T>>(x: T) {
    let next = <T>x.NEXT_PROPERTY;
    let prev = <T>x.PREV_PROPERTY;
    next.PREV_PROPERTY = prev;
    prev.NEXT_PROPERTY = next;
    x.NEXT_PROPERTY = null;
    x.PREV_PROPERTY = null;
    return x;
  }
  static * iterator<T extends Node<T>>(head: T) {
    for (let x = <T>head.NEXT_PROPERTY; x !== head; x = <T>x.NEXT_PROPERTY) {
      yield x;
    }
  }
  static * reverseIterator<T extends Node<T>>(head: T) {
    for (let x = <T>head.PREV_PROPERTY; x !== head; x = <T>x.PREV_PROPERTY) {
      yield x;
    }
  }
  static initializeHead<T extends Node<T>>(head: T) {
    head.NEXT_PROPERTY = head.PREV_PROPERTY = head;
  }
}
