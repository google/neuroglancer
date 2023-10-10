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

import {CodecKind} from 'neuroglancer/datasource/zarr/codec';
import type {Configuration} from 'neuroglancer/datasource/zarr/codec/crc32c/resolve';
import {registerCodec} from 'neuroglancer/datasource/zarr/codec/decode';
import {CancellationToken} from 'neuroglancer/util/cancellation';

const checksumSize = 4;

registerCodec({
  name: 'crc32c',
  kind: CodecKind.bytesToBytes,
  async decode(
      configuration: Configuration, encoded: Uint8Array, cancellationToken: CancellationToken):
      Promise<Uint8Array> {
        configuration;
        cancellationToken;
        if (encoded.length < checksumSize) {
          throw new Error(`Expected buffer of size at least ${checksumSize} bytes but received: ${
              encoded.length} bytes`);
        }
        // TODO(jbms): Actually verify checksum.
        return encoded.subarray(0, encoded.length - checksumSize);
      }
});
