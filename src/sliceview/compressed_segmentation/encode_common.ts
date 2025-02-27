// DO NOT EDIT.  Generated from templates/sliceview/compressed_segmentation/encode_common.template.ts.
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

import type { TypedArrayBuilder } from "#src/util/array.js";
import { getFortranOrderStrides } from "#src/util/array.js";

export const BLOCK_HEADER_SIZE = 2;

export function newCache() {
  return new Map<string, number>();
}

const writeEncodedRepresentation = new Function(
  "outputData",
  "outputOffset",
  "encodingBuffer",
  "indexBuffer",
  "encodedBits",
  "encodedSize32Bits",
  (() => {
    let code = "switch (encodedBits) { case 0: break;";
    for (const encodedBits of [1, 2, 4, 8, 16, 32]) {
      code += `case ${encodedBits}:`;
      code += `for (let wordIndex = 0, elementIndex = 0; wordIndex < encodedSize32Bits; ++wordIndex) {let word = 0;`;
      const elementsPer32Bits = 32 / encodedBits;
      for (let element = 0; element < elementsPer32Bits; ++element) {
        code += `word |= indexBuffer[encodingBuffer[elementIndex + ${element}]] << (${element * encodedBits});`;
      }
      code += `outputData[outputOffset + wordIndex] = word;elementIndex += ${elementsPer32Bits};`;
      code += `} break;`;
    }
    code += "}";
    return code;
  })(),
) as (
  outputData: Uint32Array,
  outputOffset: number,
  encodingBuffer: Uint32Array,
  indexBuffer: Uint32Array,
  encodedBits: number,
  encodedSize32Bits: number,
) => void;

type ValueTableCache = Map<string, number>;

export function writeBlock(
  output: TypedArrayBuilder<Uint32Array<ArrayBuffer>>,
  baseOffset: number,
  cache: ValueTableCache,
  numBlockElements: number,
  numUniqueValues: number,
  valuesBuffer2: Uint32Array,
  encodingBuffer: Uint32Array,
  indexBuffer2: Uint32Array,
  uint32sPerElement: number,
): [number, number] {
  let encodedBits: number;
  if (numUniqueValues === 1) {
    encodedBits = 0;
  } else {
    encodedBits = 1;
    while (1 << encodedBits < numUniqueValues) {
      encodedBits *= 2;
    }
  }
  const encodedSize32bits = Math.ceil((encodedBits * numBlockElements) / 32);

  const encodedValueBaseOffset = output.length;
  let elementsToWrite = encodedSize32bits;

  let writeTable = false;
  const key = valuesBuffer2
    .subarray(0, numUniqueValues * uint32sPerElement)
    .join();
  let tableOffset = cache.get(key);

  if (tableOffset === undefined) {
    writeTable = true;
    elementsToWrite += numUniqueValues * uint32sPerElement;
    tableOffset = encodedValueBaseOffset + encodedSize32bits - baseOffset;
    cache.set(key, tableOffset);
  }

  output.resize(encodedValueBaseOffset + elementsToWrite);
  const outputData = output.data;

  writeEncodedRepresentation(
    outputData,
    encodedValueBaseOffset,
    encodingBuffer,
    indexBuffer2,
    encodedBits,
    encodedSize32bits,
  );

  // Write table
  if (writeTable) {
    let curOutputOff = encodedValueBaseOffset + encodedSize32bits;
    for (
      let i = 0, length = numUniqueValues * uint32sPerElement;
      i < length;
      ++i
    ) {
      outputData[curOutputOff++] = valuesBuffer2[i];
    }
  }
  return [encodedBits, tableOffset];
}

