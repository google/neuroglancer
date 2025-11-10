/**
 * @license
 * Copyright 2025 Google Inc.
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

import { describe, it, expect } from "vitest";
import { DataType } from "#src/util/data_type.js";
import { getShaderTypeDefines } from "#src/webgl/shader_lib.js";

function expectExactlyOneTypeSet(result: string) {
  const ones = (result.match(/DATA_VALUE_TYPE_IS_\w+ 1/g) || []).length;
  expect(ones).toBe(1);
}

describe("getShaderTypeDefines", () => {
  it("includes all possible shader types as defines", () => {
    const result = getShaderTypeDefines(DataType.FLOAT32);
    expect(result.split("\n").length).toEqual(1+8); // 1 for DATA_VALUE_TYPE and 8 for DATA_VALUE_TYPE_IS_*

    // Check that all float types are included
    expect(result).toContain("DATA_VALUE_TYPE_IS_FLOAT");
    expect(result).toContain("DATA_VALUE_TYPE_IS_UINT8_T");
    expect(result).toContain("DATA_VALUE_TYPE_IS_INT8_T");
    expect(result).toContain("DATA_VALUE_TYPE_IS_UINT16_T")
    expect(result).toContain("DATA_VALUE_TYPE_IS_INT16_T");
    expect(result).toContain("DATA_VALUE_TYPE_IS_UINT32_T");
    expect(result).toContain("DATA_VALUE_TYPE_IS_INT32_T");
    expect(result).toContain("DATA_VALUE_TYPE_IS_UINT64_T");
  });

  it("generates correct defines for FLOAT32", () => {
    const result = getShaderTypeDefines(DataType.FLOAT32);
    expect(result).toContain("#define DATA_VALUE_TYPE float");
    expect(result).toContain("#define DATA_VALUE_TYPE_IS_FLOAT 1");
    expectExactlyOneTypeSet(result);
  });

  it("generates correct defines for UINT8", () => {
    const result = getShaderTypeDefines(DataType.UINT8);
    expect(result).toContain("#define DATA_VALUE_TYPE uint8_t");
    expect(result).toContain("#define DATA_VALUE_TYPE_IS_UINT8_T 1");
    expectExactlyOneTypeSet(result);
  });
});
