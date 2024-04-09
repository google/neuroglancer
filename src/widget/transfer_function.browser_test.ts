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
import { TrackableValue } from "#src/trackable_value.js";
import { DataType } from "#src/util/data_type.js";
import { vec3, vec4 } from "#src/util/geom.js";
import { defaultDataTypeRange } from "#src/util/lerp.js";

import { Uint64 } from "#src/util/uint64.js";
import { getShaderType } from "#src/webgl/shader_lib.js";
import { fragmentShaderTest } from "#src/webgl/shader_testing.js";
import type { TransferFunctionParameters } from "#src/widget/transfer_function.js";
import {
  SortedControlPoints,
  ControlPoint,
  LookupTable,
  TransferFunction,
  NUM_COLOR_CHANNELS,
  defineTransferFunctionShader,
  enableTransferFunctionShader,
} from "#src/widget/transfer_function.js";

const FIXED_TRANSFER_FUNCTION_LENGTH = 1024;

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
        size: FIXED_TRANSFER_FUNCTION_LENGTH,
      },
      (x) => x,
    ),
  );
}

describe("lerpBetweenControlPoints", () => {
  const output = new Uint8Array(
    NUM_COLOR_CHANNELS * FIXED_TRANSFER_FUNCTION_LENGTH,
  );
  it("returns transparent black when given no control points for base classes", () => {
    const controlPoints: ControlPoint[] = [];
    const range = defaultDataTypeRange[DataType.UINT8];
    const sortedControlPoints = new SortedControlPoints(controlPoints, range);
    const lookupTable = new LookupTable(FIXED_TRANSFER_FUNCTION_LENGTH);
    lookupTable.updateFromControlPoints(sortedControlPoints);

    expect(output.every((value) => value === 0)).toBeTruthy();
  });
  it("returns transparent black when given no control points for the transfer function class", () => {
    const transferFunction = makeTransferFunction([]);
    expect(
      transferFunction.lookupTable.outputValues.every((value) => value === 0),
    ).toBeTruthy();
  });
  it("returns transparent black up to the first control point, and the last control point value after", () => {
    const controlPoints: ControlPoint[] = [
      new ControlPoint(120, vec4.fromValues(21, 22, 254, 210)),
    ];
    const transferFunction = makeTransferFunction(controlPoints);
    const output = transferFunction.lookupTable.outputValues;
    const firstPointTransferIndex = transferFunction.toLookupTableIndex(0)!;

    expect(
      output
        .slice(0, NUM_COLOR_CHANNELS * firstPointTransferIndex)
        .every((value) => value === 0),
    ).toBeTruthy();
    const endPiece = output.slice(NUM_COLOR_CHANNELS * firstPointTransferIndex);
    const color = controlPoints[0].outputColor;
    expect(
      endPiece.every(
        (value, index) => value === color[index % NUM_COLOR_CHANNELS],
      ),
    ).toBeTruthy();
  });
  it("correctly interpolates between three control points", () => {
    const controlPoints: ControlPoint[] = [
      new ControlPoint(140, vec4.fromValues(0, 0, 0, 0)),
      new ControlPoint(120, vec4.fromValues(21, 22, 254, 210)),
      new ControlPoint(200, vec4.fromValues(255, 255, 255, 255)),
    ];
    const transferFunction = makeTransferFunction(controlPoints);
    const output = transferFunction.lookupTable.outputValues;
    const firstPointTransferIndex = transferFunction.toLookupTableIndex(0)!;
    const secondPointTransferIndex = transferFunction.toLookupTableIndex(1)!;
    const thirdPointTransferIndex = transferFunction.toLookupTableIndex(2)!;
    expect(firstPointTransferIndex).toBe(
      Math.floor((120 / 255) * (FIXED_TRANSFER_FUNCTION_LENGTH - 1)),
    );
    expect(secondPointTransferIndex).toBe(
      Math.floor((140 / 255) * (FIXED_TRANSFER_FUNCTION_LENGTH - 1)),
    );
    expect(thirdPointTransferIndex).toBe(
      Math.floor((200 / 255) * (FIXED_TRANSFER_FUNCTION_LENGTH - 1)),
    );

    // Transparent black up to the first control point
    expect(
      output
        .slice(0, NUM_COLOR_CHANNELS * firstPointTransferIndex)
        .every((value) => value === 0),
    ).toBeTruthy();
    // The last control point value after the last control point
    expect(
      output
        .slice(NUM_COLOR_CHANNELS * thirdPointTransferIndex)
        .every((value) => value === 255),
    ).toBeTruthy();

    // Performs linear interpolation between the first and second control points
    const firstColor =
      transferFunction.sortedControlPoints.controlPoints[0].outputColor;
    const secondColor =
      transferFunction.sortedControlPoints.controlPoints[1].outputColor;
    const firstToSecondDifference =
      secondPointTransferIndex - firstPointTransferIndex;
    for (
      let i = firstPointTransferIndex * NUM_COLOR_CHANNELS;
      i < secondPointTransferIndex * NUM_COLOR_CHANNELS;
      i++
    ) {
      const t =
        Math.floor(i / NUM_COLOR_CHANNELS - firstPointTransferIndex) /
        firstToSecondDifference;
      const difference =
        secondColor[i % NUM_COLOR_CHANNELS] -
        firstColor[i % NUM_COLOR_CHANNELS];
      const expectedValue = firstColor[i % NUM_COLOR_CHANNELS] + t * difference;
      // If the decimal part is 0.5, it could be rounded up or down depending on precision.
      const decimalPart = expectedValue - Math.floor(expectedValue);
      if (Math.abs(decimalPart - 0.5) < 0.001) {
        expect([Math.floor(expectedValue), Math.ceil(expectedValue)]).toContain(
          output[i],
        );
      } else {
        expect(output[i]).toBe(Math.round(expectedValue));
      }
    }

    // Performs linear interpolation between the second and third control points
    const thirdColor =
      transferFunction.sortedControlPoints.controlPoints[2].outputColor;
    const secondToThirdDifference =
      thirdPointTransferIndex - secondPointTransferIndex;
    for (
      let i = secondPointTransferIndex * NUM_COLOR_CHANNELS;
      i < thirdPointTransferIndex * NUM_COLOR_CHANNELS;
      i++
    ) {
      const t =
        Math.floor(i / NUM_COLOR_CHANNELS - secondPointTransferIndex) /
        secondToThirdDifference;
      const difference =
        thirdColor[i % NUM_COLOR_CHANNELS] -
        secondColor[i % NUM_COLOR_CHANNELS];
      const expectedValue =
        secondColor[i % NUM_COLOR_CHANNELS] + t * difference;
      // If the decimal part is 0.5, it could be rounded up or down depending on precision.
      const decimalPart = expectedValue - Math.floor(expectedValue);
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

const textureSizes = {
  [DataType.UINT8]: 0xff,
  [DataType.INT8]: 0xff,
  [DataType.UINT16]: 200,
  [DataType.INT16]: 8192,
  [DataType.UINT32]: 0xffff,
  [DataType.INT32]: 0xffff,
  [DataType.UINT64]: 0xffff,
  [DataType.FLOAT32]: 0xffff,
};

describe("compute transfer function on GPU", () => {
  for (const dataType of Object.values(DataType)) {
    if (typeof dataType === "string") continue;
    const range = defaultDataTypeRange[dataType];
    const controlPoints = new SortedControlPoints(
      [
        new ControlPoint(range[0], vec4.fromValues(0, 0, 0, 0)),
        new ControlPoint(range[1], vec4.fromValues(255, 255, 255, 255)),
      ],
      range,
    );
    it(`computes transfer function between transparent black and opaque white on GPU for ${DataType[dataType]}`, () => {
      const shaderType = getShaderType(dataType);
      fragmentShaderTest(
        { inputValue: dataType },
        {
          val1: "float",
          val2: "float",
          val3: "float",
          val4: "float",
          val5: "float",
        },
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
val5 = uTransferFunctionEnd_doTransferFunction;
`);
          const { shader } = tester;
          const testShader = (point: any) => {
            enableTransferFunctionShader(
              shader,
              "doTransferFunction",
              dataType,
              controlPoints,
              defaultDataTypeRange[dataType],
              textureSizes[dataType],
            );
            tester.execute({ inputValue: point });
            const values = tester.values;
            return {
              color: vec4.fromValues(
                values.val1,
                values.val2,
                values.val3,
                values.val4,
              ),
              size: values.val5,
            };
          };
          const minValue = defaultDataTypeRange[dataType][0];
          const maxValue = defaultDataTypeRange[dataType][1];
          const gl = tester.gl;
          const usedSize = Math.min(
            textureSizes[dataType],
            gl.getParameter(gl.MAX_TEXTURE_SIZE),
          );
          {
            const { color, size } = testShader(minValue);
            expect(size).toBe(usedSize - 1);
            expect(color).toEqual(vec4.fromValues(0, 0, 0, 0));
          }
          {
            const { color, size } = testShader(maxValue);
            expect(size).toBe(usedSize - 1);
            expect(color).toEqual(vec4.fromValues(1, 1, 1, 1));
          }
          let position: number | Uint64;
          if (dataType !== DataType.UINT64) {
            const minValueNumber = minValue as number;
            const maxValueNumber = maxValue as number;
            position = (maxValueNumber + minValueNumber) / 2;
          } else {
            const value = (maxValue as Uint64).toNumber() / 2;
            position = Uint64.fromNumber(value);
          }
          const { color, size } = testShader(position);
          expect(size).toBe(usedSize - 1);
          for (let i = 0; i < 3; i++) {
            expect(color[i]).toBeCloseTo(0.5);
          }
        },
      );
    });
  }
});
