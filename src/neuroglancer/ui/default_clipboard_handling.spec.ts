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

import {parsePositionString} from './default_clipboard_handling';
import {vec3} from '../util/geom';

describe('default_clipboard_handling', () => {
  describe('parsePositionString', () => {
    it('fails on invalid cases', () => {
      expect(parsePositionString('invalid')).toBe(undefined);
      expect(parsePositionString('1 2')).toBe(undefined);
      expect(parsePositionString('1 a 2')).toBe(undefined);
    });

    it('works on basic cases', () => {
      expect(parsePositionString('10 2 3')).toEqual(vec3.fromValues(10, 2, 3));
      expect(parsePositionString('[1 2 3')).toEqual(vec3.fromValues(1, 2, 3));
      expect(parsePositionString('[1, 2, 3,')).toEqual(vec3.fromValues(1, 2, 3));
      expect(parsePositionString('[1, 2, 3]')).toEqual(vec3.fromValues(1, 2, 3));
      expect(parsePositionString('1.2 2.4 3')).toEqual(vec3.fromValues(1.2, 2.4, 3));
      expect(parsePositionString('{200, 400, 500}')).toEqual(vec3.fromValues(200, 400, 500));
    });
  });
});
