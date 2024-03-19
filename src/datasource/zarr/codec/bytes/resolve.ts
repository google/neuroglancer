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

import type {
  CodecArrayInfo,
  CodecArrayLayoutInfo,
} from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { registerCodec } from "#src/datasource/zarr/codec/resolve.js";
import { DATA_TYPE_BYTES } from "#src/util/data_type.js";
import { ENDIANNESS, Endianness } from "#src/util/endian.js";
import { verifyObject, verifyObjectProperty } from "#src/util/json.js";

export interface Configuration {
  endian: Endianness;
}

registerCodec({
  name: "bytes",
  kind: CodecKind.arrayToBytes,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
  ): { configuration: Configuration; encodedSize: number } {
    verifyObject(configuration);
    const endian = verifyObjectProperty(configuration, "endian", (value) => {
      switch (value) {
        case "little":
          return Endianness.LITTLE;
        case "big":
          return Endianness.BIG;
        case undefined:
          if (DATA_TYPE_BYTES[decodedArrayInfo.dataType] === 1) {
            return ENDIANNESS;
          }
      }
      throw new Error(`Invalid endian value: ${JSON.stringify(value)}`);
    });
    const numElements = decodedArrayInfo.chunkShape.reduce((a, b) => a * b, 1);
    return {
      configuration: { endian },
      encodedSize: DATA_TYPE_BYTES[decodedArrayInfo.dataType] * numElements,
    };
  },
  getDecodedArrayLayoutInfo(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
  ): CodecArrayLayoutInfo {
    configuration;
    return {
      physicalToLogicalDimension: Array.from(
        decodedArrayInfo.chunkShape,
        (_, i) => i,
      ),
      readChunkShape: decodedArrayInfo.chunkShape,
    };
  },
});
