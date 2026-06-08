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

import "#src/ui/command_palette.css";
import { UserLayer } from "#src/layer/index.js";
import { Overlay } from "#src/overlay.js";
import { getMatchingTools, restoreTool } from "#src/ui/tool.js";
import { parseToolQuery } from "#src/ui/tool_query.js";
import type {
  ActionIdentifier,
  EventAction,
  NormalizedEventIdentifier,
} from "#src/util/event_action_map.js";
import { friendlyEventIdentifier } from "#src/util/event_action_map.js";
import type { Viewer } from "#src/viewer.js";

const SUPPLEMENTAL_COMMANDS: readonly {
  actionId: ActionIdentifier;
  label: string;
}[] = [
  { actionId: "edit-json-state", label: "Edit JSON State" },
  { actionId: "screenshot", label: "Screenshot" },
];

// Numeric enum so `typeof result === "number"` reliably distinguishes a skip
// result from a resolved label string.
enum ActionSkipReason {
  MissingLayer = 0,
}

// string           - resolved label; include this entry
// ActionSkipReason - matched this action type but no resource exists; exclude the entry
// undefined        - this resolver does not handle this action type; try the next
type ResolvedAction = string | ActionSkipReason | undefined;

function shouldSkip(result: ResolvedAction): result is ActionSkipReason {
  return typeof result === "number";
}

export interface ActionBinding {
  readonly actionId: ActionIdentifier;
  readonly eventAction: EventAction;
}

export interface CommandPaletteEntry {
  readonly label: string;
  readonly shortcut: string;
  readonly actionId: ActionIdentifier;
  readonly execute?: () => void;
}

function formatKeyStroke(stroke: string): string {
  return stroke
    .split("+")
    .map((part) => {
      if (part.startsWith("key")) return part.substring(3);
      if (part.startsWith("digit")) return part.substring(5);
      if (part.startsWith("arrow")) return part.substring(5);
      return part;
    })
    .join("+");
}

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
function createToolFromJson(viewer: Viewer, toolJson: unknown) {
  try {
    const json =
      typeof toolJson === "object" && toolJson !== null
        ? (toolJson as Record<string, unknown>)
        : undefined;
    const layerName = typeof json?.layer === "string" ? json.layer : undefined;
    if (layerName !== undefined) {
      const { layer: _ignored, ...rest } = json!;
      const managedLayer = viewer.layerManager.getLayerByName(layerName);
      const userLayer = managedLayer?.layer ?? null;
      if (userLayer === null) return undefined;
      return restoreTool(userLayer, rest);
    }
    return restoreTool(viewer, toolJson);
  } catch {
    return undefined;
  }
}

