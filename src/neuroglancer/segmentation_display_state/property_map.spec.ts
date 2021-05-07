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

import {mergeSegmentPropertyMaps, PreprocessedSegmentPropertyMap, SegmentPropertyMap} from 'neuroglancer/segmentation_display_state/property_map';
import { Uint64 } from 'neuroglancer/util/uint64';

describe('PreprocessedSegmentPropertyMap', () => {
  it('handles lookups correctly', () => {
    const map = new PreprocessedSegmentPropertyMap(
        {inlineProperties: {ids: Uint32Array.of(5, 0, 15, 0, 20, 5), properties: []}});
    expect(map.getSegmentInlineIndex(new Uint64(5, 0))).toEqual(0);
    expect(map.getSegmentInlineIndex(new Uint64(15, 0))).toEqual(1);
    expect(map.getSegmentInlineIndex(new Uint64(20, 5))).toEqual(2);
    expect(map.getSegmentInlineIndex(new Uint64(30, 5))).toEqual(-1);
    expect(map.getSegmentInlineIndex(new Uint64(0, 0))).toEqual(-1);
  });
});

describe('mergeSegmentPropertyMaps', () => {
  it('works correctly for 2 maps', () => {
    const a = new SegmentPropertyMap({
      inlineProperties: {
        ids: Uint32Array.of(5, 0, 6, 0, 8, 0),
        properties: [{type: 'string', id: 'prop1', values: ['x', 'y', 'z']}]
      }
    });
    const b = new SegmentPropertyMap({
      inlineProperties: {
        ids: Uint32Array.of(5, 0, 7, 0),
        properties: [{type: 'string', id: 'prop2', values: ['a', 'b']}]
      }
    });
    expect(mergeSegmentPropertyMaps([])).toBe(undefined);
    expect(mergeSegmentPropertyMaps([a])).toBe(a);
    expect(mergeSegmentPropertyMaps([b])).toBe(b);
    const c = mergeSegmentPropertyMaps([a, b]);
    expect(c?.inlineProperties).toEqual({
      ids: Uint32Array.of(5, 0, 6, 0, 7, 0, 8, 0),
      properties: [
        {type: 'string', id: 'prop1', values: ['x', 'y', '', 'z']},
        {type: 'string', id: 'prop2', values: ['a', '', 'b', '']}
      ],
    });
  });
});
