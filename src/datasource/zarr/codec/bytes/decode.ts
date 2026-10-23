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

import type { Configuration } from "#src/datasource/zarr/codec/bytes/resolve.js";
import { registerCodec } from "#src/datasource/zarr/codec/decode.js";
import type { CodecArrayInfo } from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import {
  encodedByteLength,
  getSourceDataType,
} from "#src/util/source_data_type.js";

registerCodec({
  name: "bytes",
  kind: CodecKind.arrayToBytes,
  async decode(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
    encoded,
    signal: AbortSignal,
  ) {
    signal;
    const sourceDataType = getSourceDataType(decodedArrayInfo.sourceDataType);
    const numElements = decodedArrayInfo.chunkShape.reduce((a, b) => a * b, 1);
    const expectedBytes = encodedByteLength(sourceDataType, numElements);
    if (encoded.byteLength !== expectedBytes) {
      throw new Error(
        `Raw-format chunk is ${encoded.byteLength} bytes, ` +
          `but ${expectedBytes} bytes are expected for ${numElements} elements ` +
          `of type ${sourceDataType.name}.`,
      );
    }
    return sourceDataType.decode(encoded, numElements, configuration.endian);
  },
});
