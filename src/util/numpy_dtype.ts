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

import { Endianness } from "#src/util/endian.js";
import type { SourceDataType } from "#src/util/source_data_type.js";
import { getSourceDataType } from "#src/util/source_data_type.js";

export interface NumpyDtype {
  sourceDataType: SourceDataType;
  endianness: Endianness;
}

const supportedDataTypes = new Map<
  string,
  { name: string; endianness: Endianness }
>();
supportedDataTypes.set("|u1", { endianness: Endianness.LITTLE, name: "uint8" });
supportedDataTypes.set("|i1", { endianness: Endianness.LITTLE, name: "int8" });
for (const [endiannessChar, endianness] of <[string, Endianness][]>[
  ["<", Endianness.LITTLE],
  [">", Endianness.BIG],
]) {
  for (const [typeChar, size, name] of <[string, number, string][]>[
    ["u", 2, "uint16"],
    ["i", 2, "int16"],
    ["u", 4, "uint32"],
    ["i", 4, "int32"],
    ["u", 8, "uint64"],
    ["i", 8, "int64"],
    ["f", 2, "float16"],
    ["f", 4, "float32"],
    ["f", 8, "float64"],
  ]) {
    supportedDataTypes.set(`${endiannessChar}${typeChar}${size}`, {
      endianness,
      name,
    });
  }
}

export function parseNumpyDtype(typestr: unknown): NumpyDtype {
  const dtype = supportedDataTypes.get(typestr as any);
  if (dtype === undefined) {
    throw new Error(`Unsupported numpy data type: ${JSON.stringify(typestr)}`);
  }
  return {
    sourceDataType: getSourceDataType(dtype.name),
    endianness: dtype.endianness,
  };
}
