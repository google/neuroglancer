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
  constructor(
    private numberOfStoredFrameTimes: number = 10,
    private timeoutInMS: number = 1000,
  ) {}

  start(timestamp: number = Date.now()) {
    if (this.frameTimeStamps.length == 0) {
      this.frameTimeStamps.push(timestamp);
    } else if (
      timestamp - this.frameTimeStamps[this.frameTimeStamps.length - 1] >=
      this.timeoutInMS
    ) {
      this.reset();
      this.frameTimeStamps.push(timestamp);
    }
  }
  reset() {
    this.frameTimeStamps = [];
  }

  addFrame(timestamp: number = Date.now()) {
    if (this.frameTimeStamps.length >= this.numberOfStoredFrameTimes) {
      this.frameTimeStamps.shift();
    }
    this.frameTimeStamps.push(timestamp);
  }

  calculateFrameTimeInMs() {
    if (this.frameTimeStamps.length <= 1) {
      return 0;
    }
    return (
      (this.frameTimeStamps[this.frameTimeStamps.length - 1] -
        this.frameTimeStamps[0]) /
      (this.frameTimeStamps.length - 1)
    );
  }
}
