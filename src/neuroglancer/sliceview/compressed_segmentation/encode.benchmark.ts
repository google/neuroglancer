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

import {encodeChannels as encodeChannelsUint32} from 'neuroglancer/sliceview/compressed_segmentation/encode_uint32';
import {encodeChannels as encodeChannelsUint64} from 'neuroglancer/sliceview/compressed_segmentation/encode_uint64';
import {makeRandomUint64Array} from 'neuroglancer/sliceview/compressed_segmentation/test_util';
import {prod4, vec3Key} from 'neuroglancer/util/geom';
import {Uint32ArrayBuilder} from 'neuroglancer/util/uint32array_builder';

const exampleChunkData64 = new Uint32Array(
    require<Uint8Array>('neuroglancer-testdata/64x64x64-raw-uint64-segmentation.dat').buffer);

const exampleChunkData32 = exampleChunkData64.filter((_element, index) => {
  return index % 2 === 0;
});

suite('64x64x64 example', () => {
  const blockSize = [8, 8, 8];
  const output = new Uint32ArrayBuilder(1000000);
  const volumeSize = [64, 64, 64, 1];
  benchmark(`encode_uint64`, () => {
    output.clear();
    encodeChannelsUint64(output, blockSize, exampleChunkData64, volumeSize);
  });
  benchmark(`encode_uint32`, () => {
    output.clear();
    encodeChannelsUint32(output, blockSize, exampleChunkData32, volumeSize);
  });
});



suite('compressed_segmentation', () => {
  const blockSize = [8, 8, 8];
  const output = new Uint32ArrayBuilder(1000000);
  for (let volumeSize of [   //
           [16, 16, 16, 1],  //
                             // [64, 64, 64, 1],  //
  ]) {
    const numPossibleValues = 15;
    const input = makeRandomUint64Array(prod4(volumeSize), numPossibleValues);
    benchmark(`encode_uint64 ${vec3Key(volumeSize)}`, () => {
      output.clear();
      encodeChannelsUint64(output, blockSize, input, volumeSize);
    });
  }
});
