/**
 * @license
 * Copyright 2020 Google Inc.
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
import { Uint64 } from "#src/util/uint64.js";
import {
  glsl_addSaturateInt32,
  glsl_addSaturateUint32,
  glsl_addSaturateUint64,
  glsl_log2Exact,
  glsl_shiftLeftSaturateUint32,
  glsl_subtractSaturateInt32,
  glsl_subtractSaturateUint32,
} from "#src/webgl/shader_lib.js";
import { fragmentShaderTest } from "#src/webgl/shader_testing.js";

describe("glsl_log2Exact", () => {
  it("works for small examples", () => {
    fragmentShaderTest(
      { inputValue: "uint" },
      { outputValue: "uint" },
      (tester) => {
        const { builder } = tester;
        builder.addFragmentCode(glsl_log2Exact);
        builder.setFragmentMain("outputValue = log2Exact(inputValue);");
        for (let i = 0; i < 32; ++i) {
          const j = 2 ** i;
          tester.execute({ inputValue: j });
          const values = tester.values;
          expect(values.outputValue, `i=${i}, 2**i=${j}`).toBe(i);
        }
      },
    );
  });
});

describe("uint32ShiftLeftSaturate", () => {
  it("works for examples", () => {
    fragmentShaderTest(
      { inputValue: "uint", shiftAmount: "int" },
      { outputValue: "uint" },
      (tester) => {
        const { builder } = tester;
        builder.addFragmentCode(glsl_shiftLeftSaturateUint32);
        builder.setFragmentMain(
          "outputValue = shiftLeftSaturate(inputValue, shiftAmount);",
        );
        const compute = (inputValue: number, shiftAmount: number) => {
          tester.execute({ inputValue, shiftAmount });
          return tester.values.outputValue;
        };
        expect(compute(0, 0)).toEqual(0);
        expect(compute(1, 0)).toEqual(1);
        expect(compute(1, 2)).toEqual(4);
        expect(compute(1, 31)).toEqual(0x80000000);
        expect(compute(2, 30)).toEqual(0x80000000);
        expect(compute(2, 31)).toEqual(0xffffffff);
      },
    );
  });
});

describe("uint32AddSaturate", () => {
  it("works for examples", () => {
    fragmentShaderTest(
      { inputA: "uint", inputB: "uint" },
      { outputValue: "uint" },
      (tester) => {
        const { builder } = tester;
        builder.addFragmentCode(glsl_addSaturateUint32);
        builder.setFragmentMain("outputValue = addSaturate(inputA, inputB);");
        const compute = (a: number, b: number) => {
          tester.execute({ inputA: a, inputB: b });
          return tester.values.outputValue;
        };
        expect(compute(0, 0)).toEqual(0);
        expect(compute(1, 2)).toEqual(3);
        expect(compute(0xfffffffd, 1)).toEqual(0xfffffffe);
        expect(compute(1, 0xfffffffd)).toEqual(0xfffffffe);
        expect(compute(0xffffffff, 1)).toEqual(0xffffffff);
        expect(compute(0xffffffff, 2)).toEqual(0xffffffff);
      },
    );
  });
});

describe("uint32SubtractSaturate", () => {
  it("works for examples", () => {
    fragmentShaderTest(
      { inputA: "uint", inputB: "uint" },
      { outputValue: "uint" },
      (tester) => {
        const { builder } = tester;
        builder.addFragmentCode(glsl_subtractSaturateUint32);
        builder.setFragmentMain(
          "outputValue = subtractSaturate(inputA, inputB);",
        );
        const compute = (a: number, b: number) => {
          tester.execute({ inputA: a, inputB: b });
          return tester.values.outputValue;
        };
        expect(compute(0, 0)).toEqual(0);
        expect(compute(2, 1)).toEqual(1);
        expect(compute(1, 2)).toEqual(0);
        expect(compute(0xffffffff, 0xfffffffe)).toEqual(1);
      },
    );
  });
});

describe("int32AddSaturate", () => {
  it("works for examples", () => {
    fragmentShaderTest(
      { inputA: "int", inputB: "uint" },
      { outputValue: "int" },
      (tester) => {
        const { builder } = tester;
        builder.addFragmentCode(glsl_addSaturateInt32);
        builder.setFragmentMain("outputValue = addSaturate(inputA, inputB);");
        const compute = (a: number, b: number) => {
          tester.execute({ inputA: a, inputB: b });
          return tester.values.outputValue;
        };
        expect(compute(0, 0)).toEqual(0);
        expect(compute(2, 1)).toEqual(3);
        expect(compute(-7, 5)).toEqual(-2);
        expect(compute(0, 0xffffffff)).toEqual(0x7fffffff);
        expect(compute(0, 0x7fffffff)).toEqual(0x7fffffff);
        expect(compute(1, 0xffffffff)).toEqual(0x7fffffff);
        expect(compute(-5, 0x7fffffff)).toEqual(0x7ffffffa);
        expect(compute(-0x80000000, 0x7fffffff)).toEqual(-1);
        expect(compute(2, 0x7fffffff)).toEqual(0x7fffffff);
      },
    );
  });
});

describe("int32SubtractSaturate", () => {
  it("works for examples", () => {
    fragmentShaderTest(
      { inputA: "int", inputB: "uint" },
      { outputValue: "int" },
      (tester) => {
        const { builder } = tester;
        builder.addFragmentCode(glsl_subtractSaturateInt32);
        builder.setFragmentMain(
          "outputValue = subtractSaturate(inputA, inputB);",
        );
        const compute = (a: number, b: number) => {
          tester.execute({ inputA: a, inputB: b });
          return tester.values.outputValue;
        };
        expect(compute(0, 0)).toEqual(0);
        expect(compute(2, 1)).toEqual(1);
        expect(compute(1, 2)).toEqual(-1);
        expect(compute(-5, 3)).toEqual(-8);
        expect(compute(-5, 0xffffffff)).toEqual(-0x80000000);
        expect(compute(-0x7fffffff, 1)).toEqual(-0x80000000);
      },
    );
  });
});

describe("uint64AddSaturate", () => {
  const u64 = Uint64.parseString;
  it("works for examples", () => {
    fragmentShaderTest(
      { inputA: DataType.UINT64, inputB: DataType.UINT64 },
      { outputValue: DataType.UINT64 },
      (tester) => {
        const { builder } = tester;
        builder.addFragmentCode(glsl_addSaturateUint64);
        builder.setFragmentMain("outputValue = addSaturate(inputA, inputB);");

        for (const [a, b, expected] of [
          ["0", "0", "0"],
          ["1", "2", "3"],
          ["fffffffffffffffd", "1", "fffffffffffffffe"],
          ["fffffffffffffffd", "2", "ffffffffffffffff"],
          ["fffffffffffffffd", "3", "ffffffffffffffff"],
          ["1", "fffffffffffffffd", "fffffffffffffffe"],
          ["2", "fffffffffffffffd", "ffffffffffffffff"],
          ["3", "fffffffffffffffd", "ffffffffffffffff"],
          ["1", "ffffffffffffffff", "ffffffffffffffff"],
        ]) {
          const msg = `addSaturate(${a}, ${b}) = ${expected}`;
          tester.execute({ inputA: u64(a, 16), inputB: u64(b, 16) });
          const result = tester.values.outputValue;
          expect(result.toString(16), msg).toBe(u64(expected, 16).toString(16));
        }
      },
    );
  });
});
