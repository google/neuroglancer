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
 * This is a very simple string hash function.  It isn't secure, but
 * is suitable for sharding of requests.
 */
export function simpleStringHash(s: string): number {
  let h = 0;
  let length = s.length;
  for (let i = 0; i < length; ++i) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}
