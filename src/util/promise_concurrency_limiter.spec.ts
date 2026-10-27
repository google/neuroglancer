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
    const firstTask = makeDeferredTask();
    const secondTask = makeDeferredTask();
    void limiter.run(firstTask.task);
    void limiter.run(secondTask.task);
    expect(firstTask.started).toBe(true);
    expect(secondTask.started).toBe(true);
    expect(limiter.pendingCount).toBe(0);
  });

  test("starts waiting tasks in the order they were queued as slots free", async () => {
    const limiter = new PromiseConcurrencyLimiter(() => 1);
    const firstTask = makeDeferredTask();
    const secondTask = makeDeferredTask();
    const thirdTask = makeDeferredTask();
    const firstTaskResult = limiter.run(firstTask.task);
    void limiter.run(secondTask.task);
    void limiter.run(thirdTask.task);
    expect(firstTask.started).toBe(true);
    expect(secondTask.started).toBe(false);
    expect(thirdTask.started).toBe(false);
    expect(limiter.pendingCount).toBe(2);
    firstTask.resolve();
    await firstTaskResult;
    expect(secondTask.started).toBe(true);
    expect(thirdTask.started).toBe(false);
    expect(limiter.pendingCount).toBe(1);
  });

  test("a rejected task releases its slot", async () => {
    const limiter = new PromiseConcurrencyLimiter(() => 1);
    const firstTask = makeDeferredTask();
    const secondTask = makeDeferredTask();
    const firstTaskResult = limiter.run(firstTask.task);
    void limiter.run(secondTask.task);
    firstTask.reject(new Error("failure"));
    await expect(firstTaskResult).rejects.toThrowError("failure");
    expect(secondTask.started).toBe(true);
  });

  test("a synchronously throwing task releases its slot", async () => {
    const limiter = new PromiseConcurrencyLimiter(() => 1);
    const waitingTask = makeDeferredTask();
    const throwingTaskResult = limiter.run(() => {
      throw new Error("sync failure");
    });
    void limiter.run(waitingTask.task);
    await expect(throwingTaskResult).rejects.toThrowError("sync failure");
    expect(waitingTask.started).toBe(true);
  });

  test("a raised limit lets more waiting tasks start when a slot frees", async () => {
    let limit = 1;
    const limiter = new PromiseConcurrencyLimiter(() => limit);
    const firstTask = makeDeferredTask();
    const secondTask = makeDeferredTask();
    const thirdTask = makeDeferredTask();
    const firstTaskResult = limiter.run(firstTask.task);
    void limiter.run(secondTask.task);
    void limiter.run(thirdTask.task);
    expect(secondTask.started).toBe(false);
    limit = 2;
    firstTask.resolve();
    await firstTaskResult;
    expect(secondTask.started).toBe(true);
    expect(thirdTask.started).toBe(true);
  });

  test("treats a limit below one as one", () => {
    const limiter = new PromiseConcurrencyLimiter(() => 0);
    const firstTask = makeDeferredTask();
    const secondTask = makeDeferredTask();
    void limiter.run(firstTask.task);
    void limiter.run(secondTask.task);
    expect(firstTask.started).toBe(true);
    expect(secondTask.started).toBe(false);
  });

  test("rejects immediately for an already aborted signal", async () => {
    const limiter = new PromiseConcurrencyLimiter(() => 1);
    const controller = new AbortController();
    controller.abort(new Error("already aborted"));
    const firstTask = makeDeferredTask();
    await expect(
      limiter.run(firstTask.task, { signal: controller.signal }),
    ).rejects.toThrowError("already aborted");
    expect(firstTask.started).toBe(false);
  });

  test("aborting a queued task rejects it without consuming a slot", async () => {
    const limiter = new PromiseConcurrencyLimiter(() => 1);
    const runningTask = makeDeferredTask();
    const abortedTask = makeDeferredTask();
    const waitingTask = makeDeferredTask();
    const controller = new AbortController();
    const runningTaskResult = limiter.run(runningTask.task);
    const abortedTaskResult = limiter.run(abortedTask.task, {
      signal: controller.signal,
    });
    void limiter.run(waitingTask.task);
    controller.abort(new Error("queued abort"));
    await expect(abortedTaskResult).rejects.toThrowError("queued abort");
    expect(abortedTask.started).toBe(false);
    expect(limiter.pendingCount).toBe(1);
    runningTask.resolve();
    await runningTaskResult;
    expect(waitingTask.started).toBe(true);
  });

  test("aborting a task after it starts neither rejects it nor frees its slot", async () => {
    const limiter = new PromiseConcurrencyLimiter(() => 1);
    const runningTask = makeDeferredTask();
    const abortedTask = makeDeferredTask();
    const waitingTask = makeDeferredTask();
    const controller = new AbortController();
    const runningTaskResult = limiter.run(runningTask.task);
    const abortedTaskResult = limiter.run(abortedTask.task, {
      signal: controller.signal,
    });
    void limiter.run(waitingTask.task);
    runningTask.resolve();
    await runningTaskResult;
    expect(abortedTask.started).toBe(true);

    controller.abort(new Error("late abort"));
    await Promise.resolve();
    expect(waitingTask.started).toBe(false);

    abortedTask.resolve();
    await expect(abortedTaskResult).resolves.toBeUndefined();
    expect(waitingTask.started).toBe(true);
  });

  test("starts a prioritized task ahead of tasks queued before it", async () => {
    const limiter = new PromiseConcurrencyLimiter(() => 1);
    const runningTask = makeDeferredTask();
    const earlierQueuedTask = makeDeferredTask();
    const prioritizedTask = makeDeferredTask();
    const runningTaskResult = limiter.run(runningTask.task);
    void limiter.run(earlierQueuedTask.task);
    void limiter.run(prioritizedTask.task, { isPrioritized: () => true });
    runningTask.resolve();
    await runningTaskResult;
    expect(prioritizedTask.started).toBe(true);
    expect(earlierQueuedTask.started).toBe(false);
  });

  test("starts a task prioritized after it was queued ahead of the others", async () => {
    const limiter = new PromiseConcurrencyLimiter(() => 1);
    const runningTask = makeDeferredTask();
    const earlierQueuedTask = makeDeferredTask();
    const prioritizedTask = makeDeferredTask();
    let prioritizedTaskIsUrgent = false;
    const runningTaskResult = limiter.run(runningTask.task);
    void limiter.run(earlierQueuedTask.task, { isPrioritized: () => false });
    void limiter.run(prioritizedTask.task, {
      isPrioritized: () => prioritizedTaskIsUrgent,
    });
    prioritizedTaskIsUrgent = true;
    runningTask.resolve();
    await runningTaskResult;
    expect(prioritizedTask.started).toBe(true);
    expect(earlierQueuedTask.started).toBe(false);
  });
});
