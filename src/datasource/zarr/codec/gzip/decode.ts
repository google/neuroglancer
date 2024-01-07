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

import { decodeGzip } from "#/async_computation/decode_gzip_request";
import { requestAsyncComputation } from "#/async_computation/request";
import { CodecKind } from "#/datasource/zarr/codec";
import { registerCodec } from "#/datasource/zarr/codec/decode";
import type { Configuration } from "#/datasource/zarr/codec/gzip/resolve";
import { CancellationToken } from "#/util/cancellation";

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
