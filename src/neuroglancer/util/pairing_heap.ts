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

export interface ComparisonFunction<T> { (a: T, b: T): boolean; }

export interface PairingHeapOperationsConstructor<T> {
  new(compare: ComparisonFunction<T>): PairingHeapOperations<T>;
}

export interface PairingHeapOperations<T> {
  meld: (a: T|null, b: T|null) => T | null;
  compare: ComparisonFunction<T>;
  removeMin: (root: T) => T | null;
  remove: (root: T, node: T) => T | null;
  entries: (root: T|null) => Iterator<T>;
  removedEntries: (root: T|null) => Iterator<T>;
}
