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

import type { LayerManager, SelectedLayerState } from "#src/layer/index.js";
import { UserLayer } from "#src/layer/index.js";
import type { Command } from "#src/ui/command.js";
import {
  ActionCommand,
  CallbackCommand,
  formatKeyStroke,
} from "#src/ui/command.js";
import type { CommandRegistry } from "#src/ui/command_registry.js";
import {
  getMatchingTools,
  restoreTool,
  type GlobalToolBinder,
  type LocalToolBinder,
} from "#src/ui/tool.js";
import { parseToolQuery } from "#src/ui/tool_query.js";
import type { DebouncedFunction } from "#src/util/animation_frame_debounce.js";
import { animationFrameDebounce } from "#src/util/animation_frame_debounce.js";
import { RefCounted } from "#src/util/disposable.js";
import type {
  ActionIdentifier,
  EventAction,
  NormalizedEventIdentifier,
} from "#src/util/event_action_map.js";
import { friendlyEventIdentifier } from "#src/util/event_action_map.js";
import { rankedMatches } from "#src/util/ranked_matches.js";
import { Signal } from "#src/util/signal.js";
import type { InputEventBindings } from "#src/viewer.js";

export interface CommandCatalogContext {
  readonly globalToolBinder: GlobalToolBinder;
  /**
   * Tool context for tools that are not scoped to a layer. Tool factories are
   * registered against a class prototype, so the binder's own context has to be
   * a real instance of such a class rather than an arbitrary object.
   */
  readonly toolBinder: LocalToolBinder;
  readonly layerManager: LayerManager;
  readonly selectedLayer: SelectedLayerState;
  readonly inputEventBindings: InputEventBindings;
  /**
   * Primary source of the flat command set. Registered commands are enumerated
   * directly and take precedence; any keyboard-bound action that is *not*
   * registered is still listed afterwards, so actions an embedder or the Python
   * integration only ever bound to a key do not disappear from the palette.
   */
  readonly commandRegistry: CommandRegistry;
}

export interface ActionBinding {
  readonly actionId: ActionIdentifier;
  readonly eventAction: EventAction;
}

export type CommandSource = "registered" | "derived";

// Can identify the sub-palette an entry belongs to.
export interface CommandGroup {
  readonly label: string;
  readonly shortcut: string;
}

// A command, either taken from the registry or synthesised for a keyboard-bound
// action that nothing registered. The consumer invokes it with its own context.
export interface CommandEntry {
  readonly shortcut: string;
  readonly label: string;
  readonly command: Command;
  readonly source: CommandSource;
  readonly group?: CommandGroup;
}

