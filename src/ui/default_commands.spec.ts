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
import { collectActionBindings } from "#src/ui/command_catalog.js";
import { CommandRegistry } from "#src/ui/command_registry.js";
import {
  getDefaultCommands,
  registerDefaultCommands,
} from "#src/ui/default_commands.js";
import {
  getDefaultGlobalBindings,
  getDefaultPerspectivePanelBindings,
  getDefaultSliceViewPanelBindings,
} from "#src/ui/default_input_event_bindings.js";
import type { ActionIdentifier } from "#src/util/event_action_map.js";
import { EventActionMap } from "#src/util/event_action_map.js";
import type { InputEventBindings } from "#src/viewer.js";

// Actions the default commands deliberately do not declare: tool slots and
// per-layer-index actions, both of which the catalog contributes dynamically.
const DYNAMIC_ACTIONS = [
  /^tool-[A-Z]$/,
  /^(toggle|select|toggle-pick)-layer-\d+$/,
];

// Commands that exist as viewer actions but have no default key binding.
const UNBOUND_BY_DEFAULT = new Set<ActionIdentifier>([
  "edit-json-state",
  "screenshot",
  "deactivate-active-tool",
]);

function makeDefaultInputEventBindings(): InputEventBindings {
  const make = (parent: EventActionMap) => {
    const map = new EventActionMap();
    map.addParent(parent, Number.NEGATIVE_INFINITY);
    return map;
  };
  return {
    global: make(getDefaultGlobalBindings()),
    sliceView: make(getDefaultSliceViewPanelBindings()),
    perspectiveView: make(getDefaultPerspectivePanelBindings()),
  } as unknown as InputEventBindings;
}

// Every keyboard-bound action reachable from the default global, slice-view and
// perspective-view bindings (the latter two pull in the shared rendered data
// panel bindings as a parent).
function defaultBoundActions(): ActionIdentifier[] {
  return collectActionBindings(makeDefaultInputEventBindings())
    .map(({ actionId }) => actionId)
    .filter((actionId) => !DYNAMIC_ACTIONS.some((re) => re.test(actionId)));
}

function makeDefaultRegistry() {
  const registry = new CommandRegistry();
  registerDefaultCommands(registry);
  return registry;
}

describe("registerDefaultCommands", () => {
  it("declares a command for every default keyboard binding", () => {
    const registry = makeDefaultRegistry();
    const missing = defaultBoundActions().filter(
      (actionId) => !registry.has(actionId),
    );
    expect(missing).toStrictEqual([]);
    registry.dispose();
  });

  it("declares no command id that is not a real action", () => {
    // The reverse direction: a typo in a command id would otherwise register a
    // command that dispatches an `action:` event nothing listens for. Every
    // declared command must either be bound by default or be listed as
    // knowingly unbound.
    const bound = new Set(defaultBoundActions());
    const unaccounted = getDefaultCommands()
      .map(({ id }) => id)
      .filter((id) => !bound.has(id) && !UNBOUND_BY_DEFAULT.has(id));
    expect(unaccounted).toStrictEqual([]);
  });

  it("gives every command a label and a description", () => {
    const registry = makeDefaultRegistry();
    for (const command of registry.values()) {
      expect(command.label, command.id).not.toBe("");
      expect(command.description, command.id).toBeTruthy();
    }
    registry.dispose();
  });

  it("registers the axis commands for each of x, y and z", () => {
    const registry = makeDefaultRegistry();
    for (const axis of ["x", "y", "z"]) {
      for (const sign of ["-", "+"]) {
        expect(registry.has(`${axis}${sign}`), `${axis}${sign}`).toBe(true);
        expect(
          registry.has(`rotate-relative-${axis}${sign}`),
          `rotate-relative-${axis}${sign}`,
        ).toBe(true);
      }
    }
    registry.dispose();
  });
});
