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

import "core-js/proposals/explicit-resource-management.js";
import { beforeAll, afterAll } from "vitest";

export interface Fixture<T> {
  (): Promise<T>;
}

export function fixture<T>(
  setup: (disposableStack: AsyncDisposableStack) => Promise<T>,
): Fixture<T> {
  let setupPromise: Promise<T> | undefined;
  const stack = new AsyncDisposableStack();

  afterAll(async () => {
    setupPromise = undefined;
    await stack[Symbol.asyncDispose]();
  });

  const asyncGetter = () => {
    if (setupPromise === undefined) {
      setupPromise = (async () => {
        return setup(stack);
      })();
    }
    return setupPromise;
  };

  beforeAll(async () => {
    await asyncGetter();
  });

  return asyncGetter;
}

export function constantFixture<T>(value: T): Fixture<T> {
  const promise = Promise.resolve(value);
  return () => promise;
}
