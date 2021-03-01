/**
 * @license
 * Copyright 2017 Google Inc.
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

export interface DebouncedFunction {
  /**
   * Ensures the wrapped function will be run at the next animation frame.
   */
  (): void;

  /**
   * Cancels any outstanding call.
   */
  cancel(): void;

  /**
   * Runs any outstanding call immediately.
   */
  flush(): void;
}

/**
 * Returns a function that, when called, ensures `callback` is invoked at the next animation frame.
 */
export function animationFrameDebounce(callback: () => void): DebouncedFunction {
  let handle = -1;
  const cancel = () => {
    if (handle !== -1) {
      cancelAnimationFrame(handle);
      handle = -1;
    }
  };
  const flush = () => {
    if (handle !== -1) {
      handle = -1;
      callback();
    }
  };
  return Object.assign(() => {
    if (handle === -1) {
      handle = requestAnimationFrame(() => {
        handle = -1;
        callback();
      });
    }
  }, {flush, cancel});
}
