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
import {
  computeLerp,
  dataTypeIntervalEqual,
  defaultDataTypeRange,
} from "#src/util/lerp.js";

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
  const sortedControlPoints = new SortedControlPoints(
    controlPoints,
    DataType.UINT8,
  );
  return new TransferFunction(
    DataType.UINT8,
    new TrackableValue<TransferFunctionParameters>(
      {
        sortedControlPoints,
        window: defaultDataTypeRange[DataType.UINT8],
        defaultColor: vec3.fromValues(0, 0, 0),
        channel: [],
      },
      (x) => x,
    ),
  );
}

describe("Create default transfer function", () => {
  for (const dataType of Object.values(DataType)) {
    if (typeof dataType === "string") continue;
    const transferFunction = new TransferFunction(
      dataType,
      new TrackableValue<TransferFunctionParameters>(
        {
          sortedControlPoints: new SortedControlPoints([], dataType),
          window: defaultDataTypeRange[dataType],
          defaultColor: vec3.fromValues(1, 0.2, 1),
          channel: [],
        },
        (x) => x,
      ),
    );
    it(`Creates two default transfer function points for ${DataType[dataType]} over the default window`, () => {
      transferFunction.generateDefaultControlPoints();
      expect(transferFunction.sortedControlPoints.controlPoints.length).toBe(2);
      const firstPoint = transferFunction.sortedControlPoints.controlPoints[0];
      const lastPoint = transferFunction.sortedControlPoints.controlPoints[1];
      const range = defaultDataTypeRange[dataType];
      const actualFirstPoint = computeLerp(range, dataType, 0.3);
      const actualLastPoint = computeLerp(range, dataType, 0.7);
      expect(firstPoint.inputValue).toStrictEqual(actualFirstPoint);
      expect(lastPoint.inputValue).toStrictEqual(actualLastPoint);
      expect(firstPoint.outputColor).toEqual(vec4.fromValues(0, 0, 0, 0));
      expect(lastPoint.outputColor).toEqual(vec4.fromValues(255, 51, 255, 255));
    });
    it(`Creates two default transfer function points for ${DataType[dataType]} over a custom window`, () => {
      const window =
        dataType === DataType.UINT64
<<<<<<< HEAD
          ? ([0n, 100n] as [bigint, bigint])
=======
          ? ([Uint64.ZERO, Uint64.fromNumber(100)] as [Uint64, Uint64])
>>>>>>> 0aacf094 (Ichnaea working code on top of v2.40.1)
          : ([0, 100] as [number, number]);
      transferFunction.generateDefaultControlPoints(null, window);
      expect(transferFunction.sortedControlPoints.controlPoints.length).toBe(2);
      const firstPoint = transferFunction.sortedControlPoints.controlPoints[0];
      const lastPoint = transferFunction.sortedControlPoints.controlPoints[1];
      const actualFirstPoint = computeLerp(window, dataType, 0.3);
      const actualLastPoint = computeLerp(window, dataType, 0.7);
      expect(firstPoint.inputValue).toStrictEqual(actualFirstPoint);
      expect(lastPoint.inputValue).toStrictEqual(actualLastPoint);
      expect(firstPoint.outputColor).toEqual(vec4.fromValues(0, 0, 0, 0));
      expect(lastPoint.outputColor).toEqual(vec4.fromValues(255, 51, 255, 255));
    });
    it(`Creates two default transfer function points for ${DataType[dataType]} with a defined range`, () => {
      const range =
        dataType === DataType.UINT64
<<<<<<< HEAD
          ? ([0n, 100n] as [bigint, bigint])
=======
          ? ([Uint64.ZERO, Uint64.fromNumber(100)] as [Uint64, Uint64])
>>>>>>> 0aacf094 (Ichnaea working code on top of v2.40.1)
          : ([0, 100] as [number, number]);
      transferFunction.generateDefaultControlPoints(range);
      expect(transferFunction.sortedControlPoints.controlPoints.length).toBe(2);
      const firstPoint = transferFunction.sortedControlPoints.controlPoints[0];
      const lastPoint = transferFunction.sortedControlPoints.controlPoints[1];
      expect(firstPoint.inputValue).toStrictEqual(range[0]);
      expect(lastPoint.inputValue).toStrictEqual(range[1]);
      expect(firstPoint.outputColor).toEqual(vec4.fromValues(0, 0, 0, 0));
      expect(lastPoint.outputColor).toEqual(vec4.fromValues(255, 51, 255, 255));
    });
    it(`Creates a window which bounds the control points for ${DataType[dataType]}`, () => {
      const range =
        dataType === DataType.UINT64
<<<<<<< HEAD
          ? ([0n, 100n] as [bigint, bigint])
=======
          ? ([Uint64.ZERO, Uint64.fromNumber(100)] as [Uint64, Uint64])
>>>>>>> 0aacf094 (Ichnaea working code on top of v2.40.1)
          : ([0, 100] as [number, number]);
      const pointInputValues = [0, 20, 40, 60, 80, 100];
      transferFunction.sortedControlPoints.clear();
      for (const inputValue of pointInputValues) {
        const valueToAdd =
<<<<<<< HEAD
          dataType === DataType.UINT64 ? BigInt(inputValue) : inputValue;
=======
          dataType === DataType.UINT64
            ? Uint64.fromNumber(inputValue)
            : inputValue;
>>>>>>> 0aacf094 (Ichnaea working code on top of v2.40.1)
        transferFunction.addPoint(
          new ControlPoint(valueToAdd, vec4.fromValues(0, 0, 0, 0)),
        );
      }
      transferFunction.generateDefaultWindow();
      const window = transferFunction.trackable.value.window;
      expect(
<<<<<<< HEAD
        dataTypeIntervalEqual(window, range),
=======
        dataTypeIntervalEqual(dataType, window, range),
>>>>>>> 0aacf094 (Ichnaea working code on top of v2.40.1)
        `Got ${window} expected ${range}`,
      ).toBeTruthy();
    });
  }
});

