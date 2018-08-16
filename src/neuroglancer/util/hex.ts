/**
 * @license
 * Copyright 2017 Google Inc.
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

export function hexEncodeByte(x: number) {
  return ('0' + x.toString(16)).slice(-2);
}

export function hexEncode(arr: Uint8Array) {
  return Array.prototype.map.call(arr, hexEncodeByte).join('');
}

export function hexDecode(x: string) {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(x)) {
    throw new Error('Invalid hex-encoded string');
  }
  const length = x.length / 2;
  const result = new Uint8Array(length);
  for (let i = 0; i < length; ++i) {
    result[i] = parseInt(x.substr(i * 2, 2), 16);
  }
  return result;
}
