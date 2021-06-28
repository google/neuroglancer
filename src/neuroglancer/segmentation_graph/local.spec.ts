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

import {Uint64} from 'neuroglancer/util/uint64';
import {LocalSegmentationGraphSource} from 'neuroglancer/segmentation_graph/local';

beforeEach(() => {
  jasmine.addCustomEqualityTester((a, b) => {
    if (a instanceof Uint64 && b instanceof Uint64) {
      return Uint64.equal(a, b);
    }
    return undefined;
  });
});

const u64 = (x: string|number) => Uint64.parseString(x.toString());

describe('LocalSegmentationGraphSource', () => {
  it('merge', async () => {
    const graph = new LocalSegmentationGraphSource();
    {
      let mergeResult = await graph.merge(u64(1), u64(2));
      expect(mergeResult).toEqual(u64(1));
      expect(graph.toJSON()).toEqual([['1', '2']]);
    }
    {
      let mergeResult = await graph.merge(u64(2), u64(3));
      expect(mergeResult).toEqual(u64(1));
      expect(graph.toJSON()).toEqual([['1', '2'], ['2', '3']]);
    }
    {
      let mergeResult = await graph.merge(u64(1), u64(3));
      expect(mergeResult).toEqual(u64(1));
      expect(graph.toJSON()).toEqual([['1', '2'], ['2', '3']]);
    }
  });
  it('split', async () => {
    const graph = new LocalSegmentationGraphSource();
    graph.restoreState([['1', '2'], ['2', '3']]);
    {
      expect(await graph.computeSplit(u64(1), u64(3))).toEqual({
        includeBaseSegments: [u64(1), u64(2)],
        includeRepresentative: u64(1),
        excludeBaseSegments: [u64(3)],
        excludeRepresentative: u64(3)
      });
    }
    {
      expect(await graph.split(u64(1), u64(3))).toEqual({include: u64(1), exclude: u64(3)});
      expect(graph.toJSON()).toEqual([['1', '2']]);
    }
  });
  it('split2', async () => {
    const graph = new LocalSegmentationGraphSource();
    graph.restoreState([['1', '2'], ['2', '3'], ['3', '4'], ['3', '5']]);
    {
      expect(await graph.split(u64(1), u64(3))).toEqual({include: u64(1), exclude: u64(3)});
      expect(graph.toJSON()).toEqual([['1', '2'], ['3', '4'], ['3', '5']]);
    }
  });
});
