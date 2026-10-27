/**
 * @license
 * Copyright 2017 Google Inc.
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

import { afterEach, describe, it, expect, vi } from "vitest";
import {
  encodeParametersAsDragType,
  decodeParametersFromDragType,
  getDropEffectFromModifiers,
} from "#src/util/drag_and_drop.js";

describe("drag_and_drop", () => {
  const prefix = "my-prefix\0";
  it("round trips simple json", () => {
    const json = { a: "Hello" };
    const result = decodeParametersFromDragType(
      encodeParametersAsDragType(prefix, json),
      prefix,
    );
    expect(result).toEqual(json);
  });
});

describe("getDropEffectFromModifiers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeDragEvent(
    modifiers: Partial<
      Pick<DragEvent, "shiftKey" | "ctrlKey" | "metaKey" | "altKey">
    >,
  ) {
    return {
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      ...modifiers,
    } as DragEvent;
  }

  function dropEffectFor(platform: string, modifiers: Partial<DragEvent>) {
    vi.stubGlobal("navigator", { platform });
    return getDropEffectFromModifiers(makeDragEvent(modifiers), "link", true)
      .dropEffect;
  }

  it("moves on Ctrl everywhere, and on Cmd on Mac only", () => {
    expect(dropEffectFor("Win32", { ctrlKey: true })).toBe("move");
    expect(dropEffectFor("Win32", { metaKey: true })).toBe("link");
    expect(dropEffectFor("MacIntel", { ctrlKey: true })).toBe("move");
    expect(dropEffectFor("MacIntel", { metaKey: true })).toBe("move");
  });

  it("names the move modifier per platform in the message", () => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    expect(
      getDropEffectFromModifiers(makeDragEvent({}), "link", true)
        .dropEffectMessage,
    ).toContain("hold CONTROL to move");
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    expect(
      getDropEffectFromModifiers(makeDragEvent({}), "link", true)
        .dropEffectMessage,
    ).toContain("hold COMMAND to move");
  });
});
