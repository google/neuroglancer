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

/**
 * Returns the longest common prefix of a sequence of strings.
 *
 * Returns '' if the sequence of strings is empty.
 */
export function longestCommonPrefix(strings: Iterable<string>) {
  let it = strings[Symbol.iterator]();
  let {value: firstValue, done: noValues} = it.next();
  if (noValues) {
    // The sequence of strings is empty.
    return '';
  }
  let commonPrefixLength = firstValue.length;
  while (commonPrefixLength > 0) {
    let {value, done} = it.next();
    if (done) {
      break;
    }
    let i = 0;
    for (; i < commonPrefixLength; ++i) {
      if (firstValue.charCodeAt(i) !== value.charCodeAt(i)) {
        break;
      }
    }
    commonPrefixLength = i;
  }
  return firstValue.substring(0, commonPrefixLength);
}
