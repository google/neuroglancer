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

export interface LinkedListOperations {
  insertAfter: <T>(head: T, x: T) => void;
  pop: <T>(head: T) => T;
  insertBefore: <T>(head: T, x: T) => void;
  front: <T>(head: T) => T | null;
  back: <T>(head: T) => T | null;
  iterator: <T>(head: T) => Iterator<T>;
  reverseIterator: <T>(head: T) => Iterator<T>;
  initializeHead: <T>(head: T) => void;
}
