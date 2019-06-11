/**
 * @license
 * Copyright 2019 Google Inc.
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

import {parseCSVFromArrayBuffer} from 'neuroglancer/async_computation/csv_vertex_attributes_request';
import {registerAsyncComputation} from 'neuroglancer/async_computation/handler';
import {VertexAttributeInfo} from 'neuroglancer/single_mesh/base';
import {DataType} from 'neuroglancer/util/data_type';
import {maybeDecompressGzip} from 'neuroglancer/util/gzip';

registerAsyncComputation(parseCSVFromArrayBuffer, async function(buffer: ArrayBuffer) {
  const decoder = new TextDecoder();
  const text = decoder.decode(maybeDecompressGzip(buffer));
  let lines = text.trim().split(/\n+/);
  if (!lines) {
    throw new Error(`CSV file is empty.`);
  }
  let headers = lines[0].split(',');
  let attributeInfo: VertexAttributeInfo[] =
      headers.map(name => ({name: name.trim(), dataType: DataType.FLOAT32, numComponents: 1}));
  let numRows = lines.length - 1;
  let numColumns = headers.length;
  let attributes = headers.map(() => new Float32Array(numRows));
  for (let i = 0; i < numRows; ++i) {
    let fields = lines[i + 1].split(',');
    for (let j = 0; j < numColumns; ++j) {
      attributes[j][i] = parseFloat(fields[j]);
    }
  }
  return {
    value: {
      data: {
        numVertices: numRows,
        attributeInfo,
        attributes,
      },
      size: numRows * numColumns * 4,
    },
    transfer: attributes.map(a => a.buffer),
  };
});
