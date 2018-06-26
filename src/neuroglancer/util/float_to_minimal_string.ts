/**
 * @license
 * Copyright 2018 Google Inc.
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


const tempArray = new Float32Array(1);

/**
 * Return a minimum-length string representation of `x` that round-trips.
 */
export function floatToMinimalString(x: number) {
  x = (tempArray[0] = x);
  for (let digits = 0; digits < 9; ++digits) {
    let result = x.toFixed(digits);
    tempArray[0] = parseFloat(result);
    if (tempArray[0] === x) {
      return result;
    }
  }
  return x.toString();
}
