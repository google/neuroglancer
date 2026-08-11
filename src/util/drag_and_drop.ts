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

/**
 * @file Facilities for encoding arbitrary strings as HTML5 Drag-and-drop types.
 *
 * The HTML5 Drag and Drop mechanism provides a way of attaching a set of (string key -> string
 * value) mappings to a drag.  The keys can be retrieved by any target the drag passes over, while
 * the values can only be retrieved when the actual "drop" happens.  Therefore, any data that needs
 * to be available prior to the drop must be stored as a key.  Additionally, the key strings are
 * munged.  According to the spec
 * <https://dev.w3.org/html5/spec-preview/dnd.html#the-drag-data-store>, the keys are converted to
 * ASCII lowercase, which means that only ASCII uppercase letters are modified, and all other
 * Unicode characters are preserved.  However, Chrome 62 does not appear to follow the spec, and
 * munges other characters as well.  Therefore, we hex encode to be safe.
 */

import { registerEventListener } from "#src/util/disposable.js";
import { hexEncode, hexDecode } from "#src/util/hex.js";

export function encodeStringAsDragType(s: string) {
  return hexEncode(new TextEncoder().encode(s));
}

export function decodeStringFromDragType(s: string) {
  return new TextDecoder().decode(hexDecode(s));
}

export function encodeDragType(prefix: string, parameters: any) {
  return prefix + encodeStringAsDragType(JSON.stringify(parameters));
}

export function decodeParametersFromDragType(dragType: string, prefix: string) {
  if (!dragType.startsWith(prefix)) {
    return undefined;
  }
  try {
    const jsonString = decodeStringFromDragType(
      dragType.substring(prefix.length),
    );
    return JSON.parse(jsonString);
  } catch {
    return undefined;
  }
}

export function encodeParametersAsDragType(prefix: string, parameters: any) {
  return prefix + encodeStringAsDragType(JSON.stringify(parameters));
}

export interface DragInfo {
  dragType: string;
  parameters: any;
}

export function decodeParametersFromDragTypeList(
  dragTypes: ReadonlyArray<string>,
  prefix: string,
): DragInfo | undefined {
  for (const dragType of dragTypes) {
    const parameters = decodeParametersFromDragType(dragType, prefix);
    if (parameters !== undefined) {
      return { parameters, dragType };
    }
  }
  return undefined;
}

let savedDropEffect: DataTransfer["dropEffect"] | undefined;

// Chrome on Wayland seems to report an `effectAllowed` of `copyMove` regardless
// of what the dragstart handler sets.  Convert the actual drop effect to an
// allowed value to avoid Chrome rejecting the drop.  The actual drop effect is
// still stored separately by `setDropEffect` to ensure the correct drop action
// is performed.
function getAllowedDropEffect(
  effectAllowed: string,
  dropEffect: string,
): string {
  if (effectAllowed == dropEffect) return dropEffect;
  switch (effectAllowed) {
    case "all":
      return dropEffect;
    case "copyMove":
      return dropEffect == "copy" || dropEffect == "move" ? dropEffect : "copy";
    case "copyLink":
      return dropEffect == "copy" || dropEffect == "link" ? dropEffect : "copy";
    case "linkMove":
      return dropEffect == "link" || dropEffect == "move" ? dropEffect : "link";
  }
  return effectAllowed;
}

/**
 * On Chrome 62, the dataTransfer.dropEffect property is reset to 'none' when the 'drop' event is
 * dispatched.  As a workaround, we store it in a global variable.
 *
 * The alternative workaround of recomputing it in the 'drop' event handler is problematic for a
 * different reason: the computation may depend on the modifier key states, and on Firefox 52, these
 * key states are not set in the 'drop' event.
 */
export function setDropEffect<T extends DataTransfer["dropEffect"]>(
  event: DragEvent,
  dropEffect: T,
) {
  event.dataTransfer!.dropEffect = getAllowedDropEffect(
    event.dataTransfer!.effectAllowed,
    dropEffect,
  ) as any;
  savedDropEffect = dropEffect;
  return dropEffect;
}

export function getDropEffect() {
  return savedDropEffect;
}

