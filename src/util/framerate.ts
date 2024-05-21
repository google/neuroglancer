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

export class FramerateMonitor {
  private timeElapsedQueries: (WebGLQuery | null)[] = [];
  private warnedAboutMissingExtension = false;

  constructor(private queryPoolSize: number = 10) {
    if (this.queryPoolSize < 1) {
      throw new Error(
        `Query pool size must be at least 1, but got ${queryPoolSize}.`,
      );
    }
  }

  getTimingExtension(gl: WebGL2RenderingContext) {
    const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    if (ext === null && !this.warnedAboutMissingExtension) {
      console.warn(
        "EXT_disjoint_timer_query_webgl2 extension not available. " +
          "Cannot measure frame time.",
      );
      this.warnedAboutMissingExtension = true;
    }
    return ext;
  }

  startFrameTimeQuery(gl: WebGL2RenderingContext, ext: any) {
    if (ext === null) {
      return null;
    }
    const query = gl.createQuery();
    if (query !== null) {
      gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    }
    return query;
  }

  endFrameTimeQuery(
    gl: WebGL2RenderingContext,
    ext: any,
    query: WebGLQuery | null,
  ) {
    if (ext !== null && query !== null) {
      gl.endQuery(ext.TIME_ELAPSED_EXT);
    }
    if (this.timeElapsedQueries.length >= this.queryPoolSize) {
      const oldestQuery = this.timeElapsedQueries.shift();
      if (oldestQuery !== null) {
        gl.deleteQuery(oldestQuery!);
      }
    }
    this.timeElapsedQueries.push(query);
  }

  getLastFrameTimesInMs(
    gl: WebGL2RenderingContext,
    numberOfFrames: number = 5,
  ) {
    const { timeElapsedQueries } = this;
    const results: number[] = [];
    timeElapsedQueries.forEach((timeElapsedQuery) => {
      if (timeElapsedQuery !== null) {
        const available = gl.getQueryParameter(
          timeElapsedQuery,
          gl.QUERY_RESULT_AVAILABLE,
        );
        if (available) {
          const result =
            gl.getQueryParameter(timeElapsedQuery, gl.QUERY_RESULT) / 1e6;
          results.push(result);
        }
      }
    });
    return results.slice(-numberOfFrames);
  }
}

export enum FrameTimingMethod {
  MEDIAN = 0,
  MEAN = 1,
  MAX = 2,
}

export class DownsamplingBasedOnFrameRateCalculator {
  private lastFrameTime: number | null = null;
  private frameDeltas: number[] = [];
  private downsamplingRates: number[] = [];
  constructor(
    private numberOfStoredFrameDeltas: number = 10,
    private maxDownsamplingFactor: number = 8,
    private desiredFrameTimingMs = 1000 / 60,
    private downsamplingPersistenceDurationInFrames = 15,
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
    this.downsamplingRates = [];
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
        return Math.max(...this.frameDeltas);
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

  calculateDownsamplingRateBasedOnFrameDeltas(
    method: FrameTimingMethod = FrameTimingMethod.MAX,
  ): number {
    const frameDelta = this.calculateFrameTimeInMs(method);
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
