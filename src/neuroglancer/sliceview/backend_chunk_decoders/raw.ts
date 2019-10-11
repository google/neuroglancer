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

import {postProcessRawData} from 'neuroglancer/sliceview/backend_chunk_decoders/postprocess';
import {VolumeChunk} from 'neuroglancer/sliceview/volume/backend';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {DATA_TYPE_BYTES, DataType} from 'neuroglancer/util/data_type';
import {convertEndian16, convertEndian32, Endianness, ENDIANNESS} from 'neuroglancer/util/endian';
import * as vector from 'neuroglancer/util/vector';

export async function decodeRawChunk(
    chunk: VolumeChunk, cancellationToken: CancellationToken, response: ArrayBuffer,
    endianness: Endianness = ENDIANNESS, byteOffset: number = 0,
    byteLength: number = response.byteLength) {
  cancellationToken;
  let {spec} = chunk.source!;
  let {dataType} = spec;
  let numElements = vector.prod(chunk.chunkDataSize!);
  let bytesPerElement = DATA_TYPE_BYTES[dataType];
  let expectedBytes = numElements * bytesPerElement;
  if (expectedBytes !== byteLength) {
    throw new Error(
        `Raw-format chunk is ${byteLength} bytes, ` +
        `but ${numElements} * ${bytesPerElement} = ${expectedBytes} bytes are expected.`);
  }
  let data: ArrayBufferView;
  switch (dataType) {
    case DataType.UINT8:
      data = new Uint8Array(response, byteOffset, byteLength);
      break;
    case DataType.UINT16:
      data = new Uint16Array(response, byteOffset, byteLength / 2);
      convertEndian16(data, endianness);
      break;
    case DataType.UINT32:
    case DataType.UINT64:
      data = new Uint32Array(response, byteOffset, byteLength / 4);
      convertEndian32(data, endianness);
      break;
    case DataType.FLOAT32:
      data = new Float32Array(response, byteOffset, byteLength / 4);
      convertEndian32(data, endianness);
      break;
    default:
      throw new Error(`Unexpected data type: ${dataType}.`);
  }
  await postProcessRawData(chunk, cancellationToken, data);
}
