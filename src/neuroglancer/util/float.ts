/**
 * @license
 * Copyright 2021 Google Inc.
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

import {Endianness, ENDIANNESS} from 'neuroglancer/util/endian';

const denormMin = 2 ** (-1074);

const float64Buf = new Float64Array(1);
const uint32Buf = new Uint32Array(float64Buf.buffer);

// The following implementation is derived from:
// https://github.com/scijs/nextafter/
//
// and is subject to the following license:
//
// The MIT License (MIT)
//
// Copyright (c) 2013 Mikola Lysenko
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

// Like the C standard library `nextafter` function, returns the next representable JavaScript
// number (float64) after `x` in the direction of `y`.  Returns `y` if `x === y`.
export function nextAfterFloat64(x: number, y: number) {
  if (isNaN(x) || isNaN(y)) return NaN;
  if (x === y) return y;
  if (x === 0) {
    return y < 0 ? -denormMin : denormMin;
  }
  float64Buf[0] = x;
  const lowIndex = ENDIANNESS === Endianness.LITTLE ? 0 : 1;
  const highIndex = 1 - lowIndex;
  if ((y > x) === (x > 0)) {
    if (uint32Buf[lowIndex] === 0xffffffff) {
      uint32Buf[lowIndex] = 0;
      uint32Buf[highIndex] += 1;
    } else {
      uint32Buf[lowIndex] += 1;
    }
  } else {
    if (uint32Buf[lowIndex] === 0) {
      uint32Buf[lowIndex] = 0xffffffff;
      uint32Buf[highIndex] -= 1;
    } else {
      uint32Buf[lowIndex] -= 1;
    }
  }
  return float64Buf[0];
}
