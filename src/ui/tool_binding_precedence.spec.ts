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
  getDefaultGlobalBindings,
  getDefaultSkeletonTabBindings,
  getDefaultSliceViewPanelBindings,
} from "#src/ui/default_input_event_bindings.js";
import type { Tool } from "#src/ui/tool.js";
import {
  CONTEXTUAL_PANEL_BINDING_PRIORITY,
  GlobalToolBinder,
  USER_TOOL_BINDING_PRIORITY,
} from "#src/ui/tool.js";
import { EventActionMap } from "#src/util/event_action_map.js";

/**
 * Minimal stand-in for a bound tool, covering only the members
 * `GlobalToolBinder.set` and `deleteBinding` touch.
 */
function makeTool(identifier: string): Tool {
  return {
    localBinder: {
      bindings: new Map(),
      jsonToKey: new Map(),
      changed: { dispatch: () => {} },
    },
    changed: { add: () => () => {} },
    keyBinding: undefined,
    savedJsonString: undefined,
    toJSON: () => ({ type: identifier }),
    dispose: () => {},
  } as unknown as Tool;
}

function makeToolBinder() {
  return new GlobalToolBinder(
    () => {},
    {} as unknown as ConstructorParameters<typeof GlobalToolBinder>[1],
  );
}

/**
 * Mirrors how `Viewer` wires a root binding map: the built-in defaults at
 * NEGATIVE_INFINITY and the user's tool bindings at USER_TOOL_BINDING_PRIORITY.
 */
function makeRootMap(toolBinder: GlobalToolBinder, defaults: EventActionMap) {
  const rootMap = new EventActionMap();
  rootMap.addParent(defaults, Number.NEGATIVE_INFINITY);
  rootMap.addParent(
    toolBinder.boundKeyEventActionMap,
    USER_TOOL_BINDING_PRIORITY,
  );
  return rootMap;
}

describe("GlobalToolBinder.boundKeyEventActionMap", () => {
  it("contains only letters with a tool bound", () => {
    const toolBinder = makeToolBinder();
    const { boundKeyEventActionMap } = toolBinder;

    expect(boundKeyEventActionMap.get("at:keyr")).toBeUndefined();

    toolBinder.set("R", makeTool("a"));
    expect(boundKeyEventActionMap.get("at:keyr")?.action).toBe("tool-R");
    // The legacy `shift`+letter form activates the tool as well.
    expect(boundKeyEventActionMap.get("at:shift+keyr")?.action).toBe("tool-R");
    // Other letters are unaffected.
    expect(boundKeyEventActionMap.get("at:keye")).toBeUndefined();

    toolBinder.set("R", undefined);
    expect(boundKeyEventActionMap.get("at:keyr")).toBeUndefined();
  });

  it("does not claim modifier combinations used by system bindings", () => {
    const toolBinder = makeToolBinder();
    toolBinder.set("P", makeTool("a"));
    expect(
      toolBinder.boundKeyEventActionMap.get("at:control+keyp"),
    ).toBeUndefined();
  });
});

describe("user tool binding precedence", () => {
  it("overrides the data panel rotation bindings", () => {
    const toolBinder = makeToolBinder();
    const rootMap = makeRootMap(toolBinder, getDefaultSliceViewPanelBindings());

    expect(rootMap.get("at:keyr")?.action).toBe("rotate-relative-z-");
    expect(rootMap.get("at:keye")?.action).toBe("rotate-relative-z+");

    toolBinder.set("R", makeTool("a"));
    expect(rootMap.get("at:keyr")?.action).toBe("tool-R");
    // `e` keeps rotating: precedence applies per letter.
    expect(rootMap.get("at:keye")?.action).toBe("rotate-relative-z+");

    toolBinder.set("R", undefined);
    expect(rootMap.get("at:keyr")?.action).toBe("rotate-relative-z-");
  });

  it("overrides the global bindings", () => {
    const toolBinder = makeToolBinder();
    const rootMap = makeRootMap(toolBinder, getDefaultGlobalBindings());

    expect(rootMap.get("at:keyl")?.action).toBe("recolor");

    toolBinder.set("L", makeTool("a"));
    expect(rootMap.get("at:keyl")?.action).toBe("tool-L");
  });

  it("leaves the command palette shortcut alone", () => {
    const toolBinder = makeToolBinder();
    const rootMap = makeRootMap(toolBinder, getDefaultGlobalBindings());

    toolBinder.set("P", makeTool("a"));
    expect(rootMap.get("at:control+keyp")?.action).toBe("open-command-palette");
  });

  it("overrides a visible side panel's bindings", () => {
    const toolBinder = makeToolBinder();
    const rootMap = makeRootMap(toolBinder, getDefaultSliceViewPanelBindings());
    rootMap.addParent(
      getDefaultSkeletonTabBindings(),
      CONTEXTUAL_PANEL_BINDING_PRIORITY,
    );

    // The skeleton tab still outranks the data panel bindings.
    expect(rootMap.get("at:keyr")?.action).toBe("skeleton-go-root");

    toolBinder.set("R", makeTool("a"));
    expect(rootMap.get("at:keyr")?.action).toBe("tool-R");
  });

  it("yields to the active tool's own bindings", () => {
    const toolBinder = makeToolBinder();
    const rootMap = makeRootMap(toolBinder, getDefaultSliceViewPanelBindings());
    const activeToolMap = EventActionMap.fromObject({ keyr: "tool-action" });
    rootMap.addParent(activeToolMap, Number.POSITIVE_INFINITY);

    toolBinder.set("R", makeTool("a"));
    expect(rootMap.get("at:keyr")?.action).toBe("tool-action");
  });
});
