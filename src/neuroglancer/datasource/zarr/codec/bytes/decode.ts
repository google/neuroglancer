/**
 * @license
 * Copyright 2023 Google Inc.
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

import {CodecArrayInfo, CodecKind} from 'neuroglancer/datasource/zarr/codec';
import type {Configuration} from 'neuroglancer/datasource/zarr/codec/bytes/resolve';
import {registerCodec} from 'neuroglancer/datasource/zarr/codec/decode';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {DATA_TYPE_BYTES, makeDataTypeArrayView} from 'neuroglancer/util/data_type';
import { convertEndian } from 'neuroglancer/util/endian';

registerCodec({
  name: 'bytes',
  kind: CodecKind.arrayToBytes,
  async decode(
      configuration: Configuration, decodedArrayInfo: CodecArrayInfo, encoded: Uint8Array,
      cancellationToken: CancellationToken): Promise<ArrayBufferView> {
    cancellationToken;
    const {dataType, chunkShape} = decodedArrayInfo;
    const numElements = chunkShape.reduce((a, b) => a * b, 1);
    const bytesPerElement = DATA_TYPE_BYTES[dataType];
    const expectedBytes = numElements * bytesPerElement;
    if (encoded.byteLength !== expectedBytes) {
      throw new Error(
          `Raw-format chunk is ${encoded.byteLength} bytes, ` +
          `but ${numElements} * ${bytesPerElement} = ${expectedBytes} bytes are expected.`);
    }
    const data =
        makeDataTypeArrayView(dataType, encoded.buffer, encoded.byteOffset, encoded.byteLength);
    convertEndian(data, configuration.endian, bytesPerElement);
    return data;
  },
});
