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
import { Signal } from "#src/util/signal.js";
import type { InputEventBindings } from "#src/viewer.js";

export interface CommandCatalogContext {
  globalToolBinder: GlobalToolBinder;
  layerManager: LayerManager;
  selectedLayer: SelectedLayerState;
  inputEventBindings: InputEventBindings;
  /**
   * Primary source of the flat command set. Registered commands are enumerated
   * directly and take precedence; any keyboard-bound action that is *not*
   * registered is still listed afterwards, so actions an embedder or the Python
   * integration only ever bound to a key do not disappear from the palette.
   */
  commandRegistry: CommandRegistry;
}

export interface ActionBinding {
  readonly actionId: ActionIdentifier;
  readonly eventAction: EventAction;
}

export type CommandSource = "registered" | "derived";

export interface CommandEntryBase {
  kind: string;
  shortcut: string;
  label: string;
}

// A command, either taken from the registry or synthesised for a keyboard-bound
// action that nothing registered. The consumer invokes it with its own context.
export interface CommandEntry extends CommandEntryBase {
  readonly kind: "command";
  readonly command: Command;
  readonly source: CommandSource;
}

// Opens a sub-palette of `children` instead of activating anything itself.
export interface GroupCommandEntry extends CommandEntryBase {
  readonly kind: "group";
  readonly children: readonly CommandPaletteEntry[];
}

export type CommandPaletteEntry = CommandEntry | GroupCommandEntry;

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
    // context is the viewer instance; restoreTool walks its prototype chain
    // to find the registered tool factory.
    return restoreTool(context, toolJson);
  } catch {
    return undefined;
  }
}

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

// Fallback label derived purely from the JSON structure (no instantiation).
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
  // If the same tool is already bound to a key, activate that key directly
  // rather than creating a duplicate.
  const existingKey = tool.localBinder.jsonToKey.get(
    JSON.stringify(tool.toJSON()),
  );
  if (existingKey !== undefined) {
    tool.dispose();
    context.globalToolBinder.activate(existingKey);
    return;
  }
  // No key binding — activate directly without allocating a letter slot.
  context.globalToolBinder.activateDirect(tool);
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
      if (eventAction.action === "open-command-palette") continue;
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

/**
 * Persistent, signal-driven catalog of command palette entries. Subscribes to
 * tool-binding and layer changes and rebuilds automatically via
 * animationFrameDebounce so the palette always reflects current viewer state
 * without rebuilding from scratch on every open.
 *
 * Actions can be represented hierarchically, with parent entries that
 * expand to show child entries when activated. For example,
 * layer actions (toggle-layer-N, select-layer-N, toggle-pick-layer-N) are
 * replaced by three hierarchical entries whose children are the individual
 * layer rows, enabling a two-step layer picker instead of a flat list.
 */
export class CommandCatalog extends RefCounted {
  commands: readonly CommandPaletteEntry[] = [];
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

  private rebuild() {
    const {
      globalToolBinder,
      layerManager,
      selectedLayer,
      inputEventBindings,
      commandRegistry,
    } = this.context;
    const commands: CommandPaletteEntry[] = [];

    // Hierarchical layer actions — each group entry opens a sub-palette of layers.
    // The first 9 layers carry their digit-key shortcuts so users can see they
    // still work directly from the keyboard without opening the sub-palette.
    const layers = layerManager?.managedLayers ?? [];

    commands.push({
      kind: "group",
      label: "Toggle Layer",
      shortcut: "1–9",
      children: layers.map((layer, index) => ({
        kind: "command",
        label: layer.name,
        shortcut: index < 9 ? String(index + 1) : "",
        source: "derived",
        command: new CallbackCommand(
          `toggle-layer-${index + 1}`,
          layer.name,
          () => layer.setVisible(!layer.visible),
        ),
      })),
    });

    commands.push({
      kind: "group",
      label: "Select Layer",
      shortcut: "Ctrl+1–9",
      children: layers.map((layer, index) => ({
        kind: "command",
        label: layer.name,
        shortcut: index < 9 ? `Ctrl+${index + 1}` : "",
        source: "derived",
        command: new CallbackCommand(
          `select-layer-${index + 1}`,
          layer.name,
          () => {
            selectedLayer.layer = layer;
            selectedLayer.visible = true;
          },
        ),
      })),
    });

    commands.push({
      kind: "group",
      label: "Toggle Pick Layer",
      shortcut: "Alt+1–9",
      children: layers.map((layer, index) => ({
        kind: "command",
        label: layer.name,
        shortcut: index < 9 ? `Alt+${index + 1}` : "",
        source: "derived",
        command: new CallbackCommand(
          `toggle-pick-layer-${index + 1}`,
          layer.name,
          () => {
            layer.pickEnabled = !layer.pickEnabled;
          },
        ),
      })),
    });

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
      if (!command.enabled) continue;
      commands.push({
        kind: "command",
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
      // Layer-index actions are replaced by hierarchical group entries above.
      if (/^(toggle|select|toggle-pick)-layer-\d+$/.test(actionId)) continue;
      const label = actionIdToLabel(actionId);
      commands.push({
        kind: "command",
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
            kind: "command",
            label,
            shortcut: shortcutByAction.get(actionId) ?? "",
            source: "derived",
            command: new ActionCommand(actionId, label),
          });
        } else {
          const capturedToolJson = toolJson;
          const label = getToolDescription(this.context, toolJson);
          commands.push({
            kind: "command",
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

    this.commands = commands;
    this.changed.dispatch();
  }

  filter(searchString: string): readonly CommandPaletteEntry[] {
    if (searchString === "") return this.commands;

    const query = searchString.toLowerCase();
    const prefixMatches: CommandPaletteEntry[] = [];
    const substringMatches: CommandPaletteEntry[] = [];

    for (const command of this.commands) {
      const label = command.label.toLowerCase();
      if (label.startsWith(query)) prefixMatches.push(command);
      else if (label.includes(query)) substringMatches.push(command);
    }

    return [...prefixMatches, ...substringMatches];
  }
}
