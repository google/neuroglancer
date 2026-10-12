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

import { afterEach, describe, expect, it, vi } from "vitest";

import { StatusMessage, statusMessages } from "#src/status.js";

describe("StatusMessage", () => {
  afterEach(() => {
    for (const message of [...statusMessages]) message.dispose();
  });

  it("supports a required action instead of the default Dismiss button", () => {
    const refresh = vi.fn();
    const message = StatusMessage.showErrorMessage(
      "Refresh the page to continue.",
      { label: "Refresh", callback: refresh },
    );
    const button = message.element.querySelector("button");

    expect(button?.textContent).toBe("Refresh");
    button?.click();

    expect(refresh).toHaveBeenCalledOnce();
    expect(statusMessages.has(message)).toBe(false);
  });
});
