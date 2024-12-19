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

import { describe, expect, test } from "vitest";
import { raceWithAbort, SharedAbortController } from "#src/util/abort.js";

describe("SharedAbortController", () => {
  test("supports abort from two consumers", async () => {
    const sharedController = new SharedAbortController();
    const controller1 = new AbortController();
    sharedController.addConsumer(controller1.signal);
    const controller2 = new AbortController();
    sharedController.addConsumer(controller2.signal);
    controller1.abort();
    expect(sharedController.signal.aborted).toBe(false);
    expect(sharedController.signal.aborted).toBe(false);
    controller2.abort();
    expect(sharedController.signal.aborted).toBe(true);
  });

  test("supports undefined AbortSignal", async () => {
    const sharedController = new SharedAbortController();
    const controller1 = new AbortController();
    sharedController.addConsumer(controller1.signal);
    sharedController.addConsumer(undefined);
    controller1.abort();
    await Promise.resolve();
    expect(sharedController.signal.aborted).toBe(false);
  });

  test("supports dispose", async () => {
    const controller1 = new AbortController();
    let called = false;
    {
      using sharedController = new SharedAbortController();
      sharedController.addConsumer(controller1.signal);
      sharedController.signal.addEventListener("abort", () => {
        called = true;
      });
    }
    expect(called).toBe(false);
    controller1.abort();
    expect(called).toBe(false);
  });
});

describe("raceWithAbort", () => {
  test("undefined signal", () => {
    const promise = Promise.resolve(5);
    expect(raceWithAbort(promise, undefined)).toBe(promise);
  });

  test("already aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const promise = new Promise((_resolve, _reject) => {});
    await expect(() =>
      raceWithAbort(promise, controller.signal),
    ).rejects.toThrowError(/aborted/);
  });

  test("not abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const promise = new Promise((_resolve, _reject) => {});
    await expect(() =>
      raceWithAbort(promise, controller.signal),
    ).rejects.toThrowError(/aborted/);
  });

  test("aborted later signal", async () => {
    const controller = new AbortController();
    const promise = new Promise((_resolve, _reject) => {});
    const wrappedPromise = raceWithAbort(promise, controller.signal);
    controller.abort();
    await expect(() => wrappedPromise).rejects.toThrowError(/aborted/);
  });
});
