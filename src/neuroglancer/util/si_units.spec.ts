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

import { parseScale, scaleByExp10, formatScaleWithUnit} from 'neuroglancer/util/si_units';

describe('parseScale', () => {
  const patterns: [string, {scale: number, unit: string}|undefined][] = [
    ['0', undefined],
    ['0nm', undefined],
    ['1x', undefined],
    ['', {scale: 1, unit: ''}],
    ['nm', {scale: 1e-9, unit: 'm'}],
    ['ns', {scale: 1e-9, unit: 's'}],
    ['us', {scale: 1e-6, unit: 's'}],
    ['µs', {scale: 1e-6, unit: 's'}],
    ['2µs', {scale: 2e-6, unit: 's'}],
    ['1.2e3m', {scale: 1.2e3, unit: 'm'}],
  ];
  for (const [s, result] of patterns) {
    it(`works for ${JSON.stringify(s)}`, () => {
      expect(parseScale(s)).toEqual(result);
    });
  }
});

describe('scaleByExp10', () => {
  it('works for simple cases', () => {
    expect(scaleByExp10(3, 2)).toEqual(3e2);
    expect(scaleByExp10(3, -9)).toEqual(3e-9);
    expect(scaleByExp10(50, -9)).toEqual(50e-9);
  });
});

describe('formatScaleWithUnit', () => {
  it('works for simple cases', () => {
    const examples:
        [{scale: number, unit: string}, {scale: string, prefix: string, unit: string}][] = [
          [{scale: 1, unit: ''}, {scale: '', prefix: '', unit: ''}],
          [{scale: 4e-9, unit: 'm'}, {scale: '4', prefix: 'n', unit: 'm'}],
          [{scale: 1e-9, unit: 'm'}, {scale: '', prefix: 'n', unit: 'm'}],
          [{scale: 1e-9, unit: ''}, {scale: '1e-9', prefix: '', unit: ''}],
        ];
    for (const [{scale, unit}, result] of examples) {
      expect(formatScaleWithUnit(scale, unit)).toEqual(result);
    }
  });
});
