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
import {
  DownsamplingBasedOnFrameRateCalculator,
  FrameTimingMethod,
} from "#src/util/framerate.js";

describe("FrameRateCounter", () => {
  it("calculates valid fps for evenly spaced frames", () => {
    const frameRateCounter = new DownsamplingBasedOnFrameRateCalculator(10);
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
    const frameRateCounter = new DownsamplingBasedOnFrameRateCalculator(9);
    for (let i = 0; i < 10; i++) {
      frameRateCounter.addFrame(i * 100);
    }
    frameRateCounter.resetForNewFrameSet();
    for (let i = 0; i < 10; i++) {
      frameRateCounter.addFrame(i * 10);
    }
    expect(frameRateCounter.calculateFrameTimeInMs()).toEqual(10);
    expect(
      frameRateCounter.calculateFrameTimeInMs(FrameTimingMethod.MEDIAN),
    ).toEqual(10);
  });
  it("removes last frame after reset", () => {
    const frameRateCounter = new DownsamplingBasedOnFrameRateCalculator(10);
    expect(frameRateCounter.calculateFrameTimeInMs()).toEqual(0);
    for (let i = 0; i < 10; i++) {
      frameRateCounter.addFrame(i * 100);
    }
    expect(frameRateCounter.calculateFrameTimeInMs()).toEqual(100);
    frameRateCounter.resetForNewFrameSet();
    for (let i = 0; i < 5; i++) {
      frameRateCounter.addFrame(i * 200);
    }
    expect(
      frameRateCounter.calculateFrameTimeInMs(FrameTimingMethod.MEAN),
    ).toEqual(140);
    expect(
      frameRateCounter.calculateFrameTimeInMs(FrameTimingMethod.MAX),
    ).toEqual(200);
  });
  it("calculates a valid downsampling rate", () => {
    const frameRateCounter = new DownsamplingBasedOnFrameRateCalculator(
      9,
      8,
      100,
      15,
    );

    // Without any frames, the downsampling rate is 4
    expect(frameRateCounter.calculateDownsamplingRate()).toEqual(4);

    // 80ms / 100ms < 1, so no downsampling
    for (let i = 0; i < 10; i++) {
      frameRateCounter.addFrame(i * 80);
    }
    expect(frameRateCounter.calculateDownsamplingRate()).toEqual(1);

    // 400ms / 100ms = 4, so downsampling by 4
    for (let i = 0; i < 10; i++) {
      frameRateCounter.addFrame(i * 400);
    }
    expect(frameRateCounter.calculateDownsamplingRate()).toEqual(4);

    // Better fps now, but the high rate persists for a while
    for (let i = 0; i < 10; i++) {
      frameRateCounter.addFrame(i * 50);
    }
    expect(frameRateCounter.calculateDownsamplingRate()).toEqual(4);

    // The downsampling rate will eventually drop
    for (let i = 0; i < 10; i++) {
      frameRateCounter.addFrame(i * 50);
    }
    expect(frameRateCounter.calculateDownsamplingRate()).toEqual(1);

    // If the frame rate is very bad, still caps at 8
    frameRateCounter.resetForNewFrameSet();
    expect(frameRateCounter.calculateDownsamplingRate()).toEqual(1);
    for (let i = 0; i < 9; i++) {
      frameRateCounter.addFrame(i * 1000);
    }
    expect(frameRateCounter.calculateDownsamplingRate()).toEqual(8);

    // Reset the frame set
    frameRateCounter.resetForNewFrameSet();
    // It should keep the downsampling rate from the previous frame set
    expect(frameRateCounter.calculateDownsamplingRate()).toEqual(8);

    // But a set of new frames will reset the downsampling rate
    for (let i = 0; i < 10; i++) {
      frameRateCounter.addFrame(i * 50);
      frameRateCounter.calculateDownsamplingRate();
    }
    // It won't happen immediately
    expect(frameRateCounter.calculateDownsamplingRate()).toEqual(8);
    // But it will after the persistence duration
    for (let i = 0; i < 15; i++) {
      frameRateCounter.addFrame(i * 50);
    }
    expect(frameRateCounter.calculateDownsamplingRate()).toEqual(1);
  });
});
