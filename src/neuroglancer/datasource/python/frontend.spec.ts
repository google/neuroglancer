/**
 * @license
 * Copyright 2020 Google Inc.
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

import {computeNearIsotropicDownsamplingLevels} from 'neuroglancer/datasource/python/frontend';

describe('computeNearIsotropicDownsamplingLevels', () => {
  it('works for simple examples', () => {
    const shape = Float32Array.of(512,512,512);
    const downsampleDims = [0, 1, 2];
    const effectiveVoxelSize = Float32Array.of(1, 1, 1);
    const maxDownsampling= 64;
    const maxDownsamplingScales = Number.POSITIVE_INFINITY;
    const maxDownsampledSize = 128;
    expect(computeNearIsotropicDownsamplingLevels(
               shape, downsampleDims, effectiveVoxelSize, maxDownsampling, maxDownsamplingScales,
               maxDownsampledSize))
        .toEqual([
          Float32Array.of(1, 1, 1),
          Float32Array.of(2, 2, 2),
          Float32Array.of(4, 4, 4),
        ]);

  });
});
