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
 * This decodes the BOSS (https://github.com/jhuapl-boss/) NPZ format, which is the Python
 * NPY binary format with zlib encoding.
 *
 * This is NOT the same as the Python NPZ format, which is a ZIP file containing multiple files
 * (each corresponding to a different variable) in NPY binary format.
 */

import {decodeGzip} from 'neuroglancer/async_computation/decode_gzip_request';
import {requestAsyncComputation} from 'neuroglancer/async_computation/request';
import {postProcessRawData} from 'neuroglancer/sliceview/backend_chunk_decoders/postprocess';
import {DataType} from 'neuroglancer/sliceview/base';
import {VolumeChunk} from 'neuroglancer/sliceview/volume/backend';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {vec3Key} from 'neuroglancer/util/geom';
import {parseNpy} from 'neuroglancer/util/npy';

export async function decodeBossNpzChunk(
    chunk: VolumeChunk, cancellationToken: CancellationToken, response: ArrayBuffer) {
  let parseResult = parseNpy(await requestAsyncComputation(
      decodeGzip, cancellationToken, [response], new Uint8Array(response)));
  let chunkDataSize = chunk.chunkDataSize!;
  let source = chunk.source!;
  let {shape} = parseResult;
  if (shape.length !== 3 || shape[0] !== chunkDataSize[2] || shape[1] !== chunkDataSize[1] ||
      shape[2] !== chunkDataSize[0]) {
    throw new Error(
        `Shape ${JSON.stringify(shape)} does not match chunkDataSize ${vec3Key(chunkDataSize)}`);
  }
  let parsedDataType = parseResult.dataType;
  let {spec} = source;
  if (parsedDataType !== spec.dataType) {
    throw new Error(`Data type ${DataType[parsedDataType]} does not match expected data type ${
        DataType[spec.dataType]}`);
  }
  await postProcessRawData(chunk, cancellationToken, parseResult.data);
}
