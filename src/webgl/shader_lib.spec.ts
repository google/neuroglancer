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
    const result = getShaderTypeDefines(DataType.FLOAT32, 1);
    expect(result.split("\n").length).toEqual(20); // 1 for DATA_VALUE_TYPE and 19 for DATA_VALUE_TYPE_IS_*

    // Check that all float types are included
    expect(result).toContain("DATA_VALUE_TYPE_IS_FLOAT");
    expect(result).toContain("DATA_VALUE_TYPE_IS_VEC2");
    expect(result).toContain("DATA_VALUE_TYPE_IS_VEC3");
    expect(result).toContain("DATA_VALUE_TYPE_IS_VEC4");

    // Check that uint8 types are included
    expect(result).toContain("DATA_VALUE_TYPE_IS_UINT8_T");
    expect(result).toContain("DATA_VALUE_TYPE_IS_UINT8X2_T");
    expect(result).toContain("DATA_VALUE_TYPE_IS_UINT8X3_T");
    expect(result).toContain("DATA_VALUE_TYPE_IS_UINT8X4_T");

    // Check that int8 types are included
    expect(result).toContain("DATA_VALUE_TYPE_IS_INT8_T");
    expect(result).toContain("DATA_VALUE_TYPE_IS_INT8X2_T");
    expect(result).toContain("DATA_VALUE_TYPE_IS_INT8X3_T");
    expect(result).toContain("DATA_VALUE_TYPE_IS_INT8X4_T");

    // Check that uint16 types are included
    expect(result).toContain("DATA_VALUE_TYPE_IS_UINT16_T");
    expect(result).toContain("DATA_VALUE_TYPE_IS_UINT16X2_T");

    // Check that int16 types are included
    expect(result).toContain("DATA_VALUE_TYPE_IS_INT16_T");
    expect(result).toContain("DATA_VALUE_TYPE_IS_INT16X2_T");

    // Check that uint32, int32, uint64 types are included
    expect(result).toContain("DATA_VALUE_TYPE_IS_UINT32_T");
    expect(result).toContain("DATA_VALUE_TYPE_IS_INT32_T");
    expect(result).toContain("DATA_VALUE_TYPE_IS_UINT64_T");
  });

  it("generates correct defines for FLOAT32 with 1 component", () => {
    const result = getShaderTypeDefines(DataType.FLOAT32, 1);
    expect(result).toContain("#define DATA_VALUE_TYPE float");
    expect(result).toContain("#define DATA_VALUE_TYPE_IS_FLOAT 1");
    expectExactlyOneTypeSet(result);
  });

  it("generates correct defines for FLOAT32 with 4 components", () => {
    const result = getShaderTypeDefines(DataType.FLOAT32, 4);
    expect(result).toContain("#define DATA_VALUE_TYPE vec4");
    expect(result).toContain("#define DATA_VALUE_TYPE_IS_VEC4 1");
    expectExactlyOneTypeSet(result);
  });

  it("generates correct defines for UINT8 with 1 component", () => {
    const result = getShaderTypeDefines(DataType.UINT8, 1);
    expect(result).toContain("#define DATA_VALUE_TYPE uint8_t");
    expect(result).toContain("#define DATA_VALUE_TYPE_IS_UINT8_T 1");
    expectExactlyOneTypeSet(result);
  });

  it("generates correct defines for UINT8 with 4 components", () => {
    const result = getShaderTypeDefines(DataType.UINT8, 4);
    expect(result).toContain("#define DATA_VALUE_TYPE uint8x4_t");
    expect(result).toContain("#define DATA_VALUE_TYPE_IS_UINT8X4_T 1");
    expectExactlyOneTypeSet(result);
  });

  it("generates correct defines for INT16 with 2 components", () => {
    const result = getShaderTypeDefines(DataType.INT16, 2);
    expect(result).toContain("#define DATA_VALUE_TYPE int16x2_t");
    expect(result).toContain("#define DATA_VALUE_TYPE_IS_INT16X2_T 1");
    expectExactlyOneTypeSet(result);
  });

  it("generates correct defines for UINT32 with 1 component", () => {
    const result = getShaderTypeDefines(DataType.UINT32, 1);
    expect(result).toContain("#define DATA_VALUE_TYPE uint32_t");
    expect(result).toContain("#define DATA_VALUE_TYPE_IS_UINT32_T 1");
    expectExactlyOneTypeSet(result);
  });

  it("generates correct defines for UINT64 with 1 component", () => {
    const result = getShaderTypeDefines(DataType.UINT64, 1);
    expect(result).toContain("#define DATA_VALUE_TYPE uint64_t");
    expect(result).toContain("#define DATA_VALUE_TYPE_IS_UINT64_T 1");
    expectExactlyOneTypeSet(result);
  });

  it("defaults to numComponents=1 when not specified", () => {
    const result = getShaderTypeDefines(DataType.FLOAT32);
    expect(result).toContain("#define DATA_VALUE_TYPE float");
    expect(result).toContain("#define DATA_VALUE_TYPE_IS_FLOAT 1");
    expectExactlyOneTypeSet(result);
  });
});
