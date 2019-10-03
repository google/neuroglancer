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

import {decodeSkeletonVertexPositionsAndIndices, SkeletonChunk} from 'neuroglancer/skeleton/backend';
import {VertexAttributeInfo} from 'neuroglancer/skeleton/base';
import {DATA_TYPE_BYTES} from 'neuroglancer/util/data_type';
import {convertEndian16, convertEndian32, Endianness} from 'neuroglancer/util/endian';

export function decodeSkeletonChunk(
    chunk: SkeletonChunk, response: ArrayBuffer,
    vertexAttributes: Map<string, VertexAttributeInfo>) {
  let dv = new DataView(response);
  let numVertices = dv.getUint32(0, true);
  let numEdges = dv.getUint32(4, true);

  const vertexPositionsStartOffset = 8;

  let curOffset = 8 + numVertices * 4 * 3;
  decodeSkeletonVertexPositionsAndIndices(
      chunk, response, Endianness.LITTLE, /*vertexByteOffset=*/ vertexPositionsStartOffset,
      numVertices,
      /*indexByteOffset=*/ curOffset, /*numEdges=*/ numEdges);
  curOffset += numEdges * 4 * 2;
  let attributes: Uint8Array[] = [];
  for (let info of vertexAttributes.values()) {
    const bytesPerVertex = DATA_TYPE_BYTES[info.dataType] * info.numComponents;
    const totalBytes = bytesPerVertex * numVertices;
    const attribute = new Uint8Array(response, curOffset, totalBytes);
    switch (bytesPerVertex) {
      case 2:
        convertEndian16(attribute, Endianness.LITTLE);
        break;
      case 4:
      case 8:
        convertEndian32(attribute, Endianness.LITTLE);
        break;
    }
    attributes.push(attribute);
    curOffset += totalBytes;
  }
  chunk.vertexAttributes = attributes;
}
