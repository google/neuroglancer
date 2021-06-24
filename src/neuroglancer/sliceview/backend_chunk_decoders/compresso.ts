/**
 * @license
 * Copyright 2021 William Silvermsith.
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

import {vec3} from 'neuroglancer/util/geom';
import {TypedArray} from 'neuroglancer/util/array';
import {DataType} from 'neuroglancer/sliceview/base';
import {postProcessRawData} from 'neuroglancer/sliceview/backend_chunk_decoders/postprocess';
import {VolumeChunk} from 'neuroglancer/sliceview/volume/backend';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {decodeCompresso} from 'neuroglancer/async_computation/decode_compresso_request';
import {requestAsyncComputation} from 'neuroglancer/async_computation/request';

export async function decodeCompressoChunk(
    chunk: VolumeChunk, cancellationToken: CancellationToken, response: ArrayBuffer) {
  
  let image : TypedArray = await requestAsyncComputation(
    decodeCompresso, cancellationToken, [response], new Uint8Array(response)
  );

  const dtype = chunk.source!.spec.dataType || DataType.UINT8;

  const spec = chunk.source!.spec;
  const defaultBlockSize = vec3.fromValues(8, 8, 8);

  // uint8 is already set correctly
  if (dtype === DataType.UINT16) {
    image = new Uint16Array(image.buffer);
  }
  else if (dtype === DataType.UINT32) {
    image = new Uint32Array(image.buffer);
    spec.compressedSegmentationBlockSize = spec.compressedSegmentationBlockSize || defaultBlockSize;
  }
  else if (dtype === DataType.UINT64) {
    image = new Uint32Array(image.buffer);
    spec.compressedSegmentationBlockSize = spec.compressedSegmentationBlockSize || defaultBlockSize;
  }

  await postProcessRawData(chunk, cancellationToken, image);
}
