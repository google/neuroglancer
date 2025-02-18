/**
 * @license
 * Copyright 2025 Google Inc.
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

export const EMPTY_KEY = new Uint8Array(0);

export type Key = Uint8Array<ArrayBuffer>;

export function compareArraysLexicographically(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
) {
  const minLength = Math.min(a.length, b.length);
  for (let i = 0; i < minLength; ++i) {
    const d = a[i] - b[i];
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

export function findFirstMismatch(a: ArrayLike<number>, b: ArrayLike<number>) {
  const minLength = Math.min(a.length, b.length);
  for (let i = 0; i < minLength; ++i) {
    const d = a[i] - b[i];
    if (d !== 0) return { offset: i, difference: d };
  }
  return { offset: minLength, difference: a.length - b.length };
}

export interface KeyRange {
  inclusiveMin: Key;
  exclusiveMax: Key;
}

const EMPTY_KEY_RANGE: KeyRange = {
  inclusiveMin: EMPTY_KEY,
  exclusiveMax: Uint8Array.of(0),
};

export function removeKeyRangePrefix(
  keyRange: KeyRange,
  prefix: Key,
): KeyRange {
  if (prefix.length === 0) return keyRange;
  let { inclusiveMin, exclusiveMax } = keyRange;
  {
    const { offset, difference } = findFirstMismatch(prefix, inclusiveMin);
    if (difference >= 0) {
      inclusiveMin = EMPTY_KEY;
    } else if (offset < prefix.length) {
      return EMPTY_KEY_RANGE;
    } else {
      inclusiveMin = inclusiveMin.subarray(prefix.length);
    }
  }
  if (exclusiveMax.length !== 0) {
    const { offset, difference } = findFirstMismatch(prefix, exclusiveMax);
    if (difference >= 0) {
      return EMPTY_KEY_RANGE;
    }
    if (offset < prefix.length) {
      exclusiveMax = EMPTY_KEY;
    } else {
      exclusiveMax = exclusiveMax.subarray(prefix.length);
    }
  }
  return { inclusiveMin, exclusiveMax };
}

export function concatKeys(...keys: Key[]): Key {
  let length = 0;
  for (const key of keys) {
    length += key.length;
  }
  const newKey = new Uint8Array(length);
  let offset = 0;
  for (const key of keys) {
    newKey.set(key, offset);
    offset += key.length;
  }
  return newKey;
}

export function keyStartsWith(key: Key, prefix: Key): boolean {
  return (
    key.length >= prefix.length &&
    findFirstMismatch(key, prefix).offset === prefix.length
  );
}
