/**
 * @license
 * Copyright 2017 Google Inc.
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

import {
  SKELETON_ADD_NODE,
  SKELETON_CLEAR_SELECTION,
  SKELETON_CYCLE_BRANCHES,
  SKELETON_DELETE_NODE,
  SKELETON_ENTER_CREATE,
  SKELETON_ENTER_MERGE_MODE,
  SKELETON_ENTER_SPLIT_MODE,
  SKELETON_GO_BRANCH_END,
  SKELETON_GO_BRANCH_START,
  SKELETON_GO_CHILD,
  SKELETON_GO_PARENT,
  SKELETON_GO_ROOT,
  SKELETON_GO_UNFINISHED,
  SKELETON_PIN_NODE,
  SKELETON_REDO,
  SKELETON_REROOT,
  SKELETON_TOGGLE_TRUE_END,
  SKELETON_UNDO,
} from "#src/skeleton/actions.js";
import { EventActionMap } from "#src/util/event_action_map.js";
import type { InputEventBindings } from "#src/viewer.js";

let defaultGlobalBindings: EventActionMap | undefined;

export function getDefaultGlobalBindings() {
  if (defaultGlobalBindings === undefined) {
    const map = new EventActionMap();
    map.set("keyl", "recolor");
    map.set("keyx", "clear-segments");
    map.set("keys", "toggle-show-slices");
    map.set("keyb", "toggle-scale-bar");
    map.set("keyv", "toggle-default-annotations");
    map.set("keya", "toggle-axis-lines");
    map.set("keyo", "toggle-orthographic-projection");

    for (let i = 1; i <= 9; ++i) {
      map.set("digit" + i, "toggle-layer-" + i);
      map.set("control+digit" + i, "select-layer-" + i);
      map.set("alt+digit" + i, "toggle-pick-layer-" + i);
    }

    for (let i = 0; i < 26; ++i) {
      const lowercase = String.fromCharCode(97 + i);
      const uppercase = String.fromCharCode(65 + i);
      map.set(`alt?+control?+shift+key${lowercase}`, `tool-${uppercase}`);
    }

    map.set("keyn", "add-layer");
    map.set("keyh", "help");

    map.set("space", "toggle-layout");
    map.set("shift+space", "toggle-layout-alternative");
    map.set("backslash", "toggle-show-statistics");
    map.set("control+keyp", "open-command-palette");
    defaultGlobalBindings = map;
  }
  return defaultGlobalBindings;
}

let defaultSelectBindings: EventActionMap | undefined;
export function getDefaultSelectBindings() {
  if (defaultSelectBindings === undefined) {
    defaultSelectBindings = EventActionMap.fromObject({
      "control+mousedown2": "select-position",
      "shift+control+mousedown2": "unpin-selected-position",
    });
  }
  return defaultSelectBindings;
}

let defaultAnnotationListBindings: EventActionMap | undefined;
export function getDefaultAnnotationListBindings() {
  if (defaultAnnotationListBindings === undefined) {
    defaultAnnotationListBindings = EventActionMap.fromObject(
      {
        click0: "pin-annotation",
        mousedown2: "move-to-annotation",
        "alt+mousedown0": "reorder-annotation",
      },
      { parents: [[getDefaultSelectBindings(), 0]] },
    );
  }
  return defaultAnnotationListBindings;
}

let defaultRenderedDataPanelBindings: EventActionMap | undefined;
export function getDefaultRenderedDataPanelBindings() {
  if (defaultRenderedDataPanelBindings === undefined) {
    defaultRenderedDataPanelBindings = EventActionMap.fromObject(
      {
        arrowleft: "x-",
        arrowright: "x+",
        arrowup: "y-",
        arrowdown: "y+",
        comma: "z-",
        period: "z+",
        bracketleft: "t-",
        bracketright: "t+",
        keyz: "snap",
        "control+equal": "zoom-in",
        "alt+equal": "depth-range-decrease",
        "control+shift+equal": "zoom-in",
        "alt+shift+equal": "depth-range-decrease",
        "control+minus": "zoom-out",
        "alt+minus": "depth-range-increase",
        keyr: "rotate-relative-z-",
        keye: "rotate-relative-z+",
        "shift+arrowdown": "rotate-relative-x-",
        "shift+arrowup": "rotate-relative-x+",
        "shift+arrowleft": "rotate-relative-y-",
        "shift+arrowright": "rotate-relative-y+",
        "control+wheel": { action: "zoom-via-wheel", preventDefault: true },
        "alt+wheel": {
          action: "adjust-depth-range-via-wheel",
          preventDefault: true,
        },
        "at:wheel": { action: "z+1-via-wheel", preventDefault: true },
        "at:shift+wheel": { action: "z+10-via-wheel", preventDefault: true },
        "at:dblclick0": "select",
        "at:shift+dblclick0": "star",
        "at:control+mousedown0": "annotate",
        "at:mousedown2": "move-to-mouse-position",
        "at:alt+mousedown0": "move-annotation",
        "at:control+alt+mousedown2": "delete-annotation",
        enter: "finish-annotation",
        backspace: "undo-annotation-step",
        "at:touchpinch": "zoom-via-touchpinch",
        "at:touchrotate": "rotate-in-plane-via-touchrotate",
        "at:touchtranslate2": "translate-in-plane-via-touchtranslate",
        "at:touchhold1": "move-to-mouse-position",
        "at:touchtap1x2": "select",
        "at:touchtap2x3": "snap",
      },
      {
        label: "All Data Panels",
        parents: [[getDefaultSelectBindings(), 0]],
      },
    );
  }
  return defaultRenderedDataPanelBindings;
}

let defaultPerspectivePanelBindings: EventActionMap | undefined;
export function getDefaultPerspectivePanelBindings() {
  if (defaultPerspectivePanelBindings === undefined) {
    defaultPerspectivePanelBindings = EventActionMap.fromObject(
      {
        "at:mousedown0": {
          action: "rotate-via-mouse-drag",
          stopPropagation: true,
        },
        "at:shift+mousedown0": {
          action: "translate-via-mouse-drag",
          stopPropagation: true,
        },
        "at:touchtranslate1": "rotate-out-of-plane-via-touchtranslate",
      },
      {
        parents: [
          [getDefaultRenderedDataPanelBindings(), Number.NEGATIVE_INFINITY],
        ],
      },
    );
  }
  return defaultPerspectivePanelBindings;
}

let defaultSliceViewPanelBindings: EventActionMap | undefined;
export function getDefaultSliceViewPanelBindings() {
  if (defaultSliceViewPanelBindings === undefined) {
    defaultSliceViewPanelBindings = EventActionMap.fromObject(
      {
        "at:mousedown0": {
          action: "translate-via-mouse-drag",
          stopPropagation: true,
        },
        "at:shift+mousedown0": {
          action: "rotate-via-mouse-drag",
          stopPropagation: true,
        },
        "at:touchtranslate1": "translate-z-via-touchtranslate",
      },
      {
        parents: [
          [getDefaultRenderedDataPanelBindings(), Number.NEGATIVE_INFINITY],
        ],
      },
    );
  }
  return defaultSliceViewPanelBindings;
}

let defaultSkeletonTabBindings: EventActionMap | undefined;
export function getDefaultSkeletonTabBindings() {
  if (defaultSkeletonTabBindings === undefined) {
    defaultSkeletonTabBindings = EventActionMap.fromObject(
      {
        keyr: SKELETON_GO_ROOT,
        "shift+keyr": SKELETON_REROOT,
        keyb: SKELETON_GO_BRANCH_END,
        "control+keyb": SKELETON_GO_BRANCH_START,
        bracketleft: SKELETON_GO_PARENT,
        bracketright: SKELETON_GO_CHILD,
        keyl: SKELETON_CYCLE_BRANCHES,
        keyf: SKELETON_GO_UNFINISHED,
        "control+keyz": { action: SKELETON_UNDO, preventDefault: true },
        "control+shift+keyz": { action: SKELETON_REDO, preventDefault: true },
      },
      { label: "Skeleton Tab" },
    );
  }
  return defaultSkeletonTabBindings;
}

let defaultSkeletonListBindings: EventActionMap | undefined;
export function getDefaultSkeletonListBindings() {
  if (defaultSkeletonListBindings === undefined) {
    defaultSkeletonListBindings = EventActionMap.fromObject({
      keyt: SKELETON_TOGGLE_TRUE_END,
      "shift+keyr": SKELETON_REROOT,
    });
  }
  return defaultSkeletonListBindings;
}

let defaultSkeletonEditToolBindings: EventActionMap | undefined;
export function getDefaultSkeletonEditToolBindings() {
  if (defaultSkeletonEditToolBindings === undefined) {
    defaultSkeletonEditToolBindings = EventActionMap.fromObject({
      "at:mousedown1": "rotate-via-mouse-drag",
      "at:control+mousedown1": "translate-via-mouse-drag",
      "at:shift+mousedown0": SKELETON_ADD_NODE,
      "at:keym": SKELETON_ENTER_MERGE_MODE,
      "at:keys": SKELETON_ENTER_SPLIT_MODE,
      "at:keyn": SKELETON_ENTER_CREATE,
      "at:control+mousedown2": {
        action: SKELETON_PIN_NODE,
        stopPropagation: true,
        preventDefault: true,
      },
      "at:control+alt+mousedown2": {
        action: SKELETON_DELETE_NODE,
        stopPropagation: true,
        preventDefault: true,
      },
    });
  }
  return defaultSkeletonEditToolBindings;
}

let defaultSkeletonEditAuxBindings: EventActionMap | undefined;
export function getDefaultSkeletonEditAuxBindings() {
  if (defaultSkeletonEditAuxBindings === undefined) {
    defaultSkeletonEditAuxBindings = EventActionMap.fromObject({
      "at:shift+control+mousedown2": {
        action: SKELETON_CLEAR_SELECTION,
        stopPropagation: true,
        preventDefault: true,
      },
    });
  }
  return defaultSkeletonEditAuxBindings;
}

let defaultSkeletonEditNodeBindings: EventActionMap | undefined;
export function getDefaultSkeletonEditNodeBindings() {
  if (defaultSkeletonEditNodeBindings === undefined) {
    defaultSkeletonEditNodeBindings = EventActionMap.fromObject(
      {
        keyt: SKELETON_TOGGLE_TRUE_END,
        "shift+keyr": SKELETON_REROOT,
      },
      { label: "Skeleton Edit (node)" },
    );
  }
  return defaultSkeletonEditNodeBindings;
}

export function setDefaultInputEventBindings(
  inputEventBindings: InputEventBindings,
) {
  inputEventBindings.global.addParent(
    getDefaultGlobalBindings(),
    Number.NEGATIVE_INFINITY,
  );
  inputEventBindings.sliceView.addParent(
    getDefaultSliceViewPanelBindings(),
    Number.NEGATIVE_INFINITY,
  );
  inputEventBindings.perspectiveView.addParent(
    getDefaultPerspectivePanelBindings(),
    Number.NEGATIVE_INFINITY,
  );
}
