// DO NOT EDIT.  Generated from
// templates/neuroglancer/sliceview/compressed_segmentation/encode_common.template.ts.
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

import {Uint32ArrayBuilder} from 'neuroglancer/util/uint32array_builder';

export const BLOCK_HEADER_SIZE = 2;

export function newCache() {
  return new Map<string, number>();
}

function writeEncodedRepresentation(
    outputData: Uint32Array, outputOffset: number, encodingBuffer: Uint32Array,
    indexBuffer: Uint32Array, encodedBits: number, encodedSize32Bits: number) {
  // Write encoded representation.
  if (encodedBits > 0) {
    switch (encodedBits) {
      case 1: {
        for (let wordIndex = 0, elementIndex = 0; wordIndex < encodedSize32Bits; ++wordIndex) {
          let word = 0;

          word |= (indexBuffer[encodingBuffer[elementIndex + 0]] << 0);

          word |= (indexBuffer[encodingBuffer[elementIndex + 1]] << 1);

          word |= (indexBuffer[encodingBuffer[elementIndex + 2]] << 2);

          word |= (indexBuffer[encodingBuffer[elementIndex + 3]] << 3);

          word |= (indexBuffer[encodingBuffer[elementIndex + 4]] << 4);

          word |= (indexBuffer[encodingBuffer[elementIndex + 5]] << 5);

          word |= (indexBuffer[encodingBuffer[elementIndex + 6]] << 6);

          word |= (indexBuffer[encodingBuffer[elementIndex + 7]] << 7);

          word |= (indexBuffer[encodingBuffer[elementIndex + 8]] << 8);

          word |= (indexBuffer[encodingBuffer[elementIndex + 9]] << 9);

          word |= (indexBuffer[encodingBuffer[elementIndex + 10]] << 10);

          word |= (indexBuffer[encodingBuffer[elementIndex + 11]] << 11);

          word |= (indexBuffer[encodingBuffer[elementIndex + 12]] << 12);

          word |= (indexBuffer[encodingBuffer[elementIndex + 13]] << 13);

          word |= (indexBuffer[encodingBuffer[elementIndex + 14]] << 14);

          word |= (indexBuffer[encodingBuffer[elementIndex + 15]] << 15);

          word |= (indexBuffer[encodingBuffer[elementIndex + 16]] << 16);

          word |= (indexBuffer[encodingBuffer[elementIndex + 17]] << 17);

          word |= (indexBuffer[encodingBuffer[elementIndex + 18]] << 18);

          word |= (indexBuffer[encodingBuffer[elementIndex + 19]] << 19);

          word |= (indexBuffer[encodingBuffer[elementIndex + 20]] << 20);

          word |= (indexBuffer[encodingBuffer[elementIndex + 21]] << 21);

          word |= (indexBuffer[encodingBuffer[elementIndex + 22]] << 22);

          word |= (indexBuffer[encodingBuffer[elementIndex + 23]] << 23);

          word |= (indexBuffer[encodingBuffer[elementIndex + 24]] << 24);

          word |= (indexBuffer[encodingBuffer[elementIndex + 25]] << 25);

          word |= (indexBuffer[encodingBuffer[elementIndex + 26]] << 26);

          word |= (indexBuffer[encodingBuffer[elementIndex + 27]] << 27);

          word |= (indexBuffer[encodingBuffer[elementIndex + 28]] << 28);

          word |= (indexBuffer[encodingBuffer[elementIndex + 29]] << 29);

          word |= (indexBuffer[encodingBuffer[elementIndex + 30]] << 30);

          word |= (indexBuffer[encodingBuffer[elementIndex + 31]] << 31);

          outputData[outputOffset + wordIndex] = word;
          elementIndex += 32;
        }
      } break;

      case 2: {
        for (let wordIndex = 0, elementIndex = 0; wordIndex < encodedSize32Bits; ++wordIndex) {
          let word = 0;

          word |= (indexBuffer[encodingBuffer[elementIndex + 0]] << 0);

          word |= (indexBuffer[encodingBuffer[elementIndex + 1]] << 2);

          word |= (indexBuffer[encodingBuffer[elementIndex + 2]] << 4);

          word |= (indexBuffer[encodingBuffer[elementIndex + 3]] << 6);

          word |= (indexBuffer[encodingBuffer[elementIndex + 4]] << 8);

          word |= (indexBuffer[encodingBuffer[elementIndex + 5]] << 10);

          word |= (indexBuffer[encodingBuffer[elementIndex + 6]] << 12);

          word |= (indexBuffer[encodingBuffer[elementIndex + 7]] << 14);

          word |= (indexBuffer[encodingBuffer[elementIndex + 8]] << 16);

          word |= (indexBuffer[encodingBuffer[elementIndex + 9]] << 18);

          word |= (indexBuffer[encodingBuffer[elementIndex + 10]] << 20);

          word |= (indexBuffer[encodingBuffer[elementIndex + 11]] << 22);

          word |= (indexBuffer[encodingBuffer[elementIndex + 12]] << 24);

          word |= (indexBuffer[encodingBuffer[elementIndex + 13]] << 26);

          word |= (indexBuffer[encodingBuffer[elementIndex + 14]] << 28);

          word |= (indexBuffer[encodingBuffer[elementIndex + 15]] << 30);

          outputData[outputOffset + wordIndex] = word;
          elementIndex += 16;
        }
      } break;

      case 4: {
        for (let wordIndex = 0, elementIndex = 0; wordIndex < encodedSize32Bits; ++wordIndex) {
          let word = 0;

          word |= (indexBuffer[encodingBuffer[elementIndex + 0]] << 0);

          word |= (indexBuffer[encodingBuffer[elementIndex + 1]] << 4);

          word |= (indexBuffer[encodingBuffer[elementIndex + 2]] << 8);

          word |= (indexBuffer[encodingBuffer[elementIndex + 3]] << 12);

          word |= (indexBuffer[encodingBuffer[elementIndex + 4]] << 16);

          word |= (indexBuffer[encodingBuffer[elementIndex + 5]] << 20);

          word |= (indexBuffer[encodingBuffer[elementIndex + 6]] << 24);

          word |= (indexBuffer[encodingBuffer[elementIndex + 7]] << 28);

          outputData[outputOffset + wordIndex] = word;
          elementIndex += 8;
        }
      } break;

      case 8: {
        for (let wordIndex = 0, elementIndex = 0; wordIndex < encodedSize32Bits; ++wordIndex) {
          let word = 0;

          word |= (indexBuffer[encodingBuffer[elementIndex + 0]] << 0);

          word |= (indexBuffer[encodingBuffer[elementIndex + 1]] << 8);

          word |= (indexBuffer[encodingBuffer[elementIndex + 2]] << 16);

          word |= (indexBuffer[encodingBuffer[elementIndex + 3]] << 24);

          outputData[outputOffset + wordIndex] = word;
          elementIndex += 4;
        }
      } break;

      case 16: {
        for (let wordIndex = 0, elementIndex = 0; wordIndex < encodedSize32Bits; ++wordIndex) {
          let word = 0;

          word |= (indexBuffer[encodingBuffer[elementIndex + 0]] << 0);

          word |= (indexBuffer[encodingBuffer[elementIndex + 1]] << 16);

          outputData[outputOffset + wordIndex] = word;
          elementIndex += 2;
        }
      } break;

      case 32: {
        for (let wordIndex = 0, elementIndex = 0; wordIndex < encodedSize32Bits; ++wordIndex) {
          let word = 0;

          word |= (indexBuffer[encodingBuffer[elementIndex + 0]] << 0);

          outputData[outputOffset + wordIndex] = word;
          elementIndex += 1;
        }
      } break;
    }
  }
}

