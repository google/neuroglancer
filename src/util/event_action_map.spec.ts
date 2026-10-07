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
import {
  EventActionMap,
  friendlyEventIdentifier,
  registerActionListener,
} from "#src/util/event_action_map.js";
import { KeyboardEventBinder } from "#src/util/keyboard_bindings.js";

describe("friendlyEventIdentifier", () => {
  it("strips the phase along with its colon", () => {
    expect(friendlyEventIdentifier("at:control+mousedown0")).toBe(
      "control+mousedown0",
    );
  });
});

describe("mac control bindings", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function pressKey(
    platform: string,
    bindings: Record<string, string>,
    init: KeyboardEventInit,
  ): string[] {
    vi.stubGlobal("navigator", { platform });
    const element = document.createElement("div");
    document.body.appendChild(element);
    const binder = new KeyboardEventBinder(
      element,
      EventActionMap.fromObject(bindings),
    );
    const dispatched: string[] = [];
    const listeners = Object.values(bindings).map((action) =>
      registerActionListener(element, action, () => dispatched.push(action)),
    );
    try {
      element.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, ...init }),
      );
    } finally {
      for (const listener of listeners) listener();
      binder.dispose();
      element.remove();
    }
    return dispatched;
  }

  const controlBinding = { "control+keya": "do-thing" };

  it("reaches a control binding with Command on Mac only", () => {
    const withCommand = { code: "KeyA", metaKey: true };
    expect(pressKey("MacIntel", controlBinding, withCommand)).toEqual([
      "do-thing",
    ]);
    expect(pressKey("Win32", controlBinding, withCommand)).toEqual([]);
  });

  it("still reaches a control binding with Control on Mac", () => {
    expect(
      pressKey("MacIntel", controlBinding, { code: "KeyA", ctrlKey: true }),
    ).toEqual(["do-thing"]);
  });

  it("prefers an explicit meta binding on Mac", () => {
    expect(
      pressKey(
        "MacIntel",
        { ...controlBinding, "meta+keya": "meta-thing" },
        { code: "KeyA", metaKey: true },
      ),
    ).toEqual(["meta-thing"]);
  });
});
