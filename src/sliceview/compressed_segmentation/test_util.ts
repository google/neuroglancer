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

import type { TypedArray } from "#src/util/array.js";

export function makeRandomArrayByChoosingWithReplacement<
  TArray extends TypedArray<ArrayBuffer>,
>(
  cls: { new (count: number): TArray },
  length: number,
  numPossibleValues: number,
) {
  const possibleValues = new cls(numPossibleValues);
  crypto.getRandomValues(possibleValues);
  const data = new cls(length);
  for (let i = 0; i < length; ++i) {
    const index = Math.floor(Math.random() * numPossibleValues);
    data[i] = possibleValues[index];
  }
  return data;
}
