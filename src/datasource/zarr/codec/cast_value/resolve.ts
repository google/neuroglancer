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
  OutOfRange,
  Rounding,
} from "#src/datasource/zarr/codec/cast_value/cast.js";
import {
  isSupportedCastType,
  ROUNDING_MODES,
} from "#src/datasource/zarr/codec/cast_value/cast.js";
import type {
  CodecArrayInfo,
  CodecArrayLayoutInfo,
} from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { registerCodec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";
import {
  verifyEnumString,
  verifyObject,
  verifyObjectProperty,
  verifyOptionalObjectProperty,
} from "#src/util/json.js";

export interface Configuration {
  dataType: DataType;
  rounding: Rounding;
  outOfRange: OutOfRange;
}

registerCodec({
  name: "cast_value",
  kind: CodecKind.arrayToArray,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
  ): { configuration: Configuration; encodedArrayInfo: CodecArrayInfo } {
    verifyObject(configuration);
    const dataType = verifyObjectProperty(configuration, "data_type", (x) =>
      verifyEnumString(x, DataType, /^[a-z0-9]+$/),
    );
    const rounding = verifyOptionalObjectProperty(
      configuration,
      "rounding",
      (x) => {
        if (!ROUNDING_MODES.includes(x)) {
          throw new Error(`Invalid rounding: ${JSON.stringify(x)}`);
        }
        return x as Rounding;
      },
      "nearest-even" as Rounding,
    );
    const outOfRange = verifyOptionalObjectProperty(
      configuration,
      "out_of_range",
      (x) => {
        if (x !== "clamp" && x !== "wrap") {
          throw new Error(`Invalid out_of_range: ${JSON.stringify(x)}`);
        }
        return x as OutOfRange;
      },
    );
    if ((configuration as Record<string, unknown>).scalar_map !== undefined) {
      throw new Error("cast_value: scalar_map is not supported");
    }
    for (const t of [dataType, decodedArrayInfo.dataType]) {
      if (!isSupportedCastType(t)) {
        throw new Error(`cast_value: unsupported data type ${DataType[t]}`);
      }
    }
    return {
      configuration: { dataType, rounding, outOfRange },
      encodedArrayInfo: {
        dataType,
        chunkShape: decodedArrayInfo.chunkShape,
      },
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
