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

import { describe, it, expect } from "vitest";
import { fragmentShaderTest } from "#src/webgl/shader_testing.js";

describe("FragmentShaderTester", () => {
  it("uint passthrough", () => {
    fragmentShaderTest(
      { inputValue: "uint" },
      { outputValue: "uint" },
      (tester) => {
        const { builder } = tester;
        builder.setFragmentMain("outputValue = inputValue;");
        tester.build();
        const { shader } = tester;
        shader.bind();
        for (const inputValue of [0, 1, 42, 343432, 4294967295]) {
          tester.execute({ inputValue });
          const values = tester.values;
          expect(values.outputValue).toEqual(inputValue);
        }
      },
    );
  });

  it("float passthrough", () => {
    fragmentShaderTest(
      { inputValue: "float" },
      { outputValue: "float" },
      (tester) => {
        const { builder } = tester;
        builder.setFragmentMain("outputValue = inputValue;");
        tester.build();
        function generateRandomNumber() {
          const buf = new Uint32Array(1);
          const temp = new Float32Array(buf.buffer);
          do {
            crypto.getRandomValues(buf);
          } while (!Number.isNaN(temp[0]));
          return temp[0];
        }

        const { shader } = tester;
        shader.bind();
        const testValues = [0, 1, -1, 2, -2, 3, -3, 5, -5, 1.5, -1.5];
        const count = 100;
        for (let i = 0; i < count; ++i) {
          testValues.push(generateRandomNumber());
        }
        for (const inputValue of testValues) {
          tester.execute({ inputValue });
          const values = tester.values;
          expect(values.outputValue).toEqual(inputValue);
        }
      },
    );
  });

  it("float uint passthrough", () => {
    fragmentShaderTest(
      { floatInput: "float", uintInput: "uint" },
      { floatOutput: "float", uintOutput: "uint" },
      (tester) => {
        const { builder } = tester;
        builder.setFragmentMain(`
  floatOutput = floatInput;
  uintOutput = uintInput;
`);
        tester.build();
        function generateRandomNumber() {
          const buf = new Uint32Array(1);
          const temp = new Float32Array(buf.buffer);
          do {
            crypto.getRandomValues(buf);
          } while (
            !Number.isFinite(temp[0]) ||
            (temp[0] !== 0 && Math.abs(Math.log2(Math.abs(temp[0]))) > 125)
          );
          return temp[0];
        }

        const { shader } = tester;
        shader.bind();
        const testFloatValues = [5, 0, 1, -1, 2, -2, 3, -3, 5, -5, 1.5, -1.5];
        const testUintValues = [
          7, 1, 5, 10, 33, 27, 55, 7, 5, 3, 343432, 4294967295,
        ];
        const count = 100;
        for (let i = 0; i < count; ++i) {
          testFloatValues.push(generateRandomNumber());
          testUintValues.push(i);
        }
        for (let i = 0; i < testUintValues.length; ++i) {
          const floatInput = testFloatValues[i];
          const uintInput = testUintValues[i];
          tester.execute({ floatInput, uintInput });
          const values = tester.values;
          expect(values.floatOutput).toEqual(floatInput);
          expect(values.uintOutput).toEqual(uintInput);
        }
      },
    );
  });
});
