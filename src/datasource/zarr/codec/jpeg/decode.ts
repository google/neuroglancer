/**
 * @license
 * Copyright 2026 Google Inc.
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

import { decodeJpeg } from "#src/async_computation/decode_jpeg_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import { registerCodec } from "#src/datasource/zarr/codec/decode.js";
import type { CodecArrayInfo } from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import type { Configuration } from "#src/datasource/zarr/codec/jpeg/resolve.js";
import { transposeArray2d } from "#src/util/array.js";

registerCodec({
  name: "jpeg",
  kind: CodecKind.arrayToBytes,
  async decode(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
    encoded,
    signal: AbortSignal,
  ) {
    decodedArrayInfo;
    const { width, height, numComponents } = configuration;
    const { uint8Array } = await requestAsyncComputation(
      decodeJpeg,
      signal,
      [encoded.buffer],
      encoded,
      width,
      height,
      undefined,
      numComponents,
      false,
    );
    // the decoder returns color planes; the chunk is (H, W, 3) in C order
    return numComponents === 3
      ? transposeArray2d(uint8Array, 3, width * height)
      : uint8Array;
  },
});
