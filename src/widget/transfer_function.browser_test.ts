/**
 * @license
 * Copyright 2024 Google Inc.
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
import { vec3, vec4 } from "#src/util/geom.js";
import { defaultDataTypeRange } from "#src/util/lerp.js";
import { Uint64 } from "#src/util/uint64.js";
import { getShaderType } from "#src/webgl/shader_lib.js";
import { fragmentShaderTest } from "#src/webgl/shader_testing.js";
import {
  SortedControlPoints,
  ControlPoint,
  LookupTable,
  TransferFunction,
  TransferFunctionParameters,
  NUM_COLOR_CHANNELS,
  defineTransferFunctionShader,
  enableTransferFunctionShader,
} from "#src/widget/transfer_function.js";
import { TrackableValue } from "#src/trackable_value.js";

const TRANSFER_FUNCTION_LENGTH = 512;

function makeTransferFunction(controlPoints: ControlPoint[]) {
  const range = defaultDataTypeRange[DataType.UINT8];
  const sortedControlPoints = new SortedControlPoints(controlPoints, range);
  return new TransferFunction(
    DataType.UINT8,
    new TrackableValue<TransferFunctionParameters>(
      {
        sortedControlPoints,
        range: range,
        window: range,
        defaultColor: vec3.fromValues(0, 0, 0),
        channel: [],
        size: TRANSFER_FUNCTION_LENGTH,
      },
      (x) => x,
    ),
  );
}

describe("compute transfer function on GPU", () => {
  const maxTransferFunctionPoints = TRANSFER_FUNCTION_LENGTH - 1;
  const controlPoints = new SortedControlPoints(
    [
      new ControlPoint(0, vec4.fromValues(0, 0, 0, 0)),
      new ControlPoint(
        maxTransferFunctionPoints,
        vec4.fromValues(255, 255, 255, 255),
      ),
    ],
    defaultDataTypeRange[DataType.UINT8],
  );
  for (const dataType of Object.values(DataType)) {
    if (typeof dataType === "string") continue;
    it(`computes transfer function on GPU for ${DataType[dataType]}`, () => {
      const shaderType = getShaderType(dataType);
      fragmentShaderTest(
        { inputValue: dataType },
        { val1: "float", val2: "float", val3: "float", val4: "float" },
        (tester) => {
          const { builder } = tester;
          builder.addFragmentCode(`
${shaderType} getInterpolatedDataValue() {
    return inputValue;
}`);
          builder.addFragmentCode(
            defineTransferFunctionShader(
              builder,
              "doTransferFunction",
              dataType,
              [],
            ),
          );
          builder.setFragmentMain(`
vec4 result = doTransferFunction(inputValue);
val1 = result.r;
val2 = result.g;
val3 = result.b;
val4 = result.a;
`);
          const { shader } = tester;
          const testShader = (point: any) => {
            enableTransferFunctionShader(
              shader,
              "doTransferFunction",
              dataType,
              controlPoints,
              defaultDataTypeRange[dataType],
              TRANSFER_FUNCTION_LENGTH,
            );
            tester.execute({ inputValue: point });
            const values = tester.values;
            return vec4.fromValues(
              values.val1,
              values.val2,
              values.val3,
              values.val4,
            );
          };
          const minValue = defaultDataTypeRange[dataType][0];
          const maxValue = defaultDataTypeRange[dataType][1];
          let color = testShader(minValue);
          expect(color).toEqual(vec4.fromValues(0, 0, 0, 0));
          color = testShader(maxValue);
          expect(color).toEqual(vec4.fromValues(1, 1, 1, 1));
          if (dataType !== DataType.UINT64) {
            const minValueNumber = minValue as number;
            const maxValueNumber = maxValue as number;
            color = testShader((maxValueNumber + minValueNumber) / 2);
            for (let i = 0; i < 3; i++) {
              expect(color[i]).toBeCloseTo(0.5);
            }
          } else {
            const value = (maxValue as Uint64).toNumber() / 2;
            const position = Uint64.fromNumber(value);
            color = testShader(position);
            for (let i = 0; i < 3; i++) {
              expect(color[i]).toBeCloseTo(0.5);
            }
          }
        },
      );
    });
  }
});
