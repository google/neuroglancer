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
  CommandEntry,
  CommandGroup,
} from "#src/ui/command_catalog.js";
import type { Viewer } from "#src/viewer.js";

type PaletteRow =
  | { readonly kind: "command"; readonly entry: CommandEntry }
  | { readonly kind: "group-header"; readonly group: CommandGroup };

export class CommandPalette extends Overlay {
  private readonly searchInput: HTMLInputElement;
  private readonly resultsList: HTMLElement;
  private readonly rowElementByKey = new Map<
    CommandEntry | CommandGroup,
    HTMLElement
  >();
  private readonly emptyElement: HTMLElement;
  private readonly pickerHeaderElement: HTMLElement;
  private filteredRows: readonly PaletteRow[] = [];
  private filteredRowElements: HTMLElement[] = [];
  private activeIndex = 0;
  private currentGroup: CommandGroup | undefined;

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
      if (this.filteredRows.length > 0)
        this.run(this.filteredRows[this.activeIndex]);
    },
    Backspace: () => {
      if (this.currentGroup !== undefined && this.searchInput.value === "") {
        this.goBack();
      }
    },
    ArrowLeft: (event) => {
      if (
        this.currentGroup !== undefined &&
        this.searchInput.selectionStart === 0 &&
        this.searchInput.selectionEnd === 0
      ) {
        event.preventDefault();
        this.goBack();
      }
    },
    Escape: () => {
      if (this.currentGroup !== undefined) {
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

    catalog.rebuild();
    this.buildRows();

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
    // change, or an async lister resolving). Build rows for the new entries
    // and re-render, since the current view (grouped or not) is always
    // derived live from the catalog rather than a snapshot.
    this.registerDisposer(
      this.catalog.changed.add(() => {
        this.buildRows();
        this.render();
      }),
    );

    this.render();
    searchInput.focus();
  }

  private buildRows() {
    for (const entry of this.catalog.commands) {
      if (!this.rowElementByKey.has(entry)) {
        this.rowElementByKey.set(
          entry,
          this.createRowElement(entry.label, entry.shortcut, () =>
            this.run({ kind: "command", entry }),
          ),
        );
      }
      const { group } = entry;
      if (group !== undefined && !this.rowElementByKey.has(group)) {
        this.rowElementByKey.set(
          group,
          this.createRowElement(group.label, group.shortcut, () =>
            this.run({ kind: "group-header", group }),
          ),
        );
      }
    }
  }

  private createRowElement(
    label: string,
    shortcut: string,
    onActivate: () => void,
  ): HTMLElement {
    const rowElement = document.createElement("div");
    rowElement.className = "neuroglancer-command-palette-row";
    rowElement.addEventListener("click", onActivate);

    const labelElement = document.createElement("span");
    labelElement.textContent = label;
    rowElement.appendChild(labelElement);

    if (shortcut) {
      const shortcutElement = document.createElement("span");
      shortcutElement.className = "neuroglancer-command-palette-shortcut";
      shortcutElement.textContent = shortcut;
      rowElement.appendChild(shortcutElement);
    }

    return rowElement;
  }

  // Inside a group, or while searching, the view is a flat list of matching
  // commands. Otherwise, entries sharing a group collapse into one header row.
  private computeDisplayRows(): readonly PaletteRow[] {
    const searchValue = this.searchInput.value;
    if (this.currentGroup !== undefined) {
      return this.catalog
        .filter(searchValue, this.currentGroup.label)
        .map((entry) => ({ kind: "command", entry }) as const);
    }
    if (searchValue !== "") {
      return this.catalog
        .filter(searchValue)
        .map((entry) => ({ kind: "command", entry }) as const);
    }
    const rows: PaletteRow[] = [];
    const seenGroups = new Set<string>();
    for (const entry of this.catalog.commands) {
      const { group } = entry;
      if (group === undefined) {
        rows.push({ kind: "command", entry });
      } else if (!seenGroups.has(group.label)) {
        seenGroups.add(group.label);
        rows.push({ kind: "group-header", group });
      }
    }
    return rows;
  }

  private rowElementFor(row: PaletteRow): HTMLElement {
    return this.rowElementByKey.get(
      row.kind === "command" ? row.entry : row.group,
    )!;
  }

  private render() {
    this.filteredRows = this.computeDisplayRows();
    if (this.activeIndex >= this.filteredRows.length) {
      this.activeIndex = Math.max(0, this.filteredRows.length - 1);
    }

    if (this.filteredRows.length === 0) {
      this.resultsList.replaceChildren(this.emptyElement);
      return;
    }

    this.filteredRowElements = this.filteredRows.map((row) =>
      this.rowElementFor(row),
    );
    this.filteredRowElements.forEach((rowElement, rowIndex) => {
      rowElement.toggleAttribute("data-active", rowIndex === this.activeIndex);
    });
    this.resultsList.replaceChildren(...this.filteredRowElements);
  }

  private setActive(targetIndex: number) {
    if (this.filteredRowElements.length === 0) return;
    this.activeIndex =
      ((targetIndex % this.filteredRowElements.length) +
        this.filteredRowElements.length) %
      this.filteredRowElements.length;
    this.filteredRowElements.forEach((rowElement, rowIndex) => {
      rowElement.toggleAttribute("data-active", rowIndex === this.activeIndex);
      if (rowIndex === this.activeIndex)
        rowElement.scrollIntoView({ block: "nearest" });
    });
  }

  private updateHeader() {
    if (this.currentGroup !== undefined) {
      this.pickerHeaderElement.textContent = `← ${this.currentGroup.label}`;
      this.pickerHeaderElement.removeAttribute("hidden");
    } else {
      this.pickerHeaderElement.setAttribute("hidden", "");
    }
  }

  private goBack() {
    if (this.currentGroup === undefined) {
      this.closeAndRestoreFocus();
      return;
    }
    this.currentGroup = undefined;
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

  private run(row: PaletteRow) {
    if (row.kind === "group-header") {
      this.currentGroup = row.group;
      this.searchInput.value = "";
      this.searchInput.placeholder = `Filter ${row.group.label}…`;
      this.updateHeader();
      this.activeIndex = 0;
      this.render();
      return;
    }

    this.closeAndRestoreFocus();
    row.entry.command.invoke({ dispatchTarget: this.actionDispatchTarget });
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
