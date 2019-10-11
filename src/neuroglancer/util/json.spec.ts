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

import {normalizeStringLiteral, pythonLiteralParse, pythonLiteralToJSON, urlSafeParse, urlSafeStringify, urlSafeStringifyString, urlSafeToJSON} from 'neuroglancer/util/json';

describe('url safe json', () => {
  it('urlSafeStringifyString', () => {
    expect(urlSafeStringifyString('a')).toBe(`'a'`);
    expect(urlSafeStringifyString('a"')).toBe(`'a"'`);
    expect(urlSafeStringifyString(`a'`)).toBe(`'a\\''`);
  });

  it('urlSafeStringify', () => {
    expect(urlSafeStringify(true)).toBe('true');
    expect(urlSafeStringify(false)).toBe('false');
    expect(urlSafeStringify(null)).toBe('null');
    expect(urlSafeStringify(['a', 'b'])).toBe(`['a'_'b']`);
    expect(urlSafeStringify({'a': 'b', 'b': 'c'})).toBe(`{'a':'b'_'b':'c'}`);
  });

  it('urlSafeToJSON', () => {
    expect(urlSafeToJSON(`{'a':'b'_'b':'c'}`)).toEqual(`{"a":"b","b":"c"}`);
    expect(urlSafeToJSON(`['a'_true]`)).toEqual(`["a",true]`);
    expect(urlSafeToJSON(`['a',true]`)).toEqual(`["a",true]`);
    expect(urlSafeToJSON(`["a","a'"]`)).toEqual(`["a","a'"]`);
    expect(urlSafeToJSON(`["a","a'","a'"]`)).toEqual(`["a","a'","a'"]`);
  });

  it('urlSafeStringToJSONString', () => {
    expect(normalizeStringLiteral(`'abc'`)).toBe(`"abc"`);
    expect(normalizeStringLiteral(`'abc"'`)).toBe(`"abc\\""`);
    expect(normalizeStringLiteral(`'abc\\"'`)).toBe(`"abc\\""`);
  });

  it('urlSafeParse', () => {
    expect(urlSafeParse(`{'a':'b'_'b':'c'}`)).toEqual({'a': 'b', 'b': 'c'});
    expect(urlSafeParse(`['a'_true]`)).toEqual(['a', true]);
    expect(urlSafeParse(`['a',true]`)).toEqual(['a', true]);
    expect(urlSafeParse(`["a\\"",true]`)).toEqual(['a"', true]);
  });

  it('urlSafeRoundtrip', () => {
    function testRoundTrip(x: any) {
      expect(urlSafeParse(urlSafeStringify(x))).toEqual(x);
    }
    testRoundTrip(1);
    testRoundTrip('hello');
    testRoundTrip({'key': '\''});
    testRoundTrip({'key': '\'"Hello"'});
  });

  it('pythonLiteralToJSON', () => {
    expect(pythonLiteralToJSON(`{'a':'b', 'c':True, 'd':(1,2,3,), }`))
        .toBe(`{"a":"b", "c":true, "d":[1,2,3]}`);
  });

  it('pythonLiteralParse', () => {
    expect(pythonLiteralParse(`{'a':'b', 'c':True, 'd':(1,2,3,), }`))
        .toEqual({'a': 'b', 'c': true, 'd': [1, 2, 3]});
  });
});
