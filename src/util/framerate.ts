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

export enum FrameTimingMethod {
  MEDIAN = 0,
  MEAN = 1,
  MAX = 2,
}

export class DownsamplingBasedOnFrameRateCalculator {
  private lastFrameTime: number | null = null;
  private frameDeltas: number[] = [];
  private downsamplingRates: number[] = [];

  /**
   * Creates an instance of DownsamplingBasedOnFrameRateCalculator.
   *
   * @param numberOfStoredFrameDeltas The number of frame deltas to store. Oldest frame deltas are removed. Must be at least 1.
   * @param maxDownsamplingFactor The maximum factor for downsampling. Must be at least 2.
   * @param desiredFrameTimingMs The desired frame timing in milliseconds. The downsampling rate is based on a comparison of the actual frame timing to this value.
   * @param downsamplingPersistenceDurationInFrames The max number of frames over which a high downsampling rate persists.
   */
  constructor(
    private numberOfStoredFrameDeltas: number = 10,
    private maxDownsamplingFactor: number = 8,
    private desiredFrameTimingMs = 1000 / 60,
    private downsamplingPersistenceDurationInFrames = 15,
  ) {
    this.validateConstructorArguments();
  }

  private validateConstructorArguments() {
    this.numberOfStoredFrameDeltas = Math.max(
      1,
      Math.round(this.numberOfStoredFrameDeltas),
    );
    this.maxDownsamplingFactor = Math.max(
      2,
      Math.round(this.maxDownsamplingFactor),
    );
  }

  private storeFrameDelta(frameDelta: number) {
    this.frameDeltas.push(frameDelta);
    if (this.frameDeltas.length > this.numberOfStoredFrameDeltas) {
      this.frameDeltas.shift();
    }
  }

  private calculateMeanFrameTime(): number {
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

  private calculateMaxFrameTime(): number {
    return Math.max(...this.frameDeltas);
  }

  resetLastFrameTime() {
    this.lastFrameTime = null;
    this.downsamplingRates = [];
  }

  addFrame(timestamp: number = Date.now()) {
    if (this.lastFrameTime !== null) {
      const frameDelta = timestamp - this.lastFrameTime;
      if (frameDelta > 0) {
        this.storeFrameDelta(frameDelta);
      }
    }
    this.lastFrameTime = timestamp;
  }

  calculateFrameTimeInMs(
    method: FrameTimingMethod = FrameTimingMethod.MAX,
  ): number {
    if (this.frameDeltas.length < 1) {
      return 0;
    }
    switch (method) {
      case FrameTimingMethod.MEDIAN:
        return this.calculateMedianFrameTime();
      case FrameTimingMethod.MEAN:
        return this.calculateMeanFrameTime();
      case FrameTimingMethod.MAX:
        return this.calculateMaxFrameTime();
    }
  }

  /** Should be called once per frame for proper downsampling persistence */
  calculateDownsamplingRate(
    method: FrameTimingMethod = FrameTimingMethod.MEAN,
  ): number {
    const calculatedFrameTime = this.calculateFrameTimeInMs(method);
    if (calculatedFrameTime === 0) {
      return Math.min(4, this.maxDownsamplingFactor);
    }
    let downsampleFactorBasedOnFramerate = Math.max(
      calculatedFrameTime / this.desiredFrameTimingMs,
      1,
    );
    // Round to the nearest power of 2.
    downsampleFactorBasedOnFramerate = Math.min(
      Math.pow(2, Math.round(Math.log2(downsampleFactorBasedOnFramerate))),
      this.maxDownsamplingFactor,
    );
    // Store the downsampling rate.
    this.downsamplingRates.push(downsampleFactorBasedOnFramerate);
    if (
      this.downsamplingRates.length >
      this.downsamplingPersistenceDurationInFrames
    ) {
      this.downsamplingRates.shift();
    }
    // Return the maximum downsampling rate over the last few frames.
    return Math.max(...this.downsamplingRates);
  }

  getFrameDeltas(): number[] {
    return this.frameDeltas;
  }

  setFrameDeltas(frameDeltas: number[]) {
    this.frameDeltas = frameDeltas.slice(-this.numberOfStoredFrameDeltas);
  }
}
