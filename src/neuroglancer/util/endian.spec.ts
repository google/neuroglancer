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

import {swapEndian16, swapEndian32} from 'neuroglancer/util/endian';

describe('endian', () => {
  it('swapEndian16', () => {
    let original = Uint16Array.of(0x1122, 0x3344);
    let swapped = Uint16Array.from(original);
    swapEndian16(swapped);
    expect(Array.from(swapped)).toEqual([0x2211, 0x4433]);
  });

  it('swapEndian32', () => {
    let original = Uint32Array.of(0x11223344, 0x55667788);
    let swapped = Uint32Array.from(original);
    swapEndian32(swapped);
    expect(Array.from(swapped)).toEqual([0x44332211, 0x88776655]);
  });
});
