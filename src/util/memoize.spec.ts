/**
 * @license
 * Copyright 2025 Google Inc.
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

import { describe, test, expect, vi } from "vitest";
import { raceWithAbort } from "#src/util/abort.js";
import { asyncMemoize, asyncMemoizeWithProgress } from "#src/util/memoize.js";
import type { ProgressListener } from "#src/util/progress_listener.js";
import { ProgressSpan } from "#src/util/progress_listener.js";

function asyncMemoizeTests(asyncMemoizeImpl: typeof asyncMemoize) {
  test("should call the getter only once even if called multiple times", async () => {
    const getter = vi.fn().mockResolvedValue("result");
    const memoizedGetter = asyncMemoizeImpl(getter);

    const promise1 = memoizedGetter({});
    const promise2 = memoizedGetter({});

    await Promise.all([promise1, promise2]);

    expect(getter).toHaveBeenCalledTimes(1);
  });

  test("should handle getter rejections", async () => {
    const getter = vi.fn().mockRejectedValue(new Error("error"));
    const memoizedGetter = asyncMemoizeImpl(getter);

    const promise1 = memoizedGetter({});
    const promise2 = memoizedGetter({});

    await expect(promise1).rejects.toThrow("error");
    await expect(promise2).rejects.toThrow("error");
    expect(getter).toHaveBeenCalledTimes(1);
  });

  test("should abort the getter if the signal is aborted before the call", async () => {
    const getter = vi.fn();
    const memoizedGetter = asyncMemoizeImpl(getter);
    const controller = new AbortController();
    controller.abort("reason");

    await expect(memoizedGetter({ signal: controller.signal })).rejects.toThrow(
      "reason",
    );
    expect(getter).not.toHaveBeenCalled();
  });

  test("should abort the getter if the signal is aborted during the call", async () => {
    const neverResolved = new Promise<void>(() => {});
    const getter = vi.fn(async ({ signal }) =>
      raceWithAbort(neverResolved, signal),
    );
    const memoizedGetter = asyncMemoizeImpl(getter);

    const controller = new AbortController();
    const promise = memoizedGetter({ signal: controller.signal });
    controller.abort("reason");
    await expect(promise).rejects.toBe("reason");
    expect(getter).toHaveBeenCalledTimes(1);
  });

  test("should call getter again if first call aborted", async () => {
    const { promise: getterPromise, resolve: getterResolve } =
      Promise.withResolvers<string>();
    const getter = vi.fn(async ({ signal }) =>
      raceWithAbort(getterPromise, signal),
    );
    const memoizedGetter = asyncMemoizeImpl(getter);

    const controller1 = new AbortController();
    const promise1 = memoizedGetter({ signal: controller1.signal });
    controller1.abort("reason");
    await expect(promise1).rejects.toBe("reason");

    const controller2 = new AbortController();
    const promise2 = memoizedGetter({ signal: controller2.signal });
    getterResolve("some result");
    await expect(promise2).resolves.toBe("some result");

    expect(getter).toHaveBeenCalledTimes(2);

    const promise3 = memoizedGetter({});
    await expect(promise3).resolves.toBe("some result"); // should reuse previous successful result

    expect(getter).toHaveBeenCalledTimes(2); // still 2
  });

  test("getter receives abort signal on abort", async () => {
    const abortPromise = Promise.withResolvers<void>();
    const memoizedGetter = asyncMemoizeImpl(async ({ signal }) => {
      signal.addEventListener("abort", () =>
        abortPromise.reject(signal.reason),
      );
    });

    const controller = new AbortController();
    const promise = memoizedGetter({ signal: controller.signal });
    controller.abort("abort reason");
    await expect(promise).rejects.toThrow("abort reason");

    await expect(abortPromise.promise).rejects.toThrow();
  });
}

describe("asyncMemoize", () => {
  asyncMemoizeTests(asyncMemoize);
});

describe("asyncMemoizeWithProgress", () => {
  asyncMemoizeTests(asyncMemoizeWithProgress);
  test("should report progress to the listener", async () => {
    const { promise: getterPromise, resolve: getterResolve } =
      Promise.withResolvers<void>();
    const getter = vi.fn(
      async (options: { progressListener: ProgressListener }) => {
        using _span1 = new ProgressSpan(options.progressListener, {
          message: "span1",
        });
        return await getterPromise;
      },
    );

    const memoizedGetter = asyncMemoizeWithProgress(getter);
    const listener1 = {
      addSpan: vi.fn(),
      removeSpan: vi.fn(),
    };
    const listener2 = {
      addSpan: vi.fn(),
      removeSpan: vi.fn(),
    };
    const promise = memoizedGetter({
      progressListener: listener1,
    });
    memoizedGetter({ progressListener: listener2 });

    getterResolve();

    await promise;

    expect(listener1.addSpan).toHaveBeenCalledTimes(1);
    expect(listener1.removeSpan).toHaveBeenCalledTimes(1);
    expect(listener2.addSpan).toHaveBeenCalledTimes(1);
    expect(listener2.removeSpan).toHaveBeenCalledTimes(1);
    expect(getter).toHaveBeenCalledTimes(1);
  });
  test("should not add and remove listener after completion", async () => {
    const getter = vi.fn().mockResolvedValue("result");
    const memoizedGetter = asyncMemoizeWithProgress(getter);
    const listener1 = {
      addSpan: vi.fn(),
      removeSpan: vi.fn(),
    };
    const promise1 = memoizedGetter({ progressListener: listener1 });
    await promise1;
    expect(getter).toBeCalledTimes(1);
    const listener2 = {
      addSpan: vi.fn(),
      removeSpan: vi.fn(),
    };
    memoizedGetter({ progressListener: listener2 }); // second call after the first completed
    expect(listener2.addSpan).not.toBeCalled();
    expect(listener2.removeSpan).not.toBeCalled();
    expect(getter).toBeCalledTimes(1); // still 1
  });
});
