/**
 * @license
 * Copyright 2016 Google Inc.
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

import { describe } from "vitest";
import { chunkFormatTest } from "#src/sliceview/chunk_format_testing.js";
import { ChunkFormat } from "#src/sliceview/uncompressed_chunk_format.js";
import type {
  TypedNumberArray,
  TypedNumberArrayConstructor,
} from "#src/util/array.js";
import { DataType } from "#src/util/data_type.js";
import { prod4 } from "#src/util/geom.js";
import { getRandomValues } from "#src/util/random.js";

function fillSequential(array: TypedNumberArray) {
  const length = array.length;
  for (let i = 0; i < length; ++i) {
    array[i] = i;
  }
}

describe("sliceview/uncompressed_chunk_format", () => {
  describe("data access", () => {
    for (const volumeSize of [
      Uint32Array.of(64, 64, 64, 1),
      Uint32Array.of(36, 36, 36, 1),
    ]) {
      const numElements = prod4(volumeSize);
      const data = new Float32Array(numElements);
      fillSequential(data);
      const dataType = DataType.FLOAT32;
      chunkFormatTest(
        dataType,
        volumeSize,
        (gl) => {
          const chunkFormat = ChunkFormat.get(gl, dataType, 3);
          const textureLayout = chunkFormat.getTextureLayout(gl, volumeSize);
          return [chunkFormat, textureLayout];
        },
        data,
        data,
      );
    }

    for (const volumeSize of [
      //
      Uint32Array.of(13, 17, 23, 1),
      Uint32Array.of(13, 17, 23, 2),
    ]) {
      const numElements = prod4(volumeSize);
      for (const [dataType, arrayConstructor] of <
        [DataType, TypedNumberArrayConstructor<ArrayBuffer>][]
      >[
        [DataType.UINT8, Uint8Array],
        [DataType.UINT16, Uint16Array],
        [DataType.UINT32, Uint32Array],
        [DataType.UINT64, BigUint64Array],
      ]) {
        const data = new arrayConstructor(numElements);
        getRandomValues(data);
        chunkFormatTest(
          dataType,
          volumeSize,
          (gl) => {
            const chunkFormat = ChunkFormat.get(gl, dataType, 3);
            const textureLayout = chunkFormat.getTextureLayout(gl, volumeSize);
            return [chunkFormat, textureLayout];
          },
          data,
          data,
        );
      }
    }
  });
});
