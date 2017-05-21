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

import {getNearIsotropicBlockSize} from 'neuroglancer/sliceview/base';
import {vec3} from 'neuroglancer/util/geom';

describe('sliceview/base', () => {
  it('getNearIsotropicBlockSize', () => {
    expect(
        getNearIsotropicBlockSize({voxelSize: vec3.fromValues(1, 1, 1), maxVoxelsPerChunkLog2: 18}))
        .toEqual(vec3.fromValues(64, 64, 64));

    expect(
        getNearIsotropicBlockSize({voxelSize: vec3.fromValues(2, 1, 1), maxVoxelsPerChunkLog2: 17}))
        .toEqual(vec3.fromValues(32, 64, 64));

    expect(
        getNearIsotropicBlockSize({voxelSize: vec3.fromValues(3, 3, 30), maxVoxelsPerChunkLog2: 9}))
        .toEqual(vec3.fromValues(16, 16, 2));

    expect(getNearIsotropicBlockSize({
      voxelSize: vec3.fromValues(3, 3, 30),
      upperVoxelBound: vec3.fromValues(1, 128, 128),
      maxVoxelsPerChunkLog2: 8
    })).toEqual(vec3.fromValues(1, 64, 4));
  });
});
