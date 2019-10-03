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
 * Converts `x` into its nearest single precision float representation and
 * returns a minimal string representation, with as many digits as necessary
 * to uniquely distinguish single precision `x` from its adjacent single
 * precision values.
 *
 * E.g.: 0.299999999000000017179701217174d → 0.30000001192092896f → '0.3')
 */
export function float32ToString(x: number) {
  tempArray[0] = x;
  x = tempArray[0];
  for (let digits = 1; digits < 21; ++digits) {
    let result = x.toPrecision(digits);
    tempArray[0] = parseFloat(result);
    if (tempArray[0] === x) {
      return result;
    }
  }
  return x.toString();
}
