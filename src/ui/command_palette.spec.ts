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

import { describe, expect, it } from "vitest";
import {
  collectActionBindings,
  CommandCatalog,
} from "#src/ui/command_palette.js";
import { EventActionMap } from "#src/util/event_action_map.js";
import type { Viewer } from "#src/viewer.js";

function makeViewer(
  global: EventActionMap,
  sliceView = new EventActionMap(),
  perspectiveView = new EventActionMap(),
): Viewer {
  return {
    inputEventBindings: { global, sliceView, perspectiveView },
  } as unknown as Viewer;
}

describe("collectActionBindings", () => {
  it("collects keyboard bindings", () => {
    const map = new EventActionMap();
    map.set("keya", "some-action");
    const bindings = collectActionBindings(makeViewer(map));
    expect(bindings.map((binding) => binding.actionId)).toContain("some-action");
  });

  it("excludes mouse and wheel events", () => {
    const map = new EventActionMap();
    map.set("at:mousedown0", "mouse-action");
    map.set("at:wheel", "wheel-action");
    map.set("keya", "keyboard-action");
    const ids = collectActionBindings(makeViewer(map)).map((b) => b.actionId);
    expect(ids).toContain("keyboard-action");
    expect(ids).not.toContain("mouse-action");
    expect(ids).not.toContain("wheel-action");
  });

  it("keeps only the first binding when an action appears in multiple maps", () => {
    const globalMap = new EventActionMap();
    globalMap.set("keya", "shared-action");
    const sliceMap = new EventActionMap();
    sliceMap.set("keyb", "shared-action");
    const bindings = collectActionBindings(makeViewer(globalMap, sliceMap));
    const forAction = bindings.filter((b) => b.actionId === "shared-action");
    expect(forAction).toHaveLength(1);
    expect(forAction[0].eventAction.originalEventIdentifier).toBe("keya");
  });

  it("excludes open-command-palette", () => {
    const map = new EventActionMap();
    map.set("f1", "open-command-palette");
    map.set("keya", "some-action");
    const ids = collectActionBindings(makeViewer(map)).map((b) => b.actionId);
    expect(ids).not.toContain("open-command-palette");
    expect(ids).toContain("some-action");
  });
});

describe("CommandCatalog.filter", () => {
  // With empty bindings the catalog contains only the two supplemental commands:
  // "Edit JSON State" and "Screenshot".
  function makeCatalog() {
    return new CommandCatalog(null as unknown as Viewer, []);
  }

  it("returns all commands for an empty query", () => {
    const catalog = makeCatalog();
    expect(catalog.filter("")).toStrictEqual(catalog.commands);
  });

  it("is case-insensitive", () => {
    expect(makeCatalog().filter("EDIT")).toHaveLength(1);
    expect(makeCatalog().filter("edit")).toHaveLength(1);
  });

  it("ranks prefix matches before substring matches", () => {
    // "s": "Screenshot" is a prefix match; "Edit JSON State" contains 's' as a substring
    const results = makeCatalog().filter("s");
    expect(results[0].label).toBe("Screenshot");
    expect(results[1].label).toBe("Edit JSON State");
  });

  it("returns empty for a non-matching query", () => {
    expect(makeCatalog().filter("xyz")).toHaveLength(0);
  });
});
