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

import { postProcessRawData } from "#/sliceview/backend_chunk_decoders/postprocess";
import { VolumeChunk } from "#/sliceview/volume/backend";
import { CancellationToken } from "#/util/cancellation";
import { DATA_TYPE_BYTES, makeDataTypeArrayView } from "#/util/data_type";
import { convertEndian, Endianness, ENDIANNESS } from "#/util/endian";
import * as vector from "#/util/vector";

export async function decodeRawChunk(
  chunk: VolumeChunk,
  cancellationToken: CancellationToken,
  response: ArrayBuffer,
  endianness: Endianness = ENDIANNESS,
  byteOffset = 0,
  byteLength: number = response.byteLength,
) {
  cancellationToken;
  const { spec } = chunk.source!;
  const { dataType } = spec;
  const numElements = vector.prod(chunk.chunkDataSize!);
  const bytesPerElement = DATA_TYPE_BYTES[dataType];
  const expectedBytes = numElements * bytesPerElement;
  if (expectedBytes !== byteLength) {
    throw new Error(
      `Raw-format chunk is ${byteLength} bytes, ` +
        `but ${numElements} * ${bytesPerElement} = ${expectedBytes} bytes are expected.`,
    );
  }
  const data = makeDataTypeArrayView(
    dataType,
    response,
    byteOffset,
    byteLength,
  );
  convertEndian(data, endianness, bytesPerElement);
  await postProcessRawData(chunk, cancellationToken, data);
}
