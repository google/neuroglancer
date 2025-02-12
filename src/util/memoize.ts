/**
 * @license
 * Copyright 2016 Google Inc.
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

import { raceWithAbort, SharedAbortController } from "#src/util/abort.js";
import type { RefCounted } from "#src/util/disposable.js";
import { RefCountedValue } from "#src/util/disposable.js";
import { stableStringify } from "#src/util/json.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import { MultiConsumerProgressListener } from "#src/util/progress_listener.js";

export class Memoize<Key, Value extends RefCounted> {
  private map = new Map<Key, Value>();

  /**
   * If getter throws an exception, no value is added.
   */
  get<T extends Value>(key: Key, getter: () => T): T {
    const { map } = this;
    let obj = <T>map.get(key);
    if (obj === undefined) {
      obj = getter();
      obj.registerDisposer(() => {
        map.delete(key);
      });
      map.set(key, obj);
    } else {
      obj.addRef();
    }
    return obj;
  }
}

export class StringMemoize extends Memoize<string, RefCounted> {
  get<T extends RefCounted>(x: any, getter: () => T) {
    if (typeof x !== "string") {
      x = stableStringify(x);
    }
    return super.get(x, getter);
  }

  getUncounted<T>(x: any, getter: () => T) {
    return this.get(x, () => new RefCountedValue(getter())).value;
  }

  getAsync<T>(
    x: any,
    options: Partial<ProgressOptions>,
    getter: (options: ProgressOptions) => Promise<T>,
  ) {
    return this.getUncounted(x, () => asyncMemoizeWithProgress(getter))(
      options,
    );
  }
}

export interface AsyncMemoize<T> {
  (options: { signal?: AbortSignal }): Promise<T>;
}

export interface AsyncMemoizeWithProgress<T> {
  (options: Partial<ProgressOptions>): Promise<T>;
}

export function asyncMemoize<T>(
  getter: (options: { signal: AbortSignal }) => Promise<T>,
): AsyncMemoize<T> {
  let abortController: SharedAbortController | undefined;
  let promise: Promise<T> | undefined;
  let completed: boolean = false;

  return (options: { signal?: AbortSignal }): Promise<T> => {
    if (completed) {
      return promise!;
    }
    const { signal } = options;
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    if (promise === undefined || abortController!.signal.aborted) {
      abortController = new SharedAbortController();
      const curAbortController = abortController;
      promise = (async () => {
        try {
          return await getter({
            signal: curAbortController.signal,
          });
        } catch (e) {
          if (curAbortController.signal.aborted) {
            promise = undefined;
          }
          throw e;
        } finally {
          if (promise !== undefined) {
            completed = true;
          }
          curAbortController[Symbol.dispose]();
          if (abortController === curAbortController) {
            abortController = undefined;
          }
        }
      })();
    }
    abortController!.addConsumer(signal);
    return raceWithAbort(promise, signal);
  };
}

export function asyncMemoizeWithProgress<T>(
  getter: (options: ProgressOptions) => Promise<T>,
): AsyncMemoizeWithProgress<T> {
  let progressListener: MultiConsumerProgressListener | undefined;
  let abortController: SharedAbortController | undefined;
  let promise: Promise<T> | undefined;
  let completed: boolean = false;

  return async (options: Partial<ProgressOptions>): Promise<T> => {
    if (completed) {
      return promise!;
    }
    const { signal } = options;
    signal?.throwIfAborted();
    if (promise === undefined || abortController!.signal.aborted) {
      progressListener = new MultiConsumerProgressListener();
      abortController = new SharedAbortController();
      const curAbortController = abortController;
      promise = (async () => {
        try {
          return await getter({
            signal: curAbortController.signal,
            progressListener: progressListener!,
          });
        } catch (e) {
          if (curAbortController.signal.aborted) {
            promise = undefined;
          }
          throw e;
        } finally {
          if (promise !== undefined) {
            completed = true;
          }
          progressListener = undefined;
          curAbortController[Symbol.dispose]();
          if (abortController === curAbortController) {
            abortController = undefined;
          }
        }
      })();
    }
    abortController!.addConsumer(signal);
    const curProgressListener = progressListener!;
    curProgressListener.addListener(options.progressListener);

    try {
      return await raceWithAbort(promise, signal);
    } finally {
      curProgressListener.removeListener(options.progressListener);
    }
  };
}
