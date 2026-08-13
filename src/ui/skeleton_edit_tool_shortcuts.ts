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

import svg_mouse from "#src/ui/images/mouse.svg?raw";
import { makeIcon } from "#src/widget/icon.js";

// A shortcut is shown as a plain-text label followed by one or more combo chip
// A combo's parts render together inside a single chip, consecutive key parts are joined with "+",
// while an icon sits directly beside the key it modifies with no separator.

export type SpatialSkeletonShortcutComboPart =
  | { type: "icon"; value: string }
  | { type: "key"; value: string };

export type SpatialSkeletonShortcutCombo = SpatialSkeletonShortcutComboPart[];

export interface SpatialSkeletonShortcut {
  label: string;
  combos: SpatialSkeletonShortcutCombo[];
}

export interface SpatialSkeletonToolStatusText {
  status: string;
  actions: SpatialSkeletonShortcut[];
}

export const SPATIAL_SKELETON_EDIT_TOOL_NAME = "Skeleton editing";

const mouseIcon: SpatialSkeletonShortcutComboPart = {
  type: "icon",
  value: svg_mouse,
};
const key = (value: string): SpatialSkeletonShortcutComboPart => ({
  type: "key",
  value,
});

const combo = (
  ...parts: SpatialSkeletonShortcutComboPart[]
): SpatialSkeletonShortcutCombo => parts;

// Reusable combo building blocks, shared across the shortcut entries below.
const COMBO = {
  click: combo(mouseIcon, key("click")),
  drag: combo(mouseIcon, key("drag")),
  shiftClick: combo(key("shift"), mouseIcon, key("click")),
  doubleClick: combo(mouseIcon, key("double-click")),
  holdM: combo(key("hold"), key("m")),
  holdS: combo(key("hold"), key("s")),
  holdN: combo(key("hold"), key("n")),
  holdD: combo(key("hold"), key("d")),
  releaseM: combo(key("release"), key("m")),
  releaseS: combo(key("release"), key("s")),
  releaseN: combo(key("release"), key("n")),
  releaseD: combo(key("release"), key("d")),
  middleClick: combo(key("middle click")),
  navModifierClick: combo(key("ctrl"), key("click")),
};

export const SELECT_ACTION: SpatialSkeletonShortcut = {
  label: "Select",
  combos: [COMBO.click],
};
export const MOVE_ACTION: SpatialSkeletonShortcut = {
  label: "Move",
  combos: [COMBO.drag],
};
export const ADD_NODE_ACTION: SpatialSkeletonShortcut = {
  label: "Add node",
  combos: [COMBO.shiftClick],
};
export const MERGE_ACTION: SpatialSkeletonShortcut = {
  label: "Merge",
  combos: [COMBO.holdM],
};
export const SPLIT_ACTION: SpatialSkeletonShortcut = {
  label: "Split",
  combos: [COMBO.holdS],
};
export const NEW_SKELETON_ACTION: SpatialSkeletonShortcut = {
  label: "New skeleton",
  combos: [COMBO.holdN],
};
export const DELETE_ACTION: SpatialSkeletonShortcut = {
  label: "Delete",
  combos: [COMBO.holdD],
};
export const SHOW_SKELETON_ACTION: SpatialSkeletonShortcut = {
  label: "Show",
  combos: [COMBO.doubleClick],
};
export const PLACE_ACTION: SpatialSkeletonShortcut = {
  label: "Place",
  combos: [COMBO.click],
};
export const DELETE_CLICK_ACTION: SpatialSkeletonShortcut = {
  label: "Delete",
  combos: [COMBO.click],
};
export const EXIT_MERGE_ACTION: SpatialSkeletonShortcut = {
  label: "Exit merge",
  combos: [COMBO.releaseM],
};
export const EXIT_SPLIT_ACTION: SpatialSkeletonShortcut = {
  label: "Exit split",
  combos: [COMBO.releaseS],
};
export const EXIT_CREATE_ACTION: SpatialSkeletonShortcut = {
  label: "Exit create",
  combos: [COMBO.releaseN],
};
export const EXIT_DELETE_ACTION: SpatialSkeletonShortcut = {
  label: "Exit delete",
  combos: [COMBO.releaseD],
};
export const SPATIAL_SKELETON_ROTATE_PAN_ACTION: SpatialSkeletonShortcut = {
  label: "Rotate/pan",
  combos: [COMBO.middleClick, COMBO.navModifierClick],
};

export function renderSpatialSkeletonShortcutCombo(
  combo: SpatialSkeletonShortcutCombo,
) {
  const comboElement = document.createElement("span");
  comboElement.className = "neuroglancer-skeleton-tool-shortcut-combo";
  combo.forEach((part, i) => {
    const prevPart = combo[i - 1];
    if (i > 0 && part.type === "key" && prevPart.type === "key") {
      comboElement.append(" + ");
    }
    if (part.type === "icon") {
      const shortcutIcon = makeIcon({ svg: part.value, clickable: false });
      shortcutIcon.classList.add("neuroglancer-skeleton-tool-shortcut-icon");
      comboElement.appendChild(shortcutIcon);
    } else {
      comboElement.append(part.value);
    }
  });
  return comboElement;
}

export function renderSpatialSkeletonShortcut(
  shortcut: SpatialSkeletonShortcut,
) {
  const shortcutElement = document.createElement("span");
  shortcutElement.className = "neuroglancer-skeleton-tool-shortcut";
  const labelElement = document.createElement("span");
  labelElement.className = "neuroglancer-skeleton-tool-shortcut-label";
  labelElement.textContent = shortcut.label;
  shortcutElement.appendChild(labelElement);
  shortcut.combos.forEach((combo, i) => {
    if (i > 0) {
      shortcutElement.append("/");
    }
    shortcutElement.appendChild(renderSpatialSkeletonShortcutCombo(combo));
  });
  return shortcutElement;
}
