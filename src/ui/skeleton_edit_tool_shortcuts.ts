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

import "#src/ui/annotations.css";

import {
  SKELETON_ADD_NODE,
  SKELETON_ENTER_CREATE,
  SKELETON_ENTER_DELETE_MODE,
  SKELETON_ENTER_INSERT_MODE,
  SKELETON_ENTER_MERGE_MODE,
  SKELETON_ENTER_SPLIT_MODE,
} from "#src/skeleton/actions.js";
import { getDefaultSkeletonEditToolBindings } from "#src/ui/default_input_event_bindings.js";
import svg_mouse from "#src/ui/images/mouse.svg?raw";
import type {
  ActionIdentifier,
  EventActionMap,
} from "#src/util/event_action_map.js";
import { makeIcon } from "#src/widget/icon.js";

export type SpatialSkeletonShortcutComboPart =
  | { type: "icon"; value: string }
  | { type: "key"; value: string };

export type SpatialSkeletonShortcutCombo = SpatialSkeletonShortcutComboPart[];

export interface SpatialSkeletonShortcut {
  readonly label: string;
  readonly combos: SpatialSkeletonShortcutCombo[];
}

export interface SpatialSkeletonToolStatusText {
  readonly status: string;
  readonly actions: SpatialSkeletonShortcut[];
}

export const SPATIAL_SKELETON_EDIT_TOOL_NAME = "Skeleton editing";

const mouseIcon: SpatialSkeletonShortcutComboPart = {
  type: "icon",
  value: svg_mouse,
};

function key(value: string): SpatialSkeletonShortcutComboPart {
  return { type: "key", value };
}

const MODIFIER_NAMES: Partial<Record<string, string>> = {
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  meta: "meta",
};

const MOUSE_BUTTON_NAMES: Partial<Record<string, string>> = {
  mousedown0: "click",
  mousedown1: "middle click",
  mousedown2: "right click",
};

function eventIdentifierToCombo(
  eventIdentifier: string,
): SpatialSkeletonShortcutCombo {
  const parts = eventIdentifier.split("+");
  const keyName = parts.pop()!;
  const combo: SpatialSkeletonShortcutCombo = [];
  for (const modifier of parts) {
    // Optional modifiers ("shift?") do not need to be pressed.
    if (modifier.endsWith("?")) continue;
    const modifierName = MODIFIER_NAMES[modifier];
    if (modifierName === undefined) {
      throw new Error(`Unsupported modifier in ${eventIdentifier}`);
    }
    combo.push(key(modifierName));
  }
  const mouseButtonName = MOUSE_BUTTON_NAMES[keyName];
  if (mouseButtonName !== undefined) {
    combo.push(mouseIcon, key(mouseButtonName));
  } else if (keyName.startsWith("key")) {
    combo.push(key(keyName.slice(3)));
  } else {
    throw new Error(`Unsupported key in ${eventIdentifier}`);
  }
  return combo;
}

function boundEventIdentifiers(
  map: EventActionMap,
  action: ActionIdentifier,
): string[] {
  const eventIdentifiers = new Set<string>();
  for (const [, eventAction] of map.entries()) {
    if (eventAction.action === action) {
      eventIdentifiers.add(eventAction.originalEventIdentifier!);
    }
  }
  if (eventIdentifiers.size === 0) {
    throw new Error(`No binding for ${action}`);
  }
  return Array.from(eventIdentifiers);
}

function boundShortcut(
  label: string,
  action: ActionIdentifier,
): SpatialSkeletonShortcut {
  return {
    label,
    combos: boundEventIdentifiers(
      getDefaultSkeletonEditToolBindings(),
      action,
    ).map(eventIdentifierToCombo),
  };
}

// Compare with `event.code.toLowerCase()`, as keyboard bindings do.
export function getSpatialSkeletonModeKeyCode(
  action: ActionIdentifier,
): string {
  const eventIdentifiers = boundEventIdentifiers(
    getDefaultSkeletonEditToolBindings(),
    action,
  );
  const keyCode = eventIdentifiers[0];
  if (eventIdentifiers.length !== 1 || !/^key[a-z]$/.test(keyCode)) {
    throw new Error(`${action} must be bound to exactly one plain letter key`);
  }
  return keyCode;
}

