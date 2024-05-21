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
      for (let i = timeElapsedQueries.length - 1; i >= 0; i--) {
        const timeElapsedQuery = timeElapsedQueries[i];
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
        if (results.length >= numberOfFrames) {
          break;
        }
      }
      return results;
    }
  }