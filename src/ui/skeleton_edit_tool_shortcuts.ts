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

/**
 * @file Binds the input events of the skeleton tools to actions. Derives the
 * shortcut hints of the tool status bar from those bindings.
 */

import { getDefaultRenderedDataPanelBindings } from "#src/ui/default_input_event_bindings.js";
import svg_mouse from "#src/ui/images/mouse.svg?raw";
import { makeToolStatusChip } from "#src/ui/tool.js";
import type { ActionIdentifier } from "#src/util/event_action_map.js";
import { EventActionMap } from "#src/util/event_action_map.js";
import { makeIcon } from "#src/widget/icon.js";

export const SKELETON_EDIT_AT_MOUSE = "skeleton-edit-at-mouse";

export const SKELETON_DRAG_VIEW = "skeleton-drag-view";

export const SKELETON_ADD_NODE = "skeleton-add-node";

export const SKELETON_ENTER_MERGE_MODE = "skeleton-enter-merge-mode";

export const SKELETON_ENTER_SPLIT_MODE = "skeleton-enter-split-mode";

export const SKELETON_ENTER_INSERT_MODE = "skeleton-enter-insert-mode";

export const SKELETON_ENTER_CREATE = "skeleton-enter-create";

export const SKELETON_PIN_NODE = "skeleton-pin-node";

export const SKELETON_ENTER_DELETE_MODE = "skeleton-enter-delete-mode";

export const SKELETON_CLEAR_SELECTION = "skeleton-clear-node-selection";

export const SKELETON_FIND_PATH_SELECT_ENDPOINT =
  "skeleton-find-path-select-endpoint";

const SKELETON_TOOL_NAVIGATION_INPUT_EVENT_MAP = EventActionMap.fromObject({
  // Control+left mirrors middle drag for trackpads.
  "at:mousedown1": SKELETON_DRAG_VIEW,
  "at:control+mousedown1": "translate-via-mouse-drag",
  "at:control+mousedown0": SKELETON_DRAG_VIEW,
  "at:control+shift+mousedown0": "translate-via-mouse-drag",
});

export const SKELETON_EDIT_TOOL_INPUT_EVENT_MAP = EventActionMap.fromObject(
  {
    "at:mousedown0": SKELETON_EDIT_AT_MOUSE,
    "at:shift+mousedown0": SKELETON_ADD_NODE,
    "at:keym": SKELETON_ENTER_MERGE_MODE,
    "at:keys": SKELETON_ENTER_SPLIT_MODE,
    "at:keyi": SKELETON_ENTER_INSERT_MODE,
    "at:keyn": SKELETON_ENTER_CREATE,
    "at:keyd": SKELETON_ENTER_DELETE_MODE,
    "at:control+mousedown2": {
      action: SKELETON_PIN_NODE,
      stopPropagation: true,
      preventDefault: true,
    },
  },
  { parents: [[SKELETON_TOOL_NAVIGATION_INPUT_EVENT_MAP, 0]] },
);

export const SKELETON_FIND_PATH_TOOL_INPUT_EVENT_MAP =
  EventActionMap.fromObject(
    {
      "at:shift?+mousedown0": SKELETON_FIND_PATH_SELECT_ENDPOINT,
    },
    { parents: [[SKELETON_TOOL_NAVIGATION_INPUT_EVENT_MAP, 0]] },
  );

export const SKELETON_EDIT_AUX_INPUT_EVENT_MAP = EventActionMap.fromObject({
  "at:shift+control+mousedown2": {
    action: SKELETON_CLEAR_SELECTION,
    stopPropagation: true,
    preventDefault: true,
  },
});

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

const enum Gesture {
  Press,
  Drag,
  Hold,
  Release,
}

const MOUSE_BUTTON_NAMES: Partial<
  Record<Gesture, Partial<Record<string, string>>>
> = {
  [Gesture.Press]: {
    mousedown0: "click",
    mousedown1: "middle click",
    mousedown2: "right click",
    dblclick0: "double-click",
  },
  [Gesture.Drag]: {
    mousedown0: "drag",
    mousedown1: "middle drag",
    mousedown2: "right drag",
  },
};

const KEY_GESTURE_NAMES: Partial<Record<Gesture, string>> = {
  [Gesture.Hold]: "hold",
  [Gesture.Release]: "release",
};

