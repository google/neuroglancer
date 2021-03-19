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

import {encodeCompressedSegmentationUint32, encodeCompressedSegmentationUint64} from 'neuroglancer/async_computation/encode_compressed_segmentation_request';
import {registerAsyncComputation} from 'neuroglancer/async_computation/handler';
import {encodeChannels as encodeChannelsUint32} from 'neuroglancer/sliceview/compressed_segmentation/encode_uint32';
import {encodeChannels as encodeChannelsUint64} from 'neuroglancer/sliceview/compressed_segmentation/encode_uint64';
import {Uint32ArrayBuilder} from 'neuroglancer/util/uint32array_builder';

const tempBuffer = new Uint32ArrayBuilder(20000);

registerAsyncComputation(
    encodeCompressedSegmentationUint32, async function(rawData, shape, blockSize) {
      tempBuffer.clear();
      encodeChannelsUint32(tempBuffer, blockSize, rawData, shape);
      return {value: tempBuffer.view};
    });

registerAsyncComputation(
    encodeCompressedSegmentationUint64, async function(rawData, shape, blockSize) {
      tempBuffer.clear();
      encodeChannelsUint64(tempBuffer, blockSize, rawData, shape);
      return {value: tempBuffer.view};
    });
