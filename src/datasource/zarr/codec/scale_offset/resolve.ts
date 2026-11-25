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

import type {
  CodecArrayInfo,
  CodecArrayLayoutInfo,
} from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { registerCodec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";
import {
  verifyFiniteFloat,
  verifyOptionalObjectProperty,
} from "#src/util/json.js";

export interface Configuration {
  offset: number;
  scale: number;
}

registerCodec({
  name: "scale_offset",
  kind: CodecKind.arrayToArray,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
  ): { configuration: Configuration; encodedArrayInfo: CodecArrayInfo } {
    // the configuration may be omitted, which makes the codec a no-op
    const obj = configuration ?? {};
    const offset = verifyOptionalObjectProperty(
      obj,
      "offset",
      verifyFiniteFloat,
      0,
    );
    const scale = verifyOptionalObjectProperty(
      obj,
      "scale",
      verifyFiniteFloat,
      1,
    );
    if (scale === 0) {
      throw new Error("scale_offset: scale must be nonzero");
    }
    if (decodedArrayInfo.dataType !== DataType.FLOAT32) {
      throw new Error(
        "scale_offset: only float32 arrays are supported, but received " +
          DataType[decodedArrayInfo.dataType],
      );
    }
    return {
      configuration: { offset, scale },
      encodedArrayInfo: decodedArrayInfo,
    };
  },
  getDecodedArrayLayoutInfo(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
    encodedLayout: CodecArrayLayoutInfo,
  ): CodecArrayLayoutInfo {
    configuration;
    decodedArrayInfo;
    return encodedLayout;
  },
});