type ValueTableCache = Map<string, number>;

export function writeBlock(
    output: Uint32ArrayBuilder, baseOffset: number, cache: ValueTableCache,
    numBlockElements: number, numUniqueValues: number, valuesBuffer2: Uint32Array,
    encodingBuffer: Uint32Array, indexBuffer2: Uint32Array,
    uint32sPerElement: number): [number, number] {
  let encodedBits: number;
  if (numUniqueValues === 1) {
    encodedBits = 0;
  } else {
    encodedBits = 1;
    while ((1 << encodedBits) < numUniqueValues) {
      encodedBits *= 2;
    }
  }

  let encodedSize32bits = Math.ceil(encodedBits * numBlockElements / 32);

  let encodedValueBaseOffset = output.length;
  let elementsToWrite = encodedSize32bits;

  let writeTable = false;
  let key = Array.prototype.join.call(
      valuesBuffer2.subarray(0, numUniqueValues * uint32sPerElement), ',');
  let tableOffset = cache.get(key);

  if (tableOffset === undefined) {
    writeTable = true;
    elementsToWrite += numUniqueValues * uint32sPerElement;
    tableOffset = encodedValueBaseOffset + encodedSize32bits - baseOffset;
    cache.set(key, tableOffset);
  }

  output.resize(encodedValueBaseOffset + elementsToWrite);
  let outputData = output.data;

  writeEncodedRepresentation(
      outputData, encodedValueBaseOffset, encodingBuffer, indexBuffer2, encodedBits,
      encodedSize32bits);

  // Write table
  if (writeTable) {
    let curOutputOff = encodedValueBaseOffset + encodedSize32bits;
    for (let i = 0, length = numUniqueValues * uint32sPerElement; i < length; ++i) {
      outputData[curOutputOff++] = valuesBuffer2[i];
    }
  }
  return [encodedBits, tableOffset];
}

