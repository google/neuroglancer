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

import {numberToStringFixed} from 'neuroglancer/util/number_to_string';

describe('numberToStringFixed', () => {
  it('works for simple cases', () => {
    expect(numberToStringFixed(5, 2)).toEqual('5');
    expect(numberToStringFixed(5.5, 2)).toEqual('5.5');
    expect(numberToStringFixed(5.3, 2)).toEqual('5.3');
    expect(numberToStringFixed(5.25, 2)).toEqual('5.25');
    expect(numberToStringFixed(5.333, 2)).toEqual('5.33');
  });
});
