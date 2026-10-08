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

import { postProcessRawData } from "#src/sliceview/backend_chunk_decoders/postprocess.js";
import type { VolumeChunk } from "#src/sliceview/volume/backend.js";
import type { Endianness } from "#src/util/endian.js";
import { ENDIANNESS } from "#src/util/endian.js";
import type { SourceDataType } from "#src/util/source_data_type.js";
import {
  encodedByteLength,
  getNativeSourceDataType,
} from "#src/util/source_data_type.js";
import * as vector from "#src/util/vector.js";

export async function decodeRawChunk(
  chunk: VolumeChunk,
  signal: AbortSignal,
  response: ArrayBuffer,
  endianness: Endianness = ENDIANNESS,
  byteOffset = 0,
  byteLength: number = response.byteLength,
  sourceDataType?: SourceDataType,
) {
  signal;
  const { spec } = chunk.source!;
  const numElements = vector.prod(chunk.chunkDataSize!);
  sourceDataType ??= getNativeSourceDataType(spec.dataType);
  const expectedBytes = encodedByteLength(sourceDataType, numElements);
  if (expectedBytes !== byteLength) {
    throw new Error(
      `Raw-format chunk is ${byteLength} bytes, ` +
        `but ${expectedBytes} bytes are expected for ${numElements} elements ` +
        `of type ${sourceDataType.name}.`,
    );
  }
  const data = sourceDataType.decode(
    new Uint8Array(response, byteOffset, byteLength),
    numElements,
    endianness,
  );
  await postProcessRawData(chunk, signal, data);
}
