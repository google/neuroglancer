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

import {TypedArrayConstructor} from 'neuroglancer/util/array';

/**
 * If this is updated, DATA_TYPE_BYTES must also be updated.
 */
export enum DataType {
  UINT8,
  INT8,
  UINT16,
  INT16,
  UINT32,
  INT32,
  UINT64,
  FLOAT32,
}

export const DATA_TYPE_SIGNED: Record<DataType, boolean|undefined> = {
  [DataType.UINT8]: false,
  [DataType.INT8]: true,
  [DataType.UINT16]: false,
  [DataType.INT16]: true,
  [DataType.UINT32]: false,
  [DataType.INT32]: true,
  [DataType.UINT64]: false,
  [DataType.FLOAT32]: undefined,
};

export const DATA_TYPE_BYTES: Record<DataType, number> = {
  [DataType.UINT8]: 1,
  [DataType.INT8]: 1,
  [DataType.UINT16]: 2,
  [DataType.INT16]: 2,
  [DataType.UINT32]: 4,
  [DataType.INT32]: 4,
  [DataType.UINT64]: 8,
  [DataType.FLOAT32]: 4,
};

export const DATA_TYPE_ARRAY_CONSTRUCTOR: Record<DataType, TypedArrayConstructor> = {
  [DataType.UINT8]: Uint8Array,
  [DataType.INT8]: Int8Array,
  [DataType.UINT16]: Uint16Array,
  [DataType.INT16]: Int16Array,
  [DataType.UINT32]: Uint32Array,
  [DataType.INT32]: Int32Array,
  [DataType.UINT64]: Uint32Array,
  [DataType.FLOAT32]: Float32Array,
};

export const DATA_TYPE_JAVASCRIPT_ELEMENTS_PER_ARRAY_ELEMENT: Record<DataType, number> = {
  [DataType.UINT8]: 1,
  [DataType.INT8]: 1,
  [DataType.UINT16]: 1,
  [DataType.INT16]: 1,
  [DataType.UINT32]: 1,
  [DataType.INT32]: 1,
  [DataType.UINT64]: 2,
  [DataType.FLOAT32]: 1,
};

export function makeDataTypeArrayView(
    dataType: DataType, buffer: ArrayBuffer, byteOffset: number = 0,
    byteLength: number = buffer.byteLength): ArrayBufferView {
  const bytesPerElement = DATA_TYPE_BYTES[dataType];
  const javascriptElementsPerArrayElement =
      DATA_TYPE_JAVASCRIPT_ELEMENTS_PER_ARRAY_ELEMENT[dataType];
  return new DATA_TYPE_ARRAY_CONSTRUCTOR[dataType](
      buffer, byteOffset, byteLength / bytesPerElement * javascriptElementsPerArrayElement);
}
