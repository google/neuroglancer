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
 * Basic support for parsing the Python Numpy 'npy' serialization format.
 *
 * See http://docs.scipy.org/doc/numpy-dev/neps/npy-format.html
 */

import {TypedArrayConstructor} from 'neuroglancer/util/array';
import {DataType} from 'neuroglancer/util/data_type';
import {convertEndian16, convertEndian32, Endianness} from 'neuroglancer/util/endian';
import {pythonLiteralParse} from 'neuroglancer/util/json';

interface SupportedDataType {
  arrayConstructor: TypedArrayConstructor;
  dataType: DataType;
  fixEndianness: (array: ArrayBufferView) => void;
  elementBytes: number;
  javascriptElementsPerArrayElement: number;
}

const supportedDataTypes = new Map<string, SupportedDataType>();
supportedDataTypes.set('|u1', {
  arrayConstructor: Uint8Array,
  fixEndianness: () => {},
  javascriptElementsPerArrayElement: 1,
  elementBytes: 1,
  dataType: DataType.UINT8,
});
supportedDataTypes.set('|i1', {
  arrayConstructor: Uint8Array,
  fixEndianness: () => {},
  javascriptElementsPerArrayElement: 1,
  elementBytes: 1,
  dataType: DataType.UINT8,
});
for (let [endiannessChar, endianness] of <[string, Endianness][]>[
       ['<', Endianness.LITTLE], ['>', Endianness.BIG]
     ]) {
  // For now, treat both signed and unsigned integer types as unsigned.
  for (let typeChar of ['u', 'i']) {
    supportedDataTypes.set(`${endiannessChar}${typeChar}2`, {
      arrayConstructor: Uint16Array,
      elementBytes: 2,
      fixEndianness: array => {
        convertEndian16(array, endianness);
      },
      javascriptElementsPerArrayElement: 1,
      dataType: DataType.UINT16,
    });
    supportedDataTypes.set(`${endiannessChar}${typeChar}4`, {
      arrayConstructor: Uint32Array,
      elementBytes: 4,
      fixEndianness: array => {
        convertEndian32(array, endianness);
      },
      javascriptElementsPerArrayElement: 1,
      dataType: DataType.UINT32,
    });
    supportedDataTypes.set(`${endiannessChar}${typeChar}8`, {
      arrayConstructor: Uint32Array,
      elementBytes: 8,
      // We still maintain the low 32-bit value first.
      fixEndianness: array => {
        convertEndian32(array, endianness);
      },
      javascriptElementsPerArrayElement: 2,
      dataType: DataType.UINT64,
    });
  }
  supportedDataTypes.set(`${endiannessChar}f4`, {
    arrayConstructor: Float32Array,
    elementBytes: 4,
    fixEndianness: array => { convertEndian32(array, endianness); },
    javascriptElementsPerArrayElement: 1,
    dataType: DataType.FLOAT32,
  });
}

export class NumpyArray {
  constructor(
      public data: ArrayBufferView, public shape: number[], public dataType: SupportedDataType,
      public fortranOrder: boolean) {}
};

export function parseNpy(x: Uint8Array) {
  // Verify 6-byte magic sequence: 147, 78, 85, 77, 80, 89
  if (x[0] !== 147 || x[1] !== 78 || x[2] !== 85 || x[3] !== 77 || x[4] !== 80 || x[5] !== 89) {
    throw new Error('Data does not match npy format.');
  }
  const majorVersion = x[6], minorVersion = x[7];
  if (majorVersion !== 1 || minorVersion !== 0) {
    throw new Error(`Unsupported npy version ${majorVersion}.${minorVersion}`);
  }
  const dv = new DataView(x.buffer, x.byteOffset, x.byteLength);
  const headerLength = dv.getUint16(8, /*littleEndian=*/true);
  const header = new TextDecoder('utf-8').decode(x.subarray(10, headerLength + 10));
  let headerObject: any;
  const dataOffset = headerLength + 10;
  try {
    headerObject = pythonLiteralParse(header);
  } catch (e) {
    throw new Error(`Failed to parse npy header: ${e}`);
  }
  const dtype = headerObject['descr'];
  let shape = headerObject['shape'];
  let numElements = 1;
  if (!Array.isArray(shape)) {
    throw new Error('Invalid shape ${JSON.stringify(shape)}');
  }
  for (let dim of shape) {
    if (typeof dim !== 'number') {
      throw new Error('Invalid shape ${JSON.stringify(shape)}');
    }
    numElements *= dim;
  }
  const supportedDataType = supportedDataTypes.get(dtype);
  if (supportedDataType === undefined) {
    throw new Error(`Unsupported numpy data type ${JSON.stringify(dtype)}`);
  }
  let {arrayConstructor, javascriptElementsPerArrayElement} = supportedDataType;
  const javascriptElements = javascriptElementsPerArrayElement * numElements;
  const totalDataBytes = arrayConstructor.BYTES_PER_ELEMENT * javascriptElements;
  if (totalDataBytes + dataOffset !== x.byteLength) {
    throw new Error('Expected length does not match length of data');
  }
  const data = new arrayConstructor(x.buffer, x.byteOffset + dataOffset, javascriptElements);
  supportedDataType.fixEndianness(data);
  return new NumpyArray(data, shape, supportedDataType, headerObject['fortran_order'] === true);
}
