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

export class DownsamplingBasedOnFrameRateCalculator {
  private lastFrameTime: number | null = null;
  private maxDownsamplingFactorSinceReset: number = 1;
  private frameDeltas: number[] = [];
  constructor(
    private numberOfStoredFrameDeltas: number = 10,
    private maxDownsamplingFactor: number = 8,
    private desiredFrameTimingMs = 1000 / 60,
  ) {
    if (numberOfStoredFrameDeltas < 1) {
      throw new Error(
        `Number of stored frame deltas must be at least 1, ` +
          `but got ${numberOfStoredFrameDeltas}.`,
      );
    }
    if (maxDownsamplingFactor < 2) {
      throw new Error(
        `Max downsampling factor must be at least 2, ` +
          `but got ${maxDownsamplingFactor}.`,
      );
    }
  }
  resetLastFrameTime() {
    this.lastFrameTime = null;
    this.maxDownsamplingFactorSinceReset = 1;
  }

  addFrame(timestamp: number = Date.now()) {
    if (this.lastFrameTime !== null) {
      const frameDelta = timestamp - this.lastFrameTime;
      if (frameDelta < 0) {
        throw new Error(
          `Frame delta should be non-negative, but got ${frameDelta}. ` +
            `This can happen if the clock is reset or if the ` +
            `timestamp is generated in the future.`,
        );
      }
      this.frameDeltas.push(timestamp - this.lastFrameTime);
      if (this.frameDeltas.length > this.numberOfStoredFrameDeltas) {
        this.frameDeltas.shift();
      }
    }
    this.lastFrameTime = timestamp;
  }

  calculateFrameTimeInMs(useMedian: boolean = true): number {
    if (this.frameDeltas.length < 1) {
      return 0;
    }
    if (useMedian) {
      return this.calculateMedianFrameTime();
    }
    return (
      this.frameDeltas.reduce((a, b) => a + b, 0) / this.frameDeltas.length
    );
  }

  private calculateMedianFrameTime(): number {
    const sortedFrameDeltas = this.frameDeltas.slice().sort((a, b) => a - b);
    const midpoint = Math.floor(sortedFrameDeltas.length / 2);
    return sortedFrameDeltas.length % 2 === 1
      ? sortedFrameDeltas[midpoint]
      : (sortedFrameDeltas[midpoint - 1] + sortedFrameDeltas[midpoint]) / 2;
  }

  calculateDownsamplingRateBasedOnFrameDeltas(
    useMedian: boolean = true,
  ): number {
    console.log(this.getFrameDeltas());
    const frameDelta = this.calculateFrameTimeInMs(useMedian);
    if (frameDelta === 0) {
      return Math.min(4, this.maxDownsamplingFactor);
    }
    let downsampleFactorBasedOnFramerate = Math.max(
      frameDelta / this.desiredFrameTimingMs,
      1,
    );
    // Round to the nearest power of 2.
    downsampleFactorBasedOnFramerate = Math.min(
      Math.pow(2, Math.round(Math.log2(downsampleFactorBasedOnFramerate))),
      this.maxDownsamplingFactor,
    );
    const downsampleRateFromHistory =
      this.maxDownsamplingFactorSinceReset > 1 ? 2 : 1;
    return Math.max(
      downsampleFactorBasedOnFramerate,
      downsampleRateFromHistory,
    );
  }

  getFrameDeltas(): number[] {
    return this.frameDeltas;
  }
}
