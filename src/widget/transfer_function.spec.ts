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
import type {
  TransferFunctionParameters} from "#src/widget/transfer_function.js";
import {
  SortedControlPoints,
  ControlPoint,
  LookupTable,
  TransferFunction,
  NUM_COLOR_CHANNELS,
} from "#src/widget/transfer_function.js";

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

describe("lerpBetweenControlPoints", () => {
  const range = defaultDataTypeRange[DataType.UINT8];
  const output = new Uint8Array(NUM_COLOR_CHANNELS * TRANSFER_FUNCTION_LENGTH);
  it("returns transparent black when given no control points for raw classes", () => {
    const controlPoints: ControlPoint[] = [];
    const sortedControlPoints = new SortedControlPoints(controlPoints, range);
    const lookupTable = new LookupTable(TRANSFER_FUNCTION_LENGTH);
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

    expect(
      output
        .slice(0, NUM_COLOR_CHANNELS * firstPointTransferIndex)
        .every((value) => value === 0),
    ).toBeTruthy();
    expect(
      output
        .slice(NUM_COLOR_CHANNELS * thirdPointTransferIndex)
        .every((value) => value === 255),
    ).toBeTruthy();

    const firstColor = controlPoints[0].outputColor;
    const secondColor = controlPoints[1].outputColor;
    for (
      let i = firstPointTransferIndex * NUM_COLOR_CHANNELS;
      i < secondPointTransferIndex * NUM_COLOR_CHANNELS;
      i++
    ) {
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

    const thirdColor = controlPoints[2].outputColor;
    for (
      let i = secondPointTransferIndex * NUM_COLOR_CHANNELS;
      i < thirdPointTransferIndex * NUM_COLOR_CHANNELS;
      i++
    ) {
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
