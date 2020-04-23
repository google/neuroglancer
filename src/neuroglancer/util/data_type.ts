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

interface DataTypeBytes {
  [index: number]: number;
}

export const DATA_TYPE_SIGNED: boolean[] = [];
DATA_TYPE_SIGNED[DataType.UINT8] = false;
DATA_TYPE_SIGNED[DataType.INT8] = true;
DATA_TYPE_SIGNED[DataType.UINT16] = false;
DATA_TYPE_SIGNED[DataType.INT16] = true;
DATA_TYPE_SIGNED[DataType.UINT32] = false;
DATA_TYPE_SIGNED[DataType.INT32] = true;
DATA_TYPE_SIGNED[DataType.UINT64] = false;

export const DATA_TYPE_BYTES: DataTypeBytes = [];
DATA_TYPE_BYTES[DataType.UINT8] = 1;
DATA_TYPE_BYTES[DataType.INT8] = 1;
DATA_TYPE_BYTES[DataType.UINT16] = 2;
DATA_TYPE_BYTES[DataType.INT16] = 2;
DATA_TYPE_BYTES[DataType.UINT32] = 4;
DATA_TYPE_BYTES[DataType.INT32] = 4;
DATA_TYPE_BYTES[DataType.UINT64] = 8;
DATA_TYPE_BYTES[DataType.FLOAT32] = 4;