export function encodeChannel<T extends number | bigint>(
  output: TypedArrayBuilder<Uint32Array<ArrayBuffer>>,
  blockSize: ArrayLike<number>,
  rawData: { length: number; [index: number]: T },
  volumeSize: ArrayLike<number>,
  baseInputOffset: number = 0,
  inputStrides: ArrayLike<number> = getFortranOrderStrides(volumeSize, 1),
) {
  // Maps a sorted list of table entries in the form <low>,<high>,<low>,<high>,... to the table
  // offset relative to baseOffset.
  const cache = newCache();
  const gridSize = new Array<number>(3);
  let blockIndexSize = BLOCK_HEADER_SIZE;
  for (let i = 0; i < 3; ++i) {
    const curGridSize = (gridSize[i] = Math.ceil(volumeSize[i] / blockSize[i]));
    blockIndexSize *= curGridSize;
  }
  const gx = gridSize[0],
    gy = gridSize[1],
    gz = gridSize[2];
  const xSize = volumeSize[0],
    ySize = volumeSize[1],
    zSize = volumeSize[2];
  const xBlockSize = blockSize[0],
    yBlockSize = blockSize[1],
    zBlockSize = blockSize[2];
  const baseOffset = output.length;
  let headerOffset = baseOffset;
  const actualSize = [0, 0, 0];
  output.resize(baseOffset + blockIndexSize);
  const sx = inputStrides[0],
    sy = inputStrides[1],
    sz = inputStrides[2];
  for (let bz = 0; bz < gz; ++bz) {
    actualSize[2] = Math.min(zBlockSize, zSize - bz * zBlockSize);
    for (let by = 0; by < gy; ++by) {
      actualSize[1] = Math.min(yBlockSize, ySize - by * yBlockSize);
      for (let bx = 0; bx < gx; ++bx) {
        actualSize[0] = Math.min(xBlockSize, xSize - bx * xBlockSize);
        const inputOffset =
          bz * zBlockSize * sz + by * yBlockSize * sy + bx * xBlockSize * sx;
        const encodedValueBaseOffset = output.length - baseOffset;
        const [encodedBits, tableOffset] = encodeBlock(
          rawData,
          baseInputOffset + inputOffset,
          inputStrides,
          blockSize,
          actualSize,
          baseOffset,
          cache,
          output,
        );
        const outputData = output.data;
        outputData[headerOffset++] = tableOffset | (encodedBits << 24);
        outputData[headerOffset++] = encodedValueBaseOffset;
      }
    }
  }
}

export function encodeChannels<T extends number | bigint>(
  output: TypedArrayBuilder<Uint32Array<ArrayBuffer>>,
  blockSize: ArrayLike<number>,
  rawData: { length: number; [index: number]: T },
  volumeSize: ArrayLike<number>,
  baseInputOffset: number = 0,
  inputStrides: ArrayLike<number> = getFortranOrderStrides(volumeSize, 1),
) {
  const channelOffsetOutputBase = output.length;
  const numChannels = volumeSize[3];
  output.resize(channelOffsetOutputBase + numChannels);
  for (let channel = 0; channel < numChannels; ++channel) {
    output.data[channelOffsetOutputBase + channel] = output.length;
    encodeChannel(
      output,
      blockSize,
      rawData,
      volumeSize,
      baseInputOffset + inputStrides[3] * channel,
      inputStrides,
    );
  }
}

let tempEncodingBuffer: Uint32Array = new Uint32Array(0);
let tempValuesBuffer1u32: Uint32Array = tempEncodingBuffer;
let tempValuesBuffer2u32: Uint32Array = tempEncodingBuffer;
let tempValuesBuffer1u64: BigUint64Array = new BigUint64Array();
let tempValuesBuffer2u64: BigUint64Array = tempValuesBuffer1u64;
let tempIndexBuffer1: Uint32Array = tempEncodingBuffer;
let tempIndexBuffer2: Uint32Array = tempEncodingBuffer;

