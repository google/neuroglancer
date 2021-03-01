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
 * @file Support for parsing NumPy dtype strings.
 */

import {DataType} from 'neuroglancer/util/data_type';
import {Endianness} from 'neuroglancer/util/endian';

export interface NumpyDtype {
  dataType: DataType;
  endianness: Endianness;
}

const supportedDataTypes = new Map<string, NumpyDtype>();
supportedDataTypes.set('|u1', {
  endianness: Endianness.LITTLE,
  dataType: DataType.UINT8,
});
supportedDataTypes.set('|i1', {
  endianness: Endianness.LITTLE,
  dataType: DataType.INT8,
});
for (let [endiannessChar, endianness] of <[string, Endianness][]>[
       ['<', Endianness.LITTLE], ['>', Endianness.BIG]
     ]) {
  // For now, treat both signed and unsigned integer types as unsigned.
  for (let typeChar of ['u', 'i']) {
    supportedDataTypes.set(`${endiannessChar}${typeChar}8`, {
      endianness,
      dataType: DataType.UINT64,
    });
  }
  supportedDataTypes.set(`${endiannessChar}u2`, {
    endianness,
    dataType: DataType.UINT16,
  });

  supportedDataTypes.set(`${endiannessChar}i2`, {
    endianness,
    dataType: DataType.INT16,
  });

  supportedDataTypes.set(`${endiannessChar}u4`, {
    endianness,
    dataType: DataType.UINT32,
  });

  supportedDataTypes.set(`${endiannessChar}i4`, {
    endianness,
    dataType: DataType.INT32,
  });

  supportedDataTypes.set(`${endiannessChar}f4`, {
    endianness,
    dataType: DataType.FLOAT32,
  });
}

export function parseNumpyDtype(typestr: unknown): NumpyDtype {
  const dtype = supportedDataTypes.get(typestr as any);
  if (dtype === undefined) {
    throw new Error(`Unsupported numpy data type: ${JSON.stringify(typestr)}`);
  }
  return dtype;
}
