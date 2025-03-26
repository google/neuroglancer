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

import { afterEach } from "vitest";
import type { StatusMessage } from "#src/status.js";
import { statusMessages, getStatusMessageContainers } from "#src/status.js";
import type { Fixture } from "#tests/fixtures/fixture.js";
import { fixture } from "#tests/fixtures/fixture.js";

export interface StatusMessageHandler {
  (message: StatusMessage): void;
}
export class StatusMessageObserver {
  private handlers: Set<StatusMessageHandler> = new Set();
  private observer: MutationObserver;
  constructor() {
    this.observer = new MutationObserver(() => {
      for (const handler of this.handlers) {
        for (const message of statusMessages) {
          handler(message);
        }
      }
    });
    for (const element of getStatusMessageContainers()) {
      this.observer.observe(element, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    }
  }
  registerHandler(handler: StatusMessageHandler): Disposable {
    const wrappedHandler: StatusMessageHandler = (status) => handler(status);
    this.handlers.add(wrappedHandler);
    return {
      [Symbol.dispose]: () => {
        this.handlers.delete(wrappedHandler);
      },
    };
  }
  async waitForButton(pattern: RegExp): Promise<HTMLButtonElement> {
    const { promise, resolve } = Promise.withResolvers<HTMLButtonElement>();
    using _handler = this.registerHandler((status) => {
      const result = document.evaluate(
        `.//button`,
        status.element,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null,
      );
      for (let i = 0, length = result.snapshotLength; i < length; ++i) {
        const button = result.snapshotItem(i) as HTMLButtonElement;
        if ((button.textContent ?? "").match(pattern)) {
          resolve(button);
        }
      }
    });
    return await promise;
  }
  reset() {
    this.handlers.clear();
  }
  [Symbol.dispose]() {
    this.observer.disconnect();
  }
}

export function statusMessageObserverFixture(): Fixture<StatusMessageObserver> {
  const f = fixture(async () => new StatusMessageObserver());
  afterEach(async () => {
    const handler = await f();
    handler.reset();
  });
  return f;
}