type EncodeBlockFunction =
    (rawData: Uint32Array, inputOffset: number, inputStrides: ArrayLike<number>,
     blockSize: ArrayLike<number>, actualSize: ArrayLike<number>, baseOffset: number,
     cache: ValueTableCache, output: Uint32ArrayBuilder) => [number, number];

export function encodeChannel(
    output: Uint32ArrayBuilder, blockSize: ArrayLike<number>, rawData: Uint32Array,
    volumeSize: ArrayLike<number>, baseInputOffset: number, inputStrides: ArrayLike<number>,
    encodeBlock: EncodeBlockFunction) {
  // Maps a sorted list of table entries in the form <low>,<high>,<low>,<high>,... to the table
  // offset relative to baseOffset.
  let cache = newCache();
  let gridSize = new Array<number>(3);
  let blockIndexSize = BLOCK_HEADER_SIZE;
  for (let i = 0; i < 3; ++i) {
    let curGridSize = gridSize[i] = Math.ceil(volumeSize[i] / blockSize[i]);
    blockIndexSize *= curGridSize;
  }
  const gx = gridSize[0], gy = gridSize[1], gz = gridSize[2];
  const xSize = volumeSize[0], ySize = volumeSize[1], zSize = volumeSize[2];
  const xBlockSize = blockSize[0], yBlockSize = blockSize[1], zBlockSize = blockSize[2];
  const baseOffset = output.length;
  let headerOffset = baseOffset;
  const actualSize = [0, 0, 0];
  output.resize(baseOffset + blockIndexSize);
  let sx = inputStrides[0], sy = inputStrides[1], sz = inputStrides[2];
  for (let bz = 0; bz < gz; ++bz) {
    actualSize[2] = Math.min(zBlockSize, zSize - bz * zBlockSize);
    for (let by = 0; by < gy; ++by) {
      actualSize[1] = Math.min(yBlockSize, ySize - by * yBlockSize);
      for (let bx = 0; bx < gx; ++bx) {
        actualSize[0] = Math.min(xBlockSize, xSize - bx * xBlockSize);
        let inputOffset = bz * zBlockSize * sz + by * yBlockSize * sy + bx * xBlockSize * sx;
        let encodedValueBaseOffset = output.length - baseOffset;
        let [encodedBits, tableOffset] = encodeBlock(
            rawData, baseInputOffset + inputOffset, inputStrides, blockSize, actualSize, baseOffset,
            cache, output);
        let outputData = output.data;
        outputData[headerOffset++] = tableOffset | (encodedBits << 24);
        outputData[headerOffset++] = encodedValueBaseOffset;
      }
    }
  }
}

export function encodeChannels(
    output: Uint32ArrayBuilder, blockSize: ArrayLike<number>, rawData: Uint32Array,
    volumeSize: ArrayLike<number>, baseInputOffset: number, inputStrides: ArrayLike<number>,
    encodeBlock: EncodeBlockFunction) {
  let channelOffsetOutputBase = output.length;
  const numChannels = volumeSize[3];
  output.resize(channelOffsetOutputBase + numChannels);
  for (let channel = 0; channel < numChannels; ++channel) {
    output.data[channelOffsetOutputBase + channel] = output.length;
    encodeChannel(
        output, blockSize, rawData, volumeSize, baseInputOffset + inputStrides[3] * channel,
        inputStrides, encodeBlock);
  }
}