function holdShortcut(
  label: string,
  action: ActionIdentifier,
): SpatialSkeletonShortcut {
  const letter = getSpatialSkeletonModeKeyCode(action).slice(3);
  return { label, combos: [[key("hold"), key(letter)]] };
}

function releaseShortcut(
  label: string,
  action: ActionIdentifier,
): SpatialSkeletonShortcut {
  const letter = getSpatialSkeletonModeKeyCode(action).slice(3);
  return { label, combos: [[key("release"), key(letter)]] };
}

// These pointer gestures are handled by capture-phase listeners, not bindings.
const CLICK = [mouseIcon, key("click")];
const DRAG = [mouseIcon, key("drag")];
const DOUBLE_CLICK = [mouseIcon, key("double-click")];

export const SELECT_ACTION: SpatialSkeletonShortcut = {
  label: "Select",
  combos: [CLICK],
};
export const MOVE_ACTION: SpatialSkeletonShortcut = {
  label: "Move",
  combos: [DRAG],
};
export const SHOW_SKELETON_ACTION: SpatialSkeletonShortcut = {
  label: "Show",
  combos: [DOUBLE_CLICK],
};
export const PLACE_ACTION: SpatialSkeletonShortcut = {
  label: "Place",
  combos: [CLICK],
};
export const DELETE_CLICK_ACTION: SpatialSkeletonShortcut = {
  label: "Delete",
  combos: [CLICK],
};
export const ADD_NODE_ACTION = boundShortcut("Add node", SKELETON_ADD_NODE);
export const SPATIAL_SKELETON_ROTATE_PAN_ACTION = boundShortcut(
  "Rotate/pan",
  "rotate-via-mouse-drag",
);
export const MERGE_ACTION = holdShortcut("Merge", SKELETON_ENTER_MERGE_MODE);
export const INSERT_ACTION = holdShortcut("Insert", SKELETON_ENTER_INSERT_MODE);
export const SPLIT_ACTION = holdShortcut("Split", SKELETON_ENTER_SPLIT_MODE);
export const NEW_SKELETON_ACTION = holdShortcut(
  "New skeleton",
  SKELETON_ENTER_CREATE,
);
export const DELETE_ACTION = holdShortcut("Delete", SKELETON_ENTER_DELETE_MODE);
export const EXIT_MERGE_ACTION = releaseShortcut(
  "Exit merge",
  SKELETON_ENTER_MERGE_MODE,
);
export const EXIT_INSERT_ACTION = releaseShortcut(
  "Exit insert",
  SKELETON_ENTER_INSERT_MODE,
);
export const EXIT_SPLIT_ACTION = releaseShortcut(
  "Exit split",
  SKELETON_ENTER_SPLIT_MODE,
);
export const EXIT_CREATE_ACTION = releaseShortcut(
  "Exit create",
  SKELETON_ENTER_CREATE,
);
export const EXIT_DELETE_ACTION = releaseShortcut(
  "Exit delete",
  SKELETON_ENTER_DELETE_MODE,
);

function appendCombo(
  container: HTMLElement,
  combo: SpatialSkeletonShortcutCombo,
) {
  combo.forEach((part, index) => {
    if (index > 0 && part.type === "key" && combo[index - 1].type === "key") {
      container.append(" + ");
    }
    if (part.type === "icon") {
      const icon = makeIcon({ svg: part.value, clickable: false });
      icon.classList.add("neuroglancer-skeleton-tool-shortcut-icon");
      container.appendChild(icon);
    } else {
      container.append(part.value);
    }
  });
}

export function renderSpatialSkeletonShortcut(
  shortcut: SpatialSkeletonShortcut,
): HTMLElement {
  const chip = document.createElement("div");
  chip.classList.add("neuroglancer-annotation-entry-tool-chip");
  const keyElement = document.createElement("span");
  keyElement.classList.add("neuroglancer-annotation-entry-tool-chip-key");
  shortcut.combos.forEach((combo, index) => {
    if (index > 0) keyElement.append(" / ");
    appendCombo(keyElement, combo);
  });
  const labelElement = document.createElement("span");
  labelElement.classList.add("neuroglancer-annotation-entry-tool-chip-label");
  labelElement.textContent = shortcut.label;
  chip.append(keyElement, labelElement);
  return chip;
}
