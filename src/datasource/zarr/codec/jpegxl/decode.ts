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

import { decodeJxl } from "#src/async_computation/decode_jxl_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import { registerCodec } from "#src/datasource/zarr/codec/decode.js";
import type { CodecArrayInfo } from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import type { Configuration } from "#src/datasource/zarr/codec/jpegxl/resolve.js";
import { DATA_TYPE_BYTES } from "#src/util/data_type.js";

registerCodec({
  name: "jpegxl",
  kind: CodecKind.arrayToBytes,
  async decode(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
    encoded: Uint8Array<ArrayBuffer>,
    signal: AbortSignal,
  ) {
    configuration;
    const { dataType, chunkShape } = decodedArrayInfo;
    const bytesPerPixel = DATA_TYPE_BYTES[dataType];
    // The chunk handed to this codec is the native JXL image shape
    // `[frames, height, width, samples]` (with unit frames/samples axes
    // dropped).  The decoder derives the spatial/frame/sample split from the
    // codestream itself, so here we only need the total element count.
    const expectedElements = chunkShape.reduce((a, b) => a * b, 1);
    const decoded = await requestAsyncComputation(
      decodeJxl,
      signal,
      [encoded.buffer],
      encoded,
      expectedElements,
      bytesPerPixel,
    );
    const expectedBytes = expectedElements * bytesPerPixel;
    if (decoded.uint8Array.byteLength !== expectedBytes) {
      throw new Error(
        `jpegxl: decoded chunk is ${decoded.uint8Array.byteLength} bytes, but ` +
          `${expectedElements} elements * ${bytesPerPixel} bytes = ` +
          `${expectedBytes} bytes are expected for chunk shape ` +
          `${JSON.stringify(chunkShape)}`,
      );
    }
    return decoded.uint8Array;
  },
});
