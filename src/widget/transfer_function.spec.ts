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

import {
  lerpBetweenControlPoints,
  TRANSFER_FUNCTION_LENGTH,
  NUM_COLOR_CHANNELS,
  ControlPoint,
  defineTransferFunctionShader,
  enableTransferFunctionShader,
} from "#/widget/transfer_function";
import { vec4 } from "#/util/geom";
import { DataType } from "#/util/data_type";
import { fragmentShaderTest } from "#/webgl/shader_testing";
import { defaultDataTypeRange } from "#/util/lerp";
import { Uint64 } from "#/util/uint64";
import { getShaderType } from "#/webgl/shader_lib";

describe("lerpBetweenControlPoints", () => {
  const output = new Uint8Array(NUM_COLOR_CHANNELS * TRANSFER_FUNCTION_LENGTH);
  it("returns transparent black when given no control points", () => {
    const controlPoints: ControlPoint[] = [];
    lerpBetweenControlPoints(output, controlPoints);
    expect(output.every((value) => value === 0)).toBeTruthy();
  });
  it("returns transparent black up to the first control point, and the last control point value after", () => {
    const controlPoints: ControlPoint[] = [
      { position: 120, color: vec4.fromValues(21, 22, 254, 210) },
    ];
    lerpBetweenControlPoints(output, controlPoints);
    expect(
      output.slice(0, NUM_COLOR_CHANNELS * 120).every((value) => value === 0),
    ).toBeTruthy();
    const endPiece = output.slice(NUM_COLOR_CHANNELS * 120);
    const color = controlPoints[0].color;
    expect(
      endPiece.every(
        (value, index) => value === color[index % NUM_COLOR_CHANNELS],
      ),
    ).toBeTruthy();
  });
  it("correctly interpolates between three control points", () => {
    const controlPoints: ControlPoint[] = [
      { position: 120, color: vec4.fromValues(21, 22, 254, 210) },
      { position: 140, color: vec4.fromValues(0, 0, 0, 0) },
      { position: 200, color: vec4.fromValues(255, 255, 255, 255) },
    ];
    lerpBetweenControlPoints(output, controlPoints);
    expect(
      output.slice(0, NUM_COLOR_CHANNELS * 120).every((value) => value === 0),
    ).toBeTruthy();
    expect(
      output.slice(NUM_COLOR_CHANNELS * 200).every((value) => value === 255),
    ).toBeTruthy();

    const firstColor = controlPoints[0].color;
    const secondColor = controlPoints[1].color;
    for (let i = 120 * NUM_COLOR_CHANNELS; i < 140 * NUM_COLOR_CHANNELS; i++) {
      const difference = Math.floor((i - 120 * NUM_COLOR_CHANNELS) / 4);
      const expectedValue =
        firstColor[i % NUM_COLOR_CHANNELS] +
        ((secondColor[i % NUM_COLOR_CHANNELS] -
          firstColor[i % NUM_COLOR_CHANNELS]) *
          difference) /
          20;
      const decimalPart = expectedValue - Math.floor(expectedValue);
      // If the decimal part is 0.5, it could be rounded up or down depending on precision.
      if (Math.abs(decimalPart - 0.5) < 0.001) {
        expect([Math.floor(expectedValue), Math.ceil(expectedValue)]).toContain(
          output[i],
        );
      } else {
        expect(output[i]).toBe(Math.round(expectedValue));
      }
    }

    const thirdColor = controlPoints[2].color;
    for (let i = 140 * NUM_COLOR_CHANNELS; i < 200 * NUM_COLOR_CHANNELS; i++) {
      const difference = Math.floor((i - 140 * NUM_COLOR_CHANNELS) / 4);
      const expectedValue =
        secondColor[i % NUM_COLOR_CHANNELS] +
        ((thirdColor[i % NUM_COLOR_CHANNELS] -
          secondColor[i % NUM_COLOR_CHANNELS]) *
          difference) /
          60;
      const decimalPart = expectedValue - Math.floor(expectedValue);
      // If the decimal part is 0.5, it could be rounded up or down depending on precision.
      if (Math.abs(decimalPart - 0.5) < 0.001) {
        expect([Math.floor(expectedValue), Math.ceil(expectedValue)]).toContain(
          output[i],
        );
      } else {
        expect(output[i]).toBe(Math.round(expectedValue));
      }
    }
  });
});

describe("compute transfer function on GPU", () => {
  const maxTransferFunctionPoints = TRANSFER_FUNCTION_LENGTH - 1;
  const controlPoints: ControlPoint[] = [
    { position: 0, color: vec4.fromValues(0, 0, 0, 0) },
    {
      position: maxTransferFunctionPoints,
      color: vec4.fromValues(255, 255, 255, 255),
    },
  ];
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
