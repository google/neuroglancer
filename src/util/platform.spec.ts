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
import { hasCommandOrControl, isMacPlatform } from "#src/util/platform.js";

describe("isMacPlatform", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads userAgentData, then the deprecated navigator.platform", () => {
    vi.stubGlobal("navigator", { userAgentData: { platform: "macOS" } });
    expect(isMacPlatform()).toBe(true);
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    expect(isMacPlatform()).toBe(true);
  });

  it("is false off Mac", () => {
    vi.stubGlobal("navigator", { userAgentData: { platform: "Windows" } });
    expect(isMacPlatform()).toBe(false);
  });
});

describe("hasCommandOrControl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const none = {
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
  };

  it("accepts Command only on Mac", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    expect(hasCommandOrControl({ ...none, metaKey: true })).toBe(true);
    vi.stubGlobal("navigator", { platform: "Win32" });
    expect(hasCommandOrControl({ ...none, metaKey: true })).toBe(false);
    expect(hasCommandOrControl({ ...none, ctrlKey: true })).toBe(true);
  });
});
