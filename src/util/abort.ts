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

export function scopedAbortCallback(
  signal: AbortSignal | undefined,
  callback: (reason: any) => void,
): Disposable | undefined {
  if (signal === undefined) return undefined;
  if (signal.aborted) {
    callback(signal.reason);
    return undefined;
  }
  function wrappedCallback(this: AbortSignal) {
    callback(this.reason);
  }
  signal.addEventListener("abort", wrappedCallback, { once: true });
  return {
    [Symbol.dispose]() {
      signal.removeEventListener("abort", wrappedCallback);
    },
  };
}

// Abort controller that aborts when *all* consumers have aborted.
export class SharedAbortController {
  private consumers = new Map<(this: AbortSignal) => void, AbortSignal>();
  private controller = new AbortController();
  private retainCount = 0;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  addConsumer(abortSignal: AbortSignal | undefined): void {
    if (this.controller.signal.aborted) return undefined;
    if (abortSignal !== undefined) {
      if (abortSignal.aborted) return;
      const self = this;
      function wrappedCallback(this: AbortSignal) {
        self.consumers.delete(wrappedCallback);
        if (--self.retainCount === 0) {
          self.controller.abort();
          self[Symbol.dispose]();
        }
      }
      abortSignal.addEventListener("abort", wrappedCallback, { once: true });
    }
    ++this.retainCount;
  }

  [Symbol.dispose](): void {
    for (const [wrappedCallback, abortSignal] of this.consumers) {
      abortSignal.removeEventListener("abort", wrappedCallback);
    }
    this.consumers.clear();
    this.retainCount = 0;
  }

  // Marks this controller as started. Aborts if there are no consumers.
  start(): void {
    if (this.retainCount === 0) {
      this.controller.abort();
    }
  }
}

export function promiseWithResolversAndAbortCallback<T>(
  abortSignal: AbortSignal,
  abortCallback: (reason: any) => void,
): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: any) => void;
} {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const cleanup = scopedAbortCallback(abortSignal, abortCallback);
  return {
    promise,
    resolve: (value: T) => {
      cleanup?.[Symbol.dispose]();
      resolve(value);
    },
    reject: (reason: any) => {
      cleanup?.[Symbol.dispose]();
      reject(reason);
    },
  };
}

export function raceWithAbort<T>(
  promise: Promise<T>,
  abortSignal: AbortSignal | undefined,
): Promise<T> {
  if (abortSignal === undefined) return promise;
  if (abortSignal.aborted) return Promise.reject(abortSignal.reason);

  return new Promise((resolve, reject) => {
    const cleanup = scopedAbortCallback(abortSignal, (reason) => {
      reject(reason);
    });
    promise.then(
      (value) => {
        cleanup?.[Symbol.dispose]();
        resolve(value);
      },
      (reason) => {
        cleanup?.[Symbol.dispose]();
        reject(reason);
      },
    );
  });
}

export function abortPromise(abortSignal: AbortSignal) {
  return new Promise((_resolve, reject) => {
    abortSignal.addEventListener(
      "abort",
      () => {
        reject(abortSignal.reason);
      },
      { once: true },
    );
  });
}
