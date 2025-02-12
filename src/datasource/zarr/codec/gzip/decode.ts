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

import { registerCodec } from "#src/datasource/zarr/codec/decode.js";
import type { Configuration } from "#src/datasource/zarr/codec/gzip/resolve.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { decodeGzip } from "#src/util/gzip.js";

for (const [name, compressionFormat] of [
  ["gzip", "gzip"],
  ["zlib", "deflate"],
] as const) {
  registerCodec({
    name,
    kind: CodecKind.bytesToBytes,
    async decode(configuration: Configuration, encoded, signal: AbortSignal) {
      configuration;
      return new Uint8Array(
        await decodeGzip(encoded, compressionFormat, signal),
      );
    },
  });
}
