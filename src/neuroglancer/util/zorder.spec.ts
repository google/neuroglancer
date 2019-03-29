/**
 * @license
 * Copyright 2019 Google Inc.
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

import {Uint64} from 'neuroglancer/util/uint64';
import {decodeZIndexCompressed, zorder3LessThan} from 'neuroglancer/util/zorder';

describe('decodeZIndexCompressed', () => {
  it('works for repetitive pattern 21,21,21', () => {
    expect(decodeZIndexCompressed(
               Uint64.parseString('111000100010001111000100010001111000100010001', 2), 21, 21, 21))
        .toEqual(Uint32Array.of(0b100011000110001, 0b100101001010010, 0b101001010010100));
  });

  it('works for repetitive pattern 18,15,17', () => {
    expect(decodeZIndexCompressed(
               Uint64.parseString('11101111000100010001111000100010001111000100010001', 2), 18, 15,
               17))
        .toEqual(Uint32Array.of(0b111100011000110001, 0b100101001010010, 0b10101001010010100));
  });
});

describe('zorderLessThan', () => {
  it('works for simple examples', () => {
    expect(zorder3LessThan(0, 0, 0, 0, 0, 0)).toBe(false);
    expect(zorder3LessThan(0, 0, 0, 0, 0, 1)).toBe(true);
    expect(zorder3LessThan(0, 0, 0, 0, 1, 0)).toBe(true);
    expect(zorder3LessThan(0, 0, 0, 1, 0, 0)).toBe(true);
    expect(zorder3LessThan(0, 0, 1, 0, 0, 0)).toBe(false);
    expect(zorder3LessThan(0, 1, 0, 0, 0, 0)).toBe(false);
    expect(zorder3LessThan(1, 0, 0, 0, 0, 0)).toBe(false);

    expect(zorder3LessThan(1, 0, 0, 0, 1, 0)).toBe(true);
    expect(zorder3LessThan(0, 1, 0, 0, 0, 1)).toBe(true);
    expect(zorder3LessThan(0, 1, 0, 1, 1, 0)).toBe(true);
    expect(zorder3LessThan(0, 1, 0, 0, 0, 1)).toBe(true);
    expect(zorder3LessThan(1, 1, 0, 2, 0, 0)).toBe(true);
  });
});
