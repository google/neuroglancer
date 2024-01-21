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

import { decodeGzip } from "#src/async_computation/decode_gzip_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import { registerCodec } from "#src/datasource/zarr/codec/decode.js";
import type { Configuration } from "#src/datasource/zarr/codec/gzip/resolve.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import type { CancellationToken } from "#src/util/cancellation.js";

registerCodec({
  name: "gzip",
  kind: CodecKind.bytesToBytes,
  decode(
    configuration: Configuration,
    encoded: Uint8Array,
    cancellationToken: CancellationToken,
  ): Promise<Uint8Array> {
    configuration;
    return requestAsyncComputation(
      decodeGzip,
      cancellationToken,
      [encoded.buffer],
      encoded,
    );
  },
});
