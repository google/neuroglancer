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

import {parseColorSerialization, parseRGBColorSpecification, serializeColor} from 'neuroglancer/util/color';
import {vec3, vec4} from 'neuroglancer/util/geom';

describe('color', () => {
  it('parseColorSerialization works', () => {
    expect(parseColorSerialization('#000000')).toEqual([0, 0, 0, 1]);
    expect(parseColorSerialization('#123456')).toEqual([0x12, 0x34, 0x56, 1]);
    expect(parseColorSerialization('rgba(101, 102, 103, 0.45)')).toEqual([101, 102, 103, 0.45]);
  });

  it('serializeColor works', () => {
    expect(serializeColor(vec3.fromValues(0x12 / 255, 0x34 / 255, 0x56 / 255))).toEqual('#123456');
    expect(serializeColor(vec4.fromValues(101 / 255, 102 / 255, 103 / 255, 0.45)))
        .toEqual('rgba(101, 102, 103, 0.45)');
  });

  it('parseRGBColorSpecification works', () => {
    expect(parseRGBColorSpecification('white')).toEqual(vec3.fromValues(1, 1, 1));
    expect(parseRGBColorSpecification('black')).toEqual(vec3.fromValues(0, 0, 0));
    expect(parseRGBColorSpecification('red')).toEqual(vec3.fromValues(1, 0, 0));
    expect(parseRGBColorSpecification('lime')).toEqual(vec3.fromValues(0, 1, 0));
    expect(parseRGBColorSpecification('blue')).toEqual(vec3.fromValues(0, 0, 1));
  });
});
