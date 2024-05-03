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
import { FrameRateCalculator } from "#src/util/framerate.js";

describe("FrameRateCounter", () => {
  it("calculates valid fps for evenly spaced frames", () => {
    const frameRateCounter = new FrameRateCalculator(10);
    for (let i = 0; i < 10; i++) {
      frameRateCounter.addFrame(i * 100);
      if (i === 0) {
        expect(frameRateCounter.calculateFrameTimeInMs()).toEqual(0);
      } else {
        expect(frameRateCounter.calculateFrameTimeInMs()).toEqual(100);
      }
    }
  });
  it("calculates valid fps for many frames", () => {
    const frameRateCounter = new FrameRateCalculator(10);
    for (let i = 0; i < 10; i++) {
      frameRateCounter.addFrame(i * 100);
    }
    for (let i = 0; i < 10; i++) {
      frameRateCounter.addFrame(i * 10);
    }
    expect(frameRateCounter.calculateFrameTimeInMs()).toEqual(10);
  });
  it("removes frames after reset", () => {
    const frameRateCounter = new FrameRateCalculator(10);
    expect(frameRateCounter.calculateFrameTimeInMs()).toEqual(0);
    for (let i = 0; i < 10; i++) {
      frameRateCounter.addFrame(i * 100);
    }
    expect(frameRateCounter.calculateFrameTimeInMs()).toEqual(100);
    frameRateCounter.reset();
    expect(frameRateCounter.calculateFrameTimeInMs()).toEqual(0);
  });
});
