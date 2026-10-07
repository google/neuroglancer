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
import { ActionCommand } from "#src/ui/command.js";
import {
  collectActionBindings,
  CommandCatalog,
  type CommandCatalogContext,
} from "#src/ui/command_catalog.js";
import { CommandRegistry } from "#src/ui/command_registry.js";
import { EventActionMap } from "#src/util/event_action_map.js";
import { Signal } from "#src/util/signal.js";
import type { InputEventBindings } from "#src/viewer.js";

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function makeInputEventBindings(
  global: EventActionMap,
  sliceView = new EventActionMap(),
  perspectiveView = new EventActionMap(),
): InputEventBindings {
  return {
    global,
    sliceView,
    perspectiveView,
  } as unknown as InputEventBindings;
}

const noopSignal = { add: () => () => {} };

// Registries created by makeContext, disposed after each test.
const activeRegistries: CommandRegistry[] = [];

afterEach(() => {
  while (activeRegistries.length > 0) activeRegistries.pop()!.dispose();
});

function makeLayer(name: string) {
  return {
    name,
    archived: false,
    visible: true,
    pickEnabled: true,
    supportsPickOption: true,
    setVisible: () => {},
  };
}

function makeContext(
  inputEventBindings = makeInputEventBindings(new EventActionMap()),
  commandRegistry = new CommandRegistry(),
  managedLayers: unknown[] = [],
): CommandCatalogContext {
  activeRegistries.push(commandRegistry);
  return {
    globalToolBinder: {
      changed: noopSignal,
      localBindersChanged: noopSignal,
      bindings: new Map(),
      localBinders: new Set(),
    },
    toolBinder: { context: {} },
    layerManager: {
      layersChanged: noopSignal,
      managedLayers,
      getLayerByName: () => undefined,
    },
    selectedLayer: {},
    inputEventBindings,
    commandRegistry,
  } as unknown as CommandCatalogContext;
}

describe("collectActionBindings", () => {
  it("collects keyboard bindings", () => {
    const map = new EventActionMap();
    map.set("keya", "some-action");
    const bindings = collectActionBindings(makeInputEventBindings(map));
    expect(bindings.map((binding) => binding.actionId)).toContain(
      "some-action",
    );
  });

  it("excludes mouse and wheel events", () => {
    const map = new EventActionMap();
    map.set("at:mousedown0", "mouse-action");
    map.set("at:wheel", "wheel-action");
    map.set("keya", "keyboard-action");
    const ids = collectActionBindings(makeInputEventBindings(map)).map(
      (b) => b.actionId,
    );
    expect(ids).toContain("keyboard-action");
    expect(ids).not.toContain("mouse-action");
    expect(ids).not.toContain("wheel-action");
  });

  it("keeps only the first binding when an action appears in multiple maps", () => {
    const globalMap = new EventActionMap();
    globalMap.set("keya", "shared-action");
    const sliceMap = new EventActionMap();
    sliceMap.set("keyb", "shared-action");
    const bindings = collectActionBindings(
      makeInputEventBindings(globalMap, sliceMap),
    );
    const forAction = bindings.filter((b) => b.actionId === "shared-action");
    expect(forAction).toHaveLength(1);
    expect(forAction[0].eventAction.originalEventIdentifier).toBe("keya");
  });
});

describe("collectActionBindings on Mac", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows Command for a Control binding unless Command has its own binding", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    const map = new EventActionMap();
    map.set("control+keya", "shared-action");
    map.set("control+keyb", "control-action");
    map.set("meta+keyb", "command-action");
    const bindings = collectActionBindings(makeInputEventBindings(map));
    const strokeByAction = new Map(
      bindings.map((binding) => [
        binding.actionId,
        binding.pressedEventIdentifier,
      ]),
    );
    expect(strokeByAction.get("shared-action")).toBe("meta+keya");
    expect(strokeByAction.get("control-action")).toBe("control+keyb");
    expect(strokeByAction.get("command-action")).toBe("meta+keyb");
  });
});

describe("CommandCatalog.filter", () => {
  // Seed the registry with two commands so the catalog surfaces exactly
  // "Edit JSON State" and "Screenshot" as its flat entries.
  function makeCatalog() {
    const registry = new CommandRegistry();
    registry.register(new ActionCommand("edit-json-state", "Edit JSON State"));
    registry.register(new ActionCommand("screenshot", "Screenshot"));
    return new CommandCatalog(
      makeContext(makeInputEventBindings(new EventActionMap()), registry),
    );
  }

  it("returns all commands for an empty query", () => {
    const catalog = makeCatalog();
    expect(catalog.filter("")).toStrictEqual(catalog.commands);
  });

  it("matches a command by label", () => {
    expect(
      makeCatalog()
        .filter("edit")
        .map((entry) => entry.label),
    ).toStrictEqual(["Edit JSON State"]);
  });

  it("returns empty for a non-matching query", () => {
    expect(makeCatalog().filter("xyz")).toHaveLength(0);
  });
});

