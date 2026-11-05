/**
 * @license
 * Copyright 2025 Google Inc.
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
import { registerCodec } from "#src/datasource/zarr/codec/encode.js";
import {
  type CodecArrayInfo,
  CodecKind,
} from "#src/datasource/zarr/codec/index.js";
import { DATA_TYPE_BYTES } from "#src/sliceview/base.js";
import { convertEndian } from "#src/util/endian.js";

registerCodec({
  name: "bytes",
  kind: CodecKind.arrayToBytes,
  async encode(
    configuration: Configuration,
    encodedArrayInfo: CodecArrayInfo,
    decoded: ArrayBufferView,
  ): Promise<Uint8Array> {
    const bytesPerElement = DATA_TYPE_BYTES[encodedArrayInfo.dataType];
    convertEndian(decoded, configuration.endian, bytesPerElement);
    return new Uint8Array(
      decoded.buffer,
      decoded.byteOffset,
      decoded.byteLength,
    );
  },
});