function eventIdentifierToCombo(
  eventIdentifier: string,
  gesture: Gesture,
): SpatialSkeletonShortcutCombo {
  const parts = eventIdentifier.split("+");
  const keyName = parts.pop()!;
  const combo: SpatialSkeletonShortcutCombo = [];
  const keyGestureName = KEY_GESTURE_NAMES[gesture];
  if (keyGestureName !== undefined) combo.push(key(keyGestureName));
  for (const modifier of parts) {
    // Optional modifiers ("shift?") do not need to be pressed.
    if (modifier.endsWith("?")) continue;
    const modifierName = MODIFIER_NAMES[modifier];
    if (modifierName === undefined) {
      throw new Error(`Unsupported modifier in ${eventIdentifier}`);
    }
    combo.push(key(modifierName));
  }
  if (keyName.startsWith("key") && gesture !== Gesture.Drag) {
    combo.push(key(keyName.slice(3)));
    return combo;
  }
  const mouseButtonName = MOUSE_BUTTON_NAMES[gesture]?.[keyName];
  if (mouseButtonName === undefined) {
    throw new Error(`Unsupported gesture ${gesture} for ${eventIdentifier}`);
  }
  combo.push(mouseIcon, key(mouseButtonName));
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

// Compare with `event.code.toLowerCase()`, as keyboard bindings do.
export function getSpatialSkeletonModeKeyCode(
  action: ActionIdentifier,
): string {
  const eventIdentifiers = boundEventIdentifiers(
    SKELETON_EDIT_TOOL_INPUT_EVENT_MAP,
    action,
  );
  const keyCode = eventIdentifiers[0];
  if (eventIdentifiers.length !== 1 || !/^key[a-z]$/.test(keyCode)) {
    throw new Error(`${action} must be bound to exactly one plain letter key`);
  }
  return keyCode;
}

interface ShortcutSpecification {
  readonly label: string;
  readonly action: ActionIdentifier;
  readonly gesture: Gesture;
}

function makeShortcuts<Name extends string>(
  map: EventActionMap,
  specifications: Record<Name, ShortcutSpecification>,
): Record<Name, SpatialSkeletonShortcut> {
  const shortcuts = {} as Record<Name, SpatialSkeletonShortcut>;
  for (const name in specifications) {
    const { label, action, gesture } = specifications[name];
    shortcuts[name] = {
      label,
      combos: boundEventIdentifiers(map, action)
        // The status bar shows mouse and key gestures only.
        .filter((eventIdentifier) => !eventIdentifier.startsWith("touch"))
        .map((eventIdentifier) =>
          eventIdentifierToCombo(eventIdentifier, gesture),
        ),
    };
  }
  return shortcuts;
}

export const SKELETON_EDIT_SHORTCUTS = {
  ...makeShortcuts(SKELETON_EDIT_TOOL_INPUT_EVENT_MAP, {
    select: {
      label: "Select",
      action: SKELETON_EDIT_AT_MOUSE,
      gesture: Gesture.Press,
    },
    move: {
      label: "Move",
      action: SKELETON_EDIT_AT_MOUSE,
      gesture: Gesture.Drag,
    },
    place: {
      label: "Place",
      action: SKELETON_EDIT_AT_MOUSE,
      gesture: Gesture.Press,
    },
    deleteNode: {
      label: "Delete",
      action: SKELETON_EDIT_AT_MOUSE,
      gesture: Gesture.Press,
    },
    addNode: {
      label: "Add node",
      action: SKELETON_ADD_NODE,
      gesture: Gesture.Press,
    },
    rotatePan: {
      label: "Rotate/pan",
      action: SKELETON_DRAG_VIEW,
      gesture: Gesture.Drag,
    },
    merge: {
      label: "Merge",
      action: SKELETON_ENTER_MERGE_MODE,
      gesture: Gesture.Hold,
    },
    insert: {
      label: "Insert",
      action: SKELETON_ENTER_INSERT_MODE,
      gesture: Gesture.Hold,
    },
    split: {
      label: "Split",
      action: SKELETON_ENTER_SPLIT_MODE,
      gesture: Gesture.Hold,
    },
    newSkeleton: {
      label: "New skeleton",
      action: SKELETON_ENTER_CREATE,
      gesture: Gesture.Hold,
    },
    deleteMode: {
      label: "Delete",
      action: SKELETON_ENTER_DELETE_MODE,
      gesture: Gesture.Hold,
    },
    exitMerge: {
      label: "Exit merge",
      action: SKELETON_ENTER_MERGE_MODE,
      gesture: Gesture.Release,
    },
    exitInsert: {
      label: "Exit insert",
      action: SKELETON_ENTER_INSERT_MODE,
      gesture: Gesture.Release,
    },
    exitSplit: {
      label: "Exit split",
      action: SKELETON_ENTER_SPLIT_MODE,
      gesture: Gesture.Release,
    },
    exitCreate: {
      label: "Exit create",
      action: SKELETON_ENTER_CREATE,
      gesture: Gesture.Release,
    },
    exitDelete: {
      label: "Exit delete",
      action: SKELETON_ENTER_DELETE_MODE,
      gesture: Gesture.Release,
    },
  }),
  ...makeShortcuts(getDefaultRenderedDataPanelBindings(), {
    show: { label: "Show", action: "select", gesture: Gesture.Press },
  }),
};

function appendCombo(
  container: DocumentFragment,
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
  const keyElement = document.createDocumentFragment();
  shortcut.combos.forEach((combo, index) => {
    if (index > 0) keyElement.append(" / ");
    appendCombo(keyElement, combo);
  });
  return makeToolStatusChip(keyElement, shortcut.label);
}
