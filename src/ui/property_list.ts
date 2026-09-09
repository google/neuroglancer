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

import "#src/ui/property_list.css";

export type PropertyListSortDirection = "ascending" | "descending";

export function getNextPropertyListSortDirection(
  direction: PropertyListSortDirection | undefined,
  allowClear: boolean,
): PropertyListSortDirection | undefined {
  if (direction === undefined) return "ascending";
  if (direction === "ascending") return "descending";
  return allowClear ? undefined : "ascending";
}

export interface PropertyListSortControl {
  sortIcon: HTMLElement;
  update: () => void;
}

export function bindPropertyListSortControl(options: {
  label: HTMLElement;
  sortIcon?: HTMLElement;
  fieldId: string;
  allowClear: boolean;
  getDirection: () => PropertyListSortDirection | undefined;
  onChange: (direction: PropertyListSortDirection | undefined) => void;
}): PropertyListSortControl {
  const { label, fieldId, allowClear, getDirection, onChange } = options;
  label.classList.add("neuroglancer-property-list-header-label");
  label.tabIndex = 0;
  label.setAttribute("role", "button");
  const sortIcon = options.sortIcon ?? document.createElement("span");
  sortIcon.classList.add("neuroglancer-property-list-header-sort");
  if (sortIcon.parentElement !== label) label.appendChild(sortIcon);

  const update = () => {
    const direction = getDirection();
    sortIcon.textContent = direction === "descending" ? "▼" : "▲";
    if (direction === undefined) {
      delete sortIcon.dataset.active;
      label.setAttribute("aria-pressed", "false");
    } else {
      sortIcon.dataset.active = "true";
      label.setAttribute("aria-pressed", "true");
    }
    const next = getNextPropertyListSortDirection(direction, allowClear);
    label.title =
      next === undefined
        ? `Clear sort by ${fieldId}`
        : `Sort by ${fieldId} in ${next} order`;
  };
  const activate = () => {
    onChange(getNextPropertyListSortDirection(getDirection(), allowClear));
    update();
  };
  label.addEventListener("click", activate);
  label.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    activate();
  });
  update();
  return { sortIcon, update };
}

export function createPropertyListQueryInput(options: {
  placeholder: string;
  selectOnFocus?: boolean;
}): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.classList.add("neuroglancer-property-list-query");
  input.placeholder = options.placeholder;
  input.autocomplete = "off";
  input.spellcheck = false;
  if (options.selectOnFocus) {
    input.addEventListener("focus", () => input.select());
  }
  return input;
}

export interface PropertyListStatisticsShell {
  root: HTMLDivElement;
  count: HTMLDivElement;
  content: HTMLDivElement;
  separator: HTMLDivElement;
  setVisible: (visible: boolean) => void;
}

export function createPropertyListStatisticsShell(): PropertyListStatisticsShell {
  const root = document.createElement("div");
  root.classList.add("neuroglancer-property-list-statistics");
  const count = document.createElement("div");
  count.classList.add("neuroglancer-property-list-statistics-count");
  const content = document.createElement("div");
  root.append(count, content);
  const separator = document.createElement("div");
  separator.classList.add("neuroglancer-property-list-statistics-separator");
  const setVisible = (visible: boolean) => {
    root.style.display = visible ? "" : "none";
    separator.style.display = visible ? "" : "none";
  };
  setVisible(false);
  return { root, count, content, separator, setVisible };
}
