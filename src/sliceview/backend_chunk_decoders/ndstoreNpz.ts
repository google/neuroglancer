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

/**
 * This decodes the NDStore (https://github.com/neurodata/ndstore) NPZ format, which is the Python
 * NPY binary format with zlib encoding.
 *
 * This is NOT the same as the Python NPZ format, which is a ZIP file containing multiple files
 * (each corresponding to a different variable) in NPY binary format.
 */

import { postProcessRawData } from "#src/sliceview/backend_chunk_decoders/postprocess.js";
import { DataType } from "#src/sliceview/base.js";
import type { VolumeChunk } from "#src/sliceview/volume/backend.js";
import { arraysEqual } from "#src/util/array.js";
import { decodeGzip } from "#src/util/gzip.js";
import { parseNpy } from "#src/util/npy.js";

export async function decodeNdstoreNpzChunk(
  chunk: VolumeChunk,
  abortSignal: AbortSignal,
  response: ArrayBuffer,
) {
  const parseResult = parseNpy(
    new Uint8Array(await decodeGzip(response, "deflate")),
  );
  const chunkDataSize = chunk.chunkDataSize!;
  const source = chunk.source!;
  const { shape } = parseResult;
  if (!arraysEqual(shape, chunkDataSize)) {
    throw new Error(
      `Shape ${JSON.stringify(
        shape,
      )} does not match chunkDataSize ${chunkDataSize.join()}`,
    );
  }
  const parsedDataType = parseResult.dataType;
  const { spec } = source;
  if (parsedDataType !== spec.dataType) {
    throw new Error(
      `Data type ${DataType[parsedDataType]} does not match ` +
        `expected data type ${DataType[spec.dataType]}`,
    );
  }
  await postProcessRawData(chunk, abortSignal, parseResult.data);
}
