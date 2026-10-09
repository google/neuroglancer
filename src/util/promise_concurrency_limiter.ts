/**
 * @license
 * Copyright 2026 Google Inc.
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

interface QueuedTask {
  start: () => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal | undefined;
  abortListener: (() => void) | undefined;
}

/**
 * Limits the number of concurrently running promise-returning tasks.
 *
 * Tasks submitted while under the limit start synchronously; the rest queue
 * in FIFO order and start as running tasks settle. The limit is re-read at
 * each dispatch, so it may change dynamically.
 */
export class PromiseConcurrencyLimiter {
  private runningCount = 0;
  private queue: QueuedTask[] = [];

  constructor(private getLimit: () => number) {}

  get pendingCount() {
    return this.queue.length;
  }

  run<T>(
    task: () => Promise<T>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const { signal } = options;
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    if (this.runningCount < Math.max(1, this.getLimit())) {
      return this.start(task);
    }
    return new Promise<T>((resolve, reject) => {
      const entry: QueuedTask = {
        start: () => {
          this.start(task).then(resolve, reject);
        },
        reject,
        signal,
        abortListener: undefined,
      };
      if (signal !== undefined) {
        const abortListener = () => {
          const index = this.queue.indexOf(entry);
          if (index !== -1) {
            this.queue.splice(index, 1);
          }
          reject(signal.reason);
        };
        entry.abortListener = abortListener;
        signal.addEventListener("abort", abortListener, { once: true });
      }
      this.queue.push(entry);
    });
  }

  private start<T>(task: () => Promise<T>): Promise<T> {
    ++this.runningCount;
    let promise: Promise<T>;
    try {
      promise = task();
    } catch (error) {
      promise = Promise.reject(error);
    }
    promise.then(
      () => this.releaseSlot(),
      () => this.releaseSlot(),
    );
    return promise;
  }

  private releaseSlot() {
    --this.runningCount;
    while (
      this.queue.length > 0 &&
      this.runningCount < Math.max(1, this.getLimit())
    ) {
      const entry = this.queue.shift()!;
      if (entry.abortListener !== undefined) {
        entry.signal!.removeEventListener("abort", entry.abortListener);
      }
      entry.start();
    }
  }
}
