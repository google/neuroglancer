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

import {Uint64} from 'neuroglancer/util/uint64';

describe('uint64', () => {
  it('less', () => {
    expect(Uint64.less(new Uint64(0, 0), new Uint64(0, 1))).toBe(true);
    expect(Uint64.less(new Uint64(1, 1), new Uint64(1, 0))).toBe(false);
    expect(Uint64.less(new Uint64(1, 1), new Uint64(1, 1))).toBe(false);
    expect(Uint64.less(new Uint64(0, 1), new Uint64(1, 0))).toBe(false);
    expect(Uint64.less(new Uint64(1, 0), new Uint64(0, 1))).toBe(true);
  });

  it('conversion to string', () => {
    expect(new Uint64(0, 0).toString()).toEqual('0');
    expect(new Uint64(1, 0).toString()).toEqual('1');
    expect(new Uint64(0, 1).toString()).toEqual('4294967296');
    expect(new Uint64(0, 1).toString(3)).toEqual('102002022201221111211');
    expect(new Uint64(0, 1).toString(2)).toEqual('100000000000000000000000000000000');
    expect(new Uint64(0, 1).toString(36)).toEqual('1z141z4');
    expect(new Uint64(4294967295, 4294967295).toString()).toEqual('18446744073709551615');
    expect(new Uint64(4294967295, 4294967295).toString(36)).toEqual('3w5e11264sgsf');
  });

  it('conversion from string', () => {
    expect(new Uint64(0, 0).tryParseString('0')).toBe(true);
    expect(new Uint64(1, 0).tryParseString('1')).toBe(true);
    expect(new Uint64(0, 1).tryParseString('4294967296')).toBe(true);
    expect(new Uint64(0, 1).tryParseString('102002022201221111211', 3)).toBe(true);
    expect(new Uint64(0, 1).tryParseString('100000000000000000000000000000000', 2)).toBe(true);
    expect(new Uint64(0, 1).tryParseString('1z141z4', 36)).toBe(true);
    expect(new Uint64(4294967295, 4294967295).tryParseString('18446744073709551615')).toBe(true);
    expect(new Uint64(4294967295, 4294967295).tryParseString('3w5e11264sgsf', 36)).toBe(true);
  });

  it('equal', () => {
    let a = new Uint64(1, 2);
    let b = new Uint64(1, 2);
    expect(Uint64.equal(a, b)).toBe(true);
    expect(Uint64.equal(a, new Uint64(1, 3))).toBe(false);
    expect(Uint64.equal(a, new Uint64(2, 1))).toBe(false);
  });

  it('parseString failures', () => {
    let temp = new Uint64(1, 2);
    expect(temp.tryParseString(' ')).toBe(false);
    expect(temp.tryParseString(' 0')).toBe(false);
    expect(temp.tryParseString('0 ')).toBe(false);
    expect(temp.tryParseString('z')).toBe(false);
    expect(temp.tryParseString('2', 2)).toBe(false);
    expect(temp.tryParseString('18446744073709551616')).toBe(false);
    expect(temp.tryParseString('1')).toBe(true);
  });

  it('parseString toString round trip', () => {
    function check(s: string, base: number) {
      let x = Uint64.parseString(s, base);
      expect(x.valid()).toBe(
          true, `low=${x.low}, high=${x.high}, toString(${base}) = ${x.toString(base)}, s=${s}`);
      expect(x.toString(base)).toEqual(s);
    }
    check('0', 10);
    check('1', 10);
    check('11', 10);
    check('18446744073709551615', 10);
    check('3w5e11264sgsf', 36);
  });

  it('toString parseString round trip', () => {
    function check(x: Uint64, base: number) {
      let s = x.toString(base);
      let y = Uint64.parseString(s, base);
      expect(y.low).toBe(x.low, `s=${s}, x.low=${x.low}, x.high=${x.high}, y.low=${y.low}, y.high=${y.high}, base=${base}`);
      expect(y.high).toBe(x.high, `s=${s}, x.low=${x.low}, x.high=${x.high}, y.low=${y.low}, y.high=${y.high}, base=${base}`);
    }
    const count = 100;
    {
      const u = new Uint64(264762631, 2836123747);
      expect(u.toString(13)).toEqual('153c9125c642b111b8');
      check(u, 13);
    }

    for (let base = 2; base <= 36; ++base) {
      for (let i = 0; i < count; ++i) {
        check(Uint64.random(), base);
      }
    }
  });
});
