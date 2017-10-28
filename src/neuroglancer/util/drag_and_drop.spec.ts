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

import {encodeParametersAsDragType, decodeParametersFromDragType} from 'neuroglancer/util/drag_and_drop';

describe('drag_and_drop', () => {
  const prefix = 'my-prefix\0';
  it('round trips simple json', () => {
    const json = {'a': 'Hello'};
    const result = decodeParametersFromDragType(encodeParametersAsDragType(prefix, json), prefix);
    expect(result).toEqual(json);
  });
});