export function encodeBlock<T extends number | bigint>(
  rawData: { length: number; [index: number]: T },
  inputOffset: number,
  inputStrides: ArrayLike<number>,
  blockSize: ArrayLike<number>,
  actualSize: ArrayLike<number>,
  baseOffset: number,
  cache: Map<string, number>,
  output: TypedArrayBuilder<Uint32Array<ArrayBuffer>>,
): [number, number] {
  const ax = actualSize[0],
    ay = actualSize[1],
    az = actualSize[2];
  const bx = blockSize[0],
    by = blockSize[1],
    bz = blockSize[2];
  const sx = inputStrides[0];
  let sy = inputStrides[1],
    sz = inputStrides[2];
  sz -= sy * ay;
  sy -= sx * ax;
  if (ax * ay * az === 0) {
    return [0, 0];
  }

  const numBlockElements = bx * by * bz + 31; // Add padding elements.
  if (tempEncodingBuffer.length < numBlockElements) {
    tempEncodingBuffer = new Uint32Array(numBlockElements);
    tempIndexBuffer1 = new Uint32Array(numBlockElements);
    tempIndexBuffer2 = new Uint32Array(numBlockElements);
  }

  let valuesBuffer1: { length: number; [index: number]: T };
  let valuesBuffer2: { length: number; [index: number]: T };
  const tempValuesLength =
    Math.ceil(
      (numBlockElements * (rawData instanceof Uint32Array ? 1 : 2)) / 2,
    ) * 2;
  if (tempValuesBuffer1u32.length < tempValuesLength) {
    tempValuesBuffer1u32 = new Uint32Array(tempValuesLength);
    tempValuesBuffer2u32 = new Uint32Array(tempValuesLength);
    tempValuesBuffer1u64 = new BigUint64Array(tempValuesBuffer1u32.buffer);
    tempValuesBuffer2u64 = new BigUint64Array(tempValuesBuffer2u32.buffer);
  }
  if (rawData instanceof Uint32Array) {
    valuesBuffer1 = tempValuesBuffer1u32 as any;
    valuesBuffer2 = tempValuesBuffer2u32 as any;
  } else {
    valuesBuffer1 = tempValuesBuffer1u64 as any;
    valuesBuffer2 = tempValuesBuffer2u64 as any;
  }

  const encodingBuffer = tempEncodingBuffer.subarray(0, numBlockElements);
  encodingBuffer.fill(0);
  const indexBuffer1 = tempIndexBuffer1;
  const indexBuffer2 = tempIndexBuffer2;

  let noAdjacentDuplicateIndex = 0;
  {
    let prev: T = rawData[inputOffset];
    if (!prev) {
      ++prev;
    } else {
      --prev;
    }
    let curInputOff = inputOffset;
    let blockElementIndex = 0;
    const bsy = bx - ax;
    const bsz = bx * by - bx * ay;
    for (let z = 0; z < az; ++z, curInputOff += sz, blockElementIndex += bsz) {
      for (
        let y = 0;
        y < ay;
        ++y, curInputOff += sy, blockElementIndex += bsy
      ) {
        for (let x = 0; x < ax; ++x, curInputOff += sx) {
          const value = rawData[curInputOff];
          if (value !== prev) {
            prev = valuesBuffer1[noAdjacentDuplicateIndex] = value;
            indexBuffer1[noAdjacentDuplicateIndex] = noAdjacentDuplicateIndex++;
          }
          encodingBuffer[blockElementIndex++] = noAdjacentDuplicateIndex;
        }
      }
    }
  }

  indexBuffer1.subarray(0, noAdjacentDuplicateIndex).sort((a, b) => {
    const aValue = valuesBuffer1[a];
    const bValue = valuesBuffer1[b];
    return aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
  });

  let numUniqueValues = -1;
  {
    let prev: T = valuesBuffer1[indexBuffer1[0]];
    if (!prev) {
      ++prev;
    } else {
      --prev;
    }
    for (let i = 0; i < noAdjacentDuplicateIndex; ++i) {
      const index = indexBuffer1[i];
      const value = valuesBuffer1[index];
      if (value !== prev) {
        ++numUniqueValues;
        prev = valuesBuffer2[numUniqueValues] = value;
      }
      indexBuffer2[index + 1] = numUniqueValues;
    }
    ++numUniqueValues;
  }

  return writeBlock(
    output,
    baseOffset,
    cache,
    bx * by * bz,
    numUniqueValues,
    tempValuesBuffer2u32,
    encodingBuffer,
    indexBuffer2,
    rawData instanceof Uint32Array ? 1 : 2,
  );
}
