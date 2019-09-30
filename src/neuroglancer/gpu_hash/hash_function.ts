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

const k1 = 0xcc9e2d51;
const k2 = 0x1b873593;

// MurmurHash excluding the final mixing steps.
export function hashCombine(state: number, value: number) {
  value >>>= 0;
  state >>>= 0;

  value = Math.imul(value, k1) >>> 0;
  value = ((value << 15) | (value >>> 17)) >>> 0;
  value = Math.imul(value, k2) >>> 0;
  state = (state ^ value) >>> 0;
  state = ((state << 13) | (state >>> 19)) >>> 0;
  state = ((state * 5) + 0xe6546b64) >>> 0;
  return state;
}