// Fallback label for a bound action that no command was registered for.
function actionIdToLabel(actionId: ActionIdentifier): string {
  return actionId
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function isKeyboardEvent(normalizedId: NormalizedEventIdentifier): boolean {
  return (
    !normalizedId.includes("mouse") &&
    !normalizedId.includes("wheel") &&
    !normalizedId.includes("touch") &&
    !normalizedId.includes("click")
  );
}

// Creates a Tool instance from a palette-form JSON object (with optional "layer" field).
// Caller is responsible for disposing the returned tool.
function createToolFromJson(context: CommandCatalogContext, toolJson: unknown) {
  try {
    const json =
      typeof toolJson === "object" && toolJson !== null
        ? (toolJson as Record<string, unknown>)
        : undefined;
    const layerName = typeof json?.layer === "string" ? json.layer : undefined;
    if (layerName !== undefined) {
      const { layer: _ignored, ...rest } = json!;
      const managedLayer = context.layerManager.getLayerByName(layerName);
      const userLayer = managedLayer?.layer ?? null;
      if (userLayer === null) return undefined;
      return restoreTool(userLayer, rest);
    }
    return restoreTool(context.toolBinder.context, toolJson);
  } catch {
    return undefined;
  }
}

// Attemp for full description of tool by creating then disposing
function getToolDescription(
  context: CommandCatalogContext,
  toolJson: unknown,
): string {
  const tool = createToolFromJson(context, toolJson);
  if (tool === undefined) return toolJsonToLabel(toolJson);
  const label =
    tool.context instanceof UserLayer
      ? `${tool.description} — ${tool.context.managedLayer.name}`
      : tool.description;
  tool.dispose();
  return label;
}

// Fallback label derived purely from the JSON structure
function toolJsonToLabel(toolJson: unknown): string {
  const json =
    typeof toolJson === "object" && toolJson !== null
      ? (toolJson as Record<string, unknown>)
      : undefined;
  const typeName =
    typeof toolJson === "string"
      ? toolJson
      : typeof json?.type === "string"
        ? json.type
        : undefined;
  const layerName = typeof json?.layer === "string" ? json.layer : undefined;
  const base =
    typeName !== undefined
      ? typeName
          .replace(/([A-Z])/g, " $1")
          .replace(/-./g, (s) => " " + s[1].toUpperCase())
          .replace(/^./, (s) => s.toUpperCase())
          .trim()
      : "Unknown Tool";
  return layerName !== undefined ? `${base} — ${layerName}` : base;
}

function isToolLayerVisible(
  context: CommandCatalogContext,
  toolJson: unknown,
): boolean {
  const json =
    typeof toolJson === "object" && toolJson !== null
      ? (toolJson as Record<string, unknown>)
      : undefined;
  const layerName = typeof json?.layer === "string" ? json.layer : undefined;
  if (layerName === undefined) return true;
  const managedLayer = context.layerManager.getLayerByName(layerName);
  return managedLayer !== undefined && managedLayer.visible;
}

function activateUnboundTool(
  context: CommandCatalogContext,
  toolJson: unknown,
): void {
  const tool = createToolFromJson(context, toolJson);
  if (tool === undefined) return;

  const existingKey = tool.localBinder.jsonToKey.get(
    JSON.stringify(tool.toJSON()),
  );
  if (existingKey !== undefined) {
    tool.dispose();
    context.globalToolBinder.activate(existingKey);
  } else {
    context.globalToolBinder.activateDirect(tool);
  }
}

/**
 * Walk the event action maps available on the viewer and produce a list of
 * every action with any keyboard binding. The first binding found for each
 * action is kept; subsequent bindings for the same action are ignored.
 */
export function collectActionBindings(
  inputEventBindings: InputEventBindings,
): readonly ActionBinding[] {
  const seenBindings = new Map<ActionIdentifier, EventAction>();

  const collect = (
    bindings: Iterable<[NormalizedEventIdentifier, EventAction]>,
  ) => {
    for (const [normalizedId, eventAction] of bindings) {
      if (!isKeyboardEvent(normalizedId)) continue;
      if (!seenBindings.has(eventAction.action)) {
        seenBindings.set(eventAction.action, eventAction);
      }
    }
  };

  collect(inputEventBindings.global.entries());
  collect(inputEventBindings.sliceView.entries());
  collect(inputEventBindings.perspectiveView.entries());

  return Array.from(seenBindings.entries(), ([actionId, eventAction]) => ({
    actionId,
    eventAction,
  }));
}

export class CommandCatalog extends RefCounted {
  commands: readonly CommandEntry[] = [];
  groups: readonly CommandGroup[] = [];
  readonly changed = new Signal();
  private readonly debouncedRebuild: DebouncedFunction;

  constructor(private readonly context: CommandCatalogContext) {
    super();
    const debouncedRebuild = (this.debouncedRebuild = this.registerCancellable(
      animationFrameDebounce(() => this.rebuild()),
    ));
    this.registerDisposer(
      context.globalToolBinder.changed.add(debouncedRebuild),
    );
    this.registerDisposer(
      context.globalToolBinder.localBindersChanged.add(debouncedRebuild),
    );
    this.registerDisposer(
      context.layerManager.layersChanged.add(debouncedRebuild),
    );
    this.registerDisposer(
      context.commandRegistry.changed.add(debouncedRebuild),
    );
    this.rebuild();
  }

  public rebuild() {
    const {
      globalToolBinder,
      layerManager,
      inputEventBindings,
      commandRegistry,
    } = this.context;
    const commands: CommandEntry[] = [];

    const layers = layerManager?.managedLayers ?? [];

    const toggleLayerGroup: CommandGroup = {
      label: "Toggle Layer Visibility",
      shortcut: "1–9",
    };
    const showOnlyLayerGroup: CommandGroup = {
      label: "Show Only Layer",
      shortcut: "Shift+1–9",
    };
    const selectLayerGroup: CommandGroup = {
      label: "Select Layer",
      shortcut: "Ctrl+1–9",
    };
    const togglePickLayerGroup: CommandGroup = {
      label: "Toggle Layer Picking",
      shortcut: "Alt+1–9",
    };

    let nonArchivedIndex = -1;
    for (const layer of layers) {
      const enabled = !layer.archived;
      const commonObject = {
        label: layer.name,
        source: "derived" as CommandSource,
      };
      if (enabled) ++nonArchivedIndex;

      {
        // Toggle layer
        const command = new ActionCommand(
          `toggle-layer-${nonArchivedIndex + 1}`,
          `Show/hide ${layer.name}`,
        );
        command.enabled = enabled;
        commands.push({
          ...commonObject,
          shortcut: nonArchivedIndex < 9 ? String(nonArchivedIndex + 1) : "",
          group: toggleLayerGroup,
          command,
        });
      }

      {
        // Show only layer
        const command = new ActionCommand(
          `show-only-layer-${nonArchivedIndex + 1}`,
          `Show only ${layer.name}`,
        );
        command.enabled = enabled;
        commands.push({
          ...commonObject,
          shortcut: nonArchivedIndex < 9 ? `Shift+${nonArchivedIndex + 1}` : "",
          group: showOnlyLayerGroup,
          command,
        });
      }

      {
        // Select layer
        const command = new ActionCommand(
          `select-layer-${nonArchivedIndex + 1}`,
          `Select ${layer.name}`,
        );
        command.enabled = enabled;
        commands.push({
          ...commonObject,
          shortcut: nonArchivedIndex < 9 ? `Ctrl+${nonArchivedIndex + 1}` : "",
          group: selectLayerGroup,
          command,
        });
      }

      {
        // Toggle pick
        const command = new ActionCommand(
          `toggle-pick-layer-${nonArchivedIndex + 1}`,
          `Toggle pick ${layer.name}`,
        );
        command.enabled = enabled;
        commands.push({
          label: layer.name,
          shortcut: nonArchivedIndex < 9 ? `Alt+${nonArchivedIndex + 1}` : "",
          source: "derived",
          group: togglePickLayerGroup,
          command,
        });
      }
    }

    const bindings = collectActionBindings(inputEventBindings);
    const shortcutByAction = new Map<ActionIdentifier, string>();
    for (const { actionId, eventAction } of bindings) {
      shortcutByAction.set(
        actionId,
        formatKeyStroke(
          friendlyEventIdentifier(eventAction.originalEventIdentifier ?? ""),
        ),
      );
    }

    // Registered commands come first. A command's shortcut is whatever binding
    // is currently installed for its id, shown for reference only.
    for (const command of commandRegistry.values()) {
      commands.push({
        label: command.label,
        shortcut: shortcutByAction.get(command.id) ?? "",
        source: "registered",
        command,
      });
    }

    // The registry is not required to be exhaustive: an embedder (or the Python
    // integration) may bind an action without registering a command for it.
    // Those are listed too, labelled from their action id, so nothing that used
    // to appear in the palette is lost.
    for (const { actionId } of bindings) {
      if (commandRegistry.has(actionId)) continue;
      if (/^tool-[A-Z]$/.test(actionId)) continue;
      if (/^(toggle|select|toggle-pick|show-only)-layer-\d+$/.test(actionId)) {
        continue;
      }
      const label = actionIdToLabel(actionId);
      commands.push({
        label,
        shortcut: shortcutByAction.get(actionId) ?? "",
        source: "derived",
        command: new ActionCommand(actionId, label),
      });
    }

    const toolQueryResult = parseToolQuery("+");
    if ("query" in toolQueryResult) {
      // Tool listers report changes to their available tool set (e.g. controls
      // that appear once a data source resolves) via this callback
      let toolSetChanged = false;
      const onListableToolsChanged = () => {
        if (toolSetChanged) return;
        toolSetChanged = true;
        this.debouncedRebuild();
      };
      const toolMatches = getMatchingTools(
        globalToolBinder,
        toolQueryResult.query,
        onListableToolsChanged,
      );

      // Build a reverse lookup from palette-JSON key to letter for currently-bound tools.
      // Keys must include getCommonToolProperties() to match the keys produced by
      // getMatchingTools, which merges commonProperties into every yielded tool JSON.
      const boundByJsonKey = new Map<string, string>();
      for (const [letter, tool] of globalToolBinder.bindings) {
        const paletteJson = {
          ...tool.localBinder.convertLocalJSONToPaletteJSON(tool.toJSON()),
          ...tool.localBinder.getCommonToolProperties(),
        };
        boundByJsonKey.set(JSON.stringify(paletteJson), letter);
      }

      for (const [jsonKey, toolJson] of toolMatches) {
        if (!isToolLayerVisible(this.context, toolJson)) continue;
        const boundLetter = boundByJsonKey.get(jsonKey);
        if (boundLetter !== undefined) {
          const actionId: ActionIdentifier = `tool-${boundLetter}`;
          const tool = globalToolBinder.bindings.get(boundLetter)!;
          const label =
            tool.context instanceof UserLayer
              ? `${tool.description} — ${tool.context.managedLayer.name}`
              : tool.description;
          commands.push({
            label,
            shortcut: shortcutByAction.get(actionId) ?? "",
            source: "derived",
            command: new ActionCommand(actionId, label),
          });
        } else {
          const capturedToolJson = toolJson;
          const label = getToolDescription(this.context, toolJson);
          commands.push({
            label,
            shortcut: "",
            source: "derived",
            command: new CallbackCommand(jsonKey, label, () =>
              activateUnboundTool(this.context, capturedToolJson),
            ),
          });
        }
      }
    }

    const groups: CommandGroup[] = [];
    for (const { group } of commands) {
      if (group !== undefined && !groups.includes(group)) groups.push(group);
    }

    this.commands = commands;
    this.groups = groups;
    this.changed.dispatch();
  }

  // Without a `groupLabel`, grouped entries are omitted, since their group
  // stands in for them as a single row.
  filter(
    searchString: string = "",
    groupLabel?: string,
  ): readonly CommandEntry[] {
    const pool = this.commands.filter(
      (entry) =>
        entry.command.enabled &&
        (groupLabel === undefined
          ? entry.group === undefined
          : entry.group?.label === groupLabel),
    );
    return rankedMatches(pool, "label", searchString);
  }
}
