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
import { Overlay } from "#src/overlay.js";
import type {
  CommandCatalog,
  CommandPaletteEntry,
} from "#src/ui/command_catalog.js";
import type { Viewer } from "#src/viewer.js";

export class CommandPalette extends Overlay {
  private readonly searchInput: HTMLInputElement;
  private readonly resultsList: HTMLElement;
  private readonly rowByCommand = new Map<CommandPaletteEntry, HTMLElement>();
  private readonly emptyElement: HTMLElement;
  private readonly pickerHeaderElement: HTMLElement;
  private filteredCommands: readonly CommandPaletteEntry[] = [];
  private filteredRows: HTMLElement[] = [];
  private activeIndex = 0;
  private currentCommands: readonly CommandPaletteEntry[];
  private readonly levelStack: {
    commands: readonly CommandPaletteEntry[];
    label: string;
  }[] = [];

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
    Backspace: () => {
      if (this.levelStack.length > 0 && this.searchInput.value === "") {
        this.goBack();
      }
    },
    ArrowLeft: (event) => {
      if (
        this.levelStack.length > 0 &&
        this.searchInput.selectionStart === 0 &&
        this.searchInput.selectionEnd === 0
      ) {
        event.preventDefault();
        this.goBack();
      }
    },
    Escape: () => {
      if (this.levelStack.length > 0) {
        this.goBack();
      } else {
        this.closeAndRestoreFocus();
      }
    },
  };

  constructor(
    private readonly catalog: CommandCatalog,
    private readonly actionDispatchTarget: HTMLElement,
  ) {
    super();
    this.content.classList.add("neuroglancer-command-palette");

    this.currentCommands = this.catalog.commands;

    const pickerHeader = (this.pickerHeaderElement =
      document.createElement("div"));
    pickerHeader.className = "neuroglancer-command-palette-picker-header";
    pickerHeader.setAttribute("hidden", "");
    pickerHeader.addEventListener("click", () => this.goBack());

    const emptyElement = (this.emptyElement = document.createElement("div"));
    emptyElement.className = "neuroglancer-command-palette-empty";
    emptyElement.textContent = "No commands found.";

    const inputContainer = document.createElement("div");
    inputContainer.className = "neuroglancer-command-palette-input-row";
    inputContainer.appendChild(pickerHeader);
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

    this.buildRows(this.catalog.commands);

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

    // The catalog may rebuild while this palette is open (a layer or tool
    // change, or an async lister resolving). Build rows for the new entries so
    // top-level filtering can be applied to the new entries.
    this.registerDisposer(
      this.catalog.changed.add(() => {
        this.buildRows(this.catalog.commands);
        if (this.levelStack.length === 0) {
          this.currentCommands = this.catalog.commands;
          this.render();
        }
      }),
    );

    this.render();
    searchInput.focus();
  }

  private buildRows(commands: readonly CommandPaletteEntry[]) {
    for (const command of commands) {
      if (this.rowByCommand.has(command)) continue;

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

      if (command.kind === "group") {
        this.buildRows(command.children);
      }
    }
  }

  private filterCurrentLevel(): readonly CommandPaletteEntry[] {
    if (this.levelStack.length === 0) {
      return this.catalog.filter(this.searchInput.value);
    }
    const query = this.searchInput.value.toLowerCase();
    if (query === "") return this.currentCommands;
    const prefixMatches: CommandPaletteEntry[] = [];
    const substringMatches: CommandPaletteEntry[] = [];
    for (const entry of this.currentCommands) {
      const label = entry.label.toLowerCase();
      if (label.startsWith(query)) prefixMatches.push(entry);
      else if (label.includes(query)) substringMatches.push(entry);
    }
    return [...prefixMatches, ...substringMatches];
  }

  private render() {
    this.filteredCommands = this.filterCurrentLevel();
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

  private updateHeader() {
    if (this.levelStack.length > 0) {
      this.pickerHeaderElement.textContent = `← ${this.levelStack.at(-1)!.label}`;
      this.pickerHeaderElement.removeAttribute("hidden");
    } else {
      this.pickerHeaderElement.setAttribute("hidden", "");
    }
  }

  private goBack() {
    if (this.levelStack.length === 0) {
      this.closeAndRestoreFocus();
      return;
    }
    const previous = this.levelStack.pop()!;
    this.currentCommands = previous.commands;
    this.searchInput.value = "";
    this.searchInput.placeholder = "Type a command...";
    this.updateHeader();
    this.activeIndex = 0;
    this.render();
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
    if (command.kind === "group" && command.children.length > 0) {
      this.levelStack.push({
        commands: this.currentCommands,
        label: command.label,
      });
      this.currentCommands = command.children;
      this.searchInput.value = "";
      this.searchInput.placeholder = `Filter ${command.label}…`;
      this.updateHeader();
      this.activeIndex = 0;
      this.render();
      return;
    }

    this.closeAndRestoreFocus();

    if (command.kind === "execute") {
      command.execute();
    } else if (command.kind === "command") {
      command.command.invoke({ dispatchTarget: this.actionDispatchTarget });
    }
  }
}

/**
 * Binds the command palette to a viewer by handling the "open-command-palette"
 * action at the viewer element level, the same way every other global action
 * (e.g. "help") is bound. This intentionally
 * does not install any document-level key listener, so the palette opens from
 * the main viewer UI but does not intercept keystrokes globally.
 */
export function bindCommandPalette(viewer: Viewer): void {
  let openPalette: CommandPalette | undefined;
  const openCommandPalette = () => {
    if (openPalette !== undefined && !openPalette.wasDisposed) return;
    const prevFocused = document.activeElement;
    // Tracking the dispatch target lets an activated command target the
    // specific element that had focus (e.g. the "snap" action in the panel the
    // user was in), falling back to the viewer element.
    const dispatchTarget =
      prevFocused instanceof HTMLElement && viewer.element.contains(prevFocused)
        ? prevFocused
        : viewer.element;
    openPalette = new CommandPalette(viewer.commandCatalog, dispatchTarget);
  };
  viewer.bindAction("open-command-palette", openCommandPalette);
}
