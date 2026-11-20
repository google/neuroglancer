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
import { computeReshapedShape } from "#src/datasource/zarr/codec/reshape/shape.js";
import { registerCodec } from "#src/datasource/zarr/codec/resolve.js";
import { verifyObject, verifyObjectProperty } from "#src/util/json.js";

export interface Configuration {
  encodedShape: number[];
}

function isIdentity(order: readonly number[]) {
  return order.every((x, i) => x === i);
}

registerCodec({
  name: "reshape",
  kind: CodecKind.arrayToArray,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
  ): { configuration: Configuration; encodedArrayInfo: CodecArrayInfo } {
    verifyObject(configuration);
    const encodedShape = verifyObjectProperty(configuration, "shape", (x) =>
      computeReshapedShape(x, decodedArrayInfo.chunkShape),
    );
    return {
      configuration: { encodedShape },
      encodedArrayInfo: {
        dataType: decodedArrayInfo.dataType,
        chunkShape: encodedShape,
      },
    };
  },
  getDecodedArrayLayoutInfo(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
    encodedLayout: CodecArrayLayoutInfo,
  ): CodecArrayLayoutInfo {
    // reshape keeps C order, so a C-order encoded chunk is a C-order decoded
    // chunk; any other encoded layout would need a copy
    const { readChunkShape } = encodedLayout;
    if (
      !isIdentity(encodedLayout.physicalToLogicalDimension) ||
      readChunkShape.some((x, i) => x !== configuration.encodedShape[i])
    ) {
      throw new Error("reshape: only a C-order encoded chunk is supported");
    }
    return {
      physicalToLogicalDimension: Array.from(
        decodedArrayInfo.chunkShape,
        (_, i) => i,
      ),
      readChunkShape: decodedArrayInfo.chunkShape,
    };
  },
});
