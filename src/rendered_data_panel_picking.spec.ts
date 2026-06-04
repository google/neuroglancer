/**
 * @license
 * Copyright 2026 Google Inc.
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

import { describe, expect, it } from "vitest";

import {
  clearOutOfBoundsPickData,
  getPickDiameter,
  getPickOffsetSequence,
  resolveNearestPanelPickSample,
} from "#src/rendered_data_panel_picking.js";

describe("resolveNearestPanelPickSample", () => {
  it("dereferences slice pick data using the sampled offset", () => {
    const pickRadius = 5;
    const pickOffsetSequence = getPickOffsetSequence(pickRadius);
    const targetOffset = pickOffsetSequence[1];
    const data = new Float32Array(4 * getPickDiameter(pickRadius) ** 2);
    data[4 * targetOffset] = 17;

    expect(
      resolveNearestPanelPickSample(data, pickOffsetSequence, pickRadius),
    ).toEqual({
      offset: targetOffset,
      relativeX: targetOffset % getPickDiameter(pickRadius),
      relativeY:
        (targetOffset - (targetOffset % getPickDiameter(pickRadius))) /
        getPickDiameter(pickRadius),
      pickValue: 17,
      depthValue: undefined,
    });
  });

  it("returns depth and pick payload from the same sampled pixel", () => {
    const pickRadius = 2;
    const pickDiameter = getPickDiameter(pickRadius);
    const pickOffsetSequence = getPickOffsetSequence(pickRadius);
    const targetOffset = pickOffsetSequence[3];
    const data = new Float32Array(2 * 4 * pickDiameter * pickDiameter);
    data[4 * targetOffset] = 0.25;
    data[4 * pickDiameter * pickDiameter + 4 * targetOffset] = 23;

    expect(
      resolveNearestPanelPickSample(data, pickOffsetSequence, pickRadius, {
        depthBaseOffset: 0,
        pickBaseOffset: 4 * pickDiameter * pickDiameter,
      }),
    ).toEqual({
      offset: targetOffset,
      relativeX: targetOffset % pickDiameter,
      relativeY: (targetOffset - (targetOffset % pickDiameter)) / pickDiameter,
      pickValue: 23,
      depthValue: 0.25,
    });
  });
});

describe("clearOutOfBoundsPickData", () => {
  it("zeros the relative pick-window indices that fall outside the viewport", () => {
    const pickRadius = 1;
    const pickDiameter = getPickDiameter(pickRadius);
    const buffer = new Float32Array(4 * pickDiameter * pickDiameter).fill(1);

    clearOutOfBoundsPickData(buffer, 0, 4, 0, 0, 3, 3, pickRadius);

    expect(buffer[0]).toBe(0);
    expect(buffer[4]).toBe(0);
    expect(buffer[4 * pickDiameter]).toBe(0);
    expect(buffer[4 * (pickDiameter + 1)]).toBe(1);
  });
});
