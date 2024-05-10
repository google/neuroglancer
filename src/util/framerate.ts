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

export class FrameRateCalculator {
  private lastFrameTime: number | null = null;
  private frameDeltas: number[] = [];
  constructor(private numberOfStoredFrameDeltas: number = 10) {}
  resetLastFrameTime() {
    this.lastFrameTime = null;
  }

  addFrame(timestamp: number = Date.now()) {
    if (this.lastFrameTime !== null) {
      const frameDelta = timestamp - this.lastFrameTime;
      if (frameDelta < 0) {
        throw new Error(
          `Frame delta should be non-negative, but got ${frameDelta}. ` +
            `This can happen if the clock is reset or if the ` +
            `timestamp is generated in the future.`
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
}