describe("lerpBetweenControlPoints", () => {
  const output = new Uint8Array(
    NUM_COLOR_CHANNELS * FIXED_TRANSFER_FUNCTION_LENGTH,
  );
  it("returns transparent black when given no control points for base classes", () => {
    const controlPoints: ControlPoint[] = [];
    const sortedControlPoints = new SortedControlPoints(
      controlPoints,
      DataType.UINT8,
    );
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
    const firstPointTransferIndex =
      transferFunction.sortedControlPoints.controlPoints[0].transferFunctionIndex(
        transferFunction.sortedControlPoints.range,
        transferFunction.size,
      );

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
    function toLookupTableIndex(
      transferFunction: TransferFunction,
      index: number,
    ) {
      return transferFunction.sortedControlPoints.controlPoints[
        index
      ].transferFunctionIndex(
        transferFunction.sortedControlPoints.range,
        transferFunction.size,
      );
    }
    const controlPoints: ControlPoint[] = [
      new ControlPoint(140, vec4.fromValues(0, 0, 0, 0)),
      new ControlPoint(120, vec4.fromValues(21, 22, 254, 210)),
      new ControlPoint(200, vec4.fromValues(255, 255, 255, 255)),
    ];
    const transferFunction = makeTransferFunction(controlPoints);
    const output = transferFunction.lookupTable.outputValues;
    const firstPointTransferIndex = toLookupTableIndex(transferFunction, 0);
    const secondPointTransferIndex = toLookupTableIndex(transferFunction, 1);
    const thirdPointTransferIndex = toLookupTableIndex(transferFunction, 2);
    const size = transferFunction.size;
    const range = transferFunction.range as [number, number];
    expect(firstPointTransferIndex).toBe(
      Math.floor(((120 - range[0]) / (range[1] - range[0])) * (size - 1)),
    );
    expect(secondPointTransferIndex).toBe(
      Math.floor(((140 - range[0]) / (range[1] - range[0])) * (size - 1)),
    );
    expect(thirdPointTransferIndex).toBe(
      Math.floor(((200 - range[0]) / (range[1] - range[0])) * (size - 1)),
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
      dataType,
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
}
${shaderType} getDataValue() {
    return inputValue;
}
`);
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
          let position: number | bigint;
          if (dataType !== DataType.UINT64) {
            const minValueNumber = minValue as number;
            const maxValueNumber = maxValue as number;
            position = (maxValueNumber + minValueNumber) / 2;
          } else {
            position = (maxValue as bigint) / 2n;
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