describe("CommandCatalog command sources", () => {
  function makeCatalog(map: EventActionMap, registry: CommandRegistry) {
    return new CommandCatalog(
      makeContext(makeInputEventBindings(map), registry),
    );
  }

  it("annotates a registered command with its live binding", () => {
    const map = new EventActionMap();
    map.set("keyb", "toggle-scale-bar");
    const registry = new CommandRegistry();
    registry.register(
      new ActionCommand("toggle-scale-bar", "Toggle Scale Bar"),
    );
    const catalog = makeCatalog(map, registry);
    try {
      const entries = catalog.commands.filter(
        (entry) => entry.command.id === "toggle-scale-bar",
      );
      expect(entries).toHaveLength(1);
      expect(entries[0].label).toBe("Toggle Scale Bar");
      expect(entries[0].shortcut).toBe("b");
      expect(entries[0].source).toBe("registered");
    } finally {
      catalog.dispose();
    }
  });

  it("still lists a bound action that nothing registered", () => {
    // An embedder (or the Python integration) may bind an action without
    // registering a command for it; it should not vanish from the palette.
    const map = new EventActionMap();
    map.set("keyq", "embedder-action");
    const catalog = makeCatalog(map, new CommandRegistry());
    try {
      const entries = catalog.commands.filter(
        (entry) => entry.command.id === "embedder-action",
      );
      expect(entries).toHaveLength(1);
      // Falls back to a label derived from the action id.
      expect(entries[0].label).toBe("Embedder Action");
      expect(entries[0].shortcut).toBe("q");
      expect(entries[0].source).toBe("derived");
    } finally {
      catalog.dispose();
    }
  });

  it("does not duplicate an action that is both registered and bound", () => {
    const map = new EventActionMap();
    map.set("keyb", "toggle-scale-bar");
    const registry = new CommandRegistry();
    registry.register(
      new ActionCommand("toggle-scale-bar", "Toggle Scale Bar"),
    );
    const catalog = makeCatalog(map, registry);
    try {
      expect(
        catalog.commands.filter(
          (entry) => entry.command.id === "toggle-scale-bar",
        ),
      ).toHaveLength(1);
    } finally {
      catalog.dispose();
    }
  });

  it("omits disabled commands at filter time", () => {
    const map = new EventActionMap();
    map.set("keyb", "toggle-scale-bar");
    const registry = new CommandRegistry();
    const command = new ActionCommand("toggle-scale-bar", "Toggle Scale Bar");
    command.enabled = false;
    registry.register(command);
    const catalog = makeCatalog(map, registry);
    try {
      expect(catalog.filter()).toHaveLength(0);
    } finally {
      catalog.dispose();
    }
  });
});

describe("CommandCatalog reactivity", () => {
  it("rebuilds (debounced) when a subscribed change signal fires", async () => {
    const layersChanged = new Signal();
    const context = makeContext();
    (
      context.layerManager as unknown as { layersChanged: Signal }
    ).layersChanged = layersChanged;
    const catalog = new CommandCatalog(context);
    try {
      let rebuildCount = 0;
      catalog.changed.add(() => {
        ++rebuildCount;
      });
      layersChanged.dispatch();
      // The rebuild is debounced to an animation frame, so nothing fires yet.
      expect(rebuildCount).toBe(0);
      await nextAnimationFrame();
      expect(rebuildCount).toBe(1);
    } finally {
      catalog.dispose();
    }
  });
});

describe("layer command shortcuts", () => {
  it("reads the shortcut labels from the installed bindings", () => {
    const map = new EventActionMap();
    map.set("control+digit1", "select-layer-1");
    map.set("alt+digit1", "toggle-pick-layer-1");
    const catalog = new CommandCatalog(
      makeContext(makeInputEventBindings(map), new CommandRegistry(), [
        makeLayer("first"),
      ]),
    );
    try {
      expect(
        catalog.groups.map((group) => [group.label, group.shortcut]),
      ).toContainEqual(["Select Layer", "control+1–9"]);
      expect(
        catalog.commands.map((entry) => [entry.command.id, entry.shortcut]),
      ).toContainEqual(["toggle-pick-layer-1", "alt+1"]);
    } finally {
      catalog.dispose();
    }
  });
});
