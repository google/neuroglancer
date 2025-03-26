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

import {
  encodeCompressedSegmentationUint32,
  encodeCompressedSegmentationUint64,
} from "#src/async_computation/encode_compressed_segmentation_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import { DataType } from "#src/sliceview/base.js";
import type { VolumeChunk } from "#src/sliceview/volume/backend.js";

export async function postProcessRawData(
  chunk: VolumeChunk,
  signal: AbortSignal,
  data: ArrayBufferView<ArrayBuffer>,
) {
  const { spec } = chunk.source!;
  if (spec.compressedSegmentationBlockSize !== undefined) {
    const { dataType } = spec;
    const chunkDataSize = chunk.chunkDataSize!;
    const shape = [
      chunkDataSize[0],
      chunkDataSize[1],
      chunkDataSize[2],
      chunkDataSize[3] || 1,
    ];
    switch (dataType) {
      case DataType.UINT32:
        chunk.data = await requestAsyncComputation(
          encodeCompressedSegmentationUint32,
          signal,
          [data.buffer],
          data as Uint32Array<ArrayBuffer>,
          shape,
          spec.compressedSegmentationBlockSize,
        );
        break;
      case DataType.UINT64:
        chunk.data = await requestAsyncComputation(
          encodeCompressedSegmentationUint64,
          signal,
          [data.buffer],
          data as Uint32Array<ArrayBuffer>,
          shape,
          spec.compressedSegmentationBlockSize,
        );
        break;
      default:
        throw new Error(
          `Unsupported data type for compressed segmentation: ${DataType[dataType]}`,
        );
    }
  } else {
    chunk.data = data;
  }
}