export function preventDrag(element: HTMLElement) {
  element.draggable = true;
  return registerEventListener(element, "dragstart", (event: DragEvent) => {
    event.stopPropagation();
    event.preventDefault();
  });
}

// False except on Wayland.
let mustRestartDragToChangeModifiers = false;

// When `modifiersReportedDuringDrag == false`, this stores the initial
// modifiers reported to the `dragstart` handler.
let savedModifiers:
  | {
      shiftKey: boolean;
      ctrlKey: boolean;
      altKey: boolean;
      metaKey: boolean;
    }
  | undefined = undefined;

// Apply Linux Wayland-specific workarounds.
if (
  navigator.platform.startsWith("Linux ") &&
  !navigator.userAgent.includes("CrOs") &&
  !navigator.userAgent.includes("Android") &&
  // On Wayland, screenX and screenY are always reported as 0.  However, this
  // does not definitively rule out X11.
  window.screenX === 0 &&
  window.screenY === 0
) {
  // On Linux under Wayland, Chrome does not report any modifier keys after the
  // initial `dragstart` event, while Firefox saves the modifier keys that were
  // held during `dragstart` and continues to report them on all drag-related
  // events, even if the user releases the modifiers.
  //
  // We will emulate the and Firefox do not report modifier keys
  // during drag operations due to Wayland limitations, only on the initial
  // dragstart event.  There is no way to directly detect Wayland vs X11 but we
  // on Chrome can check if any modifiers have been observed in drag events other than
  // `dragstart`.
  mustRestartDragToChangeModifiers = true;

  if (navigator.userAgent.includes("Chrome")) {
    // Under Chrome, effectively emulate the Firefox behavior by storing the
    // modifiers that are reported to `dragstart` and make them available.
    //
    // Additionally, if any modifier is reported to a drag event other than
    // `dragstart`, the platform must not be Wayland and the workaround and
    // warning can be disabled.
    const eventTypes = [
      "dragstart",
      "dragend",
      "drag",
      "dragenter",
      "dragover",
      "dragleave",
    ];
    function dragHandler(event: DragEvent) {
      if (event.type == "dragstart") {
        savedModifiers = {
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
        };
      } else if (event.type == "dragend") {
        savedModifiers = undefined;
      } else if (
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.metaKey
      ) {
        // Non-Wayland platform detected, disable workaround.
        savedModifiers = undefined;
        mustRestartDragToChangeModifiers = false;
        for (const eventType of eventTypes) {
          window.removeEventListener(eventType, dragHandler, { capture: true });
        }
      }
    }
    for (const eventType of eventTypes) {
      window.addEventListener(eventType, dragHandler, { capture: true });
    }
  }
}

export function getDropEffectFromModifiers<DropEffect extends string>(
  event: DragEvent,
  defaultDropEffect: DropEffect,
  moveAllowed: boolean,
): { dropEffect: DropEffect | "move" | "copy"; dropEffectMessage: string } {
  const modifiers = savedModifiers ?? event;
  let dropEffect: DropEffect | "move" | "copy";
  if (modifiers.shiftKey) {
    dropEffect = "copy";
  } else if (modifiers.ctrlKey && moveAllowed) {
    dropEffect = "move";
  } else {
    dropEffect = defaultDropEffect;
  }
  let message = "";
  const addMessage = (msg: string) => {
    if (message === "" && mustRestartDragToChangeModifiers) {
      message = "restart drag and ";
    } else if (message !== "") {
      message += ", ";
    }
    message += msg;
  };
  if (defaultDropEffect !== "none" && dropEffect !== defaultDropEffect) {
    if (modifiers.shiftKey) {
      addMessage(`release SHIFT to ${defaultDropEffect}`);
    } else {
      addMessage(`release CONTROL to ${defaultDropEffect}`);
    }
  }
  if (dropEffect !== "copy") {
    addMessage("hold SHIFT to copy");
  }
  if (dropEffect !== "move" && moveAllowed && defaultDropEffect !== "move") {
    addMessage("hold CONTROL to move");
  }

  if (message !== "" && mustRestartDragToChangeModifiers) {
    message +=
      "; due to Wayland limitation, modifier keys cannot be changed during drag";
  }
  return { dropEffect, dropEffectMessage: message };
}
