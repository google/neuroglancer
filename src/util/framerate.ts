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
  private downsamplingRates: Map<number, number> = new Map();
  private frameCount = 0;

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
    for (let i = 1; i <= this.maxDownsamplingFactor; i *= 2) {
      this.downsamplingRates.set(i, -Infinity);
    }
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

  private updateMaxTrackedDownsamplingRate(downsampleFactor: number) {
    this.downsamplingRates.set(downsampleFactor, this.frameCount);
    let maxTrackedDownsamplingRate = 1;
    for (const [downsamplingRate, frameCount] of this.downsamplingRates) {
      if (
        this.frameCount - frameCount <=
        this.downsamplingPersistenceDurationInFrames
      ) {
        maxTrackedDownsamplingRate = downsamplingRate;
      }
    }
    return maxTrackedDownsamplingRate;
  }

  /* This doesn't reset stored frame deltas. Is usually called on a new continous camera move */
  resetForNewFrameSet() {
    this.lastFrameTime = null;
    this.frameCount = 0;
    this.downsamplingRates.forEach((_, key) => {
      this.downsamplingRates.set(key, -Infinity);
    });
  }

  addFrame(timestamp: number = Date.now()) {
    if (this.lastFrameTime !== null) {
      const frameDelta = timestamp - this.lastFrameTime;
      if (frameDelta > 0) {
        this.storeFrameDelta(frameDelta);
      }
    }
    this.lastFrameTime = timestamp;
    this.frameCount++;
  }

  calculateFrameTimeInMs(
    method: FrameTimingMethod = FrameTimingMethod.MAX,
  ): number {
    if (this.frameDeltas.length === 0) {
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
      // Don't add this one to tracking, it's just to start the process
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
    return this.updateMaxTrackedDownsamplingRate(
      downsampleFactorBasedOnFramerate,
    );
  }

  getFrameDeltas(): number[] {
    return this.frameDeltas;
  }

  getFrameCount(): number {
    return this.frameCount;
  }

  getDownsamplingRates(): Map<number, number> {
    return this.downsamplingRates;
  }

  setFrameDeltas(frameDeltas: number[], incrementFrameCount = true) {
    this.frameDeltas = frameDeltas.slice(-this.numberOfStoredFrameDeltas);
    if (incrementFrameCount) {
      this.frameCount++;
    }
  }
}
