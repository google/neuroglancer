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
import type {
  ActionIdentifier,
  EventAction,
  NormalizedEventIdentifier,
} from "#src/util/event_action_map.js";
import { friendlyEventIdentifier } from "#src/util/event_action_map.js";
import type { Viewer } from "#src/viewer.js";

/**
 * We automatically collect actions from keyboard bindings on the
 * viewer. However, there may be some actions desired that have no keybinds.
 * Those can be listed here to be included in the command palette.
 */
const SUPPLEMENTAL_COMMANDS: readonly {
  actionId: ActionIdentifier;
  label: string;
}[] = [
  { actionId: "edit-json-state", label: "Edit JSON State" },
  { actionId: "screenshot", label: "Screenshot" },
];

// Numeric enum so `typeof result === "number"`
// reliably distinguishes a skip result from a resolved label string.
enum ActionSkipReason {
  UnoccupiedTool = 0, // tool-X is bound to a key but no tool is assigned to that slot
  MissingLayer = 1, // layer index is out of range for this binding
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
 * Take raw ActionBindings and map them to user-facing CommandPaletteEntries
 * with formatted labels and shortcuts. Actions with no meaningful label
 * (unoccupied tool slots, out-of-range layer indices) are dropped.
 */
export class CommandCatalog {
  readonly commands: CommandPaletteEntry[] = [];

  constructor(viewer: Viewer, bindings: readonly ActionBinding[]) {
    for (const { actionId, eventAction } of bindings) {
      const toolLabel = this.resolveToolLabel(viewer, actionId);
      if (shouldSkip(toolLabel)) continue;

      const layerLabel =
        toolLabel === undefined
          ? this.resolveLayerLabel(viewer, actionId)
          : undefined;
      if (shouldSkip(layerLabel)) continue;

      const label = toolLabel ?? layerLabel ?? actionIdToLabel(actionId);
      const shortcut = formatKeyStroke(
        friendlyEventIdentifier(eventAction.originalEventIdentifier ?? ""),
      );
      this.commands.push({ label, shortcut, actionId });
    }

    for (const { actionId, label } of SUPPLEMENTAL_COMMANDS) {
      this.commands.push({ label, shortcut: "", actionId });
    }
  }

  /**
   * Name-based filtering. Prefix matches are ranked before substring matches.
   */
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

  private resolveToolLabel(
    viewer: Viewer,
    actionId: ActionIdentifier,
  ): ResolvedAction {
    const toolMatch = actionId.match(/^tool-([A-Z])$/);
    if (toolMatch === null) return undefined;
    const tool = viewer.globalToolBinder.bindings.get(toolMatch[1]);
    if (tool === undefined) return ActionSkipReason.UnoccupiedTool;
    return tool.context instanceof UserLayer
      ? `${tool.description} — ${tool.context.managedLayer.name}`
      : tool.description;
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
    Escape: () => this.close(),
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

  private run(command: CommandPaletteEntry) {
    this.close();
    this.actionDispatchTarget.dispatchEvent(
      new CustomEvent(`action:${command.actionId}`, {
        bubbles: true,
        cancelable: true,
        detail: {},
      }),
    );
  }
}
