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

import { describe, expect, test } from "vitest";
import { PromiseConcurrencyLimiter } from "#src/util/promise_concurrency_limiter.js";

function makeDeferredTask() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  let started = false;
  const promise = new Promise<void>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return {
    task: () => {
      started = true;
      return promise;
    },
    get started() {
      return started;
    },
    resolve,
    reject,
  };
}

describe("PromiseConcurrencyLimiter", () => {
  test("starts tasks synchronously while under the limit", () => {
    const limiter = new PromiseConcurrencyLimiter(() => 2);
    const a = makeDeferredTask();
    const b = makeDeferredTask();
    void limiter.run(a.task);
    void limiter.run(b.task);
    expect(a.started).toBe(true);
    expect(b.started).toBe(true);
    expect(limiter.pendingCount).toBe(0);
  });

  test("queues tasks beyond the limit and dequeues in FIFO order", async () => {
    const limiter = new PromiseConcurrencyLimiter(() => 1);
    const a = makeDeferredTask();
    const b = makeDeferredTask();
    const c = makeDeferredTask();
    const aPromise = limiter.run(a.task);
    void limiter.run(b.task);
    void limiter.run(c.task);
    expect(a.started).toBe(true);
    expect(b.started).toBe(false);
    expect(c.started).toBe(false);
    expect(limiter.pendingCount).toBe(2);
    a.resolve();
    await aPromise;
    expect(b.started).toBe(true);
    expect(c.started).toBe(false);
    expect(limiter.pendingCount).toBe(1);
  });

  test("a rejected task releases its slot", async () => {
    const limiter = new PromiseConcurrencyLimiter(() => 1);
    const a = makeDeferredTask();
    const b = makeDeferredTask();
    const aPromise = limiter.run(a.task);
    void limiter.run(b.task);
    a.reject(new Error("failure"));
    await expect(aPromise).rejects.toThrowError("failure");
    expect(b.started).toBe(true);
  });

  test("a synchronously throwing task releases its slot", async () => {
    const limiter = new PromiseConcurrencyLimiter(() => 1);
    const b = makeDeferredTask();
    const aPromise = limiter.run(() => {
      throw new Error("sync failure");
    });
    void limiter.run(b.task);
    await expect(aPromise).rejects.toThrowError("sync failure");
    expect(b.started).toBe(true);
  });

  test("re-reads the limit at each dispatch", async () => {
    let limit = 1;
    const limiter = new PromiseConcurrencyLimiter(() => limit);
    const a = makeDeferredTask();
    const b = makeDeferredTask();
    const c = makeDeferredTask();
    const aPromise = limiter.run(a.task);
    void limiter.run(b.task);
    void limiter.run(c.task);
    expect(b.started).toBe(false);
    limit = 2;
    a.resolve();
    await aPromise;
    expect(b.started).toBe(true);
    expect(c.started).toBe(true);
  });

  test("treats a limit below one as one", () => {
    const limiter = new PromiseConcurrencyLimiter(() => 0);
    const a = makeDeferredTask();
    const b = makeDeferredTask();
    void limiter.run(a.task);
    void limiter.run(b.task);
    expect(a.started).toBe(true);
    expect(b.started).toBe(false);
  });

  test("rejects immediately for an already aborted signal", async () => {
    const limiter = new PromiseConcurrencyLimiter(() => 1);
    const controller = new AbortController();
    controller.abort(new Error("already aborted"));
    const a = makeDeferredTask();
    await expect(
      limiter.run(a.task, { signal: controller.signal }),
    ).rejects.toThrowError("already aborted");
    expect(a.started).toBe(false);
  });

  test("aborting a queued task rejects it without consuming a slot", async () => {
    const limiter = new PromiseConcurrencyLimiter(() => 1);
    const a = makeDeferredTask();
    const b = makeDeferredTask();
    const c = makeDeferredTask();
    const controller = new AbortController();
    const aPromise = limiter.run(a.task);
    const bPromise = limiter.run(b.task, { signal: controller.signal });
    void limiter.run(c.task);
    controller.abort(new Error("queued abort"));
    await expect(bPromise).rejects.toThrowError("queued abort");
    expect(b.started).toBe(false);
    expect(limiter.pendingCount).toBe(1);
    a.resolve();
    await aPromise;
    expect(c.started).toBe(true);
  });

  test("aborting after a task starts does not affect the limiter", async () => {
    const limiter = new PromiseConcurrencyLimiter(() => 1);
    const a = makeDeferredTask();
    const b = makeDeferredTask();
    const controller = new AbortController();
    const aPromise = limiter.run(a.task, { signal: controller.signal });
    void limiter.run(b.task);
    a.resolve();
    await aPromise;
    controller.abort();
    expect(b.started).toBe(true);
  });
});
