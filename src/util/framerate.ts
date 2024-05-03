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
  private frameTimeStamps: number[] = [];
  private frameDeltas: number[] = [];
  constructor(private numberOfStoredFrameTimes: number = 10) {}
  reset() {
    this.frameTimeStamps = [];
    this.frameDeltas = [];
  }

  addFrame(timestamp: number = Date.now()) {
    if (this.frameTimeStamps.length >= this.numberOfStoredFrameTimes) {
      this.frameTimeStamps.shift();
      this.frameDeltas.shift();
    }
    this.frameTimeStamps.push(timestamp);
    if (this.frameTimeStamps.length > 1) {
      this.calculateFrameDelta();
    }
  }

  private calculateFrameDelta() {
    this.frameDeltas.push(
      this.frameTimeStamps[this.frameTimeStamps.length - 1] -
        this.frameTimeStamps[this.frameTimeStamps.length - 2],
    );
  }

  calculateFrameTimeInMs() {
    if (this.frameDeltas.length < 1) {
      return 0;
    }
    const sortedFrameDeltas = this.frameDeltas.slice().sort((a, b) => a - b);
    const midpoint = Math.floor(sortedFrameDeltas.length / 2);
    return sortedFrameDeltas.length % 2 === 1
      ? sortedFrameDeltas[midpoint]
      : (sortedFrameDeltas[midpoint - 1] + sortedFrameDeltas[midpoint]) / 2;
  }
}
