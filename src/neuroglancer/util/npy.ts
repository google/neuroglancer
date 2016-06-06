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

import {pythonLiteralParse} from 'neuroglancer/util/json';
import {DataType} from 'neuroglancer/sliceview/base';
import {TypedArrayConstructor} from 'neuroglancer/util/array';

interface SupportedDataType {
  arrayConstructor: TypedArrayConstructor;
  dataType: DataType;
  elementBytes: number;
  javascriptElementsPerArrayElement: number;
}

const supportedDataTypes = new Map<string, SupportedDataType>();
supportedDataTypes.set('|u1', {
  arrayConstructor: Uint8Array,
  elementBytes: 1,
  javascriptElementsPerArrayElement: 1,
  dataType: DataType.UINT8,
});

supportedDataTypes.set('<u4', {
  arrayConstructor: Uint32Array,
  elementBytes: 4,
  javascriptElementsPerArrayElement: 1,
  dataType: DataType.UINT32,
});

export class NumpyArray {
  constructor(public data: ArrayBufferView, public shape: number[], public dataType: SupportedDataType, public fortranOrder: boolean) {}
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
  const totalDataBytes = supportedDataType.elementBytes * numElements;
  if (totalDataBytes + dataOffset !== x.byteLength) {
    throw new Error('Expected length does not match length of data');
  }
  const data = new (supportedDataType.arrayConstructor)(
      x.buffer, x.byteOffset + dataOffset,
      numElements * supportedDataType.javascriptElementsPerArrayElement);
  return new NumpyArray(data, shape, supportedDataType, headerObject['fortran_order'] === true);
}
