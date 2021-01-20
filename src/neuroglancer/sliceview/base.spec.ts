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

import {estimateSliceAreaPerChunk, getNearIsotropicBlockSize} from 'neuroglancer/sliceview/base';
import {ChunkLayout} from 'neuroglancer/sliceview/chunk_layout';
import {mat4, vec3} from 'neuroglancer/util/geom';

describe('sliceview/base', () => {
  it('getNearIsotropicBlockSize', () => {
    expect(getNearIsotropicBlockSize({
      rank: 3,
      displayRank: 3,
      chunkToViewTransform: Float32Array.of(
          1, 0, 0,  //
          0, 1, 0,  //
          0, 0, 1),
      maxVoxelsPerChunkLog2: 18,
    })).toEqual(Uint32Array.of(64, 64, 64));

    expect(getNearIsotropicBlockSize({
      rank: 3,
      displayRank: 3,
      chunkToViewTransform: Float32Array.of(
          2, 0, 0,  //
          0, 1, 0,  //
          0, 0, 1),
      maxVoxelsPerChunkLog2: 17,
    })).toEqual(Uint32Array.of(32, 64, 64));

    expect(getNearIsotropicBlockSize({
      rank: 3,
      displayRank: 3,
      chunkToViewTransform: Float32Array.of(
          3, 0, 0,  //
          0, 3, 0,  //
          0, 0, 30),
      maxVoxelsPerChunkLog2: 9,
    })).toEqual(Uint32Array.of(16, 16, 2));

    expect(getNearIsotropicBlockSize({
      rank: 4,
      displayRank: 3,
      chunkToViewTransform: Float32Array.of(
          3, 0, 0, 0,  //
          0, 3, 0, 0,  //
          0, 0, 30, 0),
      maxVoxelsPerChunkLog2: 9,
      minBlockSize: Uint32Array.of(1, 1, 1, 8),
    })).toEqual(Uint32Array.of(8, 8, 1, 8));


    expect(getNearIsotropicBlockSize({
      rank: 3,
      displayRank: 3,
      chunkToViewTransform: Float32Array.of(
          3, 0, 0,  //
          0, 3, 0,  //
          0, 0, 30),
      upperVoxelBound: vec3.fromValues(1, 128, 128),
      maxVoxelsPerChunkLog2: 8
    })).toEqual(Uint32Array.of(1, 64, 4));
  });
});

describe('estimateSliceAreaPerChunk', () => {
  it('works for identity chunk transform', () => {
    const chunkLayout = new ChunkLayout(vec3.fromValues(3, 4, 5), mat4.create(), 3);
    {
      const viewMatrix = Float32Array.from([
        1, 0, 0, 0,  //
        0, 1, 0, 0,  //
        0, 0, 1, 0,  //
        0, 0, 0, 1,  //
      ]) as mat4;
      expect(estimateSliceAreaPerChunk(chunkLayout, viewMatrix)).toEqual(3 * 4);
    }

    {
      const viewMatrix = Float32Array.from([
        0, 1, 0, 0,  //
        1, 0, 0, 0,  //
        0, 0, 1, 0,  //
        0, 0, 0, 1,  //
      ]) as mat4;
      expect(estimateSliceAreaPerChunk(chunkLayout, viewMatrix)).toEqual(3 * 4);
    }

    {
      const viewMatrix = Float32Array.from([
        1, 0, 0, 0,  //
        0, 0, 1, 0,  //
        0, 1, 0, 0,  //
        0, 0, 0, 1,  //
      ]) as mat4;
      expect(estimateSliceAreaPerChunk(chunkLayout, viewMatrix)).toEqual(3 * 5);
    }
  });
});