function getToolDescription(viewer: Viewer, toolJson: unknown): string {
  const tool = createToolFromJson(viewer, toolJson);
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

// Tracks letter keys that were temporarily bound by the palette (viewer → key → tool).
// WeakMap allows GC if the viewer is destroyed.
const paletteActivatedKeys = new WeakMap<object, Map<string, object>>();

// Removes any palette-activated temp bindings whose tool is no longer the active tool.
// Called each time the palette opens or before activating a new unbound tool.
function sweepPaletteActivatedKeys(viewer: Viewer): void {
  const tracked = paletteActivatedKeys.get(viewer as object);
  if (tracked === undefined) return;
  const activeTool = viewer.globalToolBinder.activeTool_?.tool;
  for (const [key, trackedTool] of tracked) {
    const currentTool = viewer.globalToolBinder.bindings.get(key);
    if (currentTool !== trackedTool) {
      // Our tool was replaced or removed at this key by something else — stop tracking.
      tracked.delete(key);
    } else if (currentTool !== activeTool) {
      // Our tool is still bound here but no longer active — clean up the temp binding.
      viewer.globalToolBinder.set(key, undefined);
      tracked.delete(key);
    }
    // currentTool === trackedTool === activeTool: still active, keep tracking.
  }
}

function activateUnboundTool(viewer: Viewer, toolJson: unknown): void {
  const tool = createToolFromJson(viewer, toolJson);
  if (tool === undefined) return;

  // GlobalToolBinder.set deduplicates by JSON string within a localBinder:
  // it removes any existing binding with the same serialized tool JSON before
  // adding the new one.  If the same tool type is already bound to a key
  // (e.g. the tool appeared as "unbound" in the palette due to a JSON mismatch),
  // activate that existing key rather than calling set and clobbering the user's binding.
  const localBinder = tool.localBinder;
  const existingKey = localBinder.jsonToKey.get(JSON.stringify(tool.toJSON()));
  if (existingKey !== undefined) {
    tool.dispose();
    viewer.globalToolBinder.activate(existingKey);
    return;
  }

  // Prefer reusing the active palette-tool's key slot: it will be deactivated
  // when the new tool activates anyway, so taking a new letter would just cause
  // the slots to bounce (A → B → A → B …) as each old binding lingers until
  // the next sweep.
  const tracked = paletteActivatedKeys.get(viewer as object);
  const activeTool = viewer.globalToolBinder.activeTool_?.tool;
  let targetKey: string | undefined;
  if (tracked !== undefined && activeTool !== undefined) {
    for (const [key, trackedTool] of tracked) {
      if (trackedTool === activeTool) {
        targetKey = key;
        break;
      }
    }
  }

  if (targetKey === undefined) {
    // No active palette slot to reuse; sweep stale entries then find a free key.
    sweepPaletteActivatedKeys(viewer);
    targetKey = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
      .split("")
      .find((key) => !viewer.globalToolBinder.bindings.has(key));
    if (targetKey === undefined) {
      tool.dispose();
      return;
    }
  }

  let newTracked = paletteActivatedKeys.get(viewer as object);
  if (newTracked === undefined) {
    newTracked = new Map();
    paletteActivatedKeys.set(viewer as object, newTracked);
  }
  newTracked.delete(targetKey);
  newTracked.set(targetKey, tool as object);

  viewer.globalToolBinder.set(targetKey, tool);
  viewer.globalToolBinder.activate(targetKey);
}

/**
 * Walk the event action maps available on the viewer and produce a list of
 * every action with any keyboard binding. The first binding found for each
 * action is kept; subsequent bindings for the same action are ignored.
 */
export function collectActionBindings(
  viewer: Viewer,
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

  collect(viewer.inputEventBindings.global.entries());
  collect(viewer.inputEventBindings.sliceView.entries());
  collect(viewer.inputEventBindings.perspectiveView.entries());

  return Array.from(seenBindings.entries(), ([actionId, eventAction]) => ({
    actionId,
    eventAction,
  }));
}

/**
 * Take raw ActionBindings and map them to user-facing CommandPaletteEntries.
 * All available tools are discovered via getMatchingTools. Unbound tools
 * are included with an execute callback that temporarily binds them to the
 * first available letter slot and activates them.
 */
export class CommandCatalog {
  readonly commands: CommandPaletteEntry[] = [];

  constructor(viewer: Viewer, bindings: readonly ActionBinding[]) {
    sweepPaletteActivatedKeys(viewer);

    // "Deactivate Active Tool" goes first so it's always one keystroke away
    // when a tool is running.
    if (viewer.globalToolBinder.activeTool_ !== undefined) {
      this.commands.push({
        label: "Deactivate Active Tool",
        shortcut: "",
        actionId: "deactivate-active-tool",
      });
    }

    const shortcutByAction = new Map<ActionIdentifier, string>();
    for (const { actionId, eventAction } of bindings) {
      shortcutByAction.set(
        actionId,
        formatKeyStroke(
          friendlyEventIdentifier(eventAction.originalEventIdentifier ?? ""),
        ),
      );
    }

    for (const { actionId, eventAction } of bindings) {
      if (/^tool-[A-Z]$/.test(actionId)) continue;

      const layerLabel = this.resolveLayerLabel(viewer, actionId);
      if (shouldSkip(layerLabel)) continue;

      const label = layerLabel ?? actionIdToLabel(actionId);
      const shortcut = formatKeyStroke(
        friendlyEventIdentifier(eventAction.originalEventIdentifier ?? ""),
      );
      this.commands.push({ label, shortcut, actionId });
    }

    const toolQueryResult = parseToolQuery("+");
    if ("query" in toolQueryResult) {
      const toolMatches = getMatchingTools(
        viewer.globalToolBinder,
        toolQueryResult.query,
      );

      // Build a reverse lookup from palette-JSON key to letter for currently-bound tools.
      const boundByJsonKey = new Map<string, string>();
      for (const [letter, tool] of viewer.globalToolBinder.bindings) {
        const paletteJson = tool.localBinder.convertLocalJSONToPaletteJSON(
          tool.toJSON(),
        );
        boundByJsonKey.set(JSON.stringify(paletteJson), letter);
      }

      for (const [jsonKey, toolJson] of toolMatches) {
        const boundLetter = boundByJsonKey.get(jsonKey);
        if (boundLetter !== undefined) {
          const actionId: ActionIdentifier = `tool-${boundLetter}`;
          const tool = viewer.globalToolBinder.bindings.get(boundLetter)!;
          const label =
            tool.context instanceof UserLayer
              ? `${tool.description} — ${tool.context.managedLayer.name}`
              : tool.description;
          this.commands.push({
            label,
            shortcut: shortcutByAction.get(actionId) ?? "",
            actionId,
          });
        } else {
          const capturedToolJson = toolJson;
          this.commands.push({
            label: getToolDescription(viewer, toolJson),
            shortcut: "",
            actionId: `tool-json:${jsonKey}` as ActionIdentifier,
            execute: () => activateUnboundTool(viewer, capturedToolJson),
          });
        }
      }
    }

    for (const { actionId, label } of SUPPLEMENTAL_COMMANDS) {
      this.commands.push({ label, shortcut: "", actionId });
    }
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

  private resolveLayerLabel(
    viewer: Viewer,
    actionId: ActionIdentifier,
  ): ResolvedAction {
    const toggleMatch = actionId.match(/^toggle-layer-(\d+)$/);
    const selectMatch = actionId.match(/^select-layer-(\d+)$/);
    const pickMatch = actionId.match(/^toggle-pick-layer-(\d+)$/);
    const match = toggleMatch ?? selectMatch ?? pickMatch;
    if (match === null) return undefined;

    const layerIndex = parseInt(match[1], 10);
    const layer = viewer.layerManager.getLayerByNonArchivedIndex(
      layerIndex - 1,
    );
    if (layer === undefined) return ActionSkipReason.MissingLayer;

    const prefix = toggleMatch
      ? "Toggle Layer"
      : selectMatch
        ? "Select Layer"
        : "Toggle Pick Layer";
    return `${prefix} ${layerIndex}: ${layer.name}`;
  }
}

export class CommandPalette extends Overlay {
  private readonly searchInput: HTMLInputElement;
  private readonly resultsList: HTMLElement;
  private readonly catalog: CommandCatalog;
  private readonly rowByCommand = new Map<CommandPaletteEntry, HTMLElement>();
  private readonly emptyElement: HTMLElement;
  private filteredCommands: readonly CommandPaletteEntry[] = [];
  private filteredRows: HTMLElement[] = [];
  private activeIndex = 0;

  private readonly keyHandlers: Partial<
    Record<string, (event: KeyboardEvent) => void>
  > = {
    ArrowDown: (event) => {
      event.preventDefault();
      this.setActive(this.activeIndex + 1);
    },
    ArrowUp: (event) => {
      event.preventDefault();
      this.setActive(this.activeIndex - 1);
    },
    Enter: (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.filteredCommands.length > 0)
        this.run(this.filteredCommands[this.activeIndex]);
    },
    Escape: () => this.closeAndRestoreFocus(),
  };

  constructor(
    viewer: Viewer,
    private readonly actionDispatchTarget: HTMLElement,
  ) {
    super();
    this.content.classList.add("neuroglancer-command-palette");

    const bindings = collectActionBindings(viewer);
    this.catalog = new CommandCatalog(viewer, bindings);

    for (const command of this.catalog.commands) {
      const commandRow = document.createElement("div");
      commandRow.className = "neuroglancer-command-palette-row";
      commandRow.addEventListener("click", () => this.run(command));

      const labelElement = document.createElement("span");
      labelElement.textContent = command.label;
      commandRow.appendChild(labelElement);

      if (command.shortcut) {
        const shortcutElement = document.createElement("span");
        shortcutElement.className = "neuroglancer-command-palette-shortcut";
        shortcutElement.textContent = command.shortcut;
        commandRow.appendChild(shortcutElement);
      }

      this.rowByCommand.set(command, commandRow);
    }

    const emptyElement = (this.emptyElement = document.createElement("div"));
    emptyElement.className = "neuroglancer-command-palette-empty";
    emptyElement.textContent = "No commands found.";

    const inputContainer = document.createElement("div");
    inputContainer.className = "neuroglancer-command-palette-input-row";
    const searchInput = (this.searchInput = document.createElement("input"));
    searchInput.type = "text";
    searchInput.className = "neuroglancer-command-palette-input";
    searchInput.placeholder = "Type a command...";
    searchInput.autocomplete = "off";
    searchInput.spellcheck = false;
    inputContainer.appendChild(searchInput);
    this.content.appendChild(inputContainer);

    const resultsList = (this.resultsList = document.createElement("div"));
    resultsList.className = "neuroglancer-command-palette-results";
    this.content.appendChild(resultsList);

    searchInput.addEventListener("input", () => {
      this.activeIndex = 0;
      this.render();
    });

    resultsList.addEventListener("mousedown", (event) =>
      event.preventDefault(),
    );

    this.content.addEventListener(
      "keydown",
      (event: KeyboardEvent) => this.keyHandlers[event.key]?.(event),
      { capture: true },
    );

    // Tools register keydown on window (bubble); stop propagation here after searchInput receives the event.
    this.content.addEventListener("keydown", (event) => {
      event.stopPropagation();
    });

    this.render();
    searchInput.focus();
  }

  private render() {
    this.filteredCommands = this.catalog.filter(this.searchInput.value);
    if (this.activeIndex >= this.filteredCommands.length) {
      this.activeIndex = Math.max(0, this.filteredCommands.length - 1);
    }

    if (this.filteredCommands.length === 0) {
      this.resultsList.replaceChildren(this.emptyElement);
      return;
    }

    this.filteredRows = this.filteredCommands.map(
      (command) => this.rowByCommand.get(command)!,
    );
    this.filteredRows.forEach((commandRow, rowIndex) => {
      commandRow.toggleAttribute("data-active", rowIndex === this.activeIndex);
    });
    this.resultsList.replaceChildren(...this.filteredRows);
  }

  private setActive(targetIndex: number) {
    if (this.filteredRows.length === 0) return;
    this.activeIndex =
      ((targetIndex % this.filteredRows.length) + this.filteredRows.length) %
      this.filteredRows.length;
    this.filteredRows.forEach((commandRow, rowIndex) => {
      commandRow.toggleAttribute("data-active", rowIndex === this.activeIndex);
      if (rowIndex === this.activeIndex)
        commandRow.scrollIntoView({ block: "nearest" });
    });
  }

  // Non-toggle tools register a window bubble-phase keydown handler that
  // calls preventDefault() on all keys. Restoring focus to the viewer element
  // before the next keydown ensures F1 bubbles through the viewer's
  // KeyboardEventBinder and can reopen the palette.
  private closeAndRestoreFocus() {
    const target = this.actionDispatchTarget;
    this.close();
    target.focus({ preventScroll: true });
  }

  private run(command: CommandPaletteEntry) {
    this.closeAndRestoreFocus();

    if (command.execute !== undefined) {
      command.execute();
    } else {
      this.actionDispatchTarget.dispatchEvent(
        new CustomEvent(`action:${command.actionId}`, {
          bubbles: true,
          cancelable: true,
          detail: {},
        }),
      );
    }
  }
}
