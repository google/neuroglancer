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

/**
 * Converts raw data volumes to the appropriate format required by the frontend.
 */

import {encodeCompressedSegmentationUint32, encodeCompressedSegmentationUint64} from 'neuroglancer/async_computation/encode_compressed_segmentation_request';
import {requestAsyncComputation} from 'neuroglancer/async_computation/request';
import {DataType} from 'neuroglancer/sliceview/base';
import {VolumeChunk} from 'neuroglancer/sliceview/volume/backend';
import {CancellationToken} from 'neuroglancer/util/cancellation';

export async function postProcessRawData(
    chunk: VolumeChunk, cancellationToken: CancellationToken, data: ArrayBufferView) {
  cancellationToken;
  const {spec} = chunk.source!;
  if (spec.compressedSegmentationBlockSize !== undefined) {
    const {dataType} = spec;
    const chunkDataSize = chunk.chunkDataSize!;
    const shape = [chunkDataSize[0], chunkDataSize[1], chunkDataSize[2], chunkDataSize[3] || 1];
    switch (dataType) {
      case DataType.UINT32:
        chunk.data = await requestAsyncComputation(
            encodeCompressedSegmentationUint32, cancellationToken, [data.buffer],
            data as Uint32Array, shape, spec.compressedSegmentationBlockSize);
        break;
      case DataType.UINT64:
        chunk.data = await requestAsyncComputation(
            encodeCompressedSegmentationUint64, cancellationToken, [data.buffer],
            data as Uint32Array, shape, spec.compressedSegmentationBlockSize);
        break;
      default:
        throw new Error(`Unsupported data type for compressed segmentation: ${DataType[dataType]}`);
    }
  } else {
    chunk.data = data;
  }
}
