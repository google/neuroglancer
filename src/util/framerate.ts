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
const DEBUG_ADAPTIVE_FRAMERATE = false;
interface QueryInfo {
  glQuery: WebGLQuery;
  frameNumber: number;
  wasStarted: boolean;
  wasEnded: boolean;
}

interface FrameDeltaInfo {
  frameDelta: number;
  frameNumber: number;
}

export class FramerateMonitor {
  private timeElapsedQueries: QueryInfo[] = [];
  private warnedAboutMissingExtension = false;
  private storedTimeDeltas: FrameDeltaInfo[] = [];

  constructor(
    private numStoredTimes: number = 10,
    private queryPoolSize: number = 10,
  ) {
    if (this.queryPoolSize < 1) {
      throw new Error(
        `Query pool size must be at least 1, but got ${queryPoolSize}.`,
      );
    }
  }

  getTimingExtension(gl: WebGL2RenderingContext) {
    const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    if (ext === null && !this.warnedAboutMissingExtension) {
      console.log(
        "EXT_disjoint_timer_query_webgl2 extension not available. " +
          "Cannot measure frame time.",
      );
      this.warnedAboutMissingExtension = true;
    }
    return ext;
  }

  getOldestQueryIndexByFrameNumber() {
    if (this.timeElapsedQueries.length === 0) {
      return undefined;
    }
    let oldestQueryIndex = 0;
    for (let i = 1; i < this.timeElapsedQueries.length; i++) {
      const oldestQuery = this.timeElapsedQueries[oldestQueryIndex];
      if (this.timeElapsedQueries[i].frameNumber < oldestQuery.frameNumber) {
        oldestQueryIndex = i;
      }
    }
    return oldestQueryIndex;
  }

  startFrameTimeQuery(
    gl: WebGL2RenderingContext,
    ext: any,
    frameNumber: number,
  ) {
    if (ext === null) {
      return null;
    }
    const query = gl.createQuery();
    const currentQuery =
      this.timeElapsedQueries[this.timeElapsedQueries.length - 1];
    if (query !== null && currentQuery !== query) {
      gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      if (this.timeElapsedQueries.length >= this.queryPoolSize) {
        const oldestQueryIndex = this.getOldestQueryIndexByFrameNumber();
        if (oldestQueryIndex !== undefined) {
          const oldestQuery = this.timeElapsedQueries.splice(
            oldestQueryIndex,
            1,
          )[0];
          gl.deleteQuery(oldestQuery.glQuery);
        }
      }
      const queryInfo: QueryInfo = {
        glQuery: query,
        frameNumber: frameNumber,
        wasStarted: true,
        wasEnded: false,
      };
      this.timeElapsedQueries.push(queryInfo);
    }
    return query;
  }

  endLastTimeQuery(gl: WebGL2RenderingContext, ext: any) {
    if (ext !== null) {
      const currentQuery =
        this.timeElapsedQueries[this.timeElapsedQueries.length - 1];
      if (!currentQuery.wasEnded && currentQuery.wasStarted) {
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        currentQuery.wasEnded = true;
      }
    }
  }

  grabAnyFinishedQueryResults(gl: WebGL2RenderingContext) {
    const deletedQueryIndices: number[] = [];
    for (let i = 0; i < this.timeElapsedQueries.length; i++) {
      const query = this.timeElapsedQueries[i];
      // Error checking: if the query was not started or ended, just delete it.
      // This can happen from errors in the rendering
      if (!query.wasEnded || !query.wasStarted) {
        gl.deleteQuery(query.glQuery);
        deletedQueryIndices.push(i);
      } else {
        const available = gl.getQueryParameter(
          query.glQuery,
          gl.QUERY_RESULT_AVAILABLE,
        );
        // If the result is null, then something went wrong and we should just delete the query.
        if (available === null) {
          gl.deleteQuery(query.glQuery);
          deletedQueryIndices.push(i);
        } else if (available) {
          const result =
            gl.getQueryParameter(query.glQuery, gl.QUERY_RESULT) / 1e6;
          this.storedTimeDeltas.push({
            frameDelta: result,
            frameNumber: query.frameNumber,
          });
          gl.deleteQuery(query.glQuery);
          deletedQueryIndices.push(i);
        }
      }
    }
    this.timeElapsedQueries = this.timeElapsedQueries.filter(
      (_, i) => !deletedQueryIndices.includes(i),
    );
    if (this.storedTimeDeltas.length > this.numStoredTimes) {
      this.storedTimeDeltas = this.storedTimeDeltas.slice(-this.numStoredTimes);
    }
  }

  getLastFrameTimesInMs(numberOfFrames: number = 10) {
    return this.storedTimeDeltas
      .slice(-numberOfFrames)
      .map((frameDeltaInfo) => frameDeltaInfo.frameDelta);
  }

  getQueries() {
    return this.timeElapsedQueries;
  }
}

export class DownsamplingBasedOnFrameRateCalculator {
  private lastFrameTime: number | null = null;
  private frameDeltas: number[] = [];
  private downsamplingRates: Map<number, number> = new Map();
  private frameCount = 0;
  /** Cache of last logged applied factor to avoid noisy logs when DEBUG_ADAPTIVE_FRAMERATE */
  private lastLoggedFactor: number | null = null;

  /**
   * @param numberOfStoredFrameDeltas The number of frame deltas to store. Oldest frame deltas are removed. Must be at least 1.
   * @param maxDownsamplingFactor The maximum factor for downsampling. Must be at least 2.
   * @param desiredFrameTimingMs The desired frame timing in milliseconds. The downsampling rate is based on a comparison of the actual frame timing to this value.
   * @param downsamplingPersistenceDurationInFrames The max number of frames over which a high downsampling rate persists.
   */
  constructor(
    public numberOfStoredFrameDeltas: number = 10,
    private maxDownsamplingFactor: number = 8,
    private desiredFrameTimingMs = 1000 / 30,
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
    const applied = this.updateMaxTrackedDownsamplingRate(
      downsampleFactorBasedOnFramerate,
    );
    if (DEBUG_ADAPTIVE_FRAMERATE) {
      // Only log when the applied factor actually changes compared to previous frame.
      if (this.lastLoggedFactor !== applied) {
        const methodName = FrameTimingMethod[method];
        console.log(
          `[Downsampling] factor=${applied} (raw=${downsampleFactorBasedOnFramerate}) ` +
            `frameTime=${calculatedFrameTime.toFixed(2)}ms ` +
            `target=${this.desiredFrameTimingMs.toFixed(2)}ms method=${methodName} ` +
            `frames=${this.frameCount}`,
        );
        this.lastLoggedFactor = applied;
      }
    }
    return applied;
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
